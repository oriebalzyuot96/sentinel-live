import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked } from '@angular/core';
import { AnalyticsStore } from './core/analytics.store';
import { ChatStore } from './core/chat.store';
import { FeedService } from './core/feed.service';
import { I18n } from './core/i18n';
import { NotificationService } from './core/notifications.service';
import { SoundService } from './core/sound.service';
import { WorkflowService } from './core/workflow.service';
import { AlertFeed } from './ui/alerts/alert-feed';
import { CameraWall } from './ui/camera/camera-wall';
import { FocusView } from './ui/camera/focus-view';
import { AnalyticsPanel } from './ui/charts/analytics-panel';
import { ChatPanel } from './ui/chat/chat-panel';
import { OperatorDialog } from './ui/chat/operator-dialog';
import { ConnectionPanel } from './ui/connection/connection-panel';
import { Icon } from './ui/icon';
import { KpiStrip } from './ui/kpi/kpi-strip';
import { NotificationBell, Toasts } from './ui/notifications/notifications';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertFeed,
    AnalyticsPanel,
    CameraWall,
    ChatPanel,
    ConnectionPanel,
    FocusView,
    Icon,
    KpiStrip,
    NotificationBell,
    OperatorDialog,
    Toasts,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly feed = inject(FeedService);
  protected readonly store = inject(AnalyticsStore);
  protected readonly chat = inject(ChatStore);
  protected readonly i18n = inject(I18n);
  protected readonly sound = inject(SoundService);
  private readonly notifications = inject(NotificationService);

  protected readonly simulated = computed(() => this.feed.state().kind === 'simulated');
  protected readonly statusLabel = computed(() => {
    const k = this.feed.state().kind;
    return k === 'live'
      ? this.i18n.t('liveFeed')
      : k === 'simulated'
        ? this.i18n.t('simulatedFeed')
        : k === 'connecting'
          ? this.i18n.t('stConnecting')
          : this.i18n.t('stReconnecting', { s: '…', n: (this.feed.state() as { attempt: number }).attempt });
  });

  constructor() {
    // Subscribers first, then open the transport.
    this.store.start();
    this.chat.start();
    inject(WorkflowService).start();
    this.feed.start();

    effect(() => (document.documentElement.dataset['chat'] = this.chat.dock()));
    // Clicking a toast / notification jumps to the relevant chat room.
    effect(() => {
      const n = this.notifications.activated();
      if (!n?.room) return;
      untracked(() => this.chat.openPanel(n.room));
    });
  }

  protected toggleChat(): void {
    if (this.chat.dock() === 'closed') this.chat.openPanel();
    else this.chat.dock.set('closed');
  }
}
