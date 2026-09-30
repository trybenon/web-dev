/**
 * Контроллер дрейфа: по измеренной ошибке позиции решает, что делать —
 * ничего, подкрутить скорость или перемотать.
 *
 * Ошибка = целевая позиция − фактическая (мс). Плюс — отстаём, минус — спешим.
 *
 * Модуль чистый: не знает про video, воркер и сеть, время передаётся
 * параметром. Поэтому он целиком покрывается unit-тестами.
 *
 * Отличия от первой версии документа (40 мс / ±2 % / 250 мс) и откуда они:
 *
 * 1. Фильтр. Одна выборка mediaTime при 24 fps шумит на ±½ кадра (±21 мс)
 *    плюс джиттер vsync. По одиночной выборке порог 40 мс срабатывает сам
 *    по себе. Берём медиану за окно ~0.6 с (MediaSync усредняет 3 выборки).
 * 2. Гистерезис вместо одного порога: начинаем при |e| > 35 мс,
 *    заканчиваем при |e| < 10 мс. Иначе на границе контроллер «дребезжит».
 * 3. Пропорциональная скорость вместо фиксированных ±2 %: rate = 1 + k·e,
 *    k = 0.0002 /мс (100 мс → 2 %), потолок ±3 %.
 * 4. Минимальный шаг ±0.3 %. В Chrome скорость в пределах ~±0.1 % от 1.0
 *    звуковой рендерер пропускает как «почти единицу» и фактически играет
 *    1.0 (media/filters/audio_renderer_algorithm.cc), а позиция в Chrome
 *    идёт по аудиочасам — коррекция просто не работает.
 * 5. Скорость меняем не чаще раза в секунду: переключение 1.0 ↔ не 1.0 при
 *    preservesPitch даёт щелчок (комментарий в том же файле Chromium).
 * 6. Перемотка от 400 мс (Jellyfin SkipToSync), с опережением, которое
 *    контроллер подбирает сам по факту промаха, и с паузой 1.5 с после
 *    перемотки. Если перемотки идут чаще 3 за 10 с — порог удваивается
 *    (защита от «молотилки», как в MediaSync).
 * 7. Режим «только перемотка» для Safari: там каждое изменение playbackRate
 *    вызывает замирание на 0.1–0.3 с (WebKit bug 163433, открыт с 2016).
 */

export interface ControllerConfig {
  enterMs: number;
  exitMs: number;
  gainPerMs: number;
  maxRateDelta: number;
  minRateDelta: number;
  seekMs: number;
  seekCooldownMs: number;
  rateHoldMs: number;
  filterWindowMs: number;
  filterMinSamples: number;
  initialSeekLeadMs: number;
  maxSeekLeadMs: number;
  initialStartLeadMs: number;
  maxStartLeadMs: number;
  seekOnly: boolean;
  seekOnlyThresholdMs: number;
  thrashWindowMs: number;
  thrashMaxSeeks: number;
  maxSeekMs: number;
}

export const DEFAULT_CONFIG: ControllerConfig = {
  enterMs: 35,
  exitMs: 10,
  gainPerMs: 0.0002,
  maxRateDelta: 0.03,
  minRateDelta: 0.003,
  seekMs: 400,
  seekCooldownMs: 1500,
  rateHoldMs: 1000,
  filterWindowMs: 600,
  filterMinSamples: 3,
  initialSeekLeadMs: 60,
  maxSeekLeadMs: 1500,
  initialStartLeadMs: 40,
  maxStartLeadMs: 400,
  seekOnly: false,
  seekOnlyThresholdMs: 150,
  thrashWindowMs: 10_000,
  thrashMaxSeeks: 3,
  maxSeekMs: 2000,
};

export type Decision =
  | { kind: 'none' }
  | { kind: 'rate'; rate: number }
  /** Перемотать на «целевая позиция + leadMs». */
  | { kind: 'seek'; leadMs: number };

export type ControllerMode = 'idle' | 'rate' | 'cooldown' | 'suspended';

export interface ControllerSnapshot {
  mode: ControllerMode;
  filteredErrorMs: number | null;
  rate: number;
  seekLeadMs: number;
  startLeadMs: number;
  effectiveSeekMs: number;
  seeks: number;
  rateChanges: number;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class DriftController {
  readonly cfg: ControllerConfig;
  private samples: Array<{ at: number; err: number }> = [];
  private mode: ControllerMode = 'idle';
  private rate = 1;
  private lastRateChangeAt = -Infinity;
  private suspendedUntil = -Infinity;
  private cooldownUntil = -Infinity;
  private seekLeadMs: number;
  private pendingLeadCheck = false;
  private startLead: number;
  private pendingStartCheck = false;
  private seekTimes: number[] = [];
  private lastSeekAt = -Infinity;
  private thrashLevel = 0;
  private seeks = 0;
  private rateChanges = 0;

  constructor(cfg: Partial<ControllerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.seekLeadMs = this.cfg.initialSeekLeadMs;
    this.startLead = this.cfg.initialStartLeadMs;
  }

  /**
   * На сколько раньше якоря вызывать play(). Между вызовом play() и началом
   * движения головки проходит время (в Chromium ~40 мс, зависит от браузера
   * и устройства). Контроллер измеряет промах после каждого старта и
   * подстраивает опережение, как и для перемоток.
   */
  get startLeadMs(): number {
    return Math.round(this.startLead);
  }

  /** Сообщить, что только что запланирован старт: первое измерение уточнит опережение. */
  noteStart(): void {
    this.pendingStartCheck = true;
  }

  /** Добавить измерение ошибки, сделанное в момент `at` (мс, любая монотонная шкала). */
  addSample(at: number, errorMs: number): void {
    if (!Number.isFinite(errorMs)) return;
    this.samples.push({ at, err: errorMs });
    const from = at - this.cfg.filterWindowMs;
    while (this.samples.length && this.samples[0].at < from) this.samples.shift();
  }

  /** Отфильтрованная ошибка или null, если выборок мало. */
  filtered(now: number): number | null {
    const from = now - this.cfg.filterWindowMs;
    const fresh = this.samples.filter((s) => s.at >= from).map((s) => s.err);
    return fresh.length >= this.cfg.filterMinSamples ? median(fresh) : null;
  }

  /**
   * Временно не измерять: плеер перематывается или буферизуется, вкладка
   * только что вернулась из фона. Выборки сбрасываются, но скорость
   * и ожидающее обучение опережения сохраняются: первое измерение после
   * паузы как раз и показывает промах перемотки.
   */
  hold(now: number, forMs: number): void {
    this.suspendedUntil = Math.max(this.suspendedUntil, now + forMs);
    this.samples = [];
    this.mode = 'suspended';
  }

  /**
   * Перестать корректировать на `forMs` после новой команды комнаты.
   * Скорость сбрасывается в 1, незавершённое обучение отменяется.
   */
  suspend(now: number, forMs: number): Decision {
    this.suspendedUntil = Math.max(this.suspendedUntil, now + forMs);
    this.samples = [];
    this.pendingLeadCheck = false;
    this.mode = 'suspended';
    return this.setRate(1, now, true);
  }

  decide(now: number): Decision {
    if (now < this.suspendedUntil) {
      this.mode = 'suspended';
      return { kind: 'none' };
    }
    if (now < this.cooldownUntil) {
      this.mode = 'cooldown';
      return { kind: 'none' };
    }
    this.decayThrash(now);

    const e = this.filtered(now);
    if (e === null) {
      if (this.mode === 'suspended' || this.mode === 'cooldown') this.mode = this.rate === 1 ? 'idle' : 'rate';
      return { kind: 'none' };
    }

    // Первое измерение после старта или перемотки показывает промах:
    // подстраиваем опережение для следующего раза.
    if (this.pendingStartCheck) {
      this.pendingStartCheck = false;
      this.startLead = clamp(this.startLead + 0.5 * e, 0, this.cfg.maxStartLeadMs);
    }
    if (this.pendingLeadCheck) {
      this.pendingLeadCheck = false;
      this.seekLeadMs = clamp(this.seekLeadMs + 0.5 * e, 0, this.cfg.maxSeekLeadMs);
    }

    const abs = Math.abs(e);

    if (this.cfg.seekOnly) {
      this.mode = 'idle';
      return abs > this.cfg.seekOnlyThresholdMs ? this.seek(now) : { kind: 'none' };
    }

    if (abs > this.effectiveSeekMs()) return this.seek(now);

    if (this.mode === 'rate') {
      if (abs < this.cfg.exitMs) {
        this.mode = 'idle';
        return this.setRate(1, now, true);
      }
    } else if (abs > this.cfg.enterMs) {
      this.mode = 'rate';
    } else {
      this.mode = 'idle';
      return { kind: 'none' };
    }

    // Режим коррекции скоростью.
    let delta = clamp(this.cfg.gainPerMs * e, -this.cfg.maxRateDelta, this.cfg.maxRateDelta);
    if (Math.abs(delta) < this.cfg.minRateDelta) delta = Math.sign(e) * this.cfg.minRateDelta;
    const target = round3(1 + delta);
    const flips = Math.sign(target - 1) !== Math.sign(this.rate - 1);
    return this.setRate(target, now, flips);
  }

  snapshot(now: number): ControllerSnapshot {
    return {
      mode: this.mode,
      filteredErrorMs: this.filtered(now),
      rate: this.rate,
      seekLeadMs: this.seekLeadMs,
      startLeadMs: this.startLeadMs,
      effectiveSeekMs: this.effectiveSeekMs(),
      seeks: this.seeks,
      rateChanges: this.rateChanges,
    };
  }

  private seek(now: number): Decision {
    this.seeks += 1;
    this.lastSeekAt = now;
    this.seekTimes.push(now);
    this.seekTimes = this.seekTimes.filter((t) => now - t <= this.cfg.thrashWindowMs);
    if (this.seekTimes.length > this.cfg.thrashMaxSeeks) {
      this.thrashLevel += 1;
      this.seekTimes = [];
    }
    this.cooldownUntil = now + this.cfg.seekCooldownMs;
    this.samples = [];
    this.pendingLeadCheck = true;
    this.mode = 'cooldown';
    this.rate = 1;
    this.lastRateChangeAt = now;
    return { kind: 'seek', leadMs: Math.round(this.seekLeadMs) };
  }

  private setRate(rate: number, now: number, force: boolean): Decision {
    if (rate === this.rate) return { kind: 'none' };
    const tooSoon = now - this.lastRateChangeAt < this.cfg.rateHoldMs;
    const tooSmall = Math.abs(rate - this.rate) < 0.002;
    if (!force && (tooSoon || tooSmall)) return { kind: 'none' };
    this.rate = rate;
    this.lastRateChangeAt = now;
    this.rateChanges += 1;
    return { kind: 'rate', rate };
  }

  private effectiveSeekMs(): number {
    return Math.min(this.cfg.maxSeekMs, this.cfg.seekMs * 2 ** this.thrashLevel);
  }

  private decayThrash(now: number): void {
    if (this.thrashLevel > 0 && now - this.lastSeekAt > 60_000) this.thrashLevel = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Грубое определение WebKit (Safari, любые браузеры на iOS). */
export function isWebKitOnly(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  return ua.includes('safari') && !/chrome|chromium|crios|edg|android|fxios|firefox/.test(ua);
}
