import { Injectable, signal } from '@angular/core';

export type FrameCallback = (now: number) => void;

/**
 * One shared requestAnimationFrame loop for every canvas. It only runs while
 * at least one callback is registered; browsers pause rAF in hidden tabs.
 */
@Injectable({ providedIn: 'root' })
export class RenderLoop {
  private readonly callbacks = new Set<FrameCallback>();
  private handle = 0;
  readonly reducedMotion = signal(
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false,
  );

  constructor() {
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => this.reducedMotion.set(e.matches));
    }
  }

  add(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    if (!this.handle && typeof requestAnimationFrame === 'function') this.handle = requestAnimationFrame(this.loop);
    return () => {
      this.callbacks.delete(cb);
      if (!this.callbacks.size && this.handle) {
        cancelAnimationFrame(this.handle);
        this.handle = 0;
      }
    };
  }

  private readonly loop = (now: number) => {
    for (const cb of this.callbacks) cb(now);
    this.handle = this.callbacks.size ? requestAnimationFrame(this.loop) : 0;
  };
}
