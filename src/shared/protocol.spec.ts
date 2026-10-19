import {
  PROTOCOL_VERSION,
  alertRoom,
  isRoomId,
  makePong,
  parseClientMessage,
  parseServerEvent,
  sanitizeText,
  validateClientMessage,
  validateServerEvent,
} from './protocol';
import { CAMERAS } from './cameras';

const v = PROTOCOL_VERSION;

describe('protocol: server events', () => {
  const frame = {
    v,
    type: 'frame',
    ts: 1,
    cam: 'cam-01',
    seq: 3,
    objects: [{ id: 'P-1', cls: 'person', bbox: { x: 0.1, y: 0.2, w: 0.05, h: 0.2 }, conf: 0.9, vx: 0.01, vy: 0 }],
  };

  it('parses a valid frame', () => {
    const r = parseServerEvent(JSON.stringify(frame));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.type).toBe('frame');
  });

  it('rejects invalid JSON without throwing', () => {
    expect(parseServerEvent('{nope')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('rejects a protocol version mismatch', () => {
    expect(validateServerEvent({ ...frame, v: 2 })).toEqual({ ok: false, reason: 'version-mismatch' });
  });

  it('rejects unknown types and non-objects', () => {
    expect(validateServerEvent({ v, ts: 1, type: 'boom' })).toEqual({ ok: false, reason: 'unknown-type' });
    expect(validateServerEvent([1, 2])).toEqual({ ok: false, reason: 'not-an-object' });
    expect(validateServerEvent(null).ok).toBe(false);
  });

  it('rejects frames with malformed objects', () => {
    const bad = { ...frame, objects: [{ ...frame.objects[0], cls: 'dragon' }] };
    expect(validateServerEvent(bad).ok).toBe(false);
    const nan = { ...frame, objects: [{ ...frame.objects[0], bbox: { x: NaN, y: 0, w: 0, h: 0 } }] };
    expect(validateServerEvent(nan).ok).toBe(false);
  });

  it('validates alerts, stats, hello and pong', () => {
    expect(
      validateServerEvent({ v, ts: 1, type: 'alert', id: 'a1', cam: 'cam-01', alertType: 'intrusion', severity: 'high', trackId: 'P-1', zone: 'Gate' }).ok,
    ).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'alert', id: 'a1', cam: 'cam-01', alertType: 'nope', severity: 'high', trackId: 'P-1' }).ok).toBe(false);
    expect(
      validateServerEvent({ v, ts: 1, type: 'stats', cam: 'cam-01', fps: 9.8, latencyMs: 20, counts: { person: 1, vehicle: 0, bag: 0 } }).ok,
    ).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'stats', cam: 'cam-01', fps: 9.8, latencyMs: 20, counts: { person: 1 } }).ok).toBe(false);
    expect(validateServerEvent({ v, ts: 1, type: 'hello', source: 'server', cameras: CAMERAS }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'pong', id: 1, clientTs: 5 }).ok).toBe(true);
  });

  it('validates chat and workflow events', () => {
    const message = { id: 'm1', room: 'general', from: 'op-a', fromName: 'A', text: 'hi', ts: 1, deliveredTo: [], readBy: [] };
    expect(validateServerEvent({ v, ts: 1, type: 'chat:message', message }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'chat:message', message: { ...message, room: 'Bad Room!' } }).ok).toBe(false);
    expect(validateServerEvent({ v, ts: 1, type: 'chat:receipt', room: 'general', by: 'op-b', kind: 'read', upTo: 5 }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'chat:receipt', room: 'general', by: 'op-b', kind: 'seen', upTo: 5 }).ok).toBe(false);
    expect(validateServerEvent({ v, ts: 1, type: 'presence', operators: [{ id: 'op-a', name: 'A', status: 'online' }] }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'presence', operators: [{ id: 'op-a', name: 'A', status: 'busy' }] }).ok).toBe(false);
    const alert = { id: 'cam-01-a1', cam: 'cam-01', alertType: 'loitering', severity: 'medium' };
    expect(validateServerEvent({ v, ts: 1, type: 'alert:assigned', alert, to: 'op-b', by: 'op-a' }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'alert:acked', alert, by: 'op-a' }).ok).toBe(true);
    expect(validateServerEvent({ v, ts: 1, type: 'welcome', operator: { id: 'op-a', name: 'A' } }).ok).toBe(true);
  });
});

describe('protocol: client messages', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage(JSON.stringify({ v, type: 'ping', id: 1, clientTs: 2 }))?.type).toBe('ping');
    expect(validateClientMessage({ v, type: 'join', operator: { id: 'op-a', name: 'A' }, auto: true })?.type).toBe('join');
    expect(validateClientMessage({ v, type: 'chat:send', clientId: 'c1', room: 'general', text: 'x', clientTs: 1 })?.type).toBe('chat:send');
    expect(validateClientMessage({ v, type: 'chat:typing', room: 'general', typing: true })?.type).toBe('chat:typing');
    expect(validateClientMessage({ v, type: 'presence', status: 'away' })?.type).toBe('presence');
  });

  it('rejects malformed messages', () => {
    expect(parseClientMessage('garbage')).toBeNull();
    expect(validateClientMessage({ v: 9, type: 'ping', id: 1, clientTs: 2 })).toBeNull();
    expect(validateClientMessage({ v, type: 'chat:send', clientId: 'c1', room: '../etc', text: 'x', clientTs: 1 })).toBeNull();
    expect(validateClientMessage({ v, type: 'presence', status: 'invisible' })).toBeNull();
    expect(validateClientMessage({ v, type: 'alert:ack', alert: { id: 'x' } })).toBeNull();
  });

  it('builds pongs echoing the client timestamp', () => {
    expect(makePong({ v, type: 'ping', id: 7, clientTs: 100 }, 150)).toEqual({ v, type: 'pong', ts: 150, id: 7, clientTs: 100 });
  });
});

describe('protocol: helpers', () => {
  it('sanitises chat text', () => {
    expect(sanitizeText('  hi\u0007 there  ')).toBe('hi there');
    expect(sanitizeText('x'.repeat(900)).length).toBe(500);
    expect(sanitizeText('line1\nline2')).toBe('line1\nline2');
  });

  it('derives safe alert room ids', () => {
    const room = alertRoom('cam-01-a12');
    expect(room).toBe('alert-cam-01-a12');
    expect(isRoomId(room)).toBe(true);
    expect(isRoomId(alertRoom('Weird ID/../x'))).toBe(true);
  });
});
