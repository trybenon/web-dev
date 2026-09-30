import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DriftController, isWebKitOnly, median } from '../core/controller.ts';

/** Подать постоянную ошибку за окно фильтра и спросить решение. */
function feed(c: DriftController, now: number, err: number, n = 5): ReturnType<DriftController['decide']> {
  for (let i = 0; i < n; i++) c.addSample(now - (n - 1 - i) * 50, err);
  return c.decide(now);
}

describe('median', () => {
  it('нечётное и чётное число значений', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('DriftController: фильтр и мёртвая зона', () => {
  it('без достаточного числа выборок ничего не делает', () => {
    const c = new DriftController();
    c.addSample(0, 500);
    expect(c.filtered(0)).toBeNull();
    expect(c.decide(0)).toEqual({ kind: 'none' });
  });

  it('отбрасывает нечисловые выборки и старые за пределами окна', () => {
    const c = new DriftController();
    c.addSample(0, NaN);
    c.addSample(0, 100);
    c.addSample(10_000, 20);
    expect(c.filtered(10_000)).toBeNull(); // одна свежая выборка
  });

  it('медиана гасит одиночный выброс', () => {
    const c = new DriftController();
    [10, 12, 400, 11, 9].forEach((e, i) => c.addSample(i * 50, e));
    expect(c.filtered(200)).toBe(11);
  });

  it('внутри мёртвой зоны — idle', () => {
    const c = new DriftController();
    expect(feed(c, 1000, 30)).toEqual({ kind: 'none' });
    expect(c.snapshot(1000).mode).toBe('idle');
  });
});

describe('DriftController: коррекция скоростью', () => {
  it('отставание ускоряет, опережение замедляет, пропорционально ошибке', () => {
    const behind = new DriftController();
    expect(feed(behind, 1000, 100)).toEqual({ kind: 'rate', rate: 1.02 });
    const ahead = new DriftController();
    expect(feed(ahead, 1000, -100)).toEqual({ kind: 'rate', rate: 0.98 });
  });

  it('скорость ограничена потолком', () => {
    const c = new DriftController();
    expect(feed(c, 1000, 390)).toEqual({ kind: 'rate', rate: 1 + DEFAULT_CONFIG.maxRateDelta });
  });

  it('малая поправка поднимается до минимального шага (Chrome игнорирует |rate−1| < ~0.1 %)', () => {
    const c = new DriftController({ gainPerMs: 0.00001 });
    expect(feed(c, 1000, 40)).toEqual({ kind: 'rate', rate: 1 + DEFAULT_CONFIG.minRateDelta });
  });

  it('гистерезис: остаётся в коррекции между порогами, выходит ниже нижнего', () => {
    const c = new DriftController();
    feed(c, 1000, 100);
    expect(feed(c, 2100, 20)).toEqual({ kind: 'rate', rate: 1.004 });
    expect(c.snapshot(2100).mode).toBe('rate');
    expect(feed(c, 3200, 5)).toEqual({ kind: 'rate', rate: 1 });
    expect(c.snapshot(3200).mode).toBe('idle');
  });

  it('не меняет скорость чаще rateHoldMs, кроме смены направления', () => {
    // Короткое окно фильтра, чтобы старые выборки не смешивались с новыми.
    const c = new DriftController({ filterWindowMs: 200 });
    feed(c, 1000, 100);
    expect(feed(c, 1300, 60)).toEqual({ kind: 'none' }); // рано
    expect(feed(c, 1600, -60)).toEqual({ kind: 'rate', rate: 0.988 }); // смена знака — сразу
  });

  it('не дёргает скорость из-за изменения меньше 0.002', () => {
    const c = new DriftController();
    feed(c, 1000, 100);
    expect(feed(c, 2500, 96)).toEqual({ kind: 'none' });
  });
});

describe('DriftController: перемотка', () => {
  it('большая ошибка — перемотка с опережением и паузой после неё', () => {
    const c = new DriftController();
    expect(feed(c, 1000, 900)).toEqual({ kind: 'seek', leadMs: DEFAULT_CONFIG.initialSeekLeadMs });
    expect(c.snapshot(1000).mode).toBe('cooldown');
    expect(feed(c, 1500, 900)).toEqual({ kind: 'none' }); // идёт пауза
    expect(c.snapshot(1500).seeks).toBe(1);
  });

  it('учится на промахе: опережение растёт, если после перемотки всё ещё отстаём', () => {
    const c = new DriftController();
    feed(c, 1000, 900);
    const d = feed(c, 3000, 40); // промах +40 мс
    expect(d.kind).toBe('rate');
    expect(c.snapshot(3000).seekLeadMs).toBe(DEFAULT_CONFIG.initialSeekLeadMs + 20);
  });

  it('частые перемотки удваивают порог (защита от «молотилки»), потом порог восстанавливается', () => {
    const c = new DriftController({ seekCooldownMs: 0 });
    let t = 0;
    for (let i = 0; i < 4; i++) {
      t += 1000;
      expect(feed(c, t, 500).kind).toBe('seek');
    }
    expect(c.snapshot(t).effectiveSeekMs).toBe(800);
    // 500 мс теперь ниже порога — корректируем скоростью, а не перемоткой
    expect(feed(c, t + 1000, 500).kind).toBe('rate');
    // через минуту тишины порог возвращается
    expect(feed(c, t + 70_000, 500).kind).toBe('seek');
    expect(c.snapshot(t + 70_000).effectiveSeekMs).toBe(400);
  });

  it('порог не превышает maxSeekMs', () => {
    const c = new DriftController({ seekCooldownMs: 0, thrashMaxSeeks: 0, maxSeekMs: 1000 });
    for (let t = 1000; t < 6000; t += 1000) feed(c, t, 5000);
    expect(c.snapshot(6000).effectiveSeekMs).toBe(1000);
  });
});

describe('DriftController: режимы', () => {
  it('только перемотка (Safari): скорость не трогает', () => {
    const c = new DriftController({ seekOnly: true });
    expect(feed(c, 1000, 120)).toEqual({ kind: 'none' });
    expect(feed(c, 2000, 200).kind).toBe('seek');
  });

  it('suspend сбрасывает скорость и молчит до конца паузы', () => {
    const c = new DriftController();
    feed(c, 1000, 100);
    expect(c.suspend(1100, 1000)).toEqual({ kind: 'rate', rate: 1 });
    expect(feed(c, 1500, 100)).toEqual({ kind: 'none' });
    expect(c.snapshot(1500).mode).toBe('suspended');
    expect(c.decide(2200)).toEqual({ kind: 'none' }); // выборки сброшены
    expect(c.snapshot(2200).mode).toBe('idle');
  });

  it('suspend без активной коррекции ничего не посылает', () => {
    const c = new DriftController();
    expect(c.suspend(0, 100)).toEqual({ kind: 'none' });
  });

  it('обучает опережение старта по первому измерению', () => {
    const c = new DriftController();
    c.noteStart();
    feed(c, 1000, 60);
    expect(c.startLeadMs).toBe(DEFAULT_CONFIG.initialStartLeadMs + 30);
    feed(c, 2000, 60);
    expect(c.startLeadMs).toBe(DEFAULT_CONFIG.initialStartLeadMs + 30); // только первое
  });

  it('опережение старта не выходит за границы', () => {
    const c = new DriftController();
    c.noteStart();
    feed(c, 1000, -300);
    expect(c.startLeadMs).toBe(0);
  });
});

describe('isWebKitOnly', () => {
  const cases: Array<[string, boolean]> = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', true],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', true],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', false],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0', false],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0', false],
  ];
  it.each(cases)('%s → %s', (ua, expected) => {
    expect(isWebKitOnly(ua)).toBe(expected);
  });
});

describe('DriftController: hold', () => {
  it('пауза измерений не сбрасывает обучение опережения перемотки', () => {
    const c = new DriftController();
    feed(c, 1000, 900); // перемотка
    c.hold(1100, 500); // событие seeking
    expect(c.snapshot(1100).mode).toBe('suspended');
    expect(feed(c, 1400, 40)).toEqual({ kind: 'none' }); // ещё пауза
    feed(c, 3000, 40);
    expect(c.snapshot(3000).seekLeadMs).toBe(DEFAULT_CONFIG.initialSeekLeadMs + 20);
  });

  it('hold сохраняет текущую скорость', () => {
    const c = new DriftController();
    feed(c, 1000, 100);
    c.hold(1100, 200);
    expect(c.snapshot(1100).rate).toBe(1.02);
  });
});
