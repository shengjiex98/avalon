import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_PROTOCOL } from '../contracts/api-protocol.ts';
import { STATE_VERSION } from '../contracts/state-version.ts';
import { logTone } from './logging.ts';
import type { LogView, OperationalLogRecord, RecentLogs } from './logging.ts';
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
  logs: RecentLogs;
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
  logs,
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
    const logView = parseLogView(url.searchParams.get('view'));
    const logLimit = parseLogLimit(url.searchParams.get('limit'));

    if (url.pathname === '/api/status') {
      json(res, 200, status, req.method === 'HEAD');
      return;
    }
    if (url.pathname === '/api/logs') {
      json(res, 200, {
        view: logView,
        limit: logLimit,
        records: logs.recent(logView, logLimit),
      }, req.method === 'HEAD');
      return;
    }
    if (url.pathname !== '/') {
      plain(res, 404, 'Not found', req.method === 'HEAD');
      return;
    }

    const body = renderAdmin(
      status,
      normalizedLogin,
      logs.recent(logView, logLimit),
      logView,
      logLimit,
    );
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

function parseLogView(input: string | null): LogView {
  return input === 'problems' || input === 'requests' || input === 'all' ? input : 'activity';
}

function parseLogLimit(input: string | null): number {
  const limit = Number(input);
  return limit === 25 || limit === 100 ? limit : 50;
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

const LOG_VIEWS: ReadonlyArray<{ value: LogView; label: string }> = [
  { value: 'activity', label: 'Activity' },
  { value: 'problems', label: 'Problems' },
  { value: 'requests', label: 'Requests' },
  { value: 'all', label: 'All' },
];

function logHref(view: LogView, limit: number): string {
  return `/?view=${view}&amp;limit=${limit}#logs`;
}

function renderLog(record: OperationalLogRecord): string {
  const tone = logTone(record);
  const label = tone === 'ok' ? 'OK' : tone.toUpperCase();
  const fields = Object.entries(record.fields).map(([key, value]) => (
    `<span class="field"><span class="field-key">${escapeHtml(key)}</span> ${escapeHtml(value)}</span>`
  )).join('');
  return `<li class="log ${tone}">
      <div class="log-head"><span class="badge">${label}</span><code class="event">${escapeHtml(record.event)}</code><time datetime="${escapeHtml(record.time)}">${escapeHtml(record.time)}</time></div>
      ${fields ? `<div class="fields">${fields}</div>` : ''}
    </li>`;
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
}, login: string, logs: OperationalLogRecord[], logView: LogView, logLimit: number): string {
  const rows = status.rooms.length ? status.rooms.map((room) => `<tr>
      <td><code>${escapeHtml(room.code)}</code></td>
      <td>${escapeHtml(room.game)}</td>
      <td><span class="phase">${escapeHtml(room.phase)}</span></td>
      <td>${room.players}</td>
      <td>${room.connections}</td>
      <td><time datetime="${escapeHtml(room.touchedAt)}">${escapeHtml(room.touchedAt)}</time></td>
    </tr>`).join('') : '<tr><td class="empty" colspan="6">No rooms</td></tr>';
  const logRows = logs.length
    ? logs.map(renderLog).join('')
    : '<li class="empty log-empty">No matching logs in this process</li>';
  const viewLinks = LOG_VIEWS.map(({ value, label }) => (
    `<a class="filter${value === logView ? ' active' : ''}" href="${logHref(value, logLimit)}"${value === logView ? ' aria-current="page"' : ''}>${label}</a>`
  )).join('');
  const limitLinks = [25, 50, 100].map((limit) => (
    `<a class="filter${limit === logLimit ? ' active' : ''}" href="${logHref(logView, limit)}"${limit === logLimit ? ' aria-current="page"' : ''}>${limit}</a>`
  )).join('');
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
    h2 { margin: 0; font-size: 1.15rem; }
    .section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 28px 0 12px; }
    .card, .table-wrap, .logs { border: 1px solid #2b3242; border-radius: 12px; background: #171c26; }
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
    .controls, .filter-group { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .filter-group + .filter-group { margin-left: 10px; }
    .filter-label { color: #69758d; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
    .filter { padding: 5px 9px; border: 1px solid #343d51; border-radius: 8px; color: #aeb8ca; font-size: .82rem; text-decoration: none; }
    .filter:hover { border-color: #6aaee8; color: #edf0f7; }
    .filter.active { border-color: #4f9bd7; background: #183651; color: #d9efff; }
    .logs { list-style: none; margin: 0; padding: 0; overflow: hidden; }
    .log { padding: 12px 14px; border-left: 4px solid #58657b; border-bottom: 1px solid #2b3242; }
    .log:last-child { border-bottom: 0; }
    .log.info { border-left-color: #6aaee8; }
    .log.ok { border-left-color: #4fc38a; }
    .log.warn { border-left-color: #e7ad45; background: #211d17; }
    .log.error { border-left-color: #ef6b73; background: #24181d; }
    .log-head { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
    .log-head time { margin-left: auto; color: #7f8aa0; font-size: .78rem; }
    .badge { min-width: 3.8rem; padding: 3px 6px; border: 1px solid currentColor; border-radius: 999px; color: #96a5bc; font-size: .68rem; font-weight: 750; letter-spacing: .06em; text-align: center; }
    .ok .badge { color: #65d69e; }
    .warn .badge { color: #f0bd5d; }
    .error .badge { color: #ff858c; }
    .event { color: #dce8f8; font-weight: 650; }
    .fields { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 8px 0 0 4.4rem; color: #aeb8ca; font: .78rem ui-monospace, SFMono-Regular, Consolas, monospace; }
    .field-key { color: #728199; }
    .log-empty { border: 0; }
    footer { margin-top: 16px; color: #69758d; font-size: .82rem; }
    @media (max-width: 640px) { .log-head time { width: 100%; margin-left: 4.4rem; } .fields { margin-left: 0; } }
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
  <div class="section-head"><h2>Rooms</h2></div>
  <div class="table-wrap"><table>
    <thead><tr><th>Room</th><th>Game</th><th>Phase</th><th>Players</th><th>Connections</th><th>Last activity</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <section id="logs" aria-labelledby="logs-heading">
    <div class="section-head">
      <h2 id="logs-heading">Recent logs</h2>
      <nav class="controls" aria-label="Log controls">
        <span class="filter-group"><span class="filter-label">Show</span>${viewLinks}</span>
        <span class="filter-group"><span class="filter-label">Rows</span>${limitLinks}</span>
      </nav>
    </div>
    <ol class="logs">${logRows}</ol>
  </section>
  <footer>Protocol ${status.protocol} · State ${status.stateVersion} · refreshes every 5 seconds</footer>
</main>
</body>
</html>`;
}
