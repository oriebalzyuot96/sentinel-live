/**
 * A scripted second operator for demo mode. It is just another client of the
 * ChatHub: it receives the same events and answers with the same client
 * messages (receipts, typing, replies, acknowledging assigned alerts).
 */
import { CAMERAS } from './cameras';
import { SIM_OPERATOR, type ChatHub } from './chat-hub';
import {
  GENERAL_ROOM,
  PROTOCOL_VERSION,
  alertRoom,
  type AlertRef,
  type ClientMessage,
  type OperatorPresence,
  type ServerEvent,
} from './protocol';

export interface SimOperatorOptions {
  now: () => number;
  schedule: (fn: () => void, ms: number) => void;
  rand: () => number;
  /** Latest notable alert, used when the sim operator hands work over. */
  latestAlert: () => AlertRef | null;
  /** Seconds between proactive hand-overs (default 55–85 s). */
  handoverEverySec?: [number, number];
}

const TYPE_LABEL: Record<AlertRef['alertType'], string> = {
  intrusion: 'intrusion',
  loitering: 'loitering',
  crowding: 'crowding',
  'abandoned-object': 'abandoned object',
  'line-crossing': 'line crossing',
};

const camName = (id: string) => CAMERAS.find((c) => c.id === id)?.name ?? id;

const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

export class SimOperator {
  readonly connId = 'bot:sim';
  readonly operator = SIM_OPERATOR;
  private humans: OperatorPresence[] = [];
  private greeted = new Set<string>();
  private replying = new Set<string>();
  private nextHandoverAt = 0;
  private seq = 0;

  constructor(
    private readonly hub: ChatHub,
    private readonly opts: SimOperatorOptions,
  ) {}

  start(): void {
    this.hub.connect(this.connId, true);
    this.send({ v: PROTOCOL_VERSION, type: 'join', operator: this.operator, auto: false });
    this.nextHandoverAt = this.opts.now() + 25_000;
  }

  /** Feed every event the hub routes to this connection. */
  onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'presence':
        this.humans = ev.operators.filter((o) => o.id !== this.operator.id && o.status !== 'offline');
        for (const h of this.humans) {
          if (this.greeted.has(h.id) || !this.alone()) continue;
          this.greeted.add(h.id);
          this.later(1800, () => {
            this.typing(GENERAL_ROOM, true);
            this.later(1400, () =>
              this.say(GENERAL_ROOM, `Hi @${h.name} 👋 I'm the simulated second operator. Message me here, or assign me an alert.`),
            );
          });
        }
        return;
      case 'chat:message': {
        const m = ev.message;
        if (m.from === this.operator.id) return;
        this.later(250 + this.opts.rand() * 400, () => this.receipt(m.room, 'delivered', m.ts));
        const readIn = 900 + this.opts.rand() * 1500;
        this.later(readIn, () => this.receipt(m.room, 'read', m.ts));
        const mentioned = /layla|@sim/i.test(m.text);
        if ((this.alone() || mentioned) && !this.replying.has(m.room)) {
          this.replying.add(m.room);
          this.later(readIn + 400, () => {
            this.typing(m.room, true);
            this.later(1300 + this.opts.rand() * 1800, () => {
              this.replying.delete(m.room);
              this.say(m.room, this.replyTo(m.text));
            });
          });
        }
        return;
      }
      case 'alert:assigned':
        if (ev.to !== this.operator.id) return;
        this.later(2200 + this.opts.rand() * 2000, () => {
          this.send({ v: PROTOCOL_VERSION, type: 'alert:ack', alert: ev.alert });
          this.say(alertRoom(ev.alert.id), `On it. Reviewing ${camName(ev.alert.cam)} for the ${TYPE_LABEL[ev.alert.alertType]} now.`);
        });
        return;
      default:
        return;
    }
  }

  /** Call periodically (e.g. every second) for proactive behaviour. */
  tick(): void {
    const now = this.opts.now();
    if (now < this.nextHandoverAt) return;
    const [lo, hi] = this.opts.handoverEverySec ?? [55, 85];
    this.nextHandoverAt = now + (lo + (hi - lo) * this.opts.rand()) * 1000;
    const human = this.humans.find((h) => h.status === 'online' && !h.simulated);
    const alert = this.opts.latestAlert();
    if (!human || !alert || !this.alone()) return;
    this.send({ v: PROTOCOL_VERSION, type: 'alert:assign', alert, to: human.id });
    this.say(alertRoom(alert.id), `@${human.name} can you take this ${TYPE_LABEL[alert.alertType]} on ${camName(alert.cam)}? I'm busy with Platform B.`);
  }

  /** Exactly one human present: the sim operator plays the counterpart. */
  private alone(): boolean {
    return this.humans.filter((h) => !h.simulated).length <= 1;
  }

  private replyTo(text: string): string {
    if (hasArabic(text)) return text.includes('؟') ? 'لحظة، أتحقق من البث الآن.' : 'تم، أتابع الكاميرا الآن 👍';
    const t = text.toLowerCase();
    if (t.includes('?')) return 'Checking the feed now, give me a few seconds.';
    if (/\b(ack|done|cleared|resolved)\b/.test(t)) return 'Thanks, noted in the shift log.';
    if (/\b(hi|hello|hey|salam)\b/.test(t)) return 'Hey! Quiet night so far, apart from the platform.';
    const canned = ['Copy that.', 'Roger, watching the east side.', 'Seen it 👍', 'Understood, I will keep an eye on it.'];
    return canned[Math.floor(this.opts.rand() * canned.length)];
  }

  private say(room: string, text: string) {
    this.typing(room, false);
    this.send({ v: PROTOCOL_VERSION, type: 'chat:send', clientId: `sim-${this.opts.now().toString(36)}-${++this.seq}`, room, text, clientTs: this.opts.now() });
  }

  private typing(room: string, typing: boolean) {
    this.send({ v: PROTOCOL_VERSION, type: 'chat:typing', room, typing });
  }

  private receipt(room: string, kind: 'delivered' | 'read', upTo: number) {
    this.send({ v: PROTOCOL_VERSION, type: 'chat:receipt', room, kind, upTo });
  }

  private send(msg: ClientMessage) {
    if (this.hub.isConnected(this.connId)) this.hub.handle(this.connId, msg);
  }

  private later(ms: number, fn: () => void) {
    this.opts.schedule(fn, ms);
  }
}
