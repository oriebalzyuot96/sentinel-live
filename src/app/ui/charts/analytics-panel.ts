import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OBJECT_CLASSES, SEVERITIES, type Severity } from '../../../shared/protocol';
import { AnalyticsStore, OCCUPANCY_LEN, TIMELINE_BUCKETS } from '../../core/analytics.store';
import { I18n } from '../../core/i18n';
import { Sparkline } from './sparkline';

export interface StackedBar {
  x: number;
  segments: { sev: Severity; y: number; h: number }[];
  total: number;
}

/** Stack severity counts into bar segments (exported for tests). */
export function stackBars(buckets: Record<Severity, number>[], height: number, barW: number, gap: number): { bars: StackedBar[]; max: number } {
  const max = Math.max(1, ...buckets.map((b) => SEVERITIES.reduce((s, k) => s + b[k], 0)));
  const bars = buckets.map((b, i) => {
    let y = height;
    const segments = SEVERITIES.filter((k) => b[k] > 0).map((sev) => {
      const h = (b[sev] / max) * (height - 4);
      y -= h;
      return { sev, y, h };
    });
    return { x: i * (barW + gap), segments, total: SEVERITIES.reduce((s, k) => s + b[k], 0) };
  });
  return { bars, max };
}

const CLASS_VAR = { person: 'var(--cls-person)', vehicle: 'var(--cls-vehicle)', bag: 'var(--cls-bag)' } as const;
const SEV_VAR: Record<Severity, string> = {
  low: 'var(--sev-low)',
  medium: 'var(--sev-medium)',
  high: 'var(--sev-high)',
  critical: 'var(--sev-critical)',
};

@Component({
  selector: 'app-analytics-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Sparkline],
  templateUrl: './analytics-panel.html',
  styleUrl: './analytics-panel.scss',
})
export class AnalyticsPanel {
  protected readonly store = inject(AnalyticsStore);
  protected readonly i18n = inject(I18n);
  protected readonly classes = OBJECT_CLASSES;
  protected readonly severities = SEVERITIES;
  protected readonly classVar = CLASS_VAR;
  protected readonly sevVar = SEV_VAR;
  protected readonly barW = 8;
  protected readonly barGap = 3;
  protected readonly tlH = 90;
  protected readonly tlW = TIMELINE_BUCKETS * (8 + 3);

  protected readonly timeline = computed(() => stackBars(this.store.timeline(), this.tlH, this.barW, this.barGap));
  protected readonly timelineLabel = computed(() => {
    const total = this.timeline().bars.reduce((s, b) => s + b.total, 0);
    return `${this.i18n.t('alertsTimeline')}: ${total}`;
  });

  protected readonly cell = 12;
  protected readonly heatCols = OCCUPANCY_LEN;
  protected readonly heat = computed(() => {
    const occ = this.store.occupancy();
    const cams = this.store.cameras();
    const max = Math.max(1, ...cams.flatMap((c) => occ[c.id] ?? []));
    return cams.map((c) => {
      const row = occ[c.id] ?? [];
      const pad = OCCUPANCY_LEN - row.length;
      return {
        cam: c,
        cells: Array.from({ length: OCCUPANCY_LEN }, (_, i) => {
          const v = i >= pad ? row[i - pad] : null;
          return { v, t: v === null ? 0 : v / max };
        }),
        last: row.at(-1) ?? 0,
      };
    });
  });

  protected latest(values: readonly number[]): number {
    return values.at(-1) ?? 0;
  }

  /** Teal → amber → red ramp for occupancy cells. */
  protected heatColor(t: number): string {
    if (t <= 0) return 'rgba(130,170,200,0.06)';
    const stops = [
      [46, 230, 197],
      [255, 200, 87],
      [255, 77, 109],
    ];
    const s = t < 0.5 ? 0 : 1;
    const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const [r0, g0, b0] = stops[s];
    const [r1, g1, b1] = stops[s + 1];
    const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
    return `rgba(${mix(r0, r1)},${mix(g0, g1)},${mix(b0, b1)},${0.25 + 0.7 * t})`;
  }
}
