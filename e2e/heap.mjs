/**
 * Memory soak check: runs the production build in demo mode and samples the JS
 * heap (after a forced GC) and DOM node count at intervals.
 *
 *   HEAP_MINUTES=10 node e2e/heap.mjs
 *
 * Passes when the post-warm-up heap does not keep growing (last sample within
 * 25 % + 3 MB of the first post-warm-up sample).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'sentinel-live', 'browser');
const PORT = Number(process.env.SMOKE_PORT ?? 4310);
const MINUTES = Number(process.env.HEAP_MINUTES ?? 10);
const SAMPLE_MS = Number(process.env.HEAP_SAMPLE_MS ?? 30_000);
const WARMUP_MS = 60_000;
const BASE = '/sentinel-live/';

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_PATH;
    if (!dir) throw new Error('playwright-core not found: set PLAYWRIGHT_CORE_PATH');
    return import(pathToFileURL(createRequire(join(dir, 'noop.js')).resolve('playwright-core')).href);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (!path.startsWith(BASE)) return res.writeHead(404).end();
  const rel = decodeURIComponent(path.slice(BASE.length)) || 'index.html';
  let file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST)) return res.writeHead(403).end();
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(rel)) return res.writeHead(404).end();
    file = join(DIST, 'index.html');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(PORT, ok));

const pw = await loadPlaywright();
const chromium = pw.chromium ?? pw.default?.chromium;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await page.goto(`http://localhost:${PORT}${BASE}?demo=1&op=a`);
await page.waitForSelector('[data-testid=sim-badge]');
// Exercise the chat too, so its buffers are part of the soak.
await page.click('[data-testid=chat-toggle]');

const samples = [];
const started = Date.now();
const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
while (Date.now() - started < MINUTES * 60_000) {
  await page.waitForTimeout(SAMPLE_MS);
  if (Date.now() - started > WARMUP_MS && samples.length % 4 === 0) {
    await page.fill('#chat-input', `soak check ${samples.length}`);
    await page.keyboard.press('Enter');
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const nodes = metrics.find((m) => m.name === 'Nodes')?.value ?? 0;
  const t = Math.round((Date.now() - started) / 1000);
  samples.push({ t, used: usedSize, nodes });
  console.log(`t=${String(t).padStart(4)}s heap=${fmt(usedSize)} nodes=${nodes}`);
}
await browser.close();
server.close();

const steady = samples.filter((s) => s.t * 1000 > WARMUP_MS);
const first = steady[0] ?? samples[0];
const last = samples.at(-1);
const peak = Math.max(...steady.map((s) => s.used));
const ok = last.used <= first.used * 1.25 + 3 * 1024 * 1024;
console.log(
  `\nafter warm-up: first ${fmt(first.used)}, last ${fmt(last.used)}, peak ${fmt(peak)}; DOM nodes ${first.nodes} → ${last.nodes}`,
);
console.log(ok ? 'PASS: no sustained heap growth' : 'FAIL: heap keeps growing');
process.exit(ok ? 0 : 1);
