# Sentinel Live

A real-time **video analytics dashboard** demo built with **Angular 22, Signals, RxJS and WebSockets**.
A small Node server streams simulated detections from six synthetic cameras; the Angular client renders
them live on a canvas camera wall, raises alerts, charts them and lets two operators coordinate over a
built-in chat on the same socket.

> **Honest scope:** this is a portfolio demo. Detections, tracks and alerts come from a deterministic
> simulator, and the camera scenes are drawn procedurally on `<canvas>`. No video is decoded and no
> machine-learning model runs. It is not a production video-analytics system.

## What it shows

| Area | What is implemented |
| --- | --- |
| Live feed over WebSockets | `rxjs/webSocket` stream, exponential backoff with jitter, heartbeat ping (RTT), stale-connection watchdog, reconnect countdown |
| REST + WebSocket together | `GET /api/cameras`, `GET /api/alerts?limit=`, `GET /api/chat/:room?before=` seed and page data, WebSocket carries the live events |
| AI insights visualised | Tracked objects with bounding boxes, track ids, confidence, motion trails, zones and tripwires, per-camera heatmap |
| Alerts | Intrusion, loitering, crowding, abandoned object, line crossing; severity colours, filters (severity / type / camera / assignee), acknowledge, assign, mute rules, sound cue |
| Charts (no chart library) | Per-class sparklines (60 s), alert timeline (5 min, stacked by severity), occupancy heatmap, KPI micro-sparklines; all SVG |
| State management | Signals for view state, RxJS for the stream (`bufferTime` batching, `groupBy` + `debounceTime` receipts, `retry` with backoff), pure reducers for alerts and chat. No NgRx. |
| Operator chat | Two operators, general room plus one room per alert, presence, typing indicator, delivered/read receipts, unread counters, emoji, optimistic send with idempotent resend after reconnect, REST history |
| Notifications | Toasts, notification centre (bell, unread count, mark all read), optional desktop notifications (permission requested only on click), sound cue behind a mute toggle |
| Demo mode | Same simulator and chat hub run in a Web Worker speaking the identical protocol; a scripted second operator; cross-tab chat via `BroadcastChannel` |
| UX quality | Dark control-room design system in plain SCSS (tokens, glass, grid), EN / AR with full RTL, keyboard accessible, `prefers-reduced-motion`, responsive to 360 px |
| Performance | OnPush + signals everywhere, one shared `requestAnimationFrame` loop, off-screen canvases skipped, bounded ring buffers, heap soak test |

## Architecture

```
                         src/shared/  (one protocol, used by every side)
        ┌───────────────────────────────────────────────────────────────────┐
        │ protocol.ts   typed events + validation, PROTOCOL_VERSION = 1      │
        │ simulator.ts  deterministic multi-camera scenes + alert rules      │
        │ chat-hub.ts   operators, rooms, receipts, alert workflow           │
        │ sim-operator.ts  scripted second operator (demo)                   │
        └───────────────┬───────────────────────────────┬───────────────────┘
                        │                               │
   server/index.ts (Node + ws, :8787)         src/app/core/demo-engine.ts
   ├─ WS  /ws         events ⇄ client msgs     (runs in a Web Worker,
   ├─ GET /api/cameras | /api/alerts           identical JSON protocol)
   ├─ GET /api/chat/:room?before=                     │
   └─ serves dist/ at /sentinel-live/                 │  BroadcastChannel
                        │                             │  (peer tabs replay
                        ▼                             ▼   each other's msgs)
        ┌───────────────────────────────────────────────────────────────────┐
        │ FeedService   SocketSource | SimulatorSource  → events$, display$  │
        │               backoff · heartbeat · pause · 30 s replay ring       │
        ├──────────────┬──────────────────┬─────────────────┬───────────────┤
        │ AnalyticsStore│ ChatStore         │ WorkflowService │ Notification │
        │ signals, KPIs │ reducer, outbox,  │ ack / assign    │ Service      │
        │ SceneState    │ receipts, typing  │ mirrored live   │ toasts, bell │
        └──────┬───────┴─────────┬─────────┴────────┬────────┴───────────────┘
               ▼                 ▼                  ▼
     Camera wall (canvas, rAF)  Chat panel   Alert feed · KPIs · SVG charts
```

Message types: `hello`, `frame`, `alert`, `stats`, `pong`, `welcome`, `presence`, `chat:message`,
`chat:typing`, `chat:receipt`, `alert:assigned`, `alert:acked` (server → client) and `ping`, `join`,
`presence`, `chat:send`, `chat:typing`, `chat:receipt`, `alert:assign`, `alert:ack` (client → server).
Every message carries `v` (protocol version); anything that fails validation is dropped.

## Run it

Requires Node 20+ (developed on Node 24).

```bash
npm install

# Option A: development (two terminals)
npm run server          # WebSocket + REST on http://localhost:8787
npm start               # Angular dev server on http://localhost:4310 (proxies /ws and /api)

# Option B: production build served by the Node server (same origin)
npm run build           # → dist/sentinel-live/browser, base href /sentinel-live/
npm run server          # open http://localhost:8787/sentinel-live/
```

`npm run server:sim` starts the server with the scripted second operator connected as well.

### Two operators

Open the app twice, for example `http://localhost:8787/sentinel-live/?op=a` and `…/?op=b`
(or pick an identity from the operator chip in the chat panel; a second tab without `?op=`
automatically takes the free identity). Messages, typing, receipts, presence, alert assignment and
acknowledgement are mirrored between the two in real time. No passwords and no accounts: this is a
demo identity picker, not authentication.

## Demo mode (static hosting)

GitHub Pages and other static hosts have no WebSocket server, so the client can run the **same
simulator and chat hub inside a Web Worker** speaking the identical JSON protocol.

- **Automatic:** if the WebSocket cannot connect on the first attempt, the client falls back to the
  simulator. (Once a live connection has existed, a drop instead shows *reconnecting* with a backoff
  countdown.)
- **Forced:** add `?demo=1` to the URL.
- **Static build:** `npm run build:pages` produces `dist/pages/browser` that starts directly in demo
  mode (no server probe, so no network errors in the console). Base href is `/sentinel-live/`; use
  `ng build --configuration pages --base-href /other-path/` to change it.

In demo mode the header shows a **Simulated feed** badge, and the chat shows a **Simulated operator**
badge for the scripted colleague, who reads your messages, types, replies, acknowledges alerts you
assign to them and occasionally hands an alert to you with an @mention. Two tabs of the same browser
can also chat with each other through `BroadcastChannel`; the scripted operator stays quiet while a
real peer tab is present.

### URL parameters

| Parameter | Effect |
| --- | --- |
| `?demo=1` | Force the in-browser simulator |
| `?live=1` | Live server only; keep retrying with backoff, never fall back |
| `?op=a` / `?op=b` | Operator identity for this tab |
| `?lang=ar` | Start in Arabic (RTL) |
| `?ws=wss://host/ws`, `?api=https://host/api/` | Override endpoints |

## Tests

```bash
npm test                # unit tests (Vitest via the Angular unit-test builder)
npm run e2e             # build + Playwright smoke test (see below)
npm run heap            # 10-minute memory soak on the production build
```

**Unit tests** cover protocol parsing and validation, the simulator (determinism, cadence, bounds,
alert generation), the backoff function, the ring buffer, the alerts reducer (dedupe, bounds, ack,
assign, mute, filters, timeline buckets), the chat reducer (receipts, unread counts, typing, presence
TTL, history merge, bounds), the chat store's reconnect resend and ack timeout, the chat hub
(dedupe by clientId, receipts, history paging, room eviction, workflow), the scripted operator, the
Web Worker engine (including cross-tab peer replay) and the chart helpers.

**Smoke test** (`e2e/smoke.mjs`, plain ESM on `playwright-core`) runs the production build:

1. demo mode at 1280 px and 390 px: events and alerts arrive, the simulated operator chats back with
   receipts, focus view + heatmap, Arabic RTL; no console errors, no horizontal overflow;
2. a static server with no backend: automatic fallback to the simulator;
3. the real Node server with two browser contexts as Operator A and B: presence, @mention toast,
   unread badge, read receipt, typing indicator, reply, alert assignment notification, real-time
   acknowledgement, REST chat history.

Screenshots are written to `screenshots/` (git-ignored). If `@playwright/test` is not installed, point
`PLAYWRIGHT_CORE_PATH` at a `node_modules` folder that contains `playwright-core` with Chromium.

## Performance notes

- Frames (60 messages/s for six cameras) never touch signals: they update mutable, bounded
  `SceneState` objects that the canvas loop reads. Signals change at most a few times per second.
- One shared `requestAnimationFrame` loop; tiles render at up to 30 fps, the focus view at 60 fps;
  off-screen canvases are skipped (IntersectionObserver); backgrounds are pre-rendered per size.
- Alerts are batched with `bufferTime(250)`; every list, trail, heat grid, chat room and the replay
  ring buffer has a fixed upper bound.
- The server drops `frame` messages for a slow client (`bufferedAmount` check) but never alerts.
- `npm run heap` samples the JS heap after forced GC for ten minutes and fails on sustained growth.

## Accessibility and i18n

- English and Arabic with full RTL (logical CSS properties throughout; camera images are not mirrored).
- All controls are native buttons, inputs and `<dialog>` elements; visible focus rings; skip link.
- Alert feed and chat are labelled regions; critical alerts are announced through a live region.
- Colour tokens meet WCAG AA contrast on the dark surfaces; motion respects `prefers-reduced-motion`.

## Project layout

```
server/index.ts               Node ws + REST server (bundled with esbuild)
src/shared/                   protocol, simulator, chat hub, scripted operator (server + client)
src/app/core/                 feed service, sources, stores, reducers, i18n, sound, notifications
src/app/workers/sim.worker.ts demo-mode worker
src/app/ui/                   camera wall + canvas renderer, alerts, charts, chat, notifications
src/styles/                   design system: tokens, base, components
e2e/                          Playwright smoke test and heap soak
```

## Limitations

- Detections are simulated; there is no video pipeline or model.
- Chat history and alert workflow live in server memory (bounded) and reset on restart.
- Operator identities are not authenticated.
- In cross-tab demo mode each tab runs its own simulator, so camera feeds differ between tabs; chat
  and alert workflow messages are shared.
- Automated browser tests run on Chromium. The code avoids engine-specific APIs (module workers,
  `<dialog>`, `BroadcastChannel`, container queries are supported in current Chrome, Edge, Firefox and
  Safari), but Firefox and Safari were not exercised by the automated tests here.

## License

Copyright © 2026 Orieb Alzyuot. All rights reserved. See [LICENSE](LICENSE).
