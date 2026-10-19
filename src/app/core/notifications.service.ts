import { Injectable, computed, inject, signal } from '@angular/core';
import { SoundService } from './sound.service';

export type NotificationKind = 'assigned' | 'acked' | 'mention' | 'message';

export interface AppNotification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  ts: number;
  read: boolean;
  /** Chat room to open when activated. */
  room?: string;
}

export const MAX_NOTIFICATIONS = 50;
export const MAX_TOASTS = 3;
export const TOAST_MS = 6_000;

type DesktopState = 'unsupported' | 'default' | 'granted' | 'denied';

/**
 * In-app notification centre + toasts, an optional sound cue and optional
 * desktop notifications. Desktop permission is requested only from an explicit
 * user click (`enableDesktop()`), never on load.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly sound = inject(SoundService);
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  readonly items = signal<AppNotification[]>([]);
  readonly toasts = signal<AppNotification[]>([]);
  readonly unread = computed(() => this.items().filter((n) => !n.read).length);
  readonly desktop = signal<DesktopState>(typeof Notification === 'function' ? (Notification.permission as DesktopState) : 'unsupported');
  /** Activation requests (e.g. clicking a toast) for the shell to route. */
  readonly activated = signal<AppNotification | null>(null);

  notify(input: Omit<AppNotification, 'id' | 'ts' | 'read'>, opts: { sound?: boolean } = {}): AppNotification {
    const n: AppNotification = { ...input, id: ++this.seq, ts: Date.now(), read: false };
    this.items.update((list) => [n, ...list].slice(0, MAX_NOTIFICATIONS));
    this.toasts.update((list) => {
      const next = [n, ...list];
      for (const dropped of next.slice(MAX_TOASTS)) this.clearTimer(dropped.id);
      return next.slice(0, MAX_TOASTS);
    });
    this.timers.set(
      n.id,
      setTimeout(() => this.dismissToast(n.id), TOAST_MS),
    );
    if (opts.sound !== false) this.sound.play(n.kind === 'message' ? 'message' : 'notify');
    this.showDesktop(n);
    return n;
  }

  dismissToast(id: number): void {
    this.clearTimer(id);
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  markRead(id: number): void {
    this.items.update((list) => list.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n)));
  }

  markAllRead(): void {
    if (!this.unread()) return;
    this.items.update((list) => list.map((n) => (n.read ? n : { ...n, read: true })));
  }

  activate(n: AppNotification): void {
    this.markRead(n.id);
    this.dismissToast(n.id);
    this.activated.set(n);
  }

  /** Must be called from a user gesture. */
  async enableDesktop(): Promise<void> {
    if (typeof Notification !== 'function') return;
    try {
      const result = await Notification.requestPermission();
      this.desktop.set(result as DesktopState);
    } catch {
      this.desktop.set('denied');
    }
  }

  private showDesktop(n: AppNotification) {
    if (this.desktop() !== 'granted' || typeof document === 'undefined' || !document.hidden) return;
    try {
      const d = new Notification(n.title, { body: n.body, tag: `sentinel-${n.kind}`, silent: true });
      d.onclick = () => {
        window.focus();
        this.activate(n);
        d.close();
      };
    } catch {
      /* some platforms only allow notifications from a service worker */
    }
  }

  private clearTimer(id: number) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}
