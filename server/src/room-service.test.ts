import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseServerMessage,
  type RoomId,
  type ServerMessage,
} from "@watch-together/shared";
import { RoomService } from "./room-service.js";
import type { GatewayClient } from "./ws-gateway.js";

function client(connectionId: string) {
  let roomId: RoomId | null = null;
  const messages: ServerMessage[] = [];
  const result: GatewayClient & { messages: ServerMessage[] } = {
    connectionId,
    get roomId() {
      return roomId;
    },
    messages,
    send: vi.fn((message: ServerMessage) => {
      expect(parseServerMessage(JSON.stringify(message)).ok).toBe(true);
      messages.push(message);
    }),
    joinRoom: vi.fn((next: RoomId) => {
      roomId = next;
    }),
    leaveRoom: vi.fn(() => {
      roomId = null;
    }),
    close: vi.fn(),
    broadcast: vi.fn(),
  };
  return result;
}
function state(c: ReturnType<typeof client>) {
  const message = c.messages.findLast((m) => m.type === "room:state");
  if (message?.type !== "room:state") throw new Error("Expected room state");
  return message.payload;
}
describe("RoomService", () => {
  let service: RoomService;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    service = new RoomService(() => Date.now());
  });
  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });
  function create() {
    const c = client("c1");
    service.onMessage(c, { type: "room:create", payload: { name: "Gleb" } });
    return c;
  }
  it("creates a room and notifies existing peers about a join", () => {
    const first = create();
    const second = client("c2");
    service.onMessage(second, {
      type: "room:join",
      payload: { roomId: state(first).roomId, name: "Vlad" },
    });
    expect(state(second).peers).toHaveLength(2);
    expect(
      first.messages.some(
        (m) =>
          m.type === "room:peer_joined" &&
          m.payload.peer.peerId === state(second).you,
      ),
    ).toBe(true);
  });
  it("rejects the fifth participant and a missing room", () => {
    const first = create();
    for (let i = 2; i <= 4; i++)
      service.onMessage(client("c" + i), {
        type: "room:join",
        payload: { roomId: state(first).roomId, name: "Peer" + i },
      });
    const fifth = client("c5");
    service.onMessage(fifth, {
      type: "room:join",
      payload: { roomId: state(first).roomId, name: "Fifth" },
    });
    expect(fifth.messages).toMatchObject([
      { type: "error", payload: { code: "room_full" } },
    ]);
    const missing = client("missing");
    service.onMessage(missing, {
      type: "room:join",
      payload: { roomId: "missing", name: "Missing" },
    });
    expect(missing.messages).toMatchObject([
      { type: "error", payload: { code: "room_not_found" } },
    ]);
  });
  it("removes an empty room immediately after an explicit leave", () => {
    const first = create();
    const roomId = state(first).roomId;
    service.onMessage(first, { type: "room:leave", payload: {} });
    expect(first.roomId).toBeNull();
    const second = client("c2");
    service.onMessage(second, {
      type: "room:join",
      payload: { roomId, name: "Vlad" },
    });
    expect(second.messages).toMatchObject([
      { type: "error", payload: { code: "room_not_found" } },
    ]);
  });
  it("resumes within 30 seconds and cancels removal", () => {
    const first = create();
    const original = state(first);
    service.onClose(first);
    vi.advanceTimersByTime(29999);
    const second = client("c2");
    service.onMessage(second, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(second).you).toBe(original.you);
    expect(state(second).sessionToken).toBe(original.sessionToken);
    vi.advanceTimersByTime(30001);
    service.syncPresence();
    const message = second.messages.at(-1);
    expect(message).toMatchObject({
      type: "presence:sync",
      payload: { peers: [{ peerId: original.you, connection: "online" }] },
    });
  });
  it("closes the previous connection and ignores its late close callback", () => {
    const first = create();
    const original = state(first);
    const second = client("c2");
    service.onMessage(second, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(first.close).toHaveBeenCalledWith(1000, "Session replaced");
    expect(first.roomId).toBeNull();
    service.onClose(first);
    vi.advanceTimersByTime(30000);
    service.syncPresence();
    expect(second.messages.at(-1)).toMatchObject({
      type: "presence:sync",
      payload: { peers: [{ peerId: original.you, connection: "online" }] },
    });
  });
  it("broadcasts reconnecting and removes an expired participant", () => {
    const first = create();
    const second = client("c2");
    const roomId = state(first).roomId;
    service.onMessage(second, {
      type: "room:join",
      payload: { roomId, name: "Vlad" },
    });
    const peerId = state(second).you;
    service.onClose(second);
    const notification = first.messages.at(-1);
    if (notification?.type !== "presence:sync")
      throw new Error("Expected presence");
    expect(notification.payload.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peerId, connection: "reconnecting" }),
      ]),
    );
    vi.advanceTimersByTime(30000);
    expect(
      first.messages.some(
        (m) => m.type === "room:peer_left" && m.payload.peerId === peerId,
      ),
    ).toBe(true);
  });
  it("treats an expired token as a new join when the room still exists", () => {
    const first = create();
    const original = state(first);
    const keeper = client("keeper");
    service.onMessage(keeper, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Keeper" },
    });
    service.onClose(first);
    vi.advanceTimersByTime(30000);
    const returning = client("new");
    service.onMessage(returning, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(returning).you).not.toBe(original.you);
    expect(state(returning).sessionToken).not.toBe(original.sessionToken);
  });
});
