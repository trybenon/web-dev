/**
 * Оценка смещения часов по схеме NTP с четырьмя метками.
 *
 * Для каждого обмена:
 *   t0 — клиент отправил запрос (по часам клиента)
 *   t1 — сервер получил запрос (по часам сервера)
 *   t2 — сервер отправил ответ (по часам сервера)
 *   t3 — клиент получил ответ (по часам клиента)
 *
 *   delay  = (t3 − t0) − (t2 − t1)          чистое время в сети туда-обратно
 *   offset = ((t1 − t0) + (t2 − t3)) / 2    серверное время = клиентское + offset
 *
 * Из последних N выборок берётся выборка с наименьшим delay: у неё меньше
 * всего очередей и задержек планировщика, значит оценка точнее. Так делают
 * NTP, Jellyfin SyncPlay и Microsoft Live Share. Медиана по всем выборкам
 * хуже: одна задержка в очереди сдвигает её, а минимум — нет.
 *
 * Ограничение: формула предполагает симметричный путь. При асимметрии
 * ошибка равна половине разницы задержек в двух направлениях, и никакая
 * фильтрация её не убирает.
 *
 * Тот же класс используется для «моста» между воркером и главным потоком:
 * у них разные time origin у performance.now(), и разница измеряется
 * тем же обменом через postMessage.
 */

export interface ClockSample {
  offset: number;
  delay: number;
  /** Локальное время получения ответа (t3). */
  at: number;
}

export interface ClockEstimatorOptions {
  /** Сколько последних выборок держать. */
  window?: number;
  /** Выборки старше этого возраста (мс) выбрасываются. */
  maxAgeMs?: number;
  /** Выборки с delay больше этого значения отбрасываются как мусор. */
  maxDelayMs?: number;
}

export class ClockEstimator {
  private readonly window: number;
  private readonly maxAgeMs: number;
  private readonly maxDelayMs: number;
  private samples: ClockSample[] = [];

  constructor(opts: ClockEstimatorOptions = {}) {
    this.window = opts.window ?? 8;
    this.maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    this.maxDelayMs = opts.maxDelayMs ?? 5_000;
  }

  /** Добавляет выборку. Возвращает её или null, если она отброшена. */
  add(t0: number, t1: number, t2: number, t3: number): ClockSample | null {
    const delay = t3 - t0 - (t2 - t1);
    if (!Number.isFinite(delay) || delay < 0 || delay > this.maxDelayMs) return null;
    const sample: ClockSample = { offset: (t1 - t0 + (t2 - t3)) / 2, delay, at: t3 };
    this.samples.push(sample);
    if (this.samples.length > this.window) this.samples.shift();
    return sample;
  }

  /** Лучшая выборка: минимальный delay среди свежих. */
  best(now?: number): ClockSample | null {
    const fresh = now === undefined ? this.samples : this.samples.filter((s) => now - s.at <= this.maxAgeMs);
    let best: ClockSample | null = null;
    for (const s of fresh) if (best === null || s.delay < best.delay) best = s;
    return best;
  }

  /** Смещение: удалённое время = локальное + offset. null, пока нет выборок. */
  offset(now?: number): number | null {
    return this.best(now)?.offset ?? null;
  }

  /** Круговая задержка лучшей выборки. */
  rtt(now?: number): number | null {
    return this.best(now)?.delay ?? null;
  }

  get size(): number {
    return this.samples.length;
  }

  /** Сброс, например после переподключения или возврата из фона. */
  reset(): void {
    this.samples = [];
  }
}

/**
 * Расписание пингов: серия частых замеров на старте, затем редкие.
 * Серию повторяют после переподключения и возврата вкладки из фона.
 */
export function nextPingDelay(samplesTaken: number, burst = 8, burstGapMs = 150, steadyGapMs = 5_000): number {
  return samplesTaken < burst ? burstGapMs : steadyGapMs;
}
