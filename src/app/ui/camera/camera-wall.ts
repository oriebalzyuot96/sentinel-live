import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OBJECT_CLASSES, type CameraInfo } from '../../../shared/protocol';
import { AnalyticsStore } from '../../core/analytics.store';
import { I18n } from '../../core/i18n';
import { UiState } from '../../core/ui-state';
import { Icon } from '../icon';
import { CameraCanvas } from './camera-canvas';

@Component({
  selector: 'app-camera-wall',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CameraCanvas, Icon],
  templateUrl: './camera-wall.html',
  styleUrl: './camera-wall.scss',
})
export class CameraWall {
  protected readonly store = inject(AnalyticsStore);
  protected readonly i18n = inject(I18n);
  private readonly ui = inject(UiState);
  protected readonly classes = OBJECT_CLASSES;

  /** Alert shown on a tile only while it is fresh (< 12 s). */
  protected readonly freshAlerts = computed(() => {
    this.store.camCounts(); // re-evaluate every sample tick
    const latest = this.store.latestByCam();
    const cutoff = Date.now() - 12_000;
    const out: Record<string, (typeof latest)[string] | undefined> = {};
    for (const [cam, a] of Object.entries(latest)) if (a.ts >= cutoff) out[cam] = a;
    return out;
  });

  protected camName(cam: CameraInfo): string {
    return this.i18n.lang() === 'ar' ? cam.nameAr : cam.name;
  }

  protected label(cam: CameraInfo): string {
    const c = this.store.camCounts()[cam.id];
    const counts = c ? OBJECT_CLASSES.map((k) => `${c[k]} ${this.i18n.cls(k)}`).join(', ') : '';
    return `${this.i18n.t('openCamera', { name: this.camName(cam) })}. ${counts}`;
  }

  protected open(cam: CameraInfo): void {
    this.ui.focusCam.set(cam.id);
  }
}
