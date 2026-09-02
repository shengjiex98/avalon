// HTTP server: static files, a JSON action endpoint and an SSE stream per
// player. Room state is periodically snapshotted for restarts.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync,
} from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_PROTOCOL } from '../contracts/api-protocol.ts';
import {
  createAdminApp, parseAdminUsers,
} from './admin.ts';
import type { RuntimeMetrics } from './admin.ts';
import { Avatars } from './avatars.ts';
import { parseAction, parseCreateRoom, parseJoin, parseRoomCode } from './commands.ts';
import { GameError } from './errors.ts';
import { defaultStateFile, load, save } from './persistence.ts';
import { Rooms } from './rooms.ts';
import { GAME_IDS } from './games/index.ts';
import { STATE_VERSION } from '../contracts/state-version.ts';
import type { GameId } from '../contracts/actions.ts';
import type { PublicView } from '../contracts/views.ts';
import {
  errorKind, operationalLogger,
} from './logging.ts';
import type { OperationalLogger } from './logging.ts';

export function runtimePaths(rootDir = process.cwd()): { rootDir: string; publicDir: string } {
  const root = resolve(rootDir);
  return { rootDir: root, publicDir: join(root, 'build/public') };
}

const RUNTIME_PATHS = runtimePaths();

/**
 * The commit this process is serving, read from the checkout rather than from
 * `git`, so nothing has to be executable for health to answer. Resolved once:
 * the answer describes the code already loaded, which is what a deployment
 * pipeline needs to hear -- a working tree moved underneath a running process
 * has not been deployed until the restart.
 */
export function readDeployedCommit(rootDir = RUNTIME_PATHS.rootDir): string | null {
  const sha = /^[0-9a-f]{40}$/;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(rootDir, 'release.json'), 'utf8'));
    if (manifest && typeof manifest === 'object' && 'commit' in manifest
        && typeof manifest.commit === 'string' && sha.test(manifest.commit)) return manifest.commit;
  } catch { /* a development checkout has no release manifest */ }

  try {
    const gitDir = join(rootDir, '.git');
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return sha.test(head) ? head : null;

    const ref = head.slice(5).trim();
    try {
      const loose = readFileSync(join(gitDir, ref), 'utf8').trim();
      if (sha.test(loose)) return loose;
    } catch { /* a packed ref, read below */ }

    for (const line of readFileSync(join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const [candidate, name] = line.split(' ');
      if (name === ref && candidate && sha.test(candidate)) return candidate;
    }
  } catch { /* not a checkout: an unstamped tarball or image */ }
  return null;
}

export const DEPLOYED_COMMIT = readDeployedCommit();

// The one supported remote client. Same-origin clients need no CORS headers.
export const CLIENT_ORIGIN = 'https://shengjiex98.github.io';

export function createRuntimeMetrics(now = Date.now): RuntimeMetrics {
  return { startedAt: now(), snapshotHealthy: null, sseConnections: 0 };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

const CONFLICT_ERRORS = new Set([
  'alreadyActed', 'alreadyPlayed', 'alreadyVoted', 'assassinOnly', 'badCentreCard',
  'badPlayerCount', 'badTarget', 'cannotLeaveMidGame', 'cannotTargetSelf',
  'cannotVoteSelf', 'drunkMustSwap', 'duplicateMember', 'gameAlreadyStarted',
  'gameInProgress', 'goodMustSucceed', 'hostOnly', 'nameTaken', 'needMorePlayers',
  'noNightAction', 'notLeader', 'notOnTeam', 'notYourTurn', 'roomFull', 'roomsFull',
  'tooManyEvilRoles', 'tooManyGoodRoles', 'tooManyRoles', 'troublemakerNotSelf',
  'unknownMember', 'wrongPhase', 'wrongTeamSize',
]);

export function createApp({
  rooms,
  avatars = new Avatars(),
  clientOrigin = CLIENT_ORIGIN,
  publicDir = RUNTIME_PATHS.publicDir,
  deployedCommit = DEPLOYED_COMMIT,
  logger = operationalLogger,
  metrics,
}: {
  rooms?: Rooms;
  avatars?: AvatarService;
  clientOrigin?: string;
  publicDir?: string;
  deployedCommit?: string | null;
  logger?: OperationalLogger;
  metrics?: RuntimeMetrics;
} = {}) {
  const registry = rooms ?? new Rooms({ logger });
  const staticDir = resolve(publicDir);
  const runtimeMetrics = metrics ?? createRuntimeMetrics();
  const connectionChange = (change: 1 | -1) => {
    runtimeMetrics.sseConnections += change;
    logger('info', 'sse.connections', { count: runtimeMetrics.sseConnections });
  };
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let requestId: string | null = null;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        requestId = logApiRequest(req, res, url, logger);
        allowClient(req, res, clientOrigin);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          });
          res.end();
          return;
        }
        await api(registry, avatars, deployedCommit, req, res, url, logger, connectionChange);
        return;
      }
      await serveStatic(staticDir, req, res, url);
    } catch (err) {
      if (err instanceof GameError) {
        if (res.headersSent) { res.end(); return; }
        const status = errorStatus(err.key);
        json(res, status, { error: err.key, params: err.params });
        return;
      }
      logger('error', 'unexpected.failure', {
        operation: requestId ? 'api.request' : 'http.request',
        error: errorKind(err),
        ...(requestId ? { requestId } : {}),
      });
      if (!res.headersSent) json(res, 500, { error: 'serverError', params: {} });
      else res.end();
    }
  };
}

export function normalizedApiRoute(pathname: string): string {
  if (pathname === '/api/health' || pathname === '/api/health/update') return pathname;
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return '/api/unknown';
  if (parts[1] === 'avatars' && parts.length === 3) return '/api/avatars/:avatar';
  if (parts[1] !== 'rooms') return '/api/unknown';
  if (parts.length === 2) return '/api/rooms';
  if (parts.length === 3) return '/api/rooms/:room';
  if (parts.length === 4 && ['events', 'join', 'action'].includes(parts[3]!)) {
    return `/api/rooms/:room/${parts[3]}`;
  }
  return '/api/unknown';
}

function logApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  logger: OperationalLogger,
): string {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  let logged = false;
  res.setHeader('x-request-id', requestId);
  const complete = () => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    logger('info', 'api.request', {
      requestId,
      method: req.method ?? 'UNKNOWN',
      route: normalizedApiRoute(url.pathname),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  };
  res.once('finish', complete);
  res.once('close', complete);
  return requestId;
}

interface AvatarService {
  readonly canGenerate: boolean;
  read(file: string): Promise<{ bytes: Buffer; mime: string } | null>;
  resolve(input: { name: string; upload?: string | false | undefined }): Promise<string | null>;
}

const isGameId = (value: string): value is GameId => GAME_IDS.some((id) => id === value);

function allowClient(req: IncomingMessage, res: ServerResponse, clientOrigin: string): void {
  const origin = String(req.headers.origin ?? '').replace(/\/$/, '');
  if (origin) res.setHeader('vary', 'origin');
  if (origin !== clientOrigin) return;
  res.setHeader('access-control-allow-origin', origin);
}

async function api(
  rooms: Rooms,
  avatars: AvatarService,
  deployedCommit: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  logger: OperationalLogger,
  connectionChange: (change: 1 | -1) => void,
): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','rooms',CODE,...]

  // Liveness always stays healthy. Updaters use /update to avoid interrupting
  // any room whose game has left the lobby.
  if (url.pathname === '/api/health' || url.pathname === '/api/health/update') {
    requireMethod(req, res, ['GET']);
    const activeGames = rooms.activeGameCount();
    const updateSafe = activeGames === 0;
    const status = url.pathname === '/api/health/update' && !updateSafe ? 409 : 200;
    json(res, status, {
      ok: true,
      service: 'avalon',
      protocol: API_PROTOCOL,
      stateVersion: STATE_VERSION,
      games: GAME_IDS,
      rooms: rooms.rooms.size,
      activeGames,
      updateSafe,
      avatarGeneration: avatars.canGenerate,
      commit: deployedCommit,
    });
    return;
  }

  if (parts[1] === 'avatars' && parts[2] && !parts[3]) {
    requireMethod(req, res, ['GET', 'HEAD']);
    const avatar = await avatars.read(parts[2]);
    if (!avatar) throw new GameError('notFound');
    res.writeHead(200, {
      'content-type': avatar.mime,
      'content-length': avatar.bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : avatar.bytes);
    return;
  }

  if (url.pathname === '/api/rooms') {
    requireMethod(req, res, ['POST']);
    const body = parseCreateRoom(await readJson(req));
    if (body.game !== undefined && !isGameId(body.game)) {
      throw new GameError('noSuchGame', { game: body.game });
    }
    json(res, 200, { code: rooms.create(body.game) });
    return;
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) {
    throw new GameError('notFound');
  }
  const code = parseRoomCode(parts[2]);
  const tail = parts[3];
  if (parts[4]) throw new GameError('notFound');

  // What a reconnecting browser asks after its stream drops: is the room still
  // here, and is my seat still in it? A restart that lost the snapshot answers
  // both, so the client can stop retrying instead of saying "reconnecting"
  // forever. Looking rather than getting: a probe must not renew a room's life.
  if (!tail) {
    requireMethod(req, res, ['GET']);
    const room = rooms.peek(code);
    const playerId = url.searchParams.get('playerId');
    json(res, 200, {
      exists: Boolean(room),
      seated: Boolean(room && playerId && room.players.some((p) => p.id === playerId)),
    });
    return;
  }

  if (tail === 'events') {
    requireMethod(req, res, ['GET']);
    stream(rooms, req, res, code, url.searchParams.get('playerId'), connectionChange);
    return;
  }

  if (tail === 'join') {
    requireMethod(req, res, ['POST']);
    const body = parseJoin(await readJson(req, 384 * 1024));
    const requestedPlayerId = body.playerId ?? null;
    const room = rooms.get(code);
    const known = Boolean(requestedPlayerId && room.players.some((p) => p.id === requestedPlayerId));
    const playerId = known ? requestedPlayerId! : randomUUID();
    rooms.dispatch(code, playerId, { type: 'join', id: playerId, name: body.name });
    json(res, 200, { playerId, code });

    // Joining is never held hostage by image generation, which can take up to
    // a couple of minutes. A placeholder appears immediately and the SSE view
    // replaces it as soon as the upload or generated portrait is stored.
    const player = room.players.find((candidate) => candidate.id === playerId)!;
    if (!known || !player.avatar) {
      void avatars.resolve({ name: player.name, upload: body.avatar })
        .then((avatar) => avatar && rooms.updatePlayerAvatar(code, playerId, avatar))
        .catch((err: unknown) => logger('error', 'unexpected.failure', {
          operation: 'avatar.prepare', error: errorKind(err),
        }));
    }
    return;
  }

  if (tail === 'action') {
    requireMethod(req, res, ['POST']);
    const input = await readJson(req);
    const room = rooms.peek(code);
    if (!room) throw new GameError('noSuchRoom', { code });
    const body = parseAction(room.game.id, input);
    if (body.type === 'setGame' && !isGameId(body.game)) {
      throw new GameError('noSuchGame', { game: body.game });
    }
    rooms.dispatch(code, body.playerId, body);
    json(res, 200, { ok: true });
    return;
  }

  throw new GameError('notFound');
}

function requireMethod(req: IncomingMessage, res: ServerResponse, methods: string[]): void {
  if (methods.includes(req.method ?? '')) return;
  res.setHeader('allow', methods.join(', '));
  throw new GameError('methodNotAllowed');
}

function errorStatus(key: string): number {
  if (key === 'notFound' || key === 'noSuchRoom') return 404;
  if (key === 'methodNotAllowed') return 405;
  if (key === 'payloadTooLarge') return 413;
  if (key === 'unsupportedMediaType') return 415;
  if (key === 'notInGame') return 403;
  if (CONFLICT_ERRORS.has(key)) return 409;
  return 400;
}

function stream(
  rooms: Rooms,
  req: IncomingMessage,
  res: ServerResponse,
  code: string,
  playerId: string | null,
  connectionChange: (change: 1 | -1) => void,
): void {
  if (!playerId) throw new GameError('notInGame');
  // Validate before committing the SSE headers. A stale room URL must get a
  // normal JSON error, rather than throwing after the 200 response has begun.
  const room = rooms.get(code);
  if (!room.players.some((player) => player.id === playerId)) {
    throw new GameError('notInGame');
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = rooms.subscribe(code, playerId, (view: PublicView) => {
    res.write(`data: ${JSON.stringify(view)}\n\n`);
  });
  connectionChange(1);
  // Proxies drop a silent stream; a comment every 25s keeps it open.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unsubscribe();
    connectionChange(-1);
  };
  req.on('close', close);
  req.on('error', close);
}

async function serveStatic(publicDir: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'notFound' });
    return;
  }
  if (url.pathname === '/version.json') return serveLocalVersion(publicDir, req, res);
  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const path = join(publicDir, rel);
  if (!path.startsWith(publicDir)) return json(res, 403, { error: 'notFound' });
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/** Local development has no build SHA, so use the newest emitted-file mtime. */
async function serveLocalVersion(publicDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body;
  try {
    body = await readFile(join(publicDir, 'version.json'));
    const version = String(JSON.parse(body.toString()).version ?? '');
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(version)) throw new Error('invalid staged version');
  } catch {
    const modified = await newestMtime(publicDir);
    body = Buffer.from(JSON.stringify({ version: `local-${Math.floor(modified).toString(36)}` }));
  }
  res.writeHead(200, {
    'content-type': MIME['.json'],
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'version.json') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase().split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new GameError('unsupportedMediaType');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new GameError('payloadTooLarge');
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GameError('badRequest');
  }
}

export function start({
  port = Number(process.env.PORT ?? 8420),
  host = process.env.HOST ?? '0.0.0.0',
  stateFile = defaultStateFile(),
}: { port?: number; host?: string; stateFile?: string } = {}): Server {
  let pendingSave: NodeJS.Timeout | null = null;
  let rooms: Rooms;
  const metrics = createRuntimeMetrics();
  const saveSnapshot = () => {
    try {
      save(rooms, stateFile);
      if (metrics.snapshotHealthy !== true) {
        operationalLogger('info', 'snapshot.save', { outcome: 'saved', rooms: rooms.rooms.size });
      }
      metrics.snapshotHealthy = true;
    } catch (err: unknown) {
      if (metrics.snapshotHealthy !== false) {
        operationalLogger('error', 'snapshot.save', { outcome: 'failed', error: errorKind(err) });
      }
      metrics.snapshotHealthy = false;
    }
  };
  const saveSoon = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      saveSnapshot();
    }, 1000);
    pendingSave.unref?.();
  };
  rooms = new Rooms({ onMutate: saveSoon, logger: operationalLogger });
  const avatars = new Avatars({ directory: join(dirname(stateFile), 'avatars') });
  const restored = load(rooms, stateFile);
  const loadOutcome = restored.restored > 0 ? 'restored'
    : restored.reason === 'no snapshot found' ? 'missing'
      : restored.reason === 'snapshot contained no rooms' ? 'empty' : 'discarded';
  operationalLogger('info', 'snapshot.load', {
    outcome: loadOutcome,
    rooms: restored.restored,
  });

  const server = createServer(createApp({ rooms, avatars, metrics }));
  const adminUsers = parseAdminUsers(process.env.ADMIN_USERS);
  const configuredAdminSocket = process.env.ADMIN_SOCKET?.trim();
  const adminSocket = configuredAdminSocket
    || join(dirname(stateFile), 'admin-socket', 'server.sock');
  const adminServer = adminUsers.size > 0
    ? listenAdmin(adminSocket, createAdminApp({
      rooms,
      allowedUsers: adminUsers,
      metrics,
      deployedCommit: DEPLOYED_COMMIT,
    }))
    : null;
  const sweeper = setInterval(() => rooms.sweep(), 10 * 60 * 1000);
  sweeper.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweeper);
    if (pendingSave) clearTimeout(pendingSave);
    saveSnapshot();
    adminServer?.close();
    server.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.listen(port, host, () => {
    operationalLogger('info', 'server.started', { host, port });
  });
  return server;
}

function listenAdmin(
  socketPath: string,
  handler: ReturnType<typeof createAdminApp>,
): Server {
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`admin socket parent is not a directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
  try {
    const existing = lstatSync(socketPath);
    if (!existing.isSocket()) throw new Error(`refusing to replace non-socket admin path: ${socketPath}`);
    unlinkSync(socketPath);
  } catch (err: unknown) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;
  }

  const server = createServer(handler);
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    operationalLogger('info', 'admin.started', { transport: 'unix' });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) start();
