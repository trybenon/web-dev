import { describe, expect, it } from 'vitest';
import { bufferedAheadMs, errorAt, mainToWorker, planStart, roomTargetAt, workerToMain } from '../core/timeline.ts';
import { parseClientMessage, type PlaybackState } from '../shared/protocol.ts';

const playing = (positionMs: number, anchor: number, rate = 1): PlaybackState => ({
  rev: 1,
  status: 'playing',
  positionMs,
  anchorServerTime: anchor,
  rate,
  setBy: null,
});

// server = worker + 10 000; main = worker + 250
const clocks = { serverOffset: 10_000, mainOffset: 250 };

describe('roomTargetAt', () => {
  it('в игре позиция растёт от якоря, до якоря стоит', () => {
    const s = playing(5000, 20_000);
    expect(roomTargetAt(s, 19_000)).toBe(5000);
    expect(roomTargetAt(s, 21_500)).toBe(6500);
    expect(roomTargetAt(playing(0, 0, 2), 1000)).toBe(2000);
  });

  it('на паузе и в ожидании — positionMs', () => {
    const s: PlaybackState = { ...playing(700, 0), status: 'paused', anchorServerTime: null };
    expect(roomTargetAt(s, 99_999)).toBe(700);
  });
});

describe('перевод шкал', () => {
  it('main ↔ worker обратимы', () => {
    expect(workerToMain(mainToWorker(1234, clocks), clocks)).toBe(1234);
    expect(mainToWorker(1000, clocks)).toBe(750);
  });
});

describe('planStart', () => {
  it('якорь в будущем — старт ровно в якорь с positionMs', () => {
    // worker now = 1000 → server now = 11 000; якорь 11 500
    const plan = planStart(playing(3000, 11_500), 1000, clocks);
    expect(plan.positionMs).toBe(3000);
    expect(plan.atMain).toBe(11_500 - 10_000 + 250);
  });

  it('якорь в прошлом — старт чуть позже «сейчас» с догнанной позицией', () => {
    // server now = 11 000, якорь был 9 000 → комната на 2 с впереди
    const plan = planStart(playing(0, 9000), 1000, clocks, 150);
    expect(plan.positionMs).toBe(2150);
    expect(plan.atMain).toBe(1000 + 150 + 250);
  });

  it('якорь слишком близко — тоже берём запас', () => {
    const plan = planStart(playing(0, 11_050), 1000, clocks, 150);
    expect(plan.atMain).toBe(1000 + 150 + 250);
    expect(plan.positionMs).toBe(100);
  });

  it('без якоря — стартуем с запасом от текущей позиции', () => {
    const s: PlaybackState = { ...playing(400, 0), status: 'paused', anchorServerTime: null };
    expect(planStart(s, 1000, clocks, 150).positionMs).toBe(400);
  });
});

describe('errorAt', () => {
  it('плюс — отстаём, минус — спешим', () => {
    const s = playing(0, 10_000); // якорь при worker 0
    // кадр показан в main 1250 → worker 1000 → server 11 000 → цель 1000
    expect(errorAt(s, 950, 1250, clocks)).toEqual({ atWorker: 1000, errorMs: 50 });
    expect(errorAt(s, 1030, 1250, clocks).errorMs).toBe(-30);
  });
});

describe('bufferedAheadMs', () => {
  it('ищет диапазон, содержащий позицию', () => {
    expect(bufferedAheadMs([[0, 10], [20, 30]], 25)).toBe(5000);
    expect(bufferedAheadMs([[0, 10]], 15)).toBe(0);
    expect(bufferedAheadMs([[1, 10]], 0.97)).toBe(9030); // допуск 50 мс у начала диапазона
    expect(bufferedAheadMs([], 3)).toBe(0);
  });
});

describe('parseClientMessage', () => {
  const presence = { readyState: 4, bufferedAheadMs: 1000, hasSource: true, deviationMs: 0, appliedRev: 2, rttMs: 30 };
  it('принимает корректные сообщения', () => {
    expect(parseClientMessage('{"type":"room:join","roomId":"demo","name":"Аня"}')).toEqual({ type: 'room:join', roomId: 'demo', name: 'Аня' });
    expect(parseClientMessage('{"type":"sync:ping","id":1,"t0":12.5}')).toEqual({ type: 'sync:ping', id: 1, t0: 12.5 });
    expect(parseClientMessage('{"type":"playback:intent","action":"seek","positionMs":1000}')).toMatchObject({ action: 'seek' });
    expect(parseClientMessage(JSON.stringify({ type: 'presence:update', presence }))).toEqual({ type: 'presence:update', presence });
  });

  it('обрезает неправдоподобный RTT', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'presence:update', presence: { ...presence, rttMs: 1e9 } }));
    expect(m?.type === 'presence:update' && m.presence.rttMs).toBe(10_000);
  });

  it.each([
    ['не JSON', '{'],
    ['не объект', '42'],
    ['null', 'null'],
    ['неизвестный тип', '{"type":"hack"}'],
    ['пустое имя', '{"type":"room:join","roomId":"demo","name":""}'],
    ['длинное имя', JSON.stringify({ type: 'room:join', roomId: 'demo', name: 'x'.repeat(40) })],
    ['ping без t0', '{"type":"sync:ping","id":1}'],
    ['бесконечность', '{"type":"sync:ping","id":1,"t0":1e999}'],
    ['плохое действие', '{"type":"playback:intent","action":"stop","positionMs":0}'],
    ['отрицательная позиция', '{"type":"playback:intent","action":"seek","positionMs":-1}'],
    ['presence без полей', '{"type":"presence:update","presence":{"readyState":4}}'],
    ['presence отсутствует', '{"type":"presence:update"}'],
  ])('отклоняет: %s', (_name, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});
