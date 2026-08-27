// Zero-dependency HTTP server: static files, a JSON action endpoint and an
// SSE stream per player. Room state is periodically snapshotted for restarts.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameError } from './lobby.js';
import { defaultStateFile, load, save } from './persistence.js';
import { Rooms } from './rooms.js';
import { GAME_IDS, gameFor } from './games/index.js';
import { STATE_VERSION } from './state-version.js';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
export const API_PROTOCOL = 2;

/**
 * The commit this process is serving, read from the checkout rather than from
 * `git`, so nothing has to be executable for health to answer. Resolved once:
 * the answer describes the code already loaded, which is what a deployment
 * pipeline needs to hear -- a working tree moved underneath a running process
 * has not been deployed until the restart.
 */
export function readDeployedCommit(rootDir = ROOT_DIR) {
  const sha = /^[0-9a-f]{40}$/;
  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'release.json'), 'utf8'));
    if (sha.test(manifest.commit)) return manifest.commit;
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
      if (name === ref && sha.test(candidate)) return candidate;
    }
  } catch { /* not a checkout: an unstamped tarball or image */ }
  return null;
}

export const DEPLOYED_COMMIT = readDeployedCommit();

// The one supported remote client. Same-origin clients need no CORS headers.
export const CLIENT_ORIGIN = 'https://shengjiex98.github.io';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
};

export function createApp({ rooms = new Rooms(), clientOrigin = CLIENT_ORIGIN } = {}) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        allowClient(req, res, clientOrigin);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '86400',
          });
          return res.end();
        }
        return await api(rooms, req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof GameError) return json(res, 400, { error: err.key, params: err.params });
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'serverError' });
      else res.end();
    }
  };
}

function allowClient(req, res, clientOrigin) {
  const origin = String(req.headers.origin ?? '').replace(/\/$/, '');
  if (origin) res.setHeader('vary', 'origin');
  if (origin !== clientOrigin) return;
  res.setHeader('access-control-allow-origin', origin);
}

async function api(rooms, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','rooms',CODE,...]

  // Liveness always stays healthy. Updaters use /update to avoid interrupting
  // any room whose game has left the lobby.
  if (req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/health/update')) {
    const activeGames = rooms.activeGameCount();
    const updateSafe = activeGames === 0;
    const status = url.pathname === '/api/health/update' && !updateSafe ? 409 : 200;
    return json(res, status, {
      ok: true,
      service: 'avalon',
      protocol: API_PROTOCOL,
      stateVersion: STATE_VERSION,
      games: GAME_IDS,
      rooms: rooms.rooms.size,
      activeGames,
      updateSafe,
      commit: DEPLOYED_COMMIT,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readJson(req);
    return json(res, 200, { code: rooms.create(body.game) });
  }

  if (parts[0] !== 'api' || parts[1] !== 'rooms' || !parts[2]) {
    return json(res, 404, { error: 'notFound' });
  }
  const code = parts[2].toUpperCase();
  const tail = parts[3];

  // What a reconnecting browser asks after its stream drops: is the room still
  // here, and is my seat still in it? A restart that lost the snapshot answers
  // both, so the client can stop retrying instead of saying "reconnecting"
  // forever. Looking rather than getting: a probe must not renew a room's life.
  if (req.method === 'GET' && !tail) {
    const room = rooms.peek(code);
    const playerId = url.searchParams.get('playerId');
    return json(res, 200, {
      exists: Boolean(room),
      seated: Boolean(room && playerId && room.game.players.some((p) => p.id === playerId)),
    });
  }

  if (req.method === 'GET' && tail === 'events') {
    return stream(rooms, req, res, code, url.searchParams.get('playerId'));
  }

  if (req.method === 'POST' && tail === 'join') {
    const body = await readJson(req);
    let playerId = typeof body.playerId === 'string' ? body.playerId : null;
    const room = rooms.get(code);
    const known = playerId && room.game.players.some((p) => p.id === playerId);
    if (!known) playerId = randomUUID();
    rooms.dispatch(code, playerId, { type: 'join', id: playerId, name: body.name });
    return json(res, 200, { playerId, code });
  }

  if (req.method === 'POST' && tail === 'action') {
    const body = await readJson(req);
    if (typeof body.playerId !== 'string') return json(res, 400, { error: 'notInGame' });

    rooms.dispatch(code, body.playerId, body);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'notFound' });
}

function stream(rooms, req, res, code, playerId) {
  if (!playerId) return json(res, 400, { error: 'notInGame' });
  // Validate before committing the SSE headers. A stale room URL must get a
  // normal JSON error, rather than throwing after the 200 response has begun.
  const room = rooms.get(code);
  if (!room.game.players.some((player) => player.id === playerId)) {
    throw new GameError('notInGame');
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = rooms.subscribe(code, playerId, (view) => {
    res.write(`data: ${JSON.stringify(view)}\n\n`);
  });
  // Proxies drop a silent stream; a comment every 25s keeps it open.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  const close = () => { clearInterval(ping); unsubscribe(); };
  req.on('close', close);
  req.on('error', close);
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'notFound' });
  if (url.pathname === '/version.json') return serveLocalVersion(req, res);
  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const path = join(PUBLIC_DIR, rel);
  if (!path.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'notFound' });
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

/** Local development has no build SHA, so use the newest public-file mtime. */
async function serveLocalVersion(req, res) {
  const modified = await newestMtime(PUBLIC_DIR);
  const body = Buffer.from(JSON.stringify({ version: `local-${Math.floor(modified).toString(36)}` }));
  res.writeHead(200, {
    'content-type': MIME['.json'],
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'version.json') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new GameError('payloadTooLarge');
    chunks.push(chunk);
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
} = {}) {
  let pendingSave = null;
  let rooms;
  const saveSoon = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      try { save(rooms, stateFile); }
      catch (err) { console.error(`could not save room snapshot: ${err.message}`); }
    }, 1000);
    pendingSave.unref?.();
  };
  rooms = new Rooms({ onMutate: saveSoon });
  const restored = load(rooms, stateFile);
  console.log(restored.restored
    ? `restored ${restored.restored} room${restored.restored === 1 ? '' : 's'} from ${stateFile}`
    : `${restored.reason} (${stateFile})`);

  const server = createServer(createApp({ rooms }));
  const sweeper = setInterval(() => rooms.sweep(), 10 * 60 * 1000);
  sweeper.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweeper);
    clearTimeout(pendingSave);
    try { save(rooms, stateFile); }
    catch (err) { console.error(`could not save room snapshot during shutdown: ${err.message}`); }
    server.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.listen(port, host, () => {
    console.log(`Avalon listening on http://${host}:${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
