import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { GENERAL_ROOM, MAX_CHAT_TEXT, alertRoom } from '../../../shared/protocol';
import { AnalyticsStore } from '../../core/analytics.store';
import { mentions, type ChatMsg, type MsgStatus, type Room } from '../../core/chat.reducer';
import { ChatStore } from '../../core/chat.store';
import { FeedService } from '../../core/feed.service';
import { I18n, type I18nKey } from '../../core/i18n';
import { UiState } from '../../core/ui-state';
import { Icon } from '../icon';

export const EMOJI = ['👍', '👀', '✅', '⚠️', '🚨', '🚓', '🚶', '🚗', '🎒', '📹', '🔥', '🙏', '👋', '😀', '🤔', '⏱️', '📍', '🛑', '🆗', '🌙'];

@Component({
  selector: 'app-chat-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.scss',
})
export class ChatPanel {
  protected readonly chat = inject(ChatStore);
  protected readonly feed = inject(FeedService);
  protected readonly i18n = inject(I18n);
  private readonly store = inject(AnalyticsStore);
  private readonly ui = inject(UiState);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  protected readonly emoji = EMOJI;
  protected readonly maxLen = MAX_CHAT_TEXT;
  protected readonly draft = signal('');
  protected readonly emojiOpen = signal(false);
  protected readonly messages = computed(() => this.chat.activeRoom()?.messages ?? []);
  protected readonly canLoadOlder = computed(
    () => this.feed.state().kind === 'live' && !!this.chat.activeRoom()?.hasMore && this.messages().length > 0,
  );

  constructor() {
    // Keep the newest message in view when it arrives (if the reader is near the bottom).
    let lastCount = 0;
    let lastRoom = '';
    effect(() => {
      const count = this.messages().length;
      const room = this.chat.state().active;
      const el = this.scroller()?.nativeElement;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      const force = room !== lastRoom;
      if (force || (count > lastCount && nearBottom) || this.messages().at(-1)?.mine) {
        requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
      }
      lastCount = count;
      lastRoom = room;
    });
  }

  protected roomTitle(r: Room): string {
    if (r.id === GENERAL_ROOM) return `# ${this.i18n.t('general')}`;
    const ref = r.alert ?? this.store.alertsState().items.find((a) => alertRoom(a.id) === r.id);
    if (!ref) return `# ${r.id.replace(/^alert-/, '')}`;
    const cam = this.store.camera(ref.cam);
    const camName = cam ? (this.i18n.lang() === 'ar' ? cam.nameAr : cam.name) : ref.cam;
    return `${this.i18n.alertType(ref.alertType)} · ${camName}`;
  }

  protected statusKey(s: MsgStatus): I18nKey {
    return ({ pending: 'stPending', failed: 'stFailed', sent: 'stSent', delivered: 'stDelivered', read: 'stRead' } as const)[s];
  }

  protected isMention(m: ChatMsg): boolean {
    return !m.mine && mentions(m.text, this.chat.me());
  }

  protected presenceKey(status: string): I18nKey {
    return status === 'online' ? 'online' : status === 'away' ? 'away' : 'offline';
  }

  protected openRoom(id: string): void {
    this.chat.openRoom(id);
  }

  protected onInput(value: string): void {
    this.draft.set(value);
    if (value.trim()) this.chat.typing();
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  protected send(): void {
    if (this.chat.sendText(this.draft())) {
      this.draft.set('');
      this.emojiOpen.set(false);
    }
    this.input()?.nativeElement.focus();
  }

  protected insertEmoji(e: string): void {
    const el = this.input()?.nativeElement;
    const value = this.draft();
    const at = el?.selectionStart ?? value.length;
    const next = value.slice(0, at) + e + value.slice(el?.selectionEnd ?? at);
    this.draft.set(next.slice(0, MAX_CHAT_TEXT));
    this.emojiOpen.set(false);
    queueMicrotask(() => {
      el?.focus();
      el?.setSelectionRange(at + e.length, at + e.length);
    });
  }

  protected toggleDock(): void {
    this.chat.dock.update((d) => (d === 'docked' ? 'floating' : 'docked'));
  }

  protected close(): void {
    this.chat.dock.set('closed');
  }

  protected chooseOperator(): void {
    this.ui.operatorDialog.set(true);
  }
}
