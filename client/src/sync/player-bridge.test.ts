import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient, type WorkerPort } from "./client";
import {
  createPlayerBridge,
  type BridgeDocument,
  type BridgeVideo,
  type FrameInfo,
} from "./player-bridge";
import { createStubSyncClient } from "./stub";
import type { PlayerBridge, SyncClient } from "./types";
import type {
  FromWorker,
  MediaReport,
  PlayerCommand,
  ToWorker,
} from "./worker-protocol";

/** Подделка document: видимость вкладки переключает тест. */
class FakeDocument implements BridgeDocument {
  visibilityState = "visible";
  readonly listeners = new Set<() => void>();

  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }

  setVisible(visible: boolean): void {
    this.visibilityState = visible ? "visible" : "hidden";
    for (const listener of this.listeners) listener();
  }
}

/** Подделка video: ведёт себя как настоящий, но всё видно и всем можно управлять. */
class FakeVideo implements BridgeVideo {
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  seeking = false;
  readyState = 4;
  currentSrc = "blob:film";
  error: unknown = null;
  buffered = { length: 1, start: () => 0, end: () => 30 };
  plays = 0;
  /** Как браузер: play() без клика отклоняется. */
  blocked = false;
  readonly ownerDocument = new FakeDocument();
  /** Ждущий следующего кадра обработчик requestVideoFrameCallback. */
  private frameCallback: ((now: number, frame: FrameInfo) => void) | null =
    null;
  private readonly listeners = new Map<string, Set<() => void>>();

  requestVideoFrameCallback(
    callback: (now: number, frame: FrameInfo) => void,
  ): number {
    this.frameCallback = callback;
    return 7;
  }

  cancelVideoFrameCallback(handle: number): void {
    if (handle === 7) this.frameCallback = null;
  }

  /** Браузер показал кадр. */
  showFrame(mediaTime: number, expectedDisplayTime: number): void {
    const callback = this.frameCallback;
    this.frameCallback = null;
    callback?.(expectedDisplayTime, { mediaTime, expectedDisplayTime });
  }

  get waitsForFrame(): boolean {
    return this.frameCallback !== null;
  }

  play(): Promise<void> {
    this.plays += 1;
    if (this.blocked) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  get listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

let toWorker: ToWorker[];
let fromWorker: (message: FromWorker) => void;
let client: SyncClient;
let video: FakeVideo;
let bridge: PlayerBridge;

const command = (c: PlayerCommand) =>
  fromWorker({ type: "player:command", command: c });
const applied = () =>
  toWorker.flatMap((m) => (m.type === "player:applied" ? [m.rev] : []));
const reports = () =>
  toWorker.flatMap((m) => (m.type === "player:media" ? [m.media] : []));
const lastReport = (): MediaReport => reports()[reports().length - 1];
const count = (type: ToWorker["type"]) =>
  toWorker.filter((m) => m.type === type).length;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  toWorker = [];
  const port: WorkerPort = {
    post: (m) => toWorker.push(m),
    listen(handler) {
      fromWorker = handler;
    },
  };
  client = createSyncClient({ url: "ws://test/ws", startWorker: () => port });
  video = new FakeVideo();
  bridge = createPlayerBridge(client, video);
});

afterEach(() => {
  bridge.dispose();
  client.dispose();
  vi.useRealTimers();
});

describe("createPlayerBridge", () => {
  it("с заглушкой не работает: у неё нет воркера", () => {
    const stub = createStubSyncClient();
    expect(() => createPlayerBridge(stub, new FakeVideo())).toThrow(
      /createSyncClient/,
    );
    stub.dispose();
  });

  it("подключается к воркеру и сразу докладывает о плеере", () => {
    expect(count("player:attach")).toBe(1);
    expect(lastReport()).toMatchObject({
      readyState: 4,
      bufferedAheadMs: 30_000,
      playerState: "paused",
      hasSource: true,
      positionMs: 0,
    });
  });

  it("пауза: останавливает, встаёт на позицию и подтверждает", () => {
    video.paused = false;
    command({ kind: "pause", rev: 3, positionMs: 12_000 });
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(12);
    expect(applied()).toEqual([3]);
  });

  it("близко к позиции — не перематывает", () => {
    video.currentTime = 12.01;
    command({ kind: "pause", rev: 3, positionMs: 12_000 });
    expect(video.currentTime).toBe(12.01);
  });

  it("подготовка подтверждается, только когда кадры загружены", () => {
    video.readyState = 1;
    command({ kind: "prepare", rev: 4, positionMs: 5_000 });
    video.seeking = true;
    video.emit("seeking");
    expect(applied()).toEqual([]);
    expect(lastReport().playerState).toBe("seeking");
    video.seeking = false;
    video.readyState = 3;
    video.emit("seeked");
    expect(applied()).toEqual([4]);
  });

  it("без файла ничего не подтверждает", () => {
    video.currentSrc = "";
    command({ kind: "pause", rev: 1, positionMs: 0 });
    vi.advanceTimersByTime(1_000);
    expect(applied()).toEqual([]);
    expect(lastReport().hasSource).toBe(false);
  });

  it("старт в будущем: позиция заранее, play() чуть раньше якоря", () => {
    const atMain = performance.now() + 1_000;
    command({
      kind: "play",
      rev: 5,
      positionMs: 3_000,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    expect(video.currentTime).toBe(3);
    expect(video.plays).toBe(0);
    expect(applied()).toEqual([5]);
    vi.advanceTimersByTime(959);
    expect(video.plays).toBe(0);
    vi.advanceTimersByTime(1);
    expect(video.plays).toBe(1);
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(3); // успели: доматывать не нужно
  });

  it("опоздали к якорю — стартует сразу и догоняет комнату", () => {
    const atMain = performance.now() - 500;
    command({
      kind: "play",
      rev: 5,
      positionMs: 3_000,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    expect(video.plays).toBe(1);
    expect(video.currentTime).toBeCloseTo(3.54, 6); // 500 мс опоздания + запас на старт
  });

  it("уже играет: малый разрыв не трогает, большой — поправляет", () => {
    video.paused = false;
    video.currentTime = 10;
    const atMain = performance.now();
    command({
      kind: "play",
      rev: 6,
      positionMs: 10_100,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    expect(video.currentTime).toBe(10);
    command({
      kind: "play",
      rev: 7,
      positionMs: 12_000,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    expect(video.currentTime).toBe(12);
    expect(video.plays).toBe(0);
  });

  it("новая команда отменяет запланированный старт", () => {
    const atMain = performance.now() + 1_000;
    command({
      kind: "play",
      rev: 5,
      positionMs: 0,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    command({ kind: "pause", rev: 6, positionMs: 0 });
    vi.advanceTimersByTime(2_000);
    expect(video.plays).toBe(0);
  });

  it("автозапуск запрещён: плеер стоит, unlock просит команду заново", async () => {
    video.blocked = true;
    command({
      kind: "play",
      rev: 5,
      positionMs: 0,
      atMain: performance.now(),
      rate: 1,
      leadMs: 40,
    });
    await Promise.resolve();
    expect(video.paused).toBe(true);
    video.blocked = false;
    await bridge.unlock();
    expect(video.plays).toBe(2); // play() внутри клика…
    expect(video.paused).toBe(true); // …и сразу pause()
    expect(count("player:reload")).toBe(1);
  });

  it("перемотка от воркера меняет только позицию", () => {
    video.paused = false;
    command({ kind: "seek", positionMs: 42_000 });
    expect(video.currentTime).toBe(42);
    expect(video.paused).toBe(false);
  });

  it("докладывает: буферизация, игра, раз в 250 мс", () => {
    video.paused = false;
    video.emit("waiting");
    expect(lastReport().playerState).toBe("buffering");
    video.emit("playing");
    expect(lastReport().playerState).toBe("playing");
    const before = reports().length;
    vi.advanceTimersByTime(1_000);
    expect(reports().length - before).toBe(4);
  });

  it("новый файл: подтверждение заново и просьба прислать команду", () => {
    video.readyState = 1;
    command({ kind: "prepare", rev: 4, positionMs: 0 });
    video.emit("loadstart");
    expect(count("player:reload")).toBe(1);
    video.readyState = 4;
    video.emit("canplay");
    expect(applied()).toEqual([]); // ждём новую команду
    command({ kind: "prepare", rev: 4, positionMs: 0 });
    expect(applied()).toEqual([4]);
  });

  it("события video не превращаются в команды комнаты", () => {
    for (const type of ["play", "pause", "seeked", "playing", "ended"]) {
      video.emit(type);
    }
    expect(toWorker.some((m) => m.type === "intent")).toBe(false);
  });

  it("опережение старта берёт из команды", () => {
    const atMain = performance.now() + 1_000;
    command({
      kind: "play",
      rev: 5,
      positionMs: 0,
      atMain,
      rate: 1,
      leadMs: 100,
    });
    vi.advanceTimersByTime(899);
    expect(video.plays).toBe(0);
    vi.advanceTimersByTime(1);
    expect(video.plays).toBe(1);
  });

  it("скорость от контура меняет только скорость", () => {
    video.paused = false;
    video.currentTime = 10;
    command({ kind: "rate", rate: 1.02 });
    expect(video.playbackRate).toBe(1.02);
    expect(video.currentTime).toBe(10);
    expect(video.paused).toBe(false);
    expect(applied()).toEqual([]);
  });

  const samples = () =>
    toWorker.flatMap((m) => (m.type === "player:sample" ? [m] : []));

  it("с каждого показанного кадра шлёт замер, пока видео идёт", () => {
    expect(video.waitsForFrame).toBe(true);
    video.showFrame(1.5, 1_234); // на паузе замер не нужен…
    expect(samples()).toEqual([]);
    video.paused = false;
    video.showFrame(1.55, 1_276); // …а в игре — каждый кадр
    expect(samples()).toEqual([
      { type: "player:sample", positionMs: 1_550, atMain: 1_276, frame: true },
    ]);
    expect(video.waitsForFrame).toBe(true); // ждёт следующий
  });

  it("по запросу воркера присылает позицию, если видео идёт", () => {
    command({ kind: "sample" });
    expect(samples()).toEqual([]);
    video.paused = false;
    video.currentTime = 2;
    command({ kind: "sample" });
    expect(samples()).toEqual([
      {
        type: "player:sample",
        positionMs: 2_000,
        atMain: performance.now(),
        frame: false,
      },
    ]);
  });

  it("вкладка вернулась на экран — сообщает воркеру", () => {
    video.ownerDocument.setVisible(false);
    expect(count("player:visible")).toBe(0);
    video.ownerDocument.setVisible(true);
    expect(count("player:visible")).toBe(1);
  });

  it("dispose снимает слушатели и таймеры и отключается от воркера", () => {
    const atMain = performance.now() + 1_000;
    command({
      kind: "play",
      rev: 5,
      positionMs: 0,
      atMain,
      rate: 1,
      leadMs: 40,
    });
    bridge.dispose();
    expect(video.listenerCount).toBe(0);
    expect(video.ownerDocument.listeners.size).toBe(0);
    expect(video.waitsForFrame).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(count("player:detach")).toBe(1);
    command({ kind: "pause", rev: 6, positionMs: 0 });
    expect(applied()).toEqual([5]);
    bridge.dispose();
    expect(count("player:detach")).toBe(1);
  });
});
