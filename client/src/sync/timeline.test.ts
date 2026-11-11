import { describe, expect, it } from "vitest";
import type { Playback } from "@watch-together/shared";
import {
  bufferedAheadMs,
  errorAt,
  mainToWorker,
  planStart,
  positionAt,
  workerToMain,
} from "./timeline";

/** Игра с позиции positionMs от якоря anchor по часам сервера. */
function playing(positionMs: number, anchor: number, rate = 1): Playback {
  return {
    rev: 1,
    status: "playing",
    positionMs,
    anchorServerTime: anchor,
    rate,
    setBy: null,
  };
}

// server = worker + 10 000; main = worker + 250
const clocks = { serverOffset: 10_000, mainOffset: 250 };

describe("positionAt", () => {
  it("в игре позиция растёт от якоря, до якоря стоит", () => {
    const p = playing(5_000, 20_000);
    expect(positionAt(p, 19_000)).toBe(5_000);
    expect(positionAt(p, 21_500)).toBe(6_500);
    expect(positionAt(playing(0, 0, 2), 1_000)).toBe(2_000);
  });

  it("на паузе и в ожидании — positionMs", () => {
    expect(positionAt({ ...playing(700, 0), status: "paused" }, 99_999)).toBe(
      700,
    );
    expect(positionAt({ ...playing(700, 0), status: "waiting" }, 99_999)).toBe(
      700,
    );
  });
});

describe("перевод шкал", () => {
  it("окно ↔ воркер обратимы", () => {
    expect(workerToMain(mainToWorker(1_234, clocks), clocks)).toBe(1_234);
    expect(mainToWorker(1_000, clocks)).toBe(750);
  });
});

describe("planStart", () => {
  it("якорь в будущем — старт ровно в якорь с positionMs", () => {
    // воркер 1 000 → сервер 11 000; якорь 11 500
    const plan = planStart(playing(3_000, 11_500), 1_000, clocks);
    expect(plan.positionMs).toBe(3_000);
    expect(plan.atMain).toBe(11_500 - 10_000 + 250);
  });

  it("якорь в прошлом — старт чуть позже «сейчас» с догнанной позиции", () => {
    // сервер 11 000, якорь был в 9 000 → комната ушла на 2 с вперёд
    const plan = planStart(playing(0, 9_000), 1_000, clocks, 150);
    expect(plan.positionMs).toBe(2_150);
    expect(plan.atMain).toBe(1_000 + 150 + 250);
  });

  it("якорь слишком близко — тоже берём запас", () => {
    const plan = planStart(playing(0, 11_050), 1_000, clocks, 150);
    expect(plan.atMain).toBe(1_000 + 150 + 250);
    expect(plan.positionMs).toBe(100);
  });

  it("на паузе — позиция комнаты без сдвига", () => {
    const paused: Playback = { ...playing(400, 0), status: "paused" };
    expect(planStart(paused, 1_000, clocks, 150).positionMs).toBe(400);
  });
});

describe("errorAt", () => {
  it("плюс — отстаём, минус — спешим", () => {
    const p = playing(0, 10_000); // якорь при воркере 0
    // кадр показан в окне в 1 250 → воркер 1 000 → сервер 11 000 → цель 1 000
    expect(errorAt(p, 950, 1_250, clocks)).toEqual({
      atWorker: 1_000,
      errorMs: 50,
    });
    expect(errorAt(p, 1_030, 1_250, clocks).errorMs).toBe(-30);
  });
});

describe("bufferedAheadMs", () => {
  it("ищет отрезок, в котором стоит позиция", () => {
    const ranges: Array<[number, number]> = [
      [0, 10],
      [20, 30],
    ];
    expect(bufferedAheadMs(ranges, 25)).toBe(5_000);
    expect(bufferedAheadMs([[0, 10]], 15)).toBe(0);
    expect(bufferedAheadMs([[1, 10]], 0.97)).toBe(9_030); // допуск у начала
    expect(bufferedAheadMs([], 3)).toBe(0);
  });
});
