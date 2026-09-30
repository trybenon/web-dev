/**
 * Перевод между шкалами времени и расчёт целевой позиции.
 *
 * В клиенте три шкалы:
 *   worker — performance.now() воркера (здесь живёт контур);
 *   main   — performance.now() главного потока (здесь video, rVFC, setTimeout);
 *   server — часы сервера (в них выражен якорь комнаты).
 *
 * У воркера и окна РАЗНЫЕ точки отсчёта performance.now(): у окна — начало
 * навигации, у воркера — момент его создания. В прототипе разница была
 * от 45 до 95 мс. Поэтому любые метки из главного потока (expectedDisplayTime из
 * rVFC, момент запуска play) переводятся через измеренное смещение:
 *   server = worker + serverOffset
 *   main   = worker + mainOffset
 */
import type { PlaybackState } from '../shared/protocol.ts';

export interface Clocks {
  /** server − worker, мс. */
  serverOffset: number;
  /** main − worker, мс. */
  mainOffset: number;
}

/** Позиция комнаты в момент serverTime. До якоря — стоим на positionMs. */
export function roomTargetAt(state: PlaybackState, serverTime: number): number {
  if (state.status !== 'playing' || state.anchorServerTime === null) return state.positionMs;
  return state.positionMs + Math.max(0, serverTime - state.anchorServerTime) * state.rate;
}

export function mainToWorker(mainTime: number, c: Clocks): number {
  return mainTime - c.mainOffset;
}

export function workerToMain(workerTime: number, c: Clocks): number {
  return workerTime + c.mainOffset;
}

/**
 * Когда и с какой позиции запускать плеер.
 * Якорь в будущем — стартуем ровно в него с positionMs.
 * Якорь в прошлом (опоздавшее сообщение, вход посреди просмотра) — выбираем
 * момент чуть впереди «сейчас» и позицию, которую комната будет иметь в него.
 */
export function planStart(
  state: PlaybackState,
  workerNow: number,
  c: Clocks,
  minLeadMs = 150,
): { positionMs: number; atMain: number } {
  const serverNow = workerNow + c.serverOffset;
  const anchor = state.anchorServerTime ?? serverNow;
  const startServer = anchor >= serverNow + minLeadMs ? anchor : serverNow + minLeadMs;
  return {
    positionMs: roomTargetAt(state, startServer),
    atMain: workerToMain(startServer - c.serverOffset, c),
  };
}

/**
 * Ошибка позиции по измерению из главного потока.
 * mediaTimeMs показан (или будет показан) в момент atMain.
 * Плюс — отстаём от комнаты, минус — спешим.
 */
export function errorAt(
  state: PlaybackState,
  mediaTimeMs: number,
  atMain: number,
  c: Clocks,
): { atWorker: number; errorMs: number } {
  const atWorker = mainToWorker(atMain, c);
  const target = roomTargetAt(state, atWorker + c.serverOffset);
  return { atWorker, errorMs: target - mediaTimeMs };
}

/** Сколько забуферено впереди позиции (мс) по TimeRanges-подобному списку. */
export function bufferedAheadMs(ranges: Array<[number, number]>, positionSec: number): number {
  for (const [start, end] of ranges) {
    if (positionSec >= start - 0.05 && positionSec <= end) return Math.max(0, Math.round((end - positionSec) * 1000));
  }
  return 0;
}
