// Zero-dependency HTTP server: static files, a JSON action endpoint and an
// SSE stream per player. State lives in memory only.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameError } from './lobby.js';
import { Rooms } from './rooms.js';
import { GAMES, GAME_IDS, gameFor } from './games/index.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Origins allowed to call the API from another host. Empty means same-origin
 * only, which is right when one process serves both the page and the API.
 * A GitHub Pages front end needs its origin listed here, e.g.
 *   ALLOW_ORIGIN=https://you.github.io
 */
const parseOrigins = (raw) =>
  String(raw ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

const ALLOW_ORIGIN = parseOrigins(process.env.ALLOW_ORIGIN);
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

/** Actions that mean the same thing whatever is being played. */
const COMMON_ACTIONS = {
  leave: (g, id) => gameFor(g.gameId).removePlayer(g, id),
};

export function createApp({ rooms = new Rooms(), allowedOrigins = ALLOW_ORIGIN } = {}) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        allowOrigin(req, res, allowedOrigins);
        if (req.method === 'OPTIONS') {           // CORS preflight
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS',
                               'access-control-allow-headers': 'content-type',
                               'access-control-max-age': '86400' });
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

/**
 * Echo back the caller's origin when it is on the allowlist. Echoing rather
 * than sending `*` keeps the door open to credentialed requests later, and
 * `vary` stops a proxy serving one origin's response to another.
 */
function allowOrigin(req, res, allowed) {
  const origin = (req.headers.origin ?? '').replace(/\/$/, '');
  res.setHeader('vary', 'origin');
  if (!origin) return;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  }
}

async function api(rooms, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','rooms',CODE,...]

  // A front end hosted elsewhere probes this before showing the lobby, so it
  // can say "that server is unreachable" instead of failing on the first join.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'avalon', games: GAME_IDS, rooms: rooms.rooms.size });
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

  if (req.method === 'GET' && !tail) {
    return json(res, 200, { exists: rooms.has(code) });
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
    rooms.apply(code, (g) => gameFor(g.gameId).addPlayer(g, { id: playerId, name: body.name }));
    return json(res, 200, { playerId, code });
  }

  if (req.method === 'POST' && tail === 'action') {
    const body = await readJson(req);
    if (typeof body.playerId !== 'string') return json(res, 400, { error: 'notInGame' });

    // Changing game replaces the room state, so it cannot run inside apply().
    if (body.type === 'setGame') {
      rooms.setGame(code, body.playerId, body.game);
      return json(res, 200, { ok: true });
    }

    rooms.apply(code, (g) => {
      if (!g.players.some((p) => p.id === body.playerId)) throw new GameError('notInGame');
      const action = COMMON_ACTIONS[body.type] ?? gameFor(g.gameId).actions[body.type];
      if (!action) throw new GameError('unknownAction', { type: body.type });
      return action(g, body.playerId, body);
    });
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
    if (entry.name === 'version.json' || entry.name === '.nojekyll') continue;
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

export function start({ port = Number(process.env.PORT ?? 8420), host = process.env.HOST ?? '0.0.0.0' } = {}) {
  const rooms = new Rooms();
  const server = createServer(createApp({ rooms, allowedOrigins: ALLOW_ORIGIN }));
  const sweeper = setInterval(() => rooms.sweep(), 10 * 60 * 1000);
  sweeper.unref();
  server.listen(port, host, () => {
    console.log(`Avalon listening on http://${host}:${port}`);
    if (ALLOW_ORIGIN.length) console.log(`Cross-origin front ends allowed: ${ALLOW_ORIGIN.join(', ')}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
