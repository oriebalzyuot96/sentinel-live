import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

let uid = 0;

/** Build an SVG polyline path for `values` in a w×h box (exported for tests). */
export function sparkPath(values: readonly number[], w: number, h: number, capacity: number, max?: number): { line: string; area: string } {
  if (values.length < 2) return { line: '', area: '' };
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const step = w / Math.max(1, capacity - 1);
  const x0 = w - (values.length - 1) * step;
  const pts = values.map((v, i) => [x0 + i * step, h - 2 - (v / top) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)} ${h}L${pts[0][0].toFixed(1)} ${h}Z`;
  return { line, area };
}

@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + w + ' ' + h()" preserveAspectRatio="none" role="img" [attr.aria-label]="label()">
      <defs>
        <linearGradient [attr.id]="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" [style.stop-color]="color()" stop-opacity="0.35" />
          <stop offset="1" [style.stop-color]="color()" stop-opacity="0" />
        </linearGradient>
      </defs>
      @if (grid()) {
        @for (y of [0.25, 0.5, 0.75]; track y) {
          <line x1="0" [attr.x2]="w" [attr.y1]="h() * y" [attr.y2]="h() * y" class="grid" vector-effect="non-scaling-stroke" />
        }
      }
      <path [attr.d]="paths().area" [attr.fill]="fill" />
      <path [attr.d]="paths().line" fill="none" [style.stroke]="color()" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  `,
  styles: `
    :host { display: block; direction: ltr; }
    svg { display: block; width: 100%; height: 100%; overflow: visible; }
    .grid { stroke: rgba(130,170,200,0.12); stroke-width: 1; stroke-dasharray: 2 4; }
  `,
})
export class Sparkline {
  readonly values = input.required<readonly number[]>();
  readonly color = input('#2ee6c5');
  readonly capacity = input(60);
  readonly h = input(32);
  readonly max = input<number | undefined>(undefined);
  readonly grid = input(false);
  readonly label = input('');
  protected readonly w = 200;
  protected readonly gid = `spark-${++uid}`;
  /** Absolute reference: with <base href> a bare url(#id) breaks in Firefox/Safari. */
  protected readonly fill = `url(${typeof location === 'undefined' ? '' : location.href.split('#')[0]}#${this.gid})`;
  protected readonly paths = computed(() => sparkPath(this.values(), this.w, this.h(), this.capacity(), this.max()));
}
