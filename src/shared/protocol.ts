/**
 * Sentinel Live wire protocol.
 *
 * Shared verbatim by the Node WebSocket server (`server/`), the in-browser
 * Web Worker simulator (demo mode) and the Angular client. Every message is
 * a JSON object carrying the protocol version `v` and a discriminating `type`.
 */

export const PROTOCOL_VERSION = 1 as const;

export type ObjectClass = 'person' | 'vehicle' | 'bag';
export const OBJECT_CLASSES: readonly ObjectClass[] = ['person', 'vehicle', 'bag'];

export type AlertType = 'intrusion' | 'loitering' | 'crowding' | 'abandoned-object' | 'line-crossing';
export const ALERT_TYPES: readonly AlertType[] = [
  'intrusion',
  'loitering',
  'crowding',
  'abandoned-object',
  'line-crossing',
];

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export type SceneKind = 'street' | 'lobby' | 'parking' | 'platform';

/** Normalised (0..1) point. */
export type Point = readonly [number, number];

/** Normalised (0..1) bounding box, origin top-left. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone {
  id: string;
  label: string;
  polygon: Point[];
}

export interface Tripwire {
  id: string;
  label: string;
  a: Point;
  b: Point;
}

export interface CameraInfo {
  id: string;
  name: string;
  nameAr: string;
  scene: SceneKind;
  zones: Zone[];
  lines: Tripwire[];
}

export interface TrackedObject {
  /** Stable track id, e.g. "P-17". */
  id: string;
  cls: ObjectClass;
  bbox: BBox;
  /** Detector confidence 0..1. */
  conf: number;
  /** Velocity in normalised units per second. */
  vx: number;
  vy: number;
}

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  /** Server (capture) timestamp, ms since epoch. */
  ts: number;
}

export interface HelloEvent extends Envelope {
  type: 'hello';
  source: 'server' | 'simulator';
  cameras: CameraInfo[];
}

export interface FrameEvent extends Envelope {
  type: 'frame';
  cam: string;
  seq: number;
  objects: TrackedObject[];
}

export interface AlertEvent extends Envelope {
  type: 'alert';
  id: string;
  cam: string;
  alertType: AlertType;
  severity: Severity;
  trackId: string;
  zone?: string;
  /** Workflow state, only present in REST history. */
  assignee?: string;
  ackedBy?: string;
}

export interface StatsEvent extends Envelope {
  type: 'stats';
  cam: string;
  fps: number;
  counts: Record<ObjectClass, number>;
  /** Simulated inference latency in ms. */
  latencyMs: number;
}

export interface PongEvent extends Envelope {
  type: 'pong';
  id: number;
  clientTs: number;
}

// ---------------------------------------------------------------------------
// Operators, chat and alert workflow
// ---------------------------------------------------------------------------

export type PresenceStatus = 'online' | 'away' | 'offline';
export type ReceiptKind = 'delivered' | 'read';

export interface Operator {
  /** `op-a`, `op-b` (humans) or `op-sim` (simulated operator in demo mode). */
  id: string;
  name: string;
}

export interface OperatorPresence extends Operator {
  status: PresenceStatus;
  simulated?: boolean;
}

/** Compact reference to an alert, carried by workflow events so a receiver can render it even if unseen. */
export interface AlertRef {
  id: string;
  cam: string;
  alertType: AlertType;
  severity: Severity;
}

export interface ChatWireMessage {
  /** Equals the sender's clientId, so every replica agrees on identity. */
  id: string;
  room: string;
  from: string;
  fromName: string;
  text: string;
  ts: number;
  /** Operator ids that confirmed delivery / read. */
  deliveredTo: string[];
  readBy: string[];
}

export interface WelcomeEvent extends Envelope {
  type: 'welcome';
  operator: Operator;
}

export interface PresenceEvent extends Envelope {
  type: 'presence';
  operators: OperatorPresence[];
}

export interface ChatMessageEvent extends Envelope {
  type: 'chat:message';
  message: ChatWireMessage;
}

export interface ChatTypingEvent extends Envelope {
  type: 'chat:typing';
  room: string;
  from: string;
  typing: boolean;
}

export interface ChatReceiptEvent extends Envelope {
  type: 'chat:receipt';
  room: string;
  by: string;
  kind: ReceiptKind;
  /** All messages in `room` with ts <= upTo (not sent by `by`) are covered. */
  upTo: number;
}

export interface AlertAssignedEvent extends Envelope {
  type: 'alert:assigned';
  alert: AlertRef;
  to: string;
  by: string;
}

export interface AlertAckedEvent extends Envelope {
  type: 'alert:acked';
  alert: AlertRef;
  by: string;
}

export type ServerEvent =
  | HelloEvent
  | FrameEvent
  | AlertEvent
  | StatsEvent
  | PongEvent
  | WelcomeEvent
  | PresenceEvent
  | ChatMessageEvent
  | ChatTypingEvent
  | ChatReceiptEvent
  | AlertAssignedEvent
  | AlertAckedEvent;
export type ServerEventType = ServerEvent['type'];

interface ClientEnvelope {
  v: typeof PROTOCOL_VERSION;
}

export interface PingMessage extends ClientEnvelope {
  type: 'ping';
  id: number;
  clientTs: number;
}

export interface JoinMessage extends ClientEnvelope {
  type: 'join';
  operator: Operator;
  /** When true the server may assign a free operator identity instead. */
  auto: boolean;
}

export interface PresenceMessage extends ClientEnvelope {
  type: 'presence';
  status: 'online' | 'away';
}

export interface ChatSendMessage extends ClientEnvelope {
  type: 'chat:send';
  clientId: string;
  room: string;
  text: string;
  clientTs: number;
}

export interface ChatTypingMessage extends ClientEnvelope {
  type: 'chat:typing';
  room: string;
  typing: boolean;
}

export interface ChatReceiptMessage extends ClientEnvelope {
  type: 'chat:receipt';
  room: string;
  kind: ReceiptKind;
  upTo: number;
}

export interface AlertAssignMessage extends ClientEnvelope {
  type: 'alert:assign';
  alert: AlertRef;
  to: string;
}

export interface AlertAckMessage extends ClientEnvelope {
  type: 'alert:ack';
  alert: AlertRef;
}

export type ClientMessage =
  | PingMessage
  | JoinMessage
  | PresenceMessage
  | ChatSendMessage
  | ChatTypingMessage
  | ChatReceiptMessage
  | AlertAssignMessage
  | AlertAckMessage;

export const GENERAL_ROOM = 'general';
export const MAX_CHAT_TEXT = 500;
export const MAX_NAME = 24;
const ROOM_RE = /^[a-z0-9-]{1,64}$/;
export const isRoomId = (x: unknown): x is string => typeof x === 'string' && ROOM_RE.test(x);
export const alertRoom = (alertId: string) => `alert-${alertId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 64);

/** Strip control characters, collapse whitespace at the ends and cap the length. */
export function sanitizeText(text: string, max = MAX_CHAT_TEXT): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Parsing / validation. Untrusted input in, typed event (or null) out.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const isObj = (x: unknown): x is Dict => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 200;
const isUnit = (x: unknown): x is number => isNum(x) && x >= -0.5 && x <= 1.5;

function isBBox(x: unknown): x is BBox {
  return isObj(x) && isUnit(x['x']) && isUnit(x['y']) && isUnit(x['w']) && isUnit(x['h']);
}

function isPoint(x: unknown): x is Point {
  return Array.isArray(x) && x.length === 2 && isUnit(x[0]) && isUnit(x[1]);
}

function isTracked(x: unknown): x is TrackedObject {
  return (
    isObj(x) &&
    isStr(x['id']) &&
    OBJECT_CLASSES.includes(x['cls'] as ObjectClass) &&
    isBBox(x['bbox']) &&
    isNum(x['conf']) &&
    isNum(x['vx']) &&
    isNum(x['vy'])
  );
}

function isCamera(x: unknown): x is CameraInfo {
  return (
    isObj(x) &&
    isStr(x['id']) &&
    isStr(x['name']) &&
    typeof x['nameAr'] === 'string' &&
    ['street', 'lobby', 'parking', 'platform'].includes(x['scene'] as string) &&
    Array.isArray(x['zones']) &&
    x['zones'].every((z) => isObj(z) && isStr(z['id']) && Array.isArray(z['polygon']) && z['polygon'].every(isPoint)) &&
    Array.isArray(x['lines']) &&
    x['lines'].every((l) => isObj(l) && isStr(l['id']) && isPoint(l['a']) && isPoint(l['b']))
  );
}

function isCounts(x: unknown): x is Record<ObjectClass, number> {
  return isObj(x) && OBJECT_CLASSES.every((c) => isNum(x[c]));
}

export type ParseResult = { ok: true; event: ServerEvent } | { ok: false; reason: string };

/** Validate an already-decoded JSON value. */
export function validateServerEvent(x: unknown): ParseResult {
  if (!isObj(x)) return { ok: false, reason: 'not-an-object' };
  if (x['v'] !== PROTOCOL_VERSION) return { ok: false, reason: 'version-mismatch' };
  if (!isNum(x['ts'])) return { ok: false, reason: 'bad-timestamp' };
  switch (x['type']) {
    case 'hello':
      if ((x['source'] === 'server' || x['source'] === 'simulator') && Array.isArray(x['cameras']) && x['cameras'].every(isCamera)) {
        return { ok: true, event: x as unknown as HelloEvent };
      }
      return { ok: false, reason: 'bad-hello' };
    case 'frame':
      if (isStr(x['cam']) && isNum(x['seq']) && Array.isArray(x['objects']) && x['objects'].every(isTracked)) {
        return { ok: true, event: x as unknown as FrameEvent };
      }
      return { ok: false, reason: 'bad-frame' };
    case 'alert':
      if (
        isStr(x['id']) &&
        isStr(x['cam']) &&
        isStr(x['trackId']) &&
        ALERT_TYPES.includes(x['alertType'] as AlertType) &&
        SEVERITIES.includes(x['severity'] as Severity) &&
        (x['zone'] === undefined || isStr(x['zone']))
      ) {
        return { ok: true, event: x as unknown as AlertEvent };
      }
      return { ok: false, reason: 'bad-alert' };
    case 'stats':
      if (isStr(x['cam']) && isNum(x['fps']) && isNum(x['latencyMs']) && isCounts(x['counts'])) {
        return { ok: true, event: x as unknown as StatsEvent };
      }
      return { ok: false, reason: 'bad-stats' };
    case 'pong':
      if (isNum(x['id']) && isNum(x['clientTs'])) return { ok: true, event: x as unknown as PongEvent };
      return { ok: false, reason: 'bad-pong' };
    case 'welcome':
      if (isOperator(x['operator'])) return { ok: true, event: x as unknown as WelcomeEvent };
      return { ok: false, reason: 'bad-welcome' };
    case 'presence':
      if (
        Array.isArray(x['operators']) &&
        x['operators'].every((o: unknown) => isOperator(o) && ['online', 'away', 'offline'].includes((o as unknown as Dict)['status'] as string))
      ) {
        return { ok: true, event: x as unknown as PresenceEvent };
      }
      return { ok: false, reason: 'bad-presence' };
    case 'chat:message':
      if (isChatMessage(x['message'])) return { ok: true, event: x as unknown as ChatMessageEvent };
      return { ok: false, reason: 'bad-chat-message' };
    case 'chat:typing':
      if (isRoomId(x['room']) && isStr(x['from']) && typeof x['typing'] === 'boolean') {
        return { ok: true, event: x as unknown as ChatTypingEvent };
      }
      return { ok: false, reason: 'bad-typing' };
    case 'chat:receipt':
      if (isRoomId(x['room']) && isStr(x['by']) && isReceiptKind(x['kind']) && isNum(x['upTo'])) {
        return { ok: true, event: x as unknown as ChatReceiptEvent };
      }
      return { ok: false, reason: 'bad-receipt' };
    case 'alert:assigned':
      if (isAlertRef(x['alert']) && isStr(x['to']) && isStr(x['by'])) return { ok: true, event: x as unknown as AlertAssignedEvent };
      return { ok: false, reason: 'bad-assigned' };
    case 'alert:acked':
      if (isAlertRef(x['alert']) && isStr(x['by'])) return { ok: true, event: x as unknown as AlertAckedEvent };
      return { ok: false, reason: 'bad-acked' };
    default:
      return { ok: false, reason: 'unknown-type' };
  }
}

function isOperator(x: unknown): x is Operator {
  return isObj(x) && isStr(x['id']) && typeof x['name'] === 'string' && x['name'].length <= MAX_NAME * 2;
}

function isReceiptKind(x: unknown): x is ReceiptKind {
  return x === 'delivered' || x === 'read';
}

function isAlertRef(x: unknown): x is AlertRef {
  return (
    isObj(x) &&
    isStr(x['id']) &&
    isStr(x['cam']) &&
    ALERT_TYPES.includes(x['alertType'] as AlertType) &&
    SEVERITIES.includes(x['severity'] as Severity)
  );
}

function isChatMessage(x: unknown): x is ChatWireMessage {
  return (
    isObj(x) &&
    isStr(x['id']) &&
    isRoomId(x['room']) &&
    isStr(x['from']) &&
    typeof x['fromName'] === 'string' &&
    typeof x['text'] === 'string' &&
    x['text'].length <= MAX_CHAT_TEXT &&
    isNum(x['ts']) &&
    Array.isArray(x['deliveredTo']) &&
    Array.isArray(x['readBy'])
  );
}

/** Validate an already-decoded client message. */
export function validateClientMessage(x: unknown): ClientMessage | null {
  if (!isObj(x) || x['v'] !== PROTOCOL_VERSION) return null;
  switch (x['type']) {
    case 'ping':
      return isNum(x['id']) && isNum(x['clientTs']) ? (x as unknown as PingMessage) : null;
    case 'join':
      return isOperator(x['operator']) && typeof x['auto'] === 'boolean' ? (x as unknown as JoinMessage) : null;
    case 'presence':
      return x['status'] === 'online' || x['status'] === 'away' ? (x as unknown as PresenceMessage) : null;
    case 'chat:send':
      return isStr(x['clientId']) &&
        isRoomId(x['room']) &&
        typeof x['text'] === 'string' &&
        x['text'].length <= MAX_CHAT_TEXT * 2 &&
        isNum(x['clientTs'])
        ? (x as unknown as ChatSendMessage)
        : null;
    case 'chat:typing':
      return isRoomId(x['room']) && typeof x['typing'] === 'boolean' ? (x as unknown as ChatTypingMessage) : null;
    case 'chat:receipt':
      return isRoomId(x['room']) && isReceiptKind(x['kind']) && isNum(x['upTo']) ? (x as unknown as ChatReceiptMessage) : null;
    case 'alert:assign':
      return isAlertRef(x['alert']) && isStr(x['to']) ? (x as unknown as AlertAssignMessage) : null;
    case 'alert:ack':
      return isAlertRef(x['alert']) ? (x as unknown as AlertAckMessage) : null;
    default:
      return null;
  }
}

/** Decode + validate a raw wire string. Never throws. */
export function parseServerEvent(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  return validateServerEvent(value);
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return validateClientMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function makePong(ping: PingMessage, now: number): PongEvent {
  return { v: PROTOCOL_VERSION, type: 'pong', ts: now, id: ping.id, clientTs: ping.clientTs };
}
