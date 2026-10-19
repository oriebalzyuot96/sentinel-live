import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input, signal } from '@angular/core';
import { AnalyticsStore } from '../../core/analytics.store';
import { I18n, type I18nKey } from '../../core/i18n';
import { RenderLoop } from '../../core/render-loop';
import { Icon, type IconName } from '../icon';
import { Sparkline } from '../charts/sparkline';

/** Number that tweens to its new value (instant when reduced motion is on). */
@Component({
  selector: 'app-counter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
  host: { class: 'mono' },
})
export class Counter {
  readonly value = input.required<number>();
  readonly digits = input(0);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly loop = inject(RenderLoop);
  private readonly i18n = inject(I18n);
  private shown = 0;
  private cancel: (() => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel?.());
    effect(() => {
      const target = this.value();
      const digits = this.digits();
      this.i18n.lang();
      this.cancel?.();
      const from = this.shown;
      if (this.loop.reducedMotion() || Math.abs(target - from) < 1e-9) {
        this.render(target, digits);
        return;
      }
      const start = performance.now();
      const dur = 450;
      this.cancel = this.loop.add((now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        this.render(from + (target - from) * eased, digits);
        if (t >= 1) {
          this.cancel?.();
          this.cancel = null;
        }
      });
    });
  }

  private render(v: number, digits: number) {
    this.shown = v;
    this.el.textContent = this.i18n.num(v, digits);
  }
}

interface KpiDef {
  key: 'objects' | 'alertsPerMin' | 'avgConfidence' | 'latencyMs' | 'fps';
  label: I18nKey;
  unit: string;
  digits: number;
  icon: IconName;
  tone: 'teal' | 'ember' | 'blue' | 'amber' | 'violet';
}

@Component({
  selector: 'app-kpi-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Counter, Icon, Sparkline],
  templateUrl: './kpi-strip.html',
  styleUrl: './kpi-strip.scss',
})
export class KpiStrip {
  protected readonly store = inject(AnalyticsStore);
  protected readonly i18n = inject(I18n);
  protected readonly defs: KpiDef[] = [
    { key: 'objects', label: 'kpiObjects', unit: '', digits: 0, icon: 'user', tone: 'teal' },
    { key: 'alertsPerMin', label: 'kpiAlertsMin', unit: '', digits: 0, icon: 'alert', tone: 'ember' },
    { key: 'avgConfidence', label: 'kpiConfidence', unit: '%', digits: 1, icon: 'check', tone: 'blue' },
    { key: 'latencyMs', label: 'kpiLatency', unit: 'ms', digits: 0, icon: 'wifi', tone: 'amber' },
    { key: 'fps', label: 'kpiFps', unit: 'fps', digits: 1, icon: 'cpu', tone: 'violet' },
  ];
  protected readonly history = signal<Record<KpiDef['key'], number[]>>({
    objects: [],
    alertsPerMin: [],
    avgConfidence: [],
    latencyMs: [],
    fps: [],
  });

  constructor() {
    // Keep a short per-KPI history for the inline micro-sparklines.
    effect(() => {
      const k = this.store.kpis();
      this.history.update((prev) => {
        const next = { ...prev };
        for (const d of this.defs) next[d.key] = [...prev[d.key].slice(-39), k[d.key]];
        return next;
      });
    });
  }
}
