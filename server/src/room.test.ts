import { describe, expect, it } from "vitest";
import { Room, type Outbound } from "./room.js";


/** Типы сообщений по порядку — так проще сравнивать. */
const types = (out: Outbound[]): string[] => out.map((o) => o.msg.type);

/** Комната с участниками p1…pn, создана в момент 0. */
function roomWith(n: number): Room {
  const room = new Room("r", 0);
  for (let i = 1; i <= n; i++) room.join(`p${i}`, `P${i}`, `token-${i}`);
  return room;
}

describe("Room: начальное состояние", () => {
  it("новая комната на паузе в начале, якорь - момент создания", () => {
    const room = new Room("r", 1_000);
    expect(room.playback).toEqual({
      rev: 0,
      status: 'paused',
      positionMs: 0,
      anchorServerTime: 1_000,
      rate: 1,
      setBy: null,
    });
  });
  it("playback отдает копию, снаружи состояние не поменять", () => {
    const room = new Room("r", 0);
    room.playback.positionMs = 99;
    expect(room.playback.positionMs).toBe(0);
  });
  it("на паузе позиция стоит", () => {
    expect(new Room("r", 0).positionAt(60_000)).toBe(0);
  });
});

describe("Room: вход и выход", () => {
  it("новичок получает снимок, остальные — уведомление", () => {
    const room = new Room("r", 0);
    room.join("a", "Аня", "token-a");
    const out = room.join("b", "Боря", "token-b");
    expect(types(out)).toEqual(["room:state", "room:peer_joined"]);
    expect(out[0]).toMatchObject({
      to: "b",
      msg: {
        payload: {
          roomId: "r",
          you: "b",
          sessionToken: "token-b",
          peers: [
            { peerId: "a", name: "Аня", connection: "online" },
            { peerId: "b", name: "Боря", connection: "online" },
          ],
          source: null,
        },
      },
    });
    expect(out[1]).toMatchObject({
      to: "all",
      except: "b",
      msg: { payload: { peer: { peerId: "b", name: "Боря" } } },
    });
    expect(room.size).toBe(2);
  });

  it("повторный вход игнорируется", () => {
    expect(roomWith(1).join("p1", "P1", "token-1")).toEqual([]);
  });

  it("пятый участник получает room_full", () => {
    const room = roomWith(4);
    const out = room.join("p5", "P5", "token-5");
    expect(out).toMatchObject([
      { to: "p5", msg: { type: "error", payload: { code: "room_full" } } },
    ]);
    expect(room.size).toBe(4);
  });

  it("выход: всем room:peer_left; выход незнакомца — пустой список", () => {
    const room = roomWith(2);
    expect(room.leave("p2")).toMatchObject([
      { to: "all", msg: { type: "room:peer_left", payload: { peerId: "p2" } } },
    ]);
    expect(room.size).toBe(1);
    expect(room.leave("x")).toEqual([]);
  });
});

describe("Room: намерения", () => {
  it("намерение не участника — not_joined", () => {
    const out = new Room("r", 0).intent("x", { action: "play" }, 0);
    expect(out).toMatchObject([
      { to: "x", msg: { type: "error", payload: { code: "not_joined" } } },
    ]);
  });

  it("если файла нет ни у кого, запуск без ожидания: waiting, потом playing", () => {
    const room = roomWith(2);
    const out = room.intent("p1", { action: "play" }, 1_000);
    expect(types(out)).toEqual(["playback:state", "playback:state"]);
    expect(out).toMatchObject([
      { msg: { payload: { rev: 1, status: "waiting" } } },
      { msg: { payload: { rev: 2, status: "playing" } } },
    ]);
    // якорь не раньше чем через 300 мс
    expect(room.playback).toMatchObject({
      anchorServerTime: 1_300,
      setBy: "p1",
    });
  });

  it("пауза во время игры запоминает позицию по якорю", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0); // якорь 300
    expect(room.positionAt(1_300)).toBe(1_000);
    room.intent("p1", { action: "pause" }, 1_300);
    expect(room.playback).toMatchObject({
      status: "paused",
      positionMs: 1_000,
      anchorServerTime: 1_300,
    });
  });

  it("до якоря позиция стоит", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0);
    expect(room.positionAt(100)).toBe(0);
  });

  it("перемотка на паузе просто сдвигает позицию", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "seek", positionMs: 5_000 }, 0);
    expect(room.playback).toMatchObject({
      rev: 1,
      status: "paused",
      positionMs: 5_000,
    });
  });

  it("повторные play и pause ничего не меняют", () => {
    const room = roomWith(1);
    expect(room.intent("p1", { action: "pause" }, 0)).toEqual([]);
    room.intent("p1", { action: "play" }, 1_000);
    expect(room.intent("p1", { action: "play" }, 2_000)).toEqual([]);
  });

  it("каждое изменение увеличивает rev", () => {
    const room = roomWith(1);
    const revs = [room.playback.rev];
    room.intent("p1", { action: "seek", positionMs: 100 }, 0);
    revs.push(room.playback.rev);
    room.intent("p1", { action: "play" }, 1_000);
    revs.push(room.playback.rev);
    expect(revs).toEqual([0, 1, 3]); // play: waiting (2) → playing (3)
  });

  it("вход посреди просмотра не трогает воспроизведение", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0);
    const before = room.playback;
    room.join("p2", "P2", "token-2");
    expect(room.playback).toEqual(before);
  });
});