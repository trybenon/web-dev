/**
 * Смещение часов клиента относительно сервера по схеме NTP.
 *
 * Один обмен sync:ping / sync:pong даёт четыре метки:
 *   t0 — клиент отправил ping (часы клиента)
 *   t1 — сервер принял ping (часы сервера)
 *   t2 — сервер отправил pong (часы сервера)
 *   t3 — клиент получил pong (часы клиента)
 *
 *   задержка = (t3 − t0) − (t2 − t1)        сеть туда и обратно
 *   смещение = ((t1 − t0) + (t2 − t3)) / 2   время сервера = время клиента + смещение
 *
 * Из последних замеров берём замер с наименьшей задержкой: его меньше всего
 * исказили очереди. Так делают NTP, Jellyfin SyncPlay и Microsoft Live Share.
 *
 * Ограничение: если задержки туда и обратно различаются, оценка ошибается
 * на половину разницы, и никакая фильтрация этого не исправит.
 */

/** Один замер. */
export interface ClockSample {
  /** Время сервера минус время клиента, мс. */
  offset: number;
  /** Сеть туда и обратно без обработки на сервере, мс. */
  delay: number;
  /** Когда получен ответ, по часам клиента (t3). */
  at: number;
}

export interface ClockOptions {
  /** Сколько последних замеров держать. */
  window?: number;
  /** Замеры старше этого, мс, не учитываются: часы могли уплыть. */
  maxAgeMs?: number;
  /** Замеры с задержкой больше этой, мс, отбрасываются как мусор. */
  maxDelayMs?: number;
}

export class ClockEstimator {
  private readonly window: number;
  private readonly maxAgeMs: number;
  private readonly maxDelayMs: number;
  private samples: ClockSample[] = [];

  constructor(options: ClockOptions = {}) {
    this.window = options.window ?? 8;
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
    this.maxDelayMs = options.maxDelayMs ?? 5_000;
  }

  /** Добавляет замер. Возвращает его или null, если замер отброшен. */
  add(t0: number, t1: number, t2: number, t3: number): ClockSample | null {
    const delay = t3 - t0 - (t2 - t1);
    if (!Number.isFinite(delay) || delay < 0 || delay > this.maxDelayMs) {
      return null;
    }
    const sample: ClockSample = {
      offset: (t1 - t0 + (t2 - t3)) / 2,
      delay,
      at: t3,
    };
    this.samples.push(sample);
    if (this.samples.length > this.window) this.samples.shift();
    return sample;
  }

  /** Лучший из свежих замеров: с наименьшей задержкой. */
  best(now: number): ClockSample | null {
    let best: ClockSample | null = null;
    for (const s of this.samples) {
      if (now - s.at > this.maxAgeMs) continue;
      if (best === null || s.delay < best.delay) best = s;
    }
    return best;
  }

  /** Время сервера = время клиента + offset. null — свежих замеров нет. */
  offset(now: number): number | null {
    return this.best(now)?.offset ?? null;
  }

  /** Задержка лучшего замера, мс. null — свежих замеров нет. */
  rtt(now: number): number | null {
    return this.best(now)?.delay ?? null;
  }

  get size(): number {
    return this.samples.length;
  }

  /** Забыть все замеры: после переподключения и возврата вкладки из фона. */
  reset(): void {
    this.samples = [];
  }
}

/**
 * Через сколько, мс, слать следующий ping: серия частых на старте,
 * потом редкие. Серию повторяют после переподключения и возврата из фона.
 */
export function nextPingDelay(
  samplesTaken: number,
  burst = 8,
  burstGapMs = 150,
  steadyGapMs = 5_000,
): number {
  return samplesTaken < burst ? burstGapMs : steadyGapMs;
}
