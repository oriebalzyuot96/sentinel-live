import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { HUMAN_OPERATORS } from '../../../shared/chat-hub';
import { MAX_NAME } from '../../../shared/protocol';
import { ChatStore } from '../../core/chat.store';
import { I18n } from '../../core/i18n';
import { UiState } from '../../core/ui-state';

/** Pick Operator A / B and a display name. No passwords, no accounts. */
@Component({
  selector: 'app-operator-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal op" aria-labelledby="op-title" (close)="ui.operatorDialog.set(false)">
      <form class="popover op__body" method="dialog" (submit)="save($event)">
        <h2 id="op-title">{{ i18n.t('chooseOperator') }}</h2>
        <p class="hint">{{ i18n.t('operatorHint') }}</p>
        <div class="choices" role="radiogroup" [attr.aria-label]="i18n.t('operator')">
          @for (o of operators; track o.id) {
            <label class="choice" [class.choice--on]="picked() === o.id">
              <input type="radio" name="op" [value]="o.id" [checked]="picked() === o.id" (change)="pick(o.id)" />
              <span class="avatar">{{ o.name.slice(-1) }}</span>
              <span>{{ o.name }}</span>
            </label>
          }
        </div>
        <label class="field">
          <span>{{ i18n.t('displayName') }}</span>
          <input class="input" [maxLength]="maxName" [value]="name()" (input)="name.set($any($event.target).value)" autocomplete="nickname" />
        </label>
        <div class="actions">
          <button type="button" class="btn" (click)="close()">{{ i18n.t('cancel') }}</button>
          <button type="submit" class="btn btn--primary">{{ i18n.t('save') }}</button>
        </div>
      </form>
    </dialog>
  `,
  styles: `
    .op { max-width: 420px; }
    .op__body { display: flex; flex-direction: column; gap: 14px; padding: 18px; }
    h2 { font-size: var(--fs-l); }
    .hint { font-size: var(--fs-s); color: var(--text-muted); }
    .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .choice { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: var(--radius-m);
      border: 1px solid var(--border); cursor: pointer; font-weight: 600; font-size: var(--fs-s); }
    .choice input { position: absolute; opacity: 0; pointer-events: none; }
    .choice:has(input:focus-visible) { outline: 2px solid var(--teal); outline-offset: 2px; }
    .choice--on { border-color: var(--teal); background: rgba(46,230,197,0.1); }
    .avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; font-weight: 800;
      background: linear-gradient(135deg, var(--ember), var(--teal)); color: #031014; }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-s); color: var(--text-muted); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
  `,
})
export class OperatorDialog {
  protected readonly ui = inject(UiState);
  protected readonly i18n = inject(I18n);
  private readonly chat = inject(ChatStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly operators = HUMAN_OPERATORS;
  protected readonly maxName = MAX_NAME;
  protected readonly picked = signal('op-a');
  protected readonly name = signal('');

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.ui.operatorDialog() && !el.open) {
        const me = this.chat.me();
        this.picked.set(me?.id ?? 'op-a');
        this.name.set(me?.name ?? '');
        el.showModal();
      } else if (!this.ui.operatorDialog() && el.open) el.close();
    });
  }

  protected pick(id: string): void {
    const prev = HUMAN_OPERATORS.find((o) => o.id === this.picked());
    this.picked.set(id);
    // Swap the default name along with the identity unless the user typed a custom one.
    if (!this.name() || this.name() === prev?.name) this.name.set(HUMAN_OPERATORS.find((o) => o.id === id)?.name ?? '');
  }

  protected save(e: Event): void {
    e.preventDefault();
    this.chat.chooseOperator(this.picked(), this.name());
    this.close();
  }

  protected close(): void {
    this.ui.operatorDialog.set(false);
  }
}
