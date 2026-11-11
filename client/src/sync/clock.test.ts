import { describe, expect, it } from "vitest";
import { ClockEstimator, nextPingDelay } from "./clock";

/**
 * Обмен ping/pong: сервер впереди клиента на trueOffset,
 * up и down — задержка сети туда и обратно, hold — обработка на сервере.
 */
function exchange(
  clock: ClockEstimator,
  sendAt: number,
  trueOffset: number,
  up: number,
  down: number,
  hold = 0,
) {
  const t0 = sendAt;
  const t1 = sendAt + up + trueOffset;
  const t2 = t1 + hold;
  const t3 = t2 - trueOffset + down;
  return clock.add(t0, t1, t2, t3);
}

describe("ClockEstimator", () => {
  it("при одинаковой задержке туда и обратно смещение точное", () => {
    const clock = new ClockEstimator();
    const sample = exchange(clock, 1_000, 5_000, 40, 40, 2);
    expect(sample?.offset).toBeCloseTo(5_000, 6);
    expect(sample?.delay).toBeCloseTo(80, 6);
    expect(clock.offset(1_100)).toBeCloseTo(5_000, 6);
    expect(clock.rtt(1_100)).toBeCloseTo(80, 6);
  });

  it("берёт замер с наименьшей задержкой", () => {
    const clock = new ClockEstimator();
    exchange(clock, 0, 5_000, 200, 20); // застрял по пути туда
    exchange(clock, 100, 5_000, 10, 10); // чистый
    exchange(clock, 200, 5_000, 20, 150); // застрял на обратном пути
    expect(clock.offset(500)).toBeCloseTo(5_000, 6);
    expect(clock.rtt(500)).toBeCloseTo(20, 6);
  });

  it("разные задержки туда и обратно дают ошибку в половину разницы", () => {
    const clock = new ClockEstimator();
    exchange(clock, 0, 0, 100, 0);
    expect(clock.offset(100)).toBeCloseTo(50, 6);
  });

  it("отбрасывает мусорные замеры", () => {
    const clock = new ClockEstimator({ maxDelayMs: 1_000 });
    expect(clock.add(10, 0, 0, 5)).toBeNull(); // задержка меньше нуля
    expect(exchange(clock, 0, 0, 800, 800)).toBeNull(); // слишком долго
    expect(clock.add(0, NaN, 0, 10)).toBeNull();
    expect(clock.size).toBe(0);
    expect(clock.offset(0)).toBeNull();
    expect(clock.rtt(0)).toBeNull();
  });

  it("держит только последние замеры", () => {
    const clock = new ClockEstimator({ window: 3 });
    exchange(clock, 0, 100, 1, 1); // лучший, но вытеснится
    for (let i = 1; i <= 3; i++) exchange(clock, i * 100, 200, 10, 10);
    expect(clock.size).toBe(3);
    expect(clock.offset(400)).toBeCloseTo(200, 6);
  });

  it("не верит старым замерам", () => {
    const clock = new ClockEstimator({ maxAgeMs: 1_000 });
    exchange(clock, 0, 100, 1, 1); // лучший, но станет старым
    exchange(clock, 5_000, 300, 20, 20);
    expect(clock.offset(500)).toBeCloseTo(100, 6);
    expect(clock.offset(5_100)).toBeCloseTo(300, 6);
    expect(clock.offset(99_999)).toBeNull();
  });

  it("reset забывает все замеры", () => {
    const clock = new ClockEstimator();
    exchange(clock, 0, 100, 1, 1);
    clock.reset();
    expect(clock.size).toBe(0);
    expect(clock.offset(10)).toBeNull();
  });
});

describe("nextPingDelay", () => {
  it("сначала частые пинги, потом редкие", () => {
    expect(nextPingDelay(0)).toBe(150);
    expect(nextPingDelay(7)).toBe(150);
    expect(nextPingDelay(8)).toBe(5_000);
    expect(nextPingDelay(2, 3, 50, 1_000)).toBe(50);
    expect(nextPingDelay(3, 3, 50, 1_000)).toBe(1_000);
  });
});
