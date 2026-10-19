/**
 * Sentinel Live demo server.
 *
 *  - WebSocket feed on any path ending in `/ws` (e.g. `/ws`, `/sentinel-live/ws`)
 *  - REST: `GET /api/cameras`, `GET /api/alerts?limit=N`, `GET /api/health`
 *  - Serves the production Angular build under `/sentinel-live/` when present,
 *    so app, REST and WebSocket share one origin.
 *
 * Detections are simulated (see src/shared/simulator.ts). Not a production system.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { CAMERAS } from '../src/shared/cameras';
import { ChatHub, resolveTargets, type HubTarget } from '../src/shared/chat-hub';
import { mulberry32 } from '../src/shared/geometry';
import { isRoomId, makePong, parseClientMessage, type ServerEvent } from '../src/shared/protocol';
import { SimOperator } from '../src/shared/sim-operator';
import { Simulator } from '../src/shared/simulator';

const PORT = Number(process.env['PORT'] ?? 8787);
const CAMERA_COUNT = Math.min(Math.max(Number(process.env['CAMERAS'] ?? CAMERAS.length), 1), CAMERAS.length);
const SEED = Number(process.env['SEED'] ?? Date.now() % 100_000);
const TICK_MS = 100;
const BASE = '/sentinel-live/';
const DIST = resolve(process.cwd(), process.env['DIST'] ?? 'dist/sentinel-live/browser');
/** Drop frame messages for a client whose socket buffer exceeds this (slow consumer). */
const MAX_BUFFERED = 1_000_000;

const sim = new Simulator({ seed: SEED, cameras: CAMERAS.slice(0, CAMERA_COUNT), source: 'server' });

// ---------------------------------------------------------------------------
// Operator chat / alert workflow
// ---------------------------------------------------------------------------
const sockets = new Map<string, WebSocket>();
let nextConn = 1;
let simOperator: SimOperator | null = null;

function deliver(target: HubTarget, ev: ServerEvent) {
  const payload = JSON.stringify(ev);
  for (const id of resolveTargets(target, hub.connectionIds())) {
    if (simOperator && id === simOperator.connId) {
      simOperator.onEvent(ev);
      continue;
    }
    const ws = sockets.get(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

const hub = new ChatHub({ now: Date.now, emit: deliver });

if (process.env['SIM_OPERATOR'] === '1' || process.argv.includes('--sim-operator')) {
  const rand = mulberry32(SEED + 7);
  simOperator = new SimOperator(hub, {
    now: Date.now,
    rand,
    schedule: (fn, ms) => void setTimeout(fn, ms),
    latestAlert: () => sim.recentAlerts(20).find((a) => a.severity === 'high' || a.severity === 'critical') ?? null,
  });
  simOperator.start();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!existsSync(DIST)) return false;
  let rel = pathname.slice(BASE.length);
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(DIST, decodeURIComponent(rel)));
  if (!file.startsWith(DIST)) return false;
  const target = existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(target).pipe(res);
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method-not-allowed' });

  const apiIdx = path.indexOf('/api/');
  if (apiIdx >= 0) {
    const route = path.slice(apiIdx + 4);
    if (route === '/cameras') return json(res, 200, { cameras: sim.cameras });
    if (route === '/alerts') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const alerts = sim.recentAlerts(Number.isFinite(limit) ? limit : 50).map((a) => ({ ...a, ...hub.workflowOf(a.id) }));
      return json(res, 200, { alerts });
    }
    if (route === '/operators') return json(res, 200, { operators: hub.presence() });
    if (route.startsWith('/chat/')) {
      const room = decodeURIComponent(route.slice(6));
      if (!isRoomId(room)) return json(res, 400, { error: 'bad-room' });
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const limit = Number(url.searchParams.get('limit') ?? 30);
      return json(res, 200, hub.history(room, Number.isFinite(before) ? before : Infinity, Number.isFinite(limit) ? limit : 30));
    }
    if (route === '/health') return json(res, 200, { ok: true, clients: wss.clients.size, cameras: sim.cameras.length });
    return json(res, 404, { error: 'not-found' });
  }
  if (path === '/' || path === '/sentinel-live') {
    res.writeHead(302, { location: BASE });
    return res.end();
  }
  if (path.startsWith(BASE) && serveStatic(req, res, path)) return;
  json(res, 404, { error: 'not-found', hint: existsSync(DIST) ? undefined : 'run `npm run build` to serve the app here' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (!path.endsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const connId = `c${nextConn++}`;
  sockets.set(connId, ws);
  hub.connect(connId);
  ws.send(JSON.stringify(sim.hello(Date.now())));
  ws.send(JSON.stringify(hub.presenceEvent()));
  ws.on('message', (data) => {
    const msg = parseClientMessage(data.toString());
    if (!msg) return;
    if (msg.type === 'ping') ws.send(JSON.stringify(makePong(msg, Date.now())));
    else hub.handle(connId, msg);
  });
  ws.on('close', () => {
    sockets.delete(connId);
    hub.disconnect(connId);
  });
});

let presenceTick = 0;
const presenceTimer = setInterval(() => {
  // Presence heartbeat every 10 s (clients expire stale entries); sim operator ticks every second.
  if (++presenceTick % 10 === 0) hub.broadcastPresence();
  simOperator?.tick();
}, 1_000);

let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  const events = sim.step(now - last, now);
  last = now;
  if (!wss.clients.size) return;
  for (const ev of events) {
    const payload = JSON.stringify(ev);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (ev.type === 'frame' && client.bufferedAmount > MAX_BUFFERED) continue;
      client.send(payload);
    }
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`[sentinel] ${CAMERA_COUNT} simulated cameras, seed ${SEED}`);
  console.log(`[sentinel] ws://localhost:${PORT}/ws  ·  http://localhost:${PORT}/api/cameras`);
  if (existsSync(DIST)) console.log(`[sentinel] app: http://localhost:${PORT}${BASE}`);
});

function shutdown() {
  clearInterval(timer);
  clearInterval(presenceTimer);
  for (const c of wss.clients) c.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
