import { Injectable, signal } from '@angular/core';

/** Cross-component view state that is not domain data. */
@Injectable({ providedIn: 'root' })
export class UiState {
  /** Camera id shown in the focus dialog. */
  readonly focusCam = signal<string | null>(null);
  readonly operatorDialog = signal(false);
  readonly notificationsOpen = signal(false);
}
