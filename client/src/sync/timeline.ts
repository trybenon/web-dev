/**
 * Позиция фильма и перевод между шкалами времени.
 *
 * В клиенте три шкалы:
 *   worker — performance.now() воркера: здесь часы и сеть;
 *   main   — performance.now() окна: здесь video и отрисовка кадров;
 *   server — часы сервера: в них якорь комнаты и сроки ожидания.
 *
 * У воркера и окна разная точка отсчёта performance.now(): у окна — начало
 * загрузки страницы, у воркера — момент его создания. В прототипе разница
 * была 45–95 мс. Поэтому метки из окна переводим через измеренное смещение:
 *   server = worker + serverOffset
 *   main   = worker + mainOffset
 */
import type { Playback } from "@watch-together/shared";

export interface Clocks {
  /** server − worker, мс. */
  serverOffset: number;
  /** main − worker, мс. */
  mainOffset: number;
}

/** Где должна стоять головка в момент serverTime по часам сервера. */
export function positionAt(playback: Playback, serverTime: number): number {
  if (playback.status !== "playing") return playback.positionMs;
  const elapsed = Math.max(0, serverTime - playback.anchorServerTime);
  return playback.positionMs + elapsed * playback.rate;
}

export function mainToWorker(mainTime: number, clocks: Clocks): number {
  return mainTime - clocks.mainOffset;
}

export function workerToMain(workerTime: number, clocks: Clocks): number {
  return workerTime + clocks.mainOffset;
}

/**
 * Когда и с какой позиции запускать плеер.
 * Якорь в будущем — стартуем ровно в него.
 * Якорь в прошлом (вход посреди просмотра, опоздавшее сообщение) — стартуем
 * чуть позже «сейчас» с позиции, где комната будет в этот момент.
 */
export function planStart(
  playback: Playback,
  workerNow: number,
  clocks: Clocks,
  minLeadMs = 150,
): { positionMs: number; atMain: number } {
  const serverNow = workerNow + clocks.serverOffset;
  const startServer = Math.max(
    playback.anchorServerTime,
    serverNow + minLeadMs,
  );
  return {
    positionMs: positionAt(playback, startServer),
    atMain: workerToMain(startServer - clocks.serverOffset, clocks),
  };
}

/**
 * Насколько плеер разошёлся с комнатой: кадр mediaTimeMs показан
 * в момент atMain по часам окна. Плюс — отстаём, минус — спешим.
 */
export function errorAt(
  playback: Playback,
  mediaTimeMs: number,
  atMain: number,
  clocks: Clocks,
): { atWorker: number; errorMs: number } {
  const atWorker = mainToWorker(atMain, clocks);
  const target = positionAt(playback, atWorker + clocks.serverOffset);
  return { atWorker, errorMs: target - mediaTimeMs };
}

/**
 * Сколько, мс, загружено вперёд от позиции. ranges — отрезки [начало, конец]
 * в секундах, как в video.buffered. У начала отрезка допуск 50 мс:
 * браузер округляет границы.
 */
export function bufferedAheadMs(
  ranges: Array<[number, number]>,
  positionSec: number,
): number {
  for (const [start, end] of ranges) {
    if (positionSec >= start - 0.05 && positionSec <= end) {
      return Math.max(0, Math.round((end - positionSec) * 1000));
    }
  }
  return 0;
}
