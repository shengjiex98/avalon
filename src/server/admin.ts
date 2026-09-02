import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_PROTOCOL } from '../contracts/api-protocol.ts';
import { STATE_VERSION } from '../contracts/state-version.ts';
import type { Rooms } from './rooms.ts';

export type RuntimeMetrics = {
  startedAt: number;
  snapshotHealthy: boolean | null;
  sseConnections: number;
};

type AdminOptions = {
  rooms: Rooms;
  allowedUsers: ReadonlySet<string>;
  metrics: RuntimeMetrics;
  deployedCommit?: string | null;
  now?: () => number;
};

export function parseAdminUsers(input: string | undefined): Set<string> {
  return new Set((input ?? '').split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

export function createAdminApp({
  rooms,
  allowedUsers,
  metrics,
  deployedCommit = null,
  now = Date.now,
}: AdminOptions) {
  return function handleAdmin(req: IncomingMessage, res: ServerResponse): void {
    const login = req.headers['tailscale-user-login'];
    const normalizedLogin = typeof login === 'string' ? login.trim().toLowerCase() : '';
    securityHeaders(res);
    if (!normalizedLogin || !allowedUsers.has(normalizedLogin)) {
      plain(res, 403, 'Forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://admin.local');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      plain(res, 405, 'Method not allowed', req.method === 'HEAD');
      return;
    }

    const status = {
      service: 'avalon',
      commit: deployedCommit,
      protocol: API_PROTOCOL,
      stateVersion: STATE_VERSION,
      uptimeSeconds: Math.max(0, Math.floor((now() - metrics.startedAt) / 1000)),
      snapshot: metrics.snapshotHealthy === null ? 'unknown'
        : metrics.snapshotHealthy ? 'healthy' : 'failed',
      sseConnections: metrics.sseConnections,
      activeGames: rooms.activeGameCount(),
      rooms: rooms.adminSummary(),
    };

    if (url.pathname === '/api/status') {
      json(res, 200, status, req.method === 'HEAD');
      return;
    }
    if (url.pathname !== '/') {
      plain(res, 404, 'Not found', req.method === 'HEAD');
      return;
    }

    const body = renderAdmin(status, normalizedLogin);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
}

function json(res: ServerResponse, status: number, payload: unknown, head = false): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

function plain(res: ServerResponse, status: number, body: string, head = false): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function renderAdmin(status: {
  commit: string | null;
  protocol: number;
  stateVersion: number;
  uptimeSeconds: number;
  snapshot: string;
  sseConnections: number;
  activeGames: number;
  rooms: ReturnType<Rooms['adminSummary']>;
}, login: string): string {
  const rows = status.rooms.length ? status.rooms.map((room) => `<tr>
      <td><code>${escapeHtml(room.code)}</code></td>
      <td>${escapeHtml(room.game)}</td>
      <td><span class="phase">${escapeHtml(room.phase)}</span></td>
      <td>${room.players}</td>
      <td>${room.connections}</td>
      <td><time datetime="${escapeHtml(room.touchedAt)}">${escapeHtml(room.touchedAt)}</time></td>
    </tr>`).join('') : '<tr><td class="empty" colspan="6">No rooms</td></tr>';
  const commit = status.commit ? status.commit.slice(0, 7) : 'development';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Avalon Admin</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #10131a; color: #edf0f7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1120px, calc(100% - 32px)); margin: 40px auto; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: clamp(1.7rem, 4vw, 2.5rem); }
    .identity, .muted { color: #98a2b8; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card, .table-wrap { border: 1px solid #2b3242; border-radius: 12px; background: #171c26; }
    .card { padding: 16px; }
    .label { color: #98a2b8; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 7px; font-size: 1.4rem; font-weight: 650; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 13px 15px; border-bottom: 1px solid #2b3242; text-align: left; white-space: nowrap; }
    th { color: #98a2b8; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
    tr:last-child td { border-bottom: 0; }
    code, .phase { color: #b9e0ff; }
    .empty { padding: 36px; text-align: center; color: #98a2b8; }
    footer { margin-top: 16px; color: #69758d; font-size: .82rem; }
  </style>
</head>
<body>
<main>
  <header><div><h1>Avalon Admin</h1><div class="muted">Read-only runtime console</div></div><div class="identity">${escapeHtml(login)}</div></header>
  <section class="cards" aria-label="Runtime summary">
    <div class="card"><div class="label">Rooms</div><div class="value">${status.rooms.length}</div></div>
    <div class="card"><div class="label">Active games</div><div class="value">${status.activeGames}</div></div>
    <div class="card"><div class="label">Connections</div><div class="value">${status.sseConnections}</div></div>
    <div class="card"><div class="label">Snapshot</div><div class="value">${escapeHtml(status.snapshot)}</div></div>
    <div class="card"><div class="label">Uptime</div><div class="value">${formatAge(status.uptimeSeconds)}</div></div>
    <div class="card"><div class="label">Commit</div><div class="value"><code>${escapeHtml(commit)}</code></div></div>
  </section>
  <div class="table-wrap"><table>
    <thead><tr><th>Room</th><th>Game</th><th>Phase</th><th>Players</th><th>Connections</th><th>Last activity</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <footer>Protocol ${status.protocol} · State ${status.stateVersion} · refreshes every 5 seconds</footer>
</main>
</body>
</html>`;
}
