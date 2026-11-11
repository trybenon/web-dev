import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientExamples, serverExamples } from "@watch-together/shared";
import {
  createStubPlayerBridge,
  createStubSyncClient,
  STUB_ROOM_IDS,
  type VideoLike,
} from "./stub";
import { positionAt } from "./timeline";
import type { SyncClient, SyncError, SyncState } from "./types";

const LATENCY = 100;
const HOLD = 1500;
const offer = clientExamples.sourcePropose.payload;

/** Настоящая дата: на часах около нуляБля баги со временем прячутся. */
const NOW = Date.parse("2026-11-08T12:00:00Z");

let client: SyncClient;
let errors: SyncError[];

client = createStubSyncClient({ latencyMs: LATENCY, holdMs: HOLD });

function state(): SyncState {
  return client.getState();
}

/** Создать комнату и дождаться ответа «сервера». */
function created(name = "Аня"): void {
  client.createRoom(name);
  vi.advanceTimersByTime(LATENCY);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  client = createStubSyncClient({ latencyMs: LATENCY });
  errors = [];
  client.onError((e) => errors.push(e));
});

afterEach(() => {
  client.dispose();
  vi.useRealTimers();
});

describe("подписка", () => {
  it("subscribe сразу отдает текущее состояние", () => {
    const seen: SyncState[] = [];
    client.subscribe((s) => seen.push(s));
    expect(seen).toEqual([client.getState()]);
    expect(seen[0]).toMatchObject({ connection: "connecting", room: null });
  });

  it("после отписки состояние больше не приходит", () => {
    const seen: SyncState[] = [];
    const unsubscribe = client.subscribe((s) => seen.push(s));
    unsubscribe();
    client.dispose();
    expect(seen).toHaveLength(1);
  });

  it("dispose закрывает связь, повторный dispose ничего не делает", () => {
    const seen: SyncState[] = [];
    client.subscribe((s) => seen.push(s));
    client.dispose();
    client.dispose();
    expect(seen.map((state) => state.connection)).toEqual([
      "connecting",
      "closed",
    ]);
    expect(errors).toEqual([]);
  });
});

describe("вход в комнату", () => {
  it("createRoom отвечает с задержкой, как сервер", () => {
    client.createRoom("  Аня  ");
    expect(state().room).toBeNull();

    vi.advanceTimersByTime(LATENCY);
    const room = state().room;
    expect(room?.peers).toEqual([
      { peerId: room?.you, name: "Аня", connection: "online", presence: null },
    ]);
    expect(state().playback).toEqual({
      ...serverExamples.playbackStateInitial.payload,
      anchorServerTime: Date.now(),
    });
  });

  it("подключение тоже идёт с задержкой", () => {
    expect(state().connection).toBe("connecting");
    vi.advanceTimersByTime(LATENCY);
    expect(state().connection).toBe("online");
  });

  it("повторный вход из комнаты игнорируется, как на сервере", () => {
    created("Аня");
    const first = state().room;
    client.createRoom("Вася");
    client.joinRoom("k7f3q", "Вася");
    vi.advanceTimersByTime(LATENCY);
    expect(state().room).toBe(first);
    expect(errors).toEqual([]);
  });

  it("пустое имя — ошибка", () => {
    client.createRoom("   ");
    vi.advanceTimersByTime(LATENCY);
    expect(state().room).toBeNull();
    expect(errors.map((e) => e.code)).toEqual(["invalid_message"]);
  });

  it("joinRoom показывает участников с готовностью", () => {
    client.joinRoom("k7f3q", "Вася");
    vi.advanceTimersByTime(LATENCY);
    const room = state().room;
    expect(room?.roomId).toBe("k7f3q");
    const me = room?.peers.find((p) => p.peerId === room.you);
    expect(me?.name).toBe("Вася");
    // новичок файл ещё не выбирал: своей сверки у него нет
    expect(state().source.checks.some((c) => c.peerId === room?.you)).toBe(
      false,
    );
    expect(room?.peers.every((p) => p.presence !== null)).toBe(true);
    expect(state().playback?.anchorServerTime).toBe(Date.now());
  });

  it.each([
    [STUB_ROOM_IDS.missing, "room_not_found"],
    [STUB_ROOM_IDS.full, "room_full"],
  ])("комната %s → ошибка %s", (roomId, code) => {
    client.joinRoom(roomId, "Вася");
    vi.advanceTimersByTime(LATENCY);
    expect(state().room).toBeNull();
    expect(errors.map((e) => e.code)).toEqual([code]);
  });

  it("leaveRoom очищает состояние, повторный выход ничего не делает", () => {
    created();
    client.leaveRoom();
    client.leaveRoom();
    vi.advanceTimersByTime(LATENCY);
    expect(state()).toMatchObject({ room: null, playback: null, hold: null });
    expect(errors).toEqual([]);
  });

  it("dispose отменяет ответы, которые ещё «в пути»", () => {
    client.createRoom("Аня");
    client.dispose();
    vi.advanceTimersByTime(LATENCY);
    expect(state().room).toBeNull();
  });
});

describe("воспроизведение", () => {
  it("команды вне комнаты → not_joined", () => {
    client.play();
    vi.advanceTimersByTime(LATENCY);
    expect(errors.map((e) => e.code)).toEqual(["not_joined"]);
  });

  it("play проходит через удержание: waiting → playing", () => {
    created();
    client.play();
    vi.advanceTimersByTime(LATENCY);
    expect(state().playback).toMatchObject({ status: "waiting", rev: 1 });
    expect(state().hold).toMatchObject({ waitingFor: [], reason: "buffering" });

    vi.advanceTimersByTime(HOLD);
    expect(state().playback).toMatchObject({ status: "playing", rev: 2 });
    expect(state().hold).toBeNull();
  });

  it("в чужой комнате ждём остальных участников", () => {
    client.joinRoom("k7f3q", "Вася");
    vi.advanceTimersByTime(LATENCY);
    client.pause();
    client.play();
    vi.advanceTimersByTime(LATENCY);
    expect(state().hold?.waitingFor).toEqual(["peer-anya"]);
  });

  it("pause запоминает позицию по якорю, setBy — я", () => {
    created();
    client.play();
    vi.advanceTimersByTime(LATENCY + HOLD);
    vi.advanceTimersByTime(4_000);

    client.pause();
    vi.advanceTimersByTime(LATENCY);
    expect(state().playback).toMatchObject({
      status: "paused",
      positionMs: 4_000 + LATENCY,
      setBy: state().room?.you,
    });
  });

  it("пауза на паузе ничего не меняет", () => {
    created();
    client.pause();
    vi.advanceTimersByTime(LATENCY);
    expect(state().playback?.rev).toBe(0);
  });

  it("seek на паузе меняет позицию, во время игры — через удержание", () => {
    created();
    client.seek(60_000);
    vi.advanceTimersByTime(LATENCY);
    expect(state().playback).toMatchObject({
      status: "paused",
      positionMs: 60_000,
    });

    client.play();
    vi.advanceTimersByTime(LATENCY + HOLD);
    client.seek(120_000);
    vi.advanceTimersByTime(LATENCY);
    expect(state().playback).toMatchObject({
      status: "waiting",
      positionMs: 120_000,
    });
  });

  it("удержание снимается, если состояние сменилось раньше", () => {
    created();
    client.play();
    vi.advanceTimersByTime(LATENCY);
    client.pause();
    vi.advanceTimersByTime(LATENCY + HOLD);
    expect(state().playback?.status).toBe("paused");
    expect(state().hold).toBeNull();
  });

  it("в чужой комнате позиция идёт от момента входа", () => {
    client.joinRoom("k7f3q", "Вася");
    vi.advanceTimersByTime(LATENCY + 2_000);
    const playback = state().playback;
    expect(playback && positionAt(playback, client.serverNow())).toBe(
      serverExamples.roomState.payload.playback.positionMs + 2_000,
    );
  });
});

describe("источник", () => {
  it("смена источника увеличивает номер, сбрасывает сверки и позицию", () => {
    client.joinRoom("k7f3q", "Вася");
    vi.advanceTimersByTime(LATENCY);
    const before = state().source.source?.rev ?? 0;

    client.proposeSource(offer);
    vi.advanceTimersByTime(LATENCY);
    expect(state().source.source?.rev).toBe(before + 1);
    expect(state().source.checks).toEqual([]);
    expect(state().playback).toMatchObject({ status: "paused", positionMs: 0 });
  });

  it("сверка засчитывается только для текущего номера источника", () => {
    created();
    client.proposeSource(offer);
    vi.advanceTimersByTime(LATENCY);
    const oldRev = state().source.source?.rev ?? 0;

    client.proposeSource(offer);
    client.reportSourceMatch(oldRev, true);
    vi.advanceTimersByTime(LATENCY);
    expect(state().source.checks).toEqual([]);

    client.reportSourceMatch(oldRev + 1, false);
    client.reportSourceMatch(oldRev + 1, true);
    vi.advanceTimersByTime(LATENCY);
    expect(state().source.checks).toEqual([
      { peerId: state().room?.you, ok: true },
    ]);
  });
});

describe("заглушка моста к плееру", () => {
  function fakeVideo(): VideoLike {
    const video = {
      currentTime: 0,
      paused: true,
      play: vi.fn(() => {
        video.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(() => {
        video.paused = true;
      }),
    };
    return video;
  }

  it("ставит video в состояние комнаты и отключается по dispose", () => {
    const video = fakeVideo();
    const bridge = createStubPlayerBridge(client, video);
    created();
    client.seek(30_000);
    vi.advanceTimersByTime(LATENCY);
    expect(video.currentTime).toBe(30);

    client.play();
    vi.advanceTimersByTime(LATENCY + HOLD);
    expect(video.play).toHaveBeenCalledTimes(1);

    client.pause();
    vi.advanceTimersByTime(LATENCY);
    expect(video.pause).toHaveBeenCalledTimes(1);

    bridge.dispose();
    client.play();
    vi.advanceTimersByTime(LATENCY + HOLD);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("unlock коротко запускает видео и ставит на паузу", async () => {
    const video = fakeVideo();
    const bridge = createStubPlayerBridge(client, video);
    await bridge.unlock();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(true);
  });

  it("unlock не бросает, если браузер не дал запустить", async () => {
    const video = fakeVideo();
    video.play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    const bridge = createStubPlayerBridge(client, video);
    await expect(bridge.unlock()).resolves.toBeUndefined();
  });

  it("запрет автозапуска не роняет мост", async () => {
    const video = fakeVideo();
    video.play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    createStubPlayerBridge(client, video);
    created();
    client.play();
    vi.advanceTimersByTime(LATENCY + HOLD);
    await Promise.resolve();
    expect(video.play).toHaveBeenCalled();
  });
});
