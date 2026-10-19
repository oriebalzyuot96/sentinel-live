import { Injectable, signal } from '@angular/core';
import type { Severity } from '../../shared/protocol';

const KEY = 'sentinel.sound';

export type Cue = Severity | 'message' | 'notify';

/**
 * Tiny Web Audio synth for cues (no audio files). Muted by default; the
 * AudioContext is only created after a user gesture, and Web Audio follows the
 * device's volume / silent switch. Cues are rate-limited.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  readonly enabled = signal(readPref());
  private ctx: AudioContext | null = null;
  private lastAt = 0;

  constructor() {
    // Browsers only allow audio after a user gesture: unlock lazily on the first one.
    const unlock = () => {
      if (this.enabled()) this.ensure();
      if (this.ctx) {
        removeEventListener('pointerdown', unlock, true);
        removeEventListener('keydown', unlock, true);
      }
    };
    if (typeof addEventListener === 'function') {
      addEventListener('pointerdown', unlock, true);
      addEventListener('keydown', unlock, true);
    }
  }

  toggle(): void {
    const next = !this.enabled();
    this.enabled.set(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
    // Called from a click: safe moment to create / resume the context.
    if (next) {
      this.ensure();
      this.play('notify');
    }
  }

  play(cue: Cue): void {
    if (!this.enabled()) return;
    const now = performance.now();
    if (now - this.lastAt < 900) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.lastAt = now;
    const tones: Record<Cue, number[]> = {
      low: [520],
      medium: [600, 760],
      high: [780, 620],
      critical: [880, 660, 880],
      message: [660, 990],
      notify: [740, 1110],
    };
    const t0 = ctx.currentTime;
    tones[cue].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = cue === 'critical' ? 'square' : 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(cue === 'critical' ? 0.05 : 0.08, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.12);
    });
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }
}

function readPref(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
