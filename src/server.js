// Zero-dependency HTTP server: static files, a JSON action endpoint and an
// SSE stream per player. State lives in memory only.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameError } from './rules.js';
import { Rooms } from './rooms.js';
import * as game from './game.js';

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
  '.json': 'application/json; charset=utf-8',
};

/** Every action a client may send, and what it does to the game. */
const ACTIONS = {
  options:   (g, id, body) => game.setOptions(g, id, body.options ?? {}),
  start:     (g, id) => game.startGame(g, id),
  confirm:   (g, id) => game.confirmRole(g, id),
  propose:   (g, id, body) => game.proposeTeam(g, id, body.team ?? []),
  vote:      (g, id, body) => game.castVote(g, id, body.approve === true),
  card:      (g, id, body) => game.playCard(g, id, body.success !== false),
  assassinate: (g, id, body) => game.assassinate(g, id, body.target),
  leave:     (g, id) => game.removePlayer(g, id),
  again:     (g, id) => game.resetToLobby(g, id),
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
    return json(res, 200, { ok: true, service: 'avalon', rooms: rooms.rooms.size });
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    return json(res, 200, { code: rooms.create() });
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
    rooms.apply(code, (g) => game.addPlayer(g, { id: playerId, name: body.name }));
    return json(res, 200, { playerId, code });
  }

  if (req.method === 'POST' && tail === 'action') {
    const body = await readJson(req);
    const action = ACTIONS[body.type];
    if (!action) return json(res, 400, { error: 'unknownAction', params: { type: body.type } });
    if (typeof body.playerId !== 'string') return json(res, 400, { error: 'notInGame' });
    rooms.apply(code, (g) => {
      if (!g.players.some((p) => p.id === body.playerId)) throw new GameError('notInGame');
      return action(g, body.playerId, body);
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'notFound' });
}

function stream(rooms, req, res, code, playerId) {
  if (!playerId) return json(res, 400, { error: 'notInGame' });
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
