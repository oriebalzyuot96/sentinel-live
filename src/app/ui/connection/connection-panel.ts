import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PROTOCOL_VERSION } from '../../../shared/protocol';
import { AnalyticsStore } from '../../core/analytics.store';
import { RUNTIME_CONFIG } from '../../core/config';
import { FeedService } from '../../core/feed.service';
import { I18n } from '../../core/i18n';
import { Sparkline } from '../charts/sparkline';
import { Icon } from '../icon';

@Component({
  selector: 'app-connection-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Sparkline],
  templateUrl: './connection-panel.html',
  styleUrl: './connection-panel.scss',
})
export class ConnectionPanel {
  protected readonly feed = inject(FeedService);
  protected readonly store = inject(AnalyticsStore);
  protected readonly i18n = inject(I18n);
  protected readonly config = inject(RUNTIME_CONFIG);
  protected readonly version = PROTOCOL_VERSION;
  private readonly now = signal(Date.now());

  protected readonly statusText = computed(() => {
    const s = this.feed.state();
    switch (s.kind) {
      case 'connecting':
        return this.i18n.t('stConnecting');
      case 'live':
        return this.i18n.t('stLive');
      case 'reconnecting': {
        const left = Math.ceil((s.retryAt - this.now()) / 1000);
        // Countdown while waiting; once it elapses the attempt itself is in flight.
        return left > 0 ? this.i18n.t('stReconnecting', { s: left, n: s.attempt }) : `${this.i18n.t('stConnecting')} (${s.attempt})`;
      }
      case 'simulated':
        return this.i18n.t('stSimulated');
    }
  });

  protected readonly reason = computed(() => {
    const s = this.feed.state();
    if (s.kind !== 'simulated') return '';
    const key = { forced: 'reasonForced', config: 'reasonConfig', fallback: 'reasonFallback', manual: 'reasonManual' } as const;
    return this.i18n.t(key[s.reason]);
  });

  /** Fraction of the backoff wait elapsed (for the countdown ring). */
  protected readonly backoffProgress = computed(() => {
    const s = this.feed.state();
    if (s.kind !== 'reconnecting') return 0;
    const total = Math.max(1, s.retryAt - (this.startedWaiting ?? s.retryAt));
    return 1 - Math.max(0, s.retryAt - this.now()) / total;
  });
  private startedWaiting: number | null = null;

  constructor() {
    const t = setInterval(() => {
      const s = this.feed.state();
      if (s.kind === 'reconnecting' && this.startedWaiting === null) this.startedWaiting = Date.now();
      if (s.kind !== 'reconnecting') this.startedWaiting = null;
      this.now.set(Date.now());
    }, 250);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }
}
