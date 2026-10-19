import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { I18n } from '../../core/i18n';
import { NotificationService, type AppNotification, type NotificationKind } from '../../core/notifications.service';
import { UiState } from '../../core/ui-state';
import { Icon, type IconName } from '../icon';

const KIND_ICON: Record<NotificationKind, IconName> = { assigned: 'assign', acked: 'check', mention: 'user', message: 'chat' };

/** Bell button + notification centre popover. */
@Component({
  selector: 'app-notification-bell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '(document:keydown.escape)': 'ui.notificationsOpen.set(false)', '(document:click)': 'onDocClick($event)' },
  template: `
    <button type="button" class="btn btn--icon bell" [attr.aria-expanded]="ui.notificationsOpen()" aria-controls="notif-center"
      [attr.aria-label]="i18n.t('notifications') + (n.unread() ? ' (' + n.unread() + ')' : '')" (click)="ui.notificationsOpen.set(!ui.notificationsOpen())">
      <app-icon name="bell" [size]="18" />
      @if (n.unread()) { <span class="count-badge mono">{{ n.unread() > 99 ? '99+' : n.unread() }}</span> }
    </button>
    @if (ui.notificationsOpen()) {
      <div class="center popover" id="notif-center" role="region" [attr.aria-label]="i18n.t('notifications')">
        <header>
          <h2>{{ i18n.t('notifications') }}</h2>
          <button type="button" class="btn btn--sm" (click)="n.markAllRead()" [disabled]="!n.unread()">{{ i18n.t('markAllRead') }}</button>
        </header>
        <ul role="list">
          @for (item of n.items(); track item.id) {
            <li>
              <button type="button" class="item" [class.item--unread]="!item.read" [attr.data-kind]="item.kind" (click)="open(item)">
                <span class="item__icon"><app-icon [name]="icon[item.kind]" [size]="14" /></span>
                <span class="item__text">
                  <strong>{{ item.title }}</strong>
                  <span dir="auto">{{ item.body }}</span>
                </span>
                <time class="mono">{{ i18n.time(item.ts) }}</time>
              </button>
            </li>
          } @empty {
            <li class="empty">{{ i18n.t('noNotifications') }}</li>
          }
        </ul>
        <footer>
          @switch (n.desktop()) {
            @case ('granted') { <span class="desk desk--on"><app-icon name="check" [size]="14" />{{ i18n.t('desktopOn') }}</span> }
            @case ('denied') { <span class="desk">{{ i18n.t('desktopBlocked') }}</span> }
            @case ('default') { <button type="button" class="btn btn--sm btn--teal" (click)="n.enableDesktop()">{{ i18n.t('enableDesktop') }}</button> }
          }
        </footer>
      </div>
    }
  `,
  styleUrl: './notifications.scss',
})
export class NotificationBell {
  protected readonly n = inject(NotificationService);
  protected readonly i18n = inject(I18n);
  protected readonly ui = inject(UiState);
  protected readonly icon = KIND_ICON;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected open(item: AppNotification): void {
    this.n.activate(item);
    this.ui.notificationsOpen.set(false);
  }

  protected onDocClick(e: MouseEvent): void {
    if (this.ui.notificationsOpen() && !this.host.contains(e.target as Node)) this.ui.notificationsOpen.set(false);
  }
}

/** Transient toasts (polite live region). */
@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="toasts" role="status" aria-live="polite" [hidden]="ui.notificationsOpen()">
      @for (t of n.toasts(); track t.id) {
        <div class="toast" [attr.data-kind]="t.kind">
          <button type="button" class="toast__body" (click)="n.activate(t)">
            <span class="item__icon"><app-icon [name]="icon[t.kind]" [size]="14" /></span>
            <span class="item__text"><strong>{{ t.title }}</strong><span dir="auto">{{ t.body }}</span></span>
          </button>
          <button type="button" class="btn btn--icon btn--ghost btn--sm" (click)="n.dismissToast(t.id)" [attr.aria-label]="i18n.t('dismiss')">
            <app-icon name="close" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  styleUrl: './notifications.scss',
})
export class Toasts {
  protected readonly n = inject(NotificationService);
  protected readonly ui = inject(UiState);
  protected readonly i18n = inject(I18n);
  protected readonly icon = KIND_ICON;
}
