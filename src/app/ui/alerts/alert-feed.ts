import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ALERT_TYPES, SEVERITIES, alertRoom, type AlertType, type Severity } from '../../../shared/protocol';
import { toggleIn, type AlertRecord } from '../../core/alerts.reducer';
import { AnalyticsStore } from '../../core/analytics.store';
import { ChatStore } from '../../core/chat.store';
import { I18n } from '../../core/i18n';
import { WorkflowService } from '../../core/workflow.service';
import { Icon } from '../icon';

@Component({
  selector: 'app-alert-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './alert-feed.html',
  styleUrl: './alert-feed.scss',
})
export class AlertFeed {
  protected readonly store = inject(AnalyticsStore);
  protected readonly chat = inject(ChatStore);
  protected readonly i18n = inject(I18n);
  private readonly workflow = inject(WorkflowService);

  protected readonly severities = SEVERITIES;
  protected readonly types = ALERT_TYPES;
  protected readonly showFilters = signal(false);
  protected readonly assignMenu = signal<string | null>(null);

  protected readonly items = computed(() => this.store.visibleAlerts().slice(0, 80));
  protected readonly unacked = computed(() => this.store.alertsState().items.filter((a) => !a.ackedBy).length);
  protected readonly activeFilters = computed(() => {
    const f = this.store.filter();
    return f.severities.length + f.types.length + f.cams.length + (f.showAcked ? 0 : 1) + (f.assignedTo ? 1 : 0);
  });
  /** Operators an alert can be assigned to (everyone known except me, online first). */
  protected readonly assignees = computed(() =>
    this.chat
      .others()
      .filter((o) => o.status !== 'offline')
      .sort((a, b) => Number(!!a.simulated) - Number(!!b.simulated)),
  );

  protected camName(id: string): string {
    const c = this.store.camera(id);
    return c ? (this.i18n.lang() === 'ar' ? c.nameAr : c.name) : id;
  }

  protected toggleSeverity(s: Severity) {
    this.store.filter.update((f) => ({ ...f, severities: toggleIn(f.severities, s) }));
  }

  protected toggleType(t: AlertType) {
    this.store.filter.update((f) => ({ ...f, types: toggleIn(f.types, t) }));
  }

  protected setCam(id: string) {
    this.store.filter.update((f) => ({ ...f, cams: id ? [id] : [] }));
  }

  protected setShowAcked(v: boolean) {
    this.store.filter.update((f) => ({ ...f, showAcked: v }));
  }

  protected setMine(v: boolean) {
    const me = this.chat.me()?.id;
    this.store.filter.update((f) => ({ ...f, assignedTo: v && me ? me : undefined }));
  }

  protected ack(a: AlertRecord) {
    this.workflow.ack(a);
  }

  protected ackAll() {
    for (const a of this.store.alertsState().items) if (!a.ackedBy) this.workflow.ack(a);
  }

  protected assign(a: AlertRecord, to: string) {
    this.assignMenu.set(null);
    this.workflow.assign(a, to);
  }

  protected discuss(a: AlertRecord) {
    this.workflow.discuss(a);
  }

  protected mute(a: AlertRecord) {
    this.store.dispatch({ type: 'mute', cam: a.cam, alertType: a.alertType });
  }

  protected unmute(key: string) {
    this.store.dispatch({ type: 'unmute', key });
  }

  protected muteLabel(key: string): string {
    const [cam, type] = key.split('|');
    return `${this.camName(cam)} · ${this.i18n.alertType(type as AlertType)}`;
  }

  protected roomUnread(a: AlertRecord): number {
    return this.chat.state().rooms[alertRoom(a.id)]?.unread ?? 0;
  }
}
