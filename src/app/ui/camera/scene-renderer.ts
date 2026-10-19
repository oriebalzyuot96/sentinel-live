/**
 * Procedural CCTV-style scene rendering on <canvas>. Everything is drawn from
 * code: perspective backgrounds, silhouettes, overlays. No video or images.
 */
import { HORIZON, mulberry32 } from '../../../shared/geometry';
import type { CameraInfo, ObjectClass, TrackedObject } from '../../../shared/protocol';
import { HEAT_H, HEAT_W, SceneState } from '../../core/scene-state';

export interface RenderOptions {
  heatmap: boolean;
  trails: boolean;
  overlays: boolean;
  /** Larger labels for the focus view. */
  detail: boolean;
  reducedMotion: boolean;
  clock: string;
}

export const CLASS_COLOR: Record<ObjectClass, string> = {
  person: '#2ee6c5',
  vehicle: '#ffc857',
  bag: '#c49bff',
};
const ALERT_COLOR = '#ff4d6d';
const ZONE_COLOR = '255,122,61';
const LINE_COLOR = '#5cc8ff';
const MONO = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Cached layers (one background + one post layer per camera, rebuilt on resize)
// ---------------------------------------------------------------------------

interface Cached {
  w: number;
  h: number;
  bg: Canvas;
  post: Canvas;
}
const cache = new Map<string, Cached>();
let noise: Canvas | null = null;
let heatCanvas: Canvas | null = null;
let palette: Uint8ClampedArray | null = null;

function layers(cam: CameraInfo, w: number, h: number): Cached {
  const hit = cache.get(cam.id);
  if (hit && hit.w === w && hit.h === h) return hit;
  const bg = makeCanvas(w, h);
  drawBackground(bg.getContext('2d') as Ctx, cam, w, h);
  const post = makeCanvas(w, h);
  drawPost(post.getContext('2d') as Ctx, w, h);
  const entry = { w, h, bg, post };
  cache.set(cam.id, entry);
  return entry;
}

function noiseTile(): Canvas {
  if (noise) return noise;
  noise = makeCanvas(128, 128);
  const ctx = noise.getContext('2d') as Ctx;
  const img = ctx.createImageData(128, 128);
  const r = mulberry32(99);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(r() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return noise;
}

function drawPost(ctx: Ctx, w: number, h: number) {
  // Scanlines.
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  // Vignette.
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function vGrad(ctx: Ctx, y0: number, y1: number, c0: string, c1: string) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, c0);
  g.addColorStop(1, c1);
  return g;
}

function drawBackground(ctx: Ctx, cam: CameraInfo, w: number, h: number) {
  const r = mulberry32(hash(cam.id));
  const hy = HORIZON * h;
  const vx = w * (0.45 + r() * 0.1);
  ctx.fillStyle = vGrad(ctx, 0, hy, '#0a1520', '#14283a');
  ctx.fillRect(0, 0, w, hy);
  ctx.fillStyle = vGrad(ctx, hy, h, '#1b2b38', '#0d1821');
  ctx.fillRect(0, hy, w, h - hy);

  const band = (y0: number, y1: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, y0 * h, w, (y1 - y0) * h);
  };
  const perspectiveLines = (y0: number, y1: number, count: number, alpha: number) => {
    ctx.strokeStyle = `rgba(150,190,215,${alpha})`;
    ctx.lineWidth = 1;
    for (let i = -count; i <= count * 2; i++) {
      const xb = (i / count) * w;
      const t0 = (y0 * h - hy) / (h - hy);
      ctx.beginPath();
      ctx.moveTo(vx + (xb - vx) * t0, y0 * h);
      ctx.lineTo(xb, y1 * h);
      ctx.stroke();
    }
  };
  const depthLines = (y0: number, y1: number, n: number, alpha: number) => {
    ctx.strokeStyle = `rgba(150,190,215,${alpha})`;
    for (let i = 1; i <= n; i++) {
      const t = Math.pow(i / n, 1.8);
      const y = (y0 + (y1 - y0) * t) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  };

  switch (cam.scene) {
    case 'street': {
      // Skyline with lit windows.
      let x = 0;
      while (x < w) {
        const bw = w * (0.06 + r() * 0.12);
        const bh = h * (0.1 + r() * 0.24);
        ctx.fillStyle = r() > 0.5 ? '#0d1b27' : '#112231';
        ctx.fillRect(x, hy - bh + h * 0.04, bw - 2, bh);
        for (let wy = hy - bh + h * 0.06; wy < hy; wy += h * 0.035) {
          for (let wx = x + 4; wx < x + bw - 8; wx += w * 0.018) {
            if (r() < 0.32) {
              ctx.fillStyle = `rgba(255,${190 + Math.floor(r() * 40)},120,${0.15 + r() * 0.45})`;
              ctx.fillRect(wx, wy, w * 0.008, h * 0.014);
            }
          }
        }
        x += bw;
      }
      band(0.4, 0.55, '#1e2f3c');
      band(0.55, 0.565, '#33495a');
      band(0.565, 0.745, '#111c26');
      band(0.745, 0.76, '#33495a');
      band(0.76, 1, '#1a2835');
      // Lane dashes.
      ctx.strokeStyle = 'rgba(230,240,245,0.35)';
      ctx.lineWidth = Math.max(1, h * 0.006);
      ctx.setLineDash([w * 0.05, w * 0.04]);
      ctx.beginPath();
      ctx.moveTo(0, 0.655 * h);
      ctx.lineTo(w, 0.655 * h);
      ctx.stroke();
      ctx.setLineDash([]);
      perspectiveLines(0.76, 1, 9, 0.06);
      depthLines(0.76, 1, 6, 0.05);
      // Street lamps.
      for (let i = 0; i < 4; i++) {
        const lx = w * (0.1 + i * 0.27 + r() * 0.05);
        ctx.strokeStyle = '#2a3a48';
        ctx.lineWidth = Math.max(1.5, w * 0.004);
        ctx.beginPath();
        ctx.moveTo(lx, 0.47 * h);
        ctx.lineTo(lx, 0.22 * h);
        ctx.stroke();
        const glow = ctx.createRadialGradient(lx, 0.22 * h, 0, lx, 0.22 * h, h * 0.14);
        glow.addColorStop(0, 'rgba(255,200,120,0.55)');
        glow.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(lx - h * 0.14, 0.08 * h, h * 0.28, h * 0.28);
      }
      break;
    }
    case 'lobby': {
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = i % 2 ? '#132433' : '#16293a';
        ctx.fillRect((i / 14) * w, 0, w / 14, hy + h * 0.06);
      }
      // Glass frontage glow.
      ctx.fillStyle = vGrad(ctx, h * 0.05, hy, 'rgba(92,200,255,0.10)', 'rgba(92,200,255,0.02)');
      ctx.fillRect(w * 0.35, h * 0.05, w * 0.5, hy - h * 0.03);
      band(0.42, 1, '#1d2e3b');
      perspectiveLines(0.42, 1, 10, 0.08);
      depthLines(0.42, 1, 9, 0.07);
      // Reception desk.
      ctx.fillStyle = '#0c1720';
      ctx.fillRect(w * 0.62, h * 0.4, w * 0.3, h * 0.07);
      ctx.fillStyle = 'rgba(46,230,197,0.35)';
      ctx.fillRect(w * 0.62, h * 0.4, w * 0.3, h * 0.006);
      // Ceiling lights.
      for (let i = 0; i < 5; i++) {
        const lx = w * (0.1 + i * 0.2);
        const g = ctx.createRadialGradient(lx, h * 0.04, 0, lx, h * 0.04, h * 0.16);
        g.addColorStop(0, 'rgba(220,240,255,0.35)');
        g.addColorStop(1, 'rgba(220,240,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(lx - h * 0.16, 0, h * 0.32, h * 0.2);
      }
      break;
    }
    case 'parking': {
      band(0, 0.42, '#121e29');
      for (let i = 0; i < 6; i++) {
        const px = w * (0.05 + i * 0.18);
        ctx.fillStyle = '#18293a';
        ctx.fillRect(px, 0, w * 0.035, hy + h * 0.08);
        ctx.fillStyle = 'rgba(255,200,87,0.5)';
        ctx.fillRect(px, hy + h * 0.02, w * 0.035, h * 0.012);
      }
      band(0.42, 1, '#18242f');
      ctx.strokeStyle = 'rgba(230,240,245,0.28)';
      ctx.lineWidth = Math.max(1, h * 0.004);
      for (let i = 0; i < 14; i++) {
        const bx = (i / 13) * w;
        ctx.beginPath();
        ctx.moveTo(bx, 0.43 * h);
        ctx.lineTo(bx - w * 0.02, 0.52 * h);
        ctx.moveTo(bx, 0.84 * h);
        ctx.lineTo(bx - w * 0.05, h);
        ctx.stroke();
      }
      // Lane arrows.
      ctx.fillStyle = 'rgba(230,240,245,0.18)';
      for (const [ly, dir] of [
        [0.6, 1],
        [0.75, -1],
      ] as const) {
        for (let i = 0; i < 3; i++) {
          const ax = w * (0.2 + i * 0.3);
          const s = h * 0.025 * (0.6 + ly * 0.6);
          ctx.beginPath();
          ctx.moveTo(ax + dir * s * 1.6, ly * h);
          ctx.lineTo(ax - dir * s, ly * h - s);
          ctx.lineTo(ax - dir * s, ly * h + s);
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }
    case 'platform': {
      band(0, 0.44, '#122230');
      ctx.fillStyle = 'rgba(46,230,197,0.55)';
      ctx.fillRect(0, h * 0.18, w, h * 0.012);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = '#0b2a33';
        ctx.fillRect(w * (0.08 + i * 0.24), h * 0.08, w * 0.12, h * 0.07);
        ctx.fillStyle = 'rgba(46,230,197,0.8)';
        ctx.font = `700 ${Math.round(h * 0.045)}px ${MONO}`;
        ctx.fillText('B', w * (0.12 + i * 0.24), h * 0.135);
      }
      band(0.44, 0.9, '#22333f');
      perspectiveLines(0.44, 0.9, 12, 0.07);
      depthLines(0.44, 0.9, 7, 0.06);
      band(0.9, 0.915, '#d9b23a');
      band(0.915, 1, '#070d12');
      ctx.strokeStyle = 'rgba(160,180,195,0.5)';
      ctx.lineWidth = Math.max(1, h * 0.006);
      for (const ry of [0.95, 0.985]) {
        ctx.beginPath();
        ctx.moveTo(0, ry * h);
        ctx.lineTo(w, ry * h);
        ctx.stroke();
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Silhouettes
// ---------------------------------------------------------------------------

const PERSON_TONES = ['#4b5a6a', '#5b4b5e', '#4a5e53', '#655946', '#3f4f66', '#5e4a44'];
const VEHICLE_TONES = ['#53687c', '#7a3b3b', '#3d6676', '#6a6a74', '#86704a', '#d5d8dc'];

function drawPerson(ctx: Ctx, o: TrackedObject, X: number, Y: number, W: number, H: number, now: number, still: boolean) {
  const hsh = hash(o.id);
  const tone = PERSON_TONES[hsh % PERSON_TONES.length];
  const cx = X + W / 2;
  const speed = Math.hypot(o.vx, o.vy);
  const phase = still ? 0 : Math.sin(now * 0.006 * (0.6 + speed * 8) + (hsh % 100));
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, Y + H, W * 0.6, Math.max(1, H * 0.035), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'round';
  // Legs.
  ctx.strokeStyle = '#26303a';
  ctx.lineWidth = Math.max(1, W * 0.22);
  const swing = phase * W * 0.28;
  ctx.beginPath();
  ctx.moveTo(cx - W * 0.12, Y + H * 0.55);
  ctx.lineTo(cx - W * 0.12 + swing, Y + H * 0.98);
  ctx.moveTo(cx + W * 0.12, Y + H * 0.55);
  ctx.lineTo(cx + W * 0.12 - swing, Y + H * 0.98);
  ctx.stroke();
  // Arms.
  ctx.strokeStyle = tone;
  ctx.lineWidth = Math.max(1, W * 0.16);
  ctx.beginPath();
  ctx.moveTo(cx - W * 0.32, Y + H * 0.24);
  ctx.lineTo(cx - W * 0.36 - swing * 0.6, Y + H * 0.52);
  ctx.moveTo(cx + W * 0.32, Y + H * 0.24);
  ctx.lineTo(cx + W * 0.36 + swing * 0.6, Y + H * 0.52);
  ctx.stroke();
  // Torso.
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.roundRect(cx - W * 0.34, Y + H * 0.18, W * 0.68, H * 0.4, W * 0.18);
  ctx.fill();
  // Head.
  ctx.fillStyle = '#7d6a5c';
  ctx.beginPath();
  ctx.arc(cx, Y + H * 0.09, Math.max(1, H * 0.075), 0, Math.PI * 2);
  ctx.fill();
  // Rim light.
  ctx.strokeStyle = 'rgba(200,230,245,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(cx - W * 0.34, Y + H * 0.18, W * 0.68, H * 0.4, W * 0.18);
  ctx.stroke();
}

function drawVehicle(ctx: Ctx, o: TrackedObject, X: number, Y: number, W: number, H: number) {
  const hsh = hash(o.id);
  const tone = VEHICLE_TONES[hsh % VEHICLE_TONES.length];
  const dir = o.vx !== 0 ? Math.sign(o.vx) : hsh % 2 ? 1 : -1;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(X + W / 2, Y + H * 0.95, W * 0.55, Math.max(1, H * 0.08), 0, 0, Math.PI * 2);
  ctx.fill();
  // Headlight beam.
  if (o.vx !== 0) {
    const fx = dir > 0 ? X + W : X;
    const g = ctx.createRadialGradient(fx, Y + H * 0.55, 0, fx, Y + H * 0.55, W * 0.6);
    g.addColorStop(0, 'rgba(255,220,150,0.28)');
    g.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(fx, Y + H * 0.5);
    ctx.lineTo(fx + dir * W * 0.6, Y + H * 0.25);
    ctx.lineTo(fx + dir * W * 0.6, Y + H * 0.95);
    ctx.closePath();
    ctx.fill();
  }
  // Cabin.
  ctx.fillStyle = tone;
  ctx.beginPath();
  const c0 = dir > 0 ? 0.18 : 0.28;
  const c1 = dir > 0 ? 0.72 : 0.82;
  ctx.moveTo(X + W * (c0 - 0.04), Y + H * 0.42);
  ctx.lineTo(X + W * (c0 + 0.08), Y + H * 0.08);
  ctx.lineTo(X + W * (c1 - 0.08), Y + H * 0.08);
  ctx.lineTo(X + W * (c1 + 0.06), Y + H * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(120,180,210,0.35)';
  ctx.beginPath();
  ctx.moveTo(X + W * (c0 + 0.03), Y + H * 0.38);
  ctx.lineTo(X + W * (c0 + 0.11), Y + H * 0.14);
  ctx.lineTo(X + W * (c1 - 0.11), Y + H * 0.14);
  ctx.lineTo(X + W * (c1 + 0.02), Y + H * 0.38);
  ctx.closePath();
  ctx.fill();
  // Body.
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.roundRect(X, Y + H * 0.38, W, H * 0.42, H * 0.12);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(X + W * 0.04, Y + H * 0.45, W * 0.92, Math.max(1, H * 0.04));
  // Lights.
  ctx.fillStyle = '#ffe2a0';
  ctx.fillRect(dir > 0 ? X + W - W * 0.04 : X, Y + H * 0.48, W * 0.04, H * 0.1);
  ctx.fillStyle = '#ff4d6d';
  ctx.fillRect(dir > 0 ? X : X + W - W * 0.03, Y + H * 0.48, W * 0.03, H * 0.1);
  // Wheels.
  for (const wx of [0.22, 0.78]) {
    ctx.fillStyle = '#080b0e';
    ctx.beginPath();
    ctx.arc(X + W * wx, Y + H * 0.8, Math.max(1, H * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4a545e';
    ctx.lineWidth = Math.max(1, H * 0.03);
    ctx.stroke();
  }
}

function drawBag(ctx: Ctx, X: number, Y: number, W: number, H: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(X + W / 2, Y + H, W * 0.6, Math.max(1, H * 0.12), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6a5440';
  ctx.beginPath();
  ctx.roundRect(X, Y + H * 0.25, W, H * 0.75, Math.max(1, W * 0.15));
  ctx.fill();
  ctx.strokeStyle = '#3d2f22';
  ctx.lineWidth = Math.max(1, W * 0.08);
  ctx.beginPath();
  ctx.arc(X + W / 2, Y + H * 0.28, W * 0.22, Math.PI, 0);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function drawZones(ctx: Ctx, cam: CameraInfo, w: number, h: number, detail: boolean) {
  const fs = detail ? 12 : 10;
  ctx.font = `600 ${fs}px ${MONO}`;
  for (const z of cam.zones) {
    ctx.beginPath();
    z.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.closePath();
    ctx.fillStyle = `rgba(${ZONE_COLOR},0.10)`;
    ctx.fill();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = `rgba(${ZONE_COLOR},0.85)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    const [lx, ly] = z.polygon[0];
    label(ctx, `▲ ${z.label.toUpperCase()}`, lx * w + 2, ly * h - 3, `rgb(${ZONE_COLOR})`, fs);
  }
  for (const l of cam.lines) {
    const [ax, ay] = l.a;
    const [bx, by] = l.b;
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax * w, ay * h);
    ctx.lineTo(bx * w, by * h);
    ctx.stroke();
    ctx.fillStyle = LINE_COLOR;
    for (const [px, py] of [l.a, l.b]) {
      ctx.beginPath();
      ctx.arc(px * w, py * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    label(ctx, `⇄ ${l.label.toUpperCase()}`, Math.min(ax, bx) * w + 6, Math.min(ay, by) * h + fs + 4, LINE_COLOR, fs);
  }
}

function label(ctx: Ctx, text: string, x: number, y: number, color: string, fs: number) {
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(4,9,14,0.78)';
  ctx.fillRect(x - 3, y - fs, tw + 6, fs + 4);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawTrails(ctx: Ctx, scene: SceneState, w: number, h: number, classOf: Map<string, ObjectClass>) {
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;
  for (const [id, t] of scene.trails) {
    if (t.len < 2) continue;
    const pts = SceneState.points(t);
    const color = CLASS_COLOR[classOf.get(id) ?? 'person'];
    for (let i = 1; i < pts.length; i++) {
      ctx.globalAlpha = (i / pts.length) * 0.75;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0] * w, pts[i - 1][1] * h);
      ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function heatPalette(): Uint8ClampedArray {
  if (palette) return palette;
  palette = new Uint8ClampedArray(256 * 4);
  const stops: [number, number, number, number, number][] = [
    [0, 0, 0, 0, 0],
    [0.15, 46, 230, 197, 70],
    [0.45, 92, 200, 255, 130],
    [0.7, 255, 200, 87, 180],
    [1, 255, 77, 109, 220],
  ];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0, a0] = stops[k];
    const [t1, r1, g1, b1, a1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    palette.set([r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, a0 + (a1 - a0) * f], i * 4);
  }
  return palette;
}

function drawHeat(ctx: Ctx, scene: SceneState, w: number, h: number) {
  if (scene.heatPeak <= 0) return;
  heatCanvas ??= makeCanvas(HEAT_W, HEAT_H);
  const hctx = heatCanvas.getContext('2d') as Ctx;
  const img = hctx.createImageData(HEAT_W, HEAT_H);
  const pal = heatPalette();
  const peak = Math.max(scene.heatPeak, 4);
  for (let i = 0; i < scene.heat.length; i++) {
    const idx = Math.min(255, Math.floor(Math.sqrt(scene.heat[i] / peak) * 255)) * 4;
    img.data[i * 4] = pal[idx];
    img.data[i * 4 + 1] = pal[idx + 1];
    img.data[i * 4 + 2] = pal[idx + 2];
    img.data[i * 4 + 3] = pal[idx + 3];
  }
  hctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = 0.8;
  ctx.drawImage(heatCanvas, 0, 0, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------

/** Render one camera frame into `ctx` (sized w × h device pixels). */
export function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, cam: CameraInfo, scene: SceneState, now: number, opts: RenderOptions): void {
  const { bg, post } = layers(cam, w, h);
  ctx.drawImage(bg, 0, 0);

  const frame = scene.frame;
  const dt = opts.reducedMotion ? 0 : Math.min(0.25, Math.max(0, (now - scene.receivedAt) / 1000));
  const objects = frame ? frame.objects.slice().sort((a, b) => a.bbox.y + a.bbox.h - (b.bbox.y + b.bbox.h)) : [];
  const classOf = new Map<string, ObjectClass>();
  for (const o of objects) classOf.set(o.id, o.cls);

  if (opts.heatmap) drawHeat(ctx, scene, w, h);
  if (opts.overlays) drawZones(ctx, cam, w, h, opts.detail);
  if (opts.trails) drawTrails(ctx, scene, w, h, classOf);

  const fs = opts.detail ? 13 : 10;
  ctx.font = `600 ${fs}px ${MONO}`;
  const pulse = opts.reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(now / 160);
  for (const o of objects) {
    const X = (o.bbox.x + o.vx * dt) * w;
    const Y = (o.bbox.y + o.vy * dt) * h;
    const W = o.bbox.w * w;
    const H = o.bbox.h * h;
    if (o.cls === 'person') drawPerson(ctx, o, X, Y, W, H, opts.reducedMotion ? 0 : now, o.vx === 0 && o.vy === 0);
    else if (o.cls === 'vehicle') drawVehicle(ctx, o, X, Y, W, H);
    else drawBag(ctx, X, Y, W, H);

    const flagged = scene.flagged.has(o.id);
    const color = flagged ? ALERT_COLOR : CLASS_COLOR[o.cls];
    const pad = 2;
    const bx = X - pad;
    const by = Y - pad;
    const bw = W + pad * 2;
    const bh = H + pad * 2;
    if (flagged) {
      ctx.fillStyle = `rgba(255,77,109,${0.12 * pulse})`;
      ctx.fillRect(bx, by, bw, bh);
    }
    ctx.globalAlpha = flagged ? pulse : 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = flagged ? 2 : 1.5;
    const c = Math.max(4, Math.min(bw, bh) * 0.25);
    ctx.beginPath();
    ctx.moveTo(bx, by + c);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + c, by);
    ctx.moveTo(bx + bw - c, by);
    ctx.lineTo(bx + bw, by);
    ctx.lineTo(bx + bw, by + c);
    ctx.moveTo(bx + bw, by + bh - c);
    ctx.lineTo(bx + bw, by + bh);
    ctx.lineTo(bx + bw - c, by + bh);
    ctx.moveTo(bx + c, by + bh);
    ctx.lineTo(bx, by + bh);
    ctx.lineTo(bx, by + bh - c);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (opts.detail || bh > 26) {
      const text = `${o.id} ${Math.round(o.conf * 100)}%`;
      const ly = by > fs + 6 ? by - 4 : by + bh + fs + 2;
      label(ctx, text, bx, ly, color, fs);
    }
  }

  // Grain + scanlines + vignette.
  if (!opts.reducedMotion) {
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.globalCompositeOperation = 'overlay';
    const n = noiseTile();
    const ox = Math.floor((now * 7.3) % 128);
    const oy = Math.floor((now * 3.1) % 128);
    for (let x = -ox; x < w; x += 128) for (let y = -oy; y < h; y += 128) ctx.drawImage(n, x, y);
    ctx.restore();
  }
  ctx.drawImage(post, 0, 0);

  // OSD.
  const ofs = opts.detail ? 13 : 10;
  ctx.font = `700 ${ofs}px ${MONO}`;
  label(ctx, `${cam.id.toUpperCase()} · ${cam.name.toUpperCase()}`, 8, ofs + 8, '#e6eef5', ofs);
  const clock = opts.clock;
  const tw = ctx.measureText(clock).width;
  label(ctx, clock, w - tw - 10, ofs + 8, '#e6eef5', ofs);
  const blink = opts.reducedMotion || Math.floor(now / 600) % 2 === 0;
  if (blink) {
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath();
    ctx.arc(w - tw - 22, ofs + 4, ofs * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}
