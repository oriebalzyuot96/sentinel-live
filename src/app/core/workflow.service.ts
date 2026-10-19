import { DestroyRef, Injectable, inject } from '@angular/core';
import { PROTOCOL_VERSION, alertRoom, type AlertRef } from '../../shared/protocol';
import { toRef, type AlertRecord } from './alerts.reducer';
import { AnalyticsStore } from './analytics.store';
import { ChatStore } from './chat.store';
import { FeedService } from './feed.service';
import { I18n } from './i18n';
import { NotificationService } from './notifications.service';

/**
 * Alert workflow shared between operators: acknowledge and assign are applied
 * optimistically, sent over the socket and mirrored to the other operator in
 * real time (with a notification when it concerns them).
 */
@Injectable({ providedIn: 'root' })
export class WorkflowService {
  private readonly feed = inject(FeedService);
  private readonly store = inject(AnalyticsStore);
  private readonly chat = inject(ChatStore);
  private readonly notifications = inject(NotificationService);
  private readonly i18n = inject(I18n);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const sub = this.feed.events$.subscribe((ev) => {
      const me = this.chat.me()?.id;
      if (ev.type === 'alert:assigned') {
        this.store.dispatch({ type: 'workflow', ref: ev.alert, ts: ev.ts, assignee: ev.to });
        if (ev.to === me && ev.by !== me) {
          this.notifications.notify({
            kind: 'assigned',
            title: this.i18n.t('nAssigned', { by: this.chat.nameOf(ev.by) }),
            body: this.describe(ev.alert),
            room: alertRoom(ev.alert.id),
          });
        }
      } else if (ev.type === 'alert:acked') {
        this.store.dispatch({ type: 'workflow', ref: ev.alert, ts: ev.ts, ackedBy: ev.by });
        if (ev.by !== me) {
          this.notifications.notify(
            {
              kind: 'acked',
              title: this.i18n.t('nAcked', { by: this.chat.nameOf(ev.by) }),
              body: this.describe(ev.alert),
              room: alertRoom(ev.alert.id),
            },
            { sound: false },
          );
        }
      }
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  ack(alert: AlertRecord): void {
    const me = this.chat.me()?.id ?? 'me';
    this.store.dispatch({ type: 'ack', id: alert.id, by: me });
    this.feed.send({ v: PROTOCOL_VERSION, type: 'alert:ack', alert: toRef(alert) });
  }

  assign(alert: AlertRecord, to: string): void {
    this.store.dispatch({ type: 'workflow', ref: toRef(alert), ts: alert.ts, assignee: to });
    this.feed.send({ v: PROTOCOL_VERSION, type: 'alert:assign', alert: toRef(alert), to });
  }

  discuss(alert: AlertRecord): void {
    this.chat.openPanel(alertRoom(alert.id), toRef(alert));
  }

  describe(ref: AlertRef): string {
    const cam = this.store.camera(ref.cam);
    const camName = cam ? (this.i18n.lang() === 'ar' ? cam.nameAr : cam.name) : ref.cam;
    return `${this.i18n.alertType(ref.alertType)} · ${camName} · ${this.i18n.severity(ref.severity)}`;
  }
}
