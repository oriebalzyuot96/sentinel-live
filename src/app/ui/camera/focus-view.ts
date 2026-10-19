import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { AnalyticsStore } from '../../core/analytics.store';
import { I18n } from '../../core/i18n';
import { UiState } from '../../core/ui-state';
import { Icon } from '../icon';
import { CameraCanvas } from './camera-canvas';
import { CLASS_COLOR } from './scene-renderer';

/** Expanded single-camera view in a native modal <dialog> (focus trap + Esc for free). */
@Component({
  selector: 'app-focus-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CameraCanvas, Icon],
  templateUrl: './focus-view.html',
  styleUrl: './focus-view.scss',
})
export class FocusView {
  protected readonly store = inject(AnalyticsStore);
  protected readonly i18n = inject(I18n);
  protected readonly ui = inject(UiState);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly heatmap = signal(false);
  protected readonly trails = signal(true);
  protected readonly overlays = signal(true);
  protected readonly classColor = CLASS_COLOR;
  private readonly tick = signal(0);

  protected readonly cam = computed(() => {
    const id = this.ui.focusCam();
    return id ? this.store.camera(id) : undefined;
  });
  protected readonly tracks = computed(() => {
    this.tick();
    const cam = this.cam();
    const objects = cam ? (this.store.scene(cam.id).frame?.objects ?? []) : [];
    return objects
      .filter((o) => o.bbox.x + o.bbox.w > 0 && o.bbox.x < 1)
      .slice()
      .sort((a, b) => b.conf - a.conf)
      .slice(0, 14);
  });
  protected readonly camAlerts = computed(() => {
    const cam = this.cam();
    return cam ? this.store.alertsState().items.filter((a) => a.cam === cam.id).slice(0, 6) : [];
  });

  constructor() {
    const timer = setInterval(() => this.cam() && this.tick.update((n) => n + 1), 500);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.cam() && !el.open) el.showModal();
      else if (!this.cam() && el.open) el.close();
    });
  }

  protected close(): void {
    this.ui.focusCam.set(null);
  }

  protected onBackdrop(e: MouseEvent): void {
    if (e.target === this.dialog().nativeElement) this.close();
  }
}
