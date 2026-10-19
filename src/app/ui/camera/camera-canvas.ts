import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  viewChild,
} from '@angular/core';
import type { CameraInfo } from '../../../shared/protocol';
import { AnalyticsStore } from '../../core/analytics.store';
import { RenderLoop } from '../../core/render-loop';
import { drawScene } from './scene-renderer';

/**
 * Canvas bound to one camera's SceneState, drawn from the shared rAF loop.
 * Skips work while off-screen; tiles render at ≤30 fps, the focus view at 60.
 */
@Component({
  selector: 'app-camera-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas aria-hidden="true"></canvas>`,
  styles: `
    :host { display: block; position: relative; direction: ltr; aspect-ratio: 16 / 9; background: #070d13; overflow: hidden; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  `,
})
export class CameraCanvas {
  readonly cam = input.required<CameraInfo>();
  readonly heatmap = input(false);
  readonly trails = input(true);
  readonly overlays = input(true);
  readonly detail = input(false);

  private readonly store = inject(AnalyticsStore);
  private readonly loop = inject(RenderLoop);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  private ctx: CanvasRenderingContext2D | null = null;
  private visible = true;
  private frameNo = 0;
  private clockText = '';
  private clockSec = -1;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const canvas = this.canvas().nativeElement;
      this.ctx = canvas.getContext('2d', { alpha: false });
      const resize = () => {
        const rect = this.host.nativeElement.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, this.detail() ? 2 : 1.5);
        const w = Math.max(160, Math.round(rect.width * dpr));
        const h = Math.max(90, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(this.host.nativeElement);
      const io = new IntersectionObserver(([e]) => (this.visible = e.isIntersecting), { threshold: 0.01 });
      io.observe(this.host.nativeElement);
      const remove = this.loop.add((now) => this.draw(now));
      destroyRef.onDestroy(() => {
        ro.disconnect();
        io.disconnect();
        remove();
      });
    });
  }

  private draw(now: number) {
    if (!this.ctx || !this.visible) return;
    if (!this.detail() && this.frameNo++ % 2) return;
    const canvas = this.canvas().nativeElement;
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.clockSec) {
      this.clockSec = sec;
      const d = new Date(sec * 1000);
      const p = (n: number) => String(n).padStart(2, '0');
      this.clockText = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    const cam = this.cam();
    drawScene(this.ctx, canvas.width, canvas.height, cam, this.store.scene(cam.id), now, {
      heatmap: this.heatmap(),
      trails: this.trails(),
      overlays: this.overlays(),
      detail: this.detail(),
      reducedMotion: this.loop.reducedMotion(),
      clock: this.clockText,
    });
  }
}
