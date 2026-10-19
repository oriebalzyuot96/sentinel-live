/**
 * Playwright smoke test (plain ESM, no test runner).
 *
 *   npm run build && npm run server:build && node e2e/smoke.mjs
 *
 * Uses `playwright-core` from node_modules if installed, otherwise from
 * PLAYWRIGHT_CORE_PATH (a node_modules folder containing playwright-core).
 * Chromium must be installed for that playwright-core version.
 *
 * Scenarios
 *  1. Demo mode (?demo=1) at 1280 px and 390 px: events arrive, alerts render,
 *     simulated operator chats back, no console errors, no horizontal overflow.
 *  2. Static hosting without a server: automatic fallback to the simulator.
 *  3. Real local server: two browser contexts as Operator A and Operator B chat
 *     live; a mention and an alert assignment raise notifications on the other side.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'sentinel-live', 'browser');
const SHOTS = join(ROOT, 'screenshots');
const STATIC_PORT = Number(process.env.SMOKE_PORT ?? 4310);
const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8787);
const BASE = '/sentinel-live/';
/** Extra time before dashboard screenshots so charts have history (e.g. SMOKE_SETTLE_MS=40000). */
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS ?? 2500);

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_PATH;
    if (!dir) throw new Error('playwright-core not found: npm i -D playwright-core, or set PLAYWRIGHT_CORE_PATH');
    const req = createRequire(join(dir, 'noop.js'));
    return import(pathToFileURL(req.resolve('playwright-core')).href);
  }
}

const failures = [];
const passes = [];
function check(cond, msg) {
  (cond ? passes : failures).push(msg);
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
}

// --- static server (what GitHub Pages would do: files only, no ws, no api) -----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
function startStatic() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (!path.startsWith(BASE)) {
      res.writeHead(404).end();
      return;
    }
    let rel = decodeURIComponent(path.slice(BASE.length)) || 'index.html';
    let file = normalize(join(DIST, rel));
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(rel)) return res.writeHead(404).end();
      file = join(DIST, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(STATIC_PORT, () => ok(server)));
}

// --- helpers -------------------------------------------------------------------
async function open(browser, url, { width, height, mobile = false, allow = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page, errors };
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const alertCount = (page) => page.locator('app-alert-feed li.alert').count();
const shot = (page, name, fullPage = true) => page.screenshot({ path: join(SHOTS, name), fullPage });

async function demoScenario(browser, origin, width, height, mobile, tag) {
  console.log(`\n▶ demo mode @ ${width}px`);
  const { context, page, errors } = await open(browser, `${origin}${BASE}?demo=1&op=a`, { width, height, mobile });
  await page.waitForSelector('[data-testid=sim-badge]', { timeout: 15_000 });
  check(true, 'simulated feed badge visible');
  await page.waitForFunction(() => document.querySelectorAll('app-alert-feed li.alert').length > 0, null, { timeout: 60_000 });
  check((await alertCount(page)) > 0, `alerts appear in the feed (${await alertCount(page)})`);
  await page.waitForFunction(
    () => Number(document.querySelector('app-kpi-strip app-counter')?.textContent?.replace(/\D/g, '') || 0) > 0,
    null,
    { timeout: 10_000 },
  );
  check(true, 'objects-tracked KPI is live');
  await page.waitForTimeout(SETTLE_MS);
  check(await noOverflow(page), 'no horizontal overflow (dashboard)');
  // Off-screen tiles skip rendering; bring each into view once so the full-page capture shows them.
  for (const tile of await page.locator('.tile').all()) {
    await tile.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `${tag}.png`);

  // Chat with the simulated operator.
  await page.click('[data-testid=chat-toggle]');
  await page.waitForSelector('.chat .presence__item', { timeout: 10_000 });
  await page.waitForSelector('[data-testid=sim-operator-badge]', { timeout: 10_000 });
  check(true, 'simulated operator badge visible');
  await page.fill('#chat-input', 'Any update on Platform B?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg--mine .ticks[data-status=read]', { timeout: 15_000 });
  check(true, 'own message reaches "read" (receipts from simulated operator)');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg:not(.msg--mine) .msg__text')].some((e) => e.textContent.includes('Checking the feed')), null, { timeout: 15_000 });
  check(true, 'simulated operator replied');
  check(await noOverflow(page), 'no horizontal overflow (chat open)');
  await shot(page, `${tag}-chat.png`, false);
  await page.click('.chat__head button[aria-label="Close"]');

  if (!mobile) {
    // Focus view with heatmap.
    await page.locator('.tile__btn').first().click();
    await page.waitForSelector('dialog.modal[open] app-camera-canvas', { timeout: 5_000 });
    await page.getByRole('button', { name: 'Heatmap' }).click();
    await page.waitForTimeout(1500);
    await shot(page, `${tag}-focus.png`, false);
    await page.keyboard.press('Escape');
    check(true, 'focus view opens with heatmap overlay');

    // Arabic / RTL.
    await page.click('button.lang');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    await page.waitForTimeout(800);
    check(await noOverflow(page), 'RTL (Arabic) layout has no horizontal overflow');
    await shot(page, `${tag}-ar.png`);
    await page.click('button.lang');
  } else {
    await page.click('button.lang');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    check(await noOverflow(page), 'RTL at 390px has no horizontal overflow');
    await shot(page, `${tag}-ar.png`, false);
    await page.click('button.lang');
  }
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await context.close();
}

async function fallbackScenario(browser, origin) {
  console.log('\n▶ static hosting without a server → automatic simulator fallback');
  // The failed WebSocket probe itself is expected to log a network error.
  const allow = [/WebSocket/i, /Failed to load resource/i, /ERR_/];
  const { context, page, errors } = await open(browser, `${origin}${BASE}`, { width: 1280, height: 800, allow });
  await page.waitForSelector('[data-testid=sim-badge]', { timeout: 20_000 });
  const reason = await page.locator('app-connection-panel .status__text').textContent();
  check(/unreachable/i.test(reason ?? ''), 'falls back to the in-browser simulator when ws cannot connect');
  await page.waitForFunction(() => document.querySelectorAll('app-alert-feed li.alert').length > 0, null, { timeout: 60_000 });
  check(true, 'fallback feed produces alerts');
  check(errors.length === 0, `no unexpected console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await context.close();
}

async function crossTabScenario(browser, origin) {
  console.log('\n▶ static demo: two tabs chat through BroadcastChannel (no server)');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const pages = [];
  for (const op of ['a', 'b']) {
    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${origin}${BASE}?demo=1&op=${op}`);
    await page.waitForSelector('[data-testid=sim-badge]', { timeout: 15_000 });
    pages.push(page);
  }
  const [a, b] = pages;
  await a.click('[data-testid=chat-toggle]');
  await b.click('[data-testid=chat-toggle]');
  // Presence heartbeats are mirrored every 5 s.
  await a.waitForSelector('.presence__item:has-text("Operator B")', { timeout: 15_000 });
  check(true, 'tab A sees Operator B (other tab) in presence');
  await a.fill('#chat-input', 'Hello from tab A');
  await a.keyboard.press('Enter');
  await b.waitForSelector('.msg__text:has-text("Hello from tab A")', { timeout: 10_000 });
  check(true, 'tab B receives tab A’s message without a server');
  await a.waitForSelector('.msg--mine .ticks[data-status=read]', { timeout: 10_000 });
  check(true, 'tab A gets a read receipt from tab B');
  check(errors.length === 0, `no console errors (cross-tab)${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await context.close();
}

async function liveScenario(browser) {
  console.log('\n▶ real local server: Operator A ↔ Operator B');
  const origin = `http://localhost:${SERVER_PORT}`;
  const child = spawn(process.execPath, [join(ROOT, 'server', 'dist', 'index.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(SERVER_PORT), SEED: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`  (server pid ${child.pid})`);
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${origin}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const cams = await (await fetch(`${origin}${BASE}api/cameras`)).json();
    check(cams.cameras?.length === 6, 'REST GET /api/cameras returns 6 cameras');

    const a = await open(browser, `${origin}${BASE}?op=a`, { width: 1280, height: 860 });
    const b = await open(browser, `${origin}${BASE}?op=b`, { width: 1280, height: 860 });
    await a.page.waitForSelector('.conn-pill[data-kind=live]', { timeout: 15_000 });
    await b.page.waitForSelector('.conn-pill[data-kind=live]', { timeout: 15_000 });
    check(true, 'both operators connected live over WebSocket');

    // A opens chat and waits until B shows as online.
    await a.page.click('[data-testid=chat-toggle]');
    await a.page.waitForSelector('.presence__item[data-status=online]:has-text("Operator B")', { timeout: 15_000 });
    check(true, 'presence: Operator B online in A');
    await a.page.fill('#chat-input', '@Operator B can you check North Gate? 🚨');
    await a.page.keyboard.press('Enter');

    // B (chat closed) gets a mention notification and an unread badge.
    await b.page.waitForSelector('.toast:has-text("mentioned you")', { timeout: 10_000 });
    check(true, 'B receives a mention toast');
    const badge = await b.page.locator('[data-testid=chat-toggle] .count-badge').textContent();
    check(Number(badge) >= 1, `B chat button shows unread count (${badge})`);
    await b.page.click('[data-testid=chat-toggle]');
    await b.page.waitForSelector('.msg__text:has-text("North Gate")', { timeout: 5_000 });
    check(true, 'B sees A’s message in the chat panel');
    await a.page.waitForSelector('.msg--mine .ticks[data-status=read]', { timeout: 10_000 });
    check(true, 'A sees a read receipt after B opened the room');

    // Typing + reply.
    await b.page.type('#chat-input', 'On it, checking now', { delay: 15 });
    await a.page.waitForSelector('.typing:has-text("typing")', { timeout: 5_000 });
    check(true, 'A sees B typing');
    await b.page.keyboard.press('Enter');
    await a.page.waitForSelector('.msg:not(.msg--mine) .msg__text:has-text("On it")', { timeout: 5_000 });
    check(true, 'A receives B’s reply');

    // Alert assignment A → B notifies B in real time.
    await a.page.click('.chat__head button[aria-label="Close"]');
    await a.page.waitForFunction(() => document.querySelectorAll('app-alert-feed li.alert').length > 0, null, { timeout: 30_000 });
    const first = a.page.locator('app-alert-feed li.alert').first();
    await first.locator('.assign > button').click();
    await a.page.click('.assign__menu button:has-text("Operator B")');
    await b.page.waitForSelector('.toast:has-text("assigned you an alert")', { timeout: 10_000 });
    check(true, 'B receives an "assigned you an alert" notification');
    await b.page.click('app-notification-bell .bell');
    await b.page.waitForSelector('#notif-center .item', { timeout: 3_000 });
    const items = await b.page.locator('#notif-center .item').count();
    check(items >= 2, `B notification centre lists ${items} notifications`);
    await b.page.waitForTimeout(400);
    await shot(b.page, 'live-operator-b.png', false);
    await b.page.click('#notif-center button:has-text("Mark all read")');
    await b.page.keyboard.press('Escape');

    // B acknowledges via the alert feed; A sees "Ack by Operator B".
    const assigned = b.page.locator('app-alert-feed li.alert:has-text("Assigned to You")').first();
    await assigned.locator('button:has-text("Acknowledge")').click();
    await a.page.waitForSelector('app-alert-feed .flow--ack:has-text("Operator B")', { timeout: 10_000 });
    check(true, 'A sees the acknowledgement from B in real time');
    await a.page.waitForTimeout(400);
    await shot(a.page, 'live-operator-a.png', false);

    const hist = await (await fetch(`${origin}${BASE}api/chat/general?limit=10`)).json();
    check(hist.messages?.length >= 2, `REST chat history returns ${hist.messages?.length} messages`);

    check(a.errors.length === 0, `no console errors (A)${a.errors.length ? ': ' + a.errors.join(' | ') : ''}`);
    check(b.errors.length === 0, `no console errors (B)${b.errors.length ? ': ' + b.errors.join(' | ') : ''}`);
    await a.context.close();
    await b.context.close();
  } finally {
    child.kill();
  }
}

// --- main -------------------------------------------------------------------------
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('Build missing: run `npm run build` first.');
  process.exit(2);
}
if (!existsSync(join(ROOT, 'server', 'dist', 'index.mjs'))) {
  console.error('Server bundle missing: run `npm run server:build` first.');
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });
const pw = await loadPlaywright();
const chromium = pw.chromium ?? pw.default?.chromium;
const browser = await chromium.launch();
const staticServer = await startStatic();
const origin = `http://localhost:${STATIC_PORT}`;
try {
  await demoScenario(browser, origin, 1280, 800, false, 'desktop-1280');
  await demoScenario(browser, origin, 390, 844, true, 'mobile-390');
  await fallbackScenario(browser, origin);
  await crossTabScenario(browser, origin);
  await liveScenario(browser);
} catch (e) {
  failures.push(String(e?.message ?? e));
  console.error(e);
} finally {
  await browser.close();
  staticServer.close();
}
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
