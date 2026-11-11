import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerClock } from "./server-clock";

/** Сервер впереди клиента на 10 с, сеть 5 мс в каждую сторону. */
const OFFSET = 10_000;

let sent: number[];
let clock: ServerClock;

/** Ответить на последний ping так, как ответил бы сервер. */
function answer() {
  const t0 = sent[sent.length - 1];
  vi.advanceTimersByTime(10);
  clock.onPong(t0, t0 + 5 + OFFSET, t0 + 5 + OFFSET);
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  clock = new ServerClock(
    (t0) => sent.push(t0),
    () => Date.now(),
  );
});

afterEach(() => {
  clock.stop();
  vi.useRealTimers();
});

describe("ServerClock", () => {
  it("до первого ответа время сервера неизвестно", () => {
    clock.start();
    expect(sent).toHaveLength(1);
    expect(clock.serverNow()).toBeNull();
    expect(clock.rtt()).toBeNull();
  });

  it("после ответа знает время сервера и задержку", () => {
    clock.start();
    answer();
    expect(clock.serverNow()).toBe(Date.now() + OFFSET);
    expect(clock.offset()).toBe(OFFSET);
    expect(clock.rtt()).toBe(10);
    expect(clock.answers).toBe(1);
  });

  it("сначала восемь частых пингов, потом раз в 5 секунд", () => {
    clock.start();
    for (let i = 0; i < 8; i++) {
      answer();
      vi.advanceTimersByTime(140); // 10 мс ушло на ответ
    }
    expect(sent).toHaveLength(9);
    vi.advanceTimersByTime(4_999);
    expect(sent).toHaveLength(9);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(10);
  });

  it("stop останавливает пинги, start калибрует заново", () => {
    clock.start();
    answer();
    clock.stop();
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(1);
    clock.start();
    expect(sent).toHaveLength(2);
    expect(clock.serverNow()).toBeNull();
    expect(clock.answers).toBe(0);
  });
});
