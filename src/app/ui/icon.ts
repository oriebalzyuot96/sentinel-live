import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Inline stroke icons (24×24 grid), hand-drawn paths, no icon font. */
const PATHS = {
  camera: 'M3 7h11l3 3V7l4-2v12l-4-2v-3l-3 3H3z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  chat: 'M4 5h16v11H9l-5 4z',
  sound: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  replay: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  checks: 'M2 12l5 5 9-10M10 16l1 1 9-10',
  user: 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0',
  assign: 'M10 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M3 21a7 7 0 0 1 12-5M17 14v6M14 17h6',
  volumeOff: 'M4 9h4l5-4v14l-5-4H4z M17 9l5 6M22 9l-5 6',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  dock: 'M4 4h16v16H4zM14 4v16',
  float: 'M4 4h16v16H4zM12 12h6v6h-6z',
  send: 'M4 12l16-8-6 16-3-6z',
  smile: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  cpu: 'M7 7h10v10H7zM10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  retry: 'M20 12a8 8 0 1 1-3-6.2M20 4v4h-4',
  muteRule: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5.6 5.6l12.8 12.8',
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', style: 'display:inline-flex;line-height:0' },
  template: `<svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path [attr.d]="d()" /></svg>`,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  protected readonly d = computed(() => PATHS[this.name()]);
}
