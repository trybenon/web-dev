import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientExamples,
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
    expect(first.close).toHaveBeenCalledWith(4001, "Session replaced");
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
  it("keeps room identities independent and session fields private", () => {
    const first = create();
    const second = client("c2");
    service.onMessage(second, {
      type: "room:create",
      payload: { name: "Second" },
    });
    const a = state(first);
    const b = state(second);
    expect(
      new Set([
        a.roomId,
        a.you,
        a.sessionToken,
        b.roomId,
        b.you,
        b.sessionToken,
      ]).size,
    ).toBe(6);
    service.onMessage(second, { type: "room:leave", payload: {} });
    service.onMessage(second, {
      type: "room:join",
      payload: { roomId: a.roomId, name: "Second" },
    });
    expect(state(second).peers).toHaveLength(2);
    expect(
      state(second).peers.every(
        (p) => !("sessionToken" in p) && !("connectionId" in p),
      ),
    ).toBe(true);
    expect(state(second).sessionToken).not.toBe(a.sessionToken);
  });

  it("ignores repeated room entry commands from an existing participant", () => {
    const first = create();
    const original = state(first);
    const count = first.messages.length;
    service.onMessage(first, {
      type: "room:create",
      payload: { name: "Duplicate" },
    });
    service.onMessage(first, {
      type: "room:join",
      payload: { roomId: "missing", name: "Duplicate" },
    });
    expect(first.messages).toHaveLength(count);
    const other = client("c2");
    service.onMessage(other, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Other" },
    });
    expect(state(other).peers).toHaveLength(2);
    expect(state(other).peers[0]?.peerId).toBe(original.you);
  });

  it("reserves a place during disconnect and restores it in a full room", () => {
    const first = create();
    const original = state(first);
    for (let i = 2; i <= 4; i++)
      service.onMessage(client(`c${i}`), {
        type: "room:join",
        payload: { roomId: original.roomId, name: `Peer ${i}` },
      });
    service.onClose(first);
    vi.advanceTimersByTime(29_999);
    const fifth = client("c5");
    service.onMessage(fifth, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Fifth" },
    });
    expect(fifth.messages.at(-1)).toMatchObject({
      type: "error",
      payload: { code: "room_full" },
    });
    const restored = client("restored");
    service.onMessage(restored, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(restored).you).toBe(original.you);
    expect(state(restored).peers).toHaveLength(4);
    service.onMessage(restored, { type: "room:leave", payload: {} });
    service.onMessage(fifth, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Fifth" },
    });
    expect(state(fifth).peers).toHaveLength(4);
  });

  it("deletes an empty room when its last reservation expires", () => {
    const first = create();
    const original = state(first);
    service.onClose(first);
    vi.advanceTimersByTime(30_000);
    const other = client("other");
    service.onMessage(other, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Other" },
    });
    expect(other.messages.at(-1)).toMatchObject({
      type: "error",
      payload: { code: "room_not_found" },
    });
  });

  it("does not extend the reservation on a repeated close callback", () => {
    const first = create();
    const original = state(first);
    service.onClose(first);
    vi.advanceTimersByTime(29_000);
    service.onClose(first);
    vi.advanceTimersByTime(1_000);
    const other = client("other");
    service.onMessage(other, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Other" },
    });
    expect(other.messages.at(-1)).toMatchObject({
      type: "error",
      payload: { code: "room_not_found" },
    });
  });

  it("never uses a token from another room to replace its owner", () => {
    const first = create();
    const original = state(first);
    const before = first.messages.length;
    const owner = client("owner");
    service.onMessage(owner, {
      type: "room:create",
      payload: { name: "Owner" },
    });
    const other = client("other");
    service.onMessage(other, {
      type: "room:join",
      payload: {
        roomId: state(owner).roomId,
        name: "Other",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(other).you).not.toBe(original.you);
    expect(state(other).sessionToken).not.toBe(original.sessionToken);
    expect(state(other).peers).toHaveLength(2);
    expect(first.close).not.toHaveBeenCalled();
    expect(first.messages).toHaveLength(before);
  });

  it("invalidates a token immediately after an explicit leave", () => {
    const first = create();
    const original = state(first);
    const keeper = client("keeper");
    service.onMessage(keeper, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Keeper" },
    });
    service.onMessage(first, { type: "room:leave", payload: {} });
    service.onMessage(first, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(first).you).not.toBe(original.you);
    expect(state(first).sessionToken).not.toBe(original.sessionToken);
    expect(state(first).peers).toHaveLength(2);
  });

  it("rejects restoration at the deadline even if the timer has not run", () => {
    const first = create();
    const original = state(first);
    const keeper = client("keeper");
    service.onMessage(keeper, {
      type: "room:join",
      payload: { roomId: original.roomId, name: "Keeper" },
    });
    service.onClose(first);
    vi.setSystemTime(30_000);
    const other = client("other");
    service.onMessage(other, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    expect(state(other).you).not.toBe(original.you);
    expect(
      keeper.messages.some(
        (m) => m.type === "room:peer_left" && m.payload.peerId === original.you,
      ),
    ).toBe(true);
  });

  it("updates presence only from the current connection", () => {
    const first = create();
    const original = state(first);
    const replacement = client("replacement");
    service.onMessage(replacement, {
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Gleb",
        sessionToken: original.sessionToken,
      },
    });
    service.onMessage(replacement, {
      type: "presence:update",
      payload: { ...clientExamples.presenceUpdate.payload, rttMs: 42 },
    });
    service.onMessage(first, {
      type: "presence:update",
      payload: { ...clientExamples.presenceUpdate.payload, rttMs: 999 },
    });
    expect(first.messages.at(-1)).toMatchObject({
      type: "error",
      payload: { code: "not_joined" },
    });
    service.syncPresence();
    expect(replacement.messages.at(-1)).toMatchObject({
      type: "presence:sync",
      payload: {
        peers: [{ peerId: original.you, rttMs: 42, hasSource: true }],
      },
    });
  });

  it("routes source and playback commands and releases a barrier on tick", () => {
    const first = create();
    const original = state(first);
    service.onMessage(first, clientExamples.sourcePropose);
    const source = first.messages.findLast((m) => m.type === "source:state");
    if (source?.type !== "source:state" || !source.payload.source)
      throw new Error("Expected source");
    service.onMessage(first, {
      type: "source:matched",
      payload: { sourceRev: source.payload.source.rev, ok: true },
    });
    expect(first.messages.at(-1)).toMatchObject({
      type: "source:state",
      payload: { checks: [{ peerId: original.you, ok: true }] },
    });
    service.onMessage(first, {
      type: "playback:intent",
      payload: { action: "seek", positionMs: 1000 },
    });
    expect(first.messages.at(-1)).toMatchObject({
      type: "playback:state",
      payload: { status: "paused", positionMs: 1000 },
    });
    service.onMessage(first, {
      type: "presence:update",
      payload: clientExamples.presenceUpdate.payload,
    });
    service.onMessage(first, {
      type: "playback:intent",
      payload: { action: "play" },
    });
    expect(first.messages.at(-1)?.type).toBe("playback:hold");
    vi.advanceTimersByTime(10_000);
    service.tick();
    expect(first.messages.at(-1)).toMatchObject({
      type: "playback:state",
      payload: { status: "playing", positionMs: 1000 },
    });
  });

  it("ignores a leave without membership and rejects other room commands", () => {
    const outsider = client("outsider");
    service.onMessage(outsider, { type: "room:leave", payload: {} });
    expect(outsider.messages).toEqual([]);
    service.onMessage(outsider, {
      type: "playback:intent",
      payload: { action: "pause" },
    });
    expect(outsider.messages).toMatchObject([
      { type: "error", payload: { code: "not_joined" } },
    ]);
  });

  it("cancels reservation timers when the service is disposed", () => {
    const first = create();
    service.onClose(first);
    expect(vi.getTimerCount()).toBe(1);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
