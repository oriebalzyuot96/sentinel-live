import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, retry, timeout } from 'rxjs';
import { validateServerEvent, type AlertEvent, type CameraInfo, type ChatWireMessage } from '../../shared/protocol';
import { RUNTIME_CONFIG } from './config';

export interface ChatHistory {
  messages: ChatWireMessage[];
  hasMore: boolean;
}

/** REST side of the integration. All calls degrade to `null` on failure. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(RUNTIME_CONFIG).apiBase;

  cameras(): Observable<CameraInfo[] | null> {
    return this.http.get<{ cameras: CameraInfo[] }>(`${this.base}cameras`).pipe(
      timeout(5000),
      retry({ count: 1, delay: 500 }),
      map((r) => (Array.isArray(r?.cameras) ? r.cameras : null)),
      catchError(() => of(null)),
    );
  }

  recentAlerts(limit = 50): Observable<AlertEvent[] | null> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<{ alerts: unknown[] }>(`${this.base}alerts`, { params }).pipe(
      timeout(5000),
      map((r) =>
        (r?.alerts ?? []).flatMap((a) => {
          const v = validateServerEvent(a);
          return v.ok && v.event.type === 'alert' ? [v.event] : [];
        }),
      ),
      catchError(() => of(null)),
    );
  }

  chatHistory(room: string, before?: number, limit = 30): Observable<ChatHistory | null> {
    let params = new HttpParams().set('limit', limit);
    if (before !== undefined && Number.isFinite(before)) params = params.set('before', before);
    return this.http.get<ChatHistory>(`${this.base}chat/${encodeURIComponent(room)}`, { params }).pipe(
      timeout(5000),
      map((r) => (Array.isArray(r?.messages) ? { messages: r.messages, hasMore: !!r.hasMore } : null)),
      catchError(() => of(null)),
    );
  }
}
