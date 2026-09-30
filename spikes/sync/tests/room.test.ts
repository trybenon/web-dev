import { describe, expect, it } from 'vitest';
import { EMPTY_PRESENCE, Room, type Outbound } from '../core/room.ts';
import type { Presence } from '../shared/protocol.ts';

const types = (out: Outbound[]): string[] => out.map((o) => o.msg.type);
const ready = (rev: number, extra: Partial<Presence> = {}): Presence => ({
  ...EMPTY_PRESENCE,
  readyState: 4,
  bufferedAheadMs: 5000,
  hasSource: true,
  appliedRev: rev,
  ...extra,
});

function roomWith(n: number): Room {
  const r = new Room('r');
  for (let i = 1; i <= n; i++) r.join(`p${i}`, `P${i}`);
  return r;
}

describe('Room: вход и выход', () => {
  it('новичок получает снимок, остальные — уведомление', () => {
    const r = new Room('r');
    r.join('a', 'A');
    const out = r.join('b', 'B');
    expect(types(out)).toEqual(['room:state', 'room:peer_joined']);
    expect(out[0].to).toBe('b');
    expect(out[1]).toMatchObject({ to: 'all', except: 'b' });
    expect(r.size).toBe(2);
    expect(r.join('b', 'B')).toEqual([]); // повторный вход игнорируется
  });

  it('пятый участник получает room_full', () => {
    const r = roomWith(4);
    const out = r.join('p5', 'P5');
    expect(out).toHaveLength(1);
    expect(out[0].msg).toMatchObject({ type: 'error', code: 'room_full' });
    expect(r.size).toBe(4);
  });

  it('вход посреди просмотра не трогает воспроизведение', () => {
    const r = roomWith(1);
    r.intent('p1', 'play', 0, 0); // ни у кого нет файла — сразу playing
    const rev = r.playback.rev;
    r.join('p2', 'P2');
    expect(r.playback.rev).toBe(rev);
    expect(r.playback.status).toBe('playing');
  });

  it('выход неизвестного — пустой список', () => {
    expect(new Room('r').leave('x', 0)).toEqual([]);
  });
});

describe('Room: барьер готовности', () => {
  it('если файла нет ни у кого, старт без ожидания', () => {
    const r = roomWith(2);
    const out = r.intent('p1', 'play', 0, 1000);
    expect(types(out)).toEqual(['playback:state', 'playback:state']);
    expect(r.playback.status).toBe('playing');
    expect(r.playback.anchorServerTime).toBe(1000 + 300);
  });

  it('ждёт всех с файлом; старое «готов» до перемотки не засчитывается', () => {
    const r = roomWith(2);
    r.presence('p1', ready(0), 0);
    r.presence('p2', ready(0), 0);
    const out = r.intent('p1', 'play', 0, 1000);
    expect(types(out)).toEqual(['playback:state', 'playback:hold']);
    const waitRev = r.playback.rev;
    expect(r.playback.status).toBe('waiting');
    expect(r.waitingFor.sort()).toEqual(['p1', 'p2']);

    // Отчёт с прошлой ревизией не отпускает барьер.
    expect(r.presence('p1', ready(waitRev - 1), 1100)).toEqual([]);
    // p1 подготовился к новой ревизии, p2 ещё нет.
    expect(r.presence('p1', ready(waitRev), 1200)).toEqual([]);
    expect(r.waitingFor).toEqual(['p2']);
    // Мало буфера — ещё не готов.
    expect(r.presence('p2', ready(waitRev, { bufferedAheadMs: 500 }), 1300)).toEqual([]);
    const rel = r.presence('p2', ready(waitRev, { rttMs: 250 }), 1400);
    expect(types(rel)).toEqual(['playback:state']);
    expect(r.playback.status).toBe('playing');
    // Якорь: наибольший RTT + 200 мс, но не меньше 300.
    expect(r.playback.anchorServerTime).toBe(1400 + 450);
    expect(r.playback.setBy).toBe('p1');
  });

  it('по дедлайну стартует без отставших', () => {
    const r = roomWith(2);
    r.presence('p1', ready(0), 0);
    r.presence('p2', ready(0), 0);
    r.intent('p1', 'play', 0, 1000);
    expect(r.tick(5000)).toEqual([]);
    const out = r.tick(1000 + r.cfg.barrierTimeoutMs);
    expect(types(out)).toEqual(['playback:state']);
    expect(r.playback.status).toBe('playing');
    expect(r.tick(99_999)).toEqual([]);
  });

  it('выход участника, которого ждали, отпускает барьер', () => {
    const r = roomWith(2);
    r.presence('p1', ready(0), 0);
    r.presence('p2', ready(0), 0);
    r.intent('p1', 'play', 0, 1000);
    r.presence('p1', ready(r.playback.rev), 1100);
    const out = r.leave('p2', 1200);
    expect(types(out)).toEqual(['room:peer_left', 'playback:state']);
    expect(r.playback.status).toBe('playing');
  });

  it('наблюдатель без файла комнату не держит', () => {
    const r = roomWith(2);
    r.presence('p1', ready(0), 0);
    r.intent('p1', 'play', 0, 0);
    expect(r.waitingFor).toEqual(['p1']);
  });

  it('presence от незнакомца игнорируется', () => {
    expect(new Room('r').presence('x', ready(0), 0)).toEqual([]);
  });
});

describe('Room: намерения', () => {
  it('пауза во время игры фиксирует вычисленную позицию', () => {
    const r = roomWith(1);
    r.intent('p1', 'play', 0, 0); // якорь 300
    expect(r.positionAt(1300)).toBe(1000);
    r.intent('p1', 'pause', 123, 1300); // позиция клиента игнорируется
    expect(r.playback).toMatchObject({ status: 'paused', positionMs: 1000, anchorServerTime: null });
  });

  it('до якоря позиция стоит', () => {
    const r = roomWith(1);
    r.intent('p1', 'play', 0, 0);
    expect(r.positionAt(100)).toBe(0);
  });

  it('пауза во время ожидания', () => {
    const r = roomWith(1);
    r.presence('p1', ready(0), 0);
    r.intent('p1', 'seek', 5000, 0); // на паузе: просто сдвиг
    expect(r.playback).toMatchObject({ status: 'paused', positionMs: 5000 });
    r.intent('p1', 'play', 0, 1000);
    expect(r.playback.status).toBe('waiting');
    r.intent('p1', 'pause', 0, 2000);
    expect(r.playback).toMatchObject({ status: 'paused', positionMs: 5000 });
    expect(r.waitingFor).toEqual([]);
  });

  it('перемотка во время игры проходит через барьер', () => {
    const r = roomWith(1);
    r.presence('p1', ready(0), 0);
    r.intent('p1', 'play', 0, 0);
    r.presence('p1', ready(r.playback.rev), 100);
    expect(r.playback.status).toBe('playing');
    const out = r.intent('p1', 'seek', 60_000, 1000);
    expect(types(out)).toEqual(['playback:state', 'playback:hold']);
    expect(r.playback).toMatchObject({ status: 'waiting', positionMs: 60_000 });
  });

  it('повторные play и pause — без изменений; отрицательная позиция обрезается', () => {
    const r = roomWith(1);
    expect(r.intent('p1', 'pause', 0, 0)).toEqual([]);
    r.intent('p1', 'seek', -50, 1000);
    expect(r.playback.positionMs).toBe(0);
    r.intent('p1', 'play', 0, 2000);
    expect(r.intent('p1', 'play', 0, 3000)).toEqual([]);
  });

  it('ограничение частоты намерений', () => {
    const r = roomWith(1);
    r.intent('p1', 'seek', 1000, 0);
    const out = r.intent('p1', 'seek', 2000, 100);
    expect(out[0].msg).toMatchObject({ type: 'error', code: 'rate_limited' });
    expect(r.intent('p1', 'seek', 2000, 300)).toHaveLength(1);
  });

  it('намерение не участника — not_joined', () => {
    const out = new Room('r').intent('x', 'play', 0, 0);
    expect(out[0].msg).toMatchObject({ type: 'error', code: 'not_joined' });
  });

  it('каждое изменение увеличивает rev', () => {
    const r = roomWith(1);
    const revs = [r.playback.rev];
    r.intent('p1', 'seek', 100, 0);
    revs.push(r.playback.rev);
    r.intent('p1', 'play', 0, 1000);
    revs.push(r.playback.rev);
    expect(revs).toEqual([0, 1, 3]); // play без файлов: waiting (2) → playing (3)
  });

  it('presenceSync рассылает всех', () => {
    const r = roomWith(2);
    const o = r.presenceSync();
    expect(o.to).toBe('all');
    expect(o.msg.type === 'presence:sync' && o.msg.peers).toHaveLength(2);
  });
});
