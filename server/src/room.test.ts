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