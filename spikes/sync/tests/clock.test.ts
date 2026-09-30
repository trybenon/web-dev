import { describe, expect, it } from 'vitest';
import { ClockEstimator, nextPingDelay } from '../core/clock.ts';

/** Симулирует обмен: сервер впереди клиента на `trueOffset`, задержки туда и обратно заданы. */
function exchange(c: ClockEstimator, sendAt: number, trueOffset: number, up: number, down: number, serverHold = 0) {
  const t0 = sendAt;
  const t1 = sendAt + up + trueOffset;
  const t2 = t1 + serverHold;
  const t3 = t2 - trueOffset + down;
  return c.add(t0, t1, t2, t3);
}

describe('ClockEstimator', () => {
  it('при симметричной задержке смещение определяется точно', () => {
    const c = new ClockEstimator();
    const s = exchange(c, 1000, 5000, 40, 40, 2);
    expect(s?.offset).toBeCloseTo(5000, 6);
    expect(s?.delay).toBeCloseTo(80, 6);
    expect(c.offset()).toBeCloseTo(5000, 6);
    expect(c.rtt()).toBeCloseTo(80, 6);
  });

  it('берёт выборку с наименьшей задержкой, а не среднее', () => {
    const c = new ClockEstimator();
    exchange(c, 0, 5000, 200, 20); // застряла в очереди туда: смещение завышено на 90
    exchange(c, 100, 5000, 10, 10); // чистая
    exchange(c, 200, 5000, 20, 150); // застряла обратно
    expect(c.offset()).toBeCloseTo(5000, 6);
    expect(c.rtt()).toBeCloseTo(20, 6);
  });

  it('асимметрия даёт ошибку в половину разницы — это известное ограничение', () => {
    const c = new ClockEstimator();
    exchange(c, 0, 0, 100, 0);
    expect(c.offset()).toBeCloseTo(50, 6);
  });

  it('отбрасывает мусорные выборки', () => {
    const c = new ClockEstimator({ maxDelayMs: 1000 });
    expect(c.add(10, 0, 0, 5)).toBeNull(); // отрицательная задержка
    expect(exchange(c, 0, 0, 800, 800)).toBeNull(); // слишком долго
    expect(c.add(0, NaN, 0, 10)).toBeNull();
    expect(c.size).toBe(0);
    expect(c.offset()).toBeNull();
    expect(c.rtt()).toBeNull();
  });

  it('держит окно последних N выборок', () => {
    const c = new ClockEstimator({ window: 3 });
    exchange(c, 0, 100, 1, 1); // лучшая, но вытеснится
    for (let i = 1; i <= 3; i++) exchange(c, i * 100, 200, 10, 10);
    expect(c.size).toBe(3);
    expect(c.offset()).toBeCloseTo(200, 6);
  });

  it('игнорирует устаревшие выборки при переданном now', () => {
    const c = new ClockEstimator({ maxAgeMs: 1000 });
    exchange(c, 0, 100, 1, 1);
    exchange(c, 5000, 300, 20, 20);
    expect(c.offset()).toBeCloseTo(100, 6);
    expect(c.offset(5100)).toBeCloseTo(300, 6);
    expect(c.best(99_999)).toBeNull();
  });

  it('reset очищает оценку', () => {
    const c = new ClockEstimator();
    exchange(c, 0, 100, 1, 1);
    c.reset();
    expect(c.size).toBe(0);
    expect(c.offset()).toBeNull();
  });
});

describe('nextPingDelay', () => {
  it('частые пинги в начале, редкие потом', () => {
    expect(nextPingDelay(0)).toBe(150);
    expect(nextPingDelay(7)).toBe(150);
    expect(nextPingDelay(8)).toBe(5000);
    expect(nextPingDelay(2, 3, 50, 1000)).toBe(50);
    expect(nextPingDelay(3, 3, 50, 1000)).toBe(1000);
  });
});
