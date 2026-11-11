import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverExamples } from "@watch-together/shared";
import { createSyncClient, playerChannel, type WorkerPort } from "./client";
import { createStubSyncClient } from "./stub";
import type { SyncClient, SyncState } from "./types";
import type { FromWorker, ToWorker } from "./worker-protocol";

let toWorker: ToWorker[];
let fromWorker: (message: FromWorker) => void;
let client: SyncClient;

function fakeWorker(): WorkerPort {
  return {
    post: (message) => toWorker.push(message),
    listen(handler) {
      fromWorker = handler;
    },
  };
}

const roomState: SyncState = {
  connection: "online",
  room: { roomId: "k7f3q", you: "peer-petya", peers: [] },
  playback: serverExamples.playbackState.payload,
  hold: null,
  source: { source: null, checks: [] },
};

beforeEach(() => {
  toWorker = [];
  client = createSyncClient({ url: "ws://test/ws", startWorker: fakeWorker });
});

afterEach(() => {
  client.dispose();
  vi.unstubAllGlobals();
});

describe("createSyncClient", () => {
  it("сразу подключается по адресу", () => {
    expect(toWorker).toEqual([{ type: "connect", url: "ws://test/ws" }]);
    expect(client.getState().connection).toBe("connecting");
  });

  it("по умолчанию — /ws на том же хосте, wss для https", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "kromo.online" });
    toWorker = [];
    const other = createSyncClient({ startWorker: fakeWorker });
    expect(toWorker[0]).toEqual({
      type: "connect",
      url: "wss://kromo.online/ws",
    });
    other.dispose();
  });

  it("состояние из воркера — подписчикам и в getState", () => {
    const seen: SyncState[] = [];
    const unsubscribe = client.subscribe((s) => seen.push(s));
    expect(seen).toHaveLength(1); // сразу текущее
    fromWorker({ type: "state", state: roomState });
    expect(client.getState()).toBe(roomState);
    expect(seen[1]).toBe(roomState);
    unsubscribe();
    fromWorker({ type: "state", state: { ...roomState, hold: null } });
    expect(seen).toHaveLength(2);
  });

  it("serverNow — время страницы плюс смещение из воркера", () => {
    fromWorker({ type: "clock", serverOffset: 1_000_000 });
    const before = performance.now();
    const value = client.serverNow();
    expect(value).toBeGreaterThanOrEqual(before + 1_000_000);
    expect(value).toBeLessThanOrEqual(performance.now() + 1_000_000);
  });

  it("на пинг часов отвечает сразу своим временем", () => {
    const before = performance.now();
    fromWorker({ type: "clock:ping", t0: 42 });
    const pong = toWorker.pop();
    expect(pong).toMatchObject({ type: "clock:pong", t0: 42 });
    expect(pong?.type === "clock:pong" && pong.t1).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("команды интерфейса уходят в воркер", () => {
    client.createRoom("Аня");
    client.joinRoom("k7f3q", "Петя");
    client.play();
    client.pause();
    client.seek(5_000);
    client.proposeSource(serverExamples.sourceState.payload.source);
    client.reportSourceMatch(3, false);
    client.leaveRoom();
    expect(toWorker.slice(1)).toEqual([
      { type: "createRoom", name: "Аня" },
      { type: "joinRoom", roomId: "k7f3q", name: "Петя" },
      { type: "intent", intent: { action: "play" } },
      { type: "intent", intent: { action: "pause" } },
      { type: "intent", intent: { action: "seek", positionMs: 5_000 } },
      {
        type: "proposeSource",
        offer: serverExamples.sourceState.payload.source,
      },
      { type: "reportSourceMatch", sourceRev: 3, ok: false },
      { type: "leaveRoom" },
    ]);
  });

  it("ошибки — слушателям onError", () => {
    const errors: string[] = [];
    const off = client.onError((e) => errors.push(e.code));
    fromWorker({
      type: "error",
      error: { code: "room_full", message: "full" },
    });
    off();
    fromWorker({
      type: "error",
      error: { code: "room_not_found", message: "gone" },
    });
    expect(errors).toEqual(["room_full"]);
  });

  it("dispose: closed, воркеру — dispose, дальше тишина", () => {
    const seen: SyncState[] = [];
    client.subscribe((s) => seen.push(s));
    client.dispose();
    expect(toWorker[toWorker.length - 1]).toEqual({ type: "dispose" });
    expect(client.getState().connection).toBe("closed");
    expect(seen[seen.length - 1].connection).toBe("closed");
    client.play();
    fromWorker({ type: "state", state: roomState });
    expect(toWorker.some((m) => m.type === "intent")).toBe(false);
    expect(client.getState().connection).toBe("closed");
    client.dispose(); // второй раз ничего не делает
    expect(toWorker.filter((m) => m.type === "dispose")).toHaveLength(1);
  });
});

describe("канал к плееру", () => {
  it("есть только у настоящего клиента", () => {
    const stub = createStubSyncClient();
    expect(playerChannel(client)).toBeDefined();
    expect(playerChannel(stub)).toBeUndefined();
    stub.dispose();
  });

  it("передаёт команды плееру и его отчёты воркеру", () => {
    const channel = playerChannel(client)!;
    const commands: unknown[] = [];
    channel.attach((command) => commands.push(command));
    fromWorker({
      type: "player:command",
      command: { kind: "pause", rev: 1, positionMs: 0 },
    });
    const media = {
      readyState: 4,
      bufferedAheadMs: 1_000,
      playerState: "paused" as const,
      hasSource: true,
      positionMs: 0,
      atMain: 1,
    };
    channel.report(media);
    channel.applied(1);
    channel.reload();
    channel.sample(1_500, 2, true);
    channel.visible();
    channel.detach();
    fromWorker({
      type: "player:command",
      command: { kind: "pause", rev: 2, positionMs: 0 },
    });
    expect(commands).toEqual([{ kind: "pause", rev: 1, positionMs: 0 }]);
    expect(toWorker.slice(1)).toEqual([
      { type: "player:attach" },
      { type: "player:media", media },
      { type: "player:applied", rev: 1 },
      { type: "player:reload" },
      { type: "player:sample", positionMs: 1_500, atMain: 2, frame: true },
      { type: "player:visible" },
      { type: "player:detach" },
    ]);
  });
});
