import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServerMessage } from "@watch-together/shared";
import { RoomStore } from "./rooms.js";

describe("RoomStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("builds a protocol-valid presence snapshot", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const joined = store.join(room.roomId, "Влад", "connection-2");

    if (!joined.ok) {
      throw new Error(`Join failed: ${joined.code}`);
    }

    const snapshot = store.presenceSnapshot(room.roomId);

    expect(snapshot).toBeDefined();

    if (!snapshot) {
      throw new Error("Expected a presence snapshot");
    }

    expect(parseServerMessage(JSON.stringify(snapshot)).ok).toBe(true);
    expect(snapshot.payload.peers).toHaveLength(2);

    expect(snapshot.payload.peers[0]).toMatchObject({
      peerId: member.peer.peerId,
      connection: "online",
      hasSource: false,
      appliedRev: -1,
    });

    expect(
      snapshot.payload.peers.every(
        (peer) => !("sessionToken" in peer) && !("connectionId" in peer),
      ),
    ).toBe(true);

    expect(store.presenceSnapshot("missing-room")).toBeUndefined();
  });

  it("updates presence only through the current connection", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const presence = {
      ...member.presence,
      readyState: 4,
      bufferedAheadMs: 5_000,
      hasSource: true,
      rttMs: 40,
    };

    expect(
      store.updatePresence(
        room.roomId,
        member.peer.peerId,
        "old-connection",
        presence,
      ),
    ).toBe(false);

    expect(member.presence.hasSource).toBe(false);

    expect(
      store.updatePresence(
        room.roomId,
        member.peer.peerId,
        "connection-1",
        presence,
      ),
    ).toBe(true);

    expect(store.presenceSnapshot(room.roomId)?.payload.peers[0]).toMatchObject(
      {
        peerId: member.peer.peerId,
        readyState: 4,
        bufferedAheadMs: 5_000,
        hasSource: true,
        rttMs: 40,
      },
    );

    presence.bufferedAheadMs = 0;

    expect(member.presence.bufferedAheadMs).toBe(5_000);
  });

  it("includes a reconnecting participant until their reservation expires", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const joined = store.join(room.roomId, "Влад", "connection-2");

    if (!joined.ok) {
      throw new Error(`Join failed: ${joined.code}`);
    }

    store.disconnect(room.roomId, member.peer.peerId, "connection-1");

    const disconnected = store
      .presenceSnapshot(room.roomId)
      ?.payload.peers.find((peer) => peer.peerId === member.peer.peerId);

    expect(disconnected?.connection).toBe("reconnecting");

    vi.advanceTimersByTime(30_000);

    const snapshot = store.presenceSnapshot(room.roomId);

    expect(snapshot?.payload.peers).toHaveLength(1);
    expect(snapshot?.payload.peers[0]?.peerId).toBe(joined.member.peer.peerId);
  });

  it("restores a participant before their reservation expires", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");
    const originalPeerId = member.peer.peerId;
    const originalToken = member.sessionToken;

    store.disconnect(room.roomId, originalPeerId, "connection-1");

    vi.advanceTimersByTime(29_999);

    const restored = store.resume(room.roomId, originalToken, "connection-2");

    expect(restored?.member).toBe(member);
    expect(restored?.previousConnectionId).toBeNull();
    expect(member.peer.peerId).toBe(originalPeerId);
    expect(member.sessionToken).toBe(originalToken);
    expect(member.connectionId).toBe("connection-2");
    expect(member.peer.connection).toBe("online");
    expect(room.members.size).toBe(1);

    vi.advanceTimersByTime(30_000);

    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.get(originalPeerId)).toBe(member);
  });

  it("restores a participant even when all four places are occupied", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    for (let index = 2; index <= 4; index += 1) {
      const joined = store.join(
        room.roomId,
        `Участник ${index}`,
        `connection-${index}`,
      );

      expect(joined.ok).toBe(true);
    }

    store.disconnect(room.roomId, member.peer.peerId, "connection-1");

    const restored = store.resume(
      room.roomId,
      member.sessionToken,
      "connection-new",
    );

    expect(restored?.member).toBe(member);
    expect(member.connectionId).toBe("connection-new");
    expect(member.peer.connection).toBe("online");
    expect(room.members.size).toBe(4);
  });

  it("replaces the connection and ignores its later disconnect", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-old");

    const restored = store.resume(
      room.roomId,
      member.sessionToken,
      "connection-new",
    );

    expect(restored?.previousConnectionId).toBe("connection-old");
    expect(restored?.member).toBe(member);

    const disconnected = store.disconnect(
      room.roomId,
      member.peer.peerId,
      "connection-old",
    );

    expect(disconnected).toBeUndefined();
    expect(member.connectionId).toBe("connection-new");
    expect(member.peer.connection).toBe("online");

    vi.advanceTimersByTime(30_000);

    expect(room.members.get(member.peer.peerId)).toBe(member);
  });

  it("rejects an unknown token or a token from another room", () => {
    const store = new RoomStore();
    const first = store.create("Глеб", "connection-1");
    const second = store.create("Влад", "connection-2");

    expect(
      store.resume(first.room.roomId, "wrong-token", "connection-3"),
    ).toBeUndefined();

    expect(
      store.resume(
        second.room.roomId,
        first.member.sessionToken,
        "connection-3",
      ),
    ).toBeUndefined();

    expect(
      store.resume("missing-room", first.member.sessionToken, "connection-3"),
    ).toBeUndefined();

    expect(first.member.connectionId).toBe("connection-1");
    expect(second.member.connectionId).toBe("connection-2");
    expect(first.room.members.size).toBe(1);
    expect(second.room.members.size).toBe(1);
  });

  it("does not restore a participant after their reservation expires", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const joined = store.join(room.roomId, "Влад", "connection-2");

    if (!joined.ok) {
      throw new Error(`Join failed: ${joined.code}`);
    }

    store.disconnect(room.roomId, member.peer.peerId, "connection-1");

    vi.advanceTimersByTime(30_000);

    const restored = store.resume(
      room.roomId,
      member.sessionToken,
      "connection-3",
    );

    expect(restored).toBeUndefined();
    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.size).toBe(1);
    expect(room.members.has(member.peer.peerId)).toBe(false);
  });
  it("keeps a disconnected participant for 30 seconds", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const disconnected = store.disconnect(
      room.roomId,
      member.peer.peerId,
      "connection-1",
    );

    expect(disconnected).toBe(member);
    expect(member.connectionId).toBeNull();
    expect(member.peer.connection).toBe("reconnecting");
    expect(room.members.size).toBe(1);

    const snapshot = store.snapshot(room.roomId, member.peer.peerId);

    expect(snapshot?.payload.peers[0]?.connection).toBe("reconnecting");

    vi.advanceTimersByTime(29_999);

    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.has(member.peer.peerId)).toBe(true);

    vi.advanceTimersByTime(1);

    expect(room.members.has(member.peer.peerId)).toBe(false);
    expect(store.get(room.roomId)).toBeUndefined();
  });

  it("removes an expired participant and keeps the other participant", () => {
    const store = new RoomStore();
    const { room, member: creator } = store.create("Глеб", "connection-1");

    const joined = store.join(room.roomId, "Влад", "connection-2");

    if (!joined.ok) {
      throw new Error(`Join failed: ${joined.code}`);
    }

    store.disconnect(room.roomId, creator.peer.peerId, "connection-1");

    vi.advanceTimersByTime(30_000);

    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.size).toBe(1);
    expect(room.members.has(creator.peer.peerId)).toBe(false);
    expect(room.members.get(joined.member.peer.peerId)).toBe(joined.member);
    expect(joined.member.peer.connection).toBe("online");
  });

  it("ignores a disconnect from a different connection", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const disconnected = store.disconnect(
      room.roomId,
      member.peer.peerId,
      "old-connection",
    );

    expect(disconnected).toBeUndefined();
    expect(member.connectionId).toBe("connection-1");
    expect(member.peer.connection).toBe("online");

    vi.advanceTimersByTime(30_000);

    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.get(member.peer.peerId)).toBe(member);
  });
  it("adds a second participant to an existing room", () => {
    const store = new RoomStore();
    const { room, member: creator } = store.create("Глеб", "connection-1");

    const result = store.join(room.roomId, "Влад", "connection-2");

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(`Join failed: ${result.code}`);
    }

    expect(room.members.size).toBe(2);
    expect(result.member.peer.name).toBe("Влад");
    expect(result.member.peer.peerId).not.toBe(creator.peer.peerId);
    expect(result.member.sessionToken).not.toBe(creator.sessionToken);

    const snapshot = store.snapshot(room.roomId, result.member.peer.peerId);

    expect(snapshot?.payload.sessionToken).toBe(result.member.sessionToken);
    expect(snapshot?.payload.peers).toHaveLength(2);
    expect(
      snapshot?.payload.peers.every((peer) => !("sessionToken" in peer)),
    ).toBe(true);
  });

  it("rejects joining an unknown room", () => {
    const store = new RoomStore();

    expect(store.join("missing-room", "Глеб", "connection-1")).toEqual({
      ok: false,
      code: "room_not_found",
    });
  });

  it("allows four participants and rejects the fifth", () => {
    const store = new RoomStore();
    const { room } = store.create("Первый", "connection-1");

    for (let index = 2; index <= 4; index += 1) {
      const result = store.join(
        room.roomId,
        `Участник ${index}`,
        `connection-${index}`,
      );

      expect(result.ok).toBe(true);
    }

    expect(store.join(room.roomId, "Пятый", "connection-5")).toEqual({
      ok: false,
      code: "room_full",
    });

    expect(room.members.size).toBe(4);
  });

  it("does not duplicate a participant using the same connection", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const result = store.join(room.roomId, "Глеб", "connection-1");

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(`Join failed: ${result.code}`);
    }

    expect(result.member).toBe(member);
    expect(room.members.size).toBe(1);
  });

  it("removes a participant immediately and frees their place", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    store.join(room.roomId, "Влад", "connection-2");

    const removed = store.leave(
      room.roomId,
      member.peer.peerId,
      "connection-1",
    );

    expect(removed).toBe(member);
    expect(member.connectionId).toBeNull();
    expect(room.members.has(member.peer.peerId)).toBe(false);
    expect(room.members.size).toBe(1);
    expect(store.get(room.roomId)).toBe(room);

    const joinedAgain = store.join(room.roomId, "Глеб", "connection-3");

    expect(joinedAgain.ok).toBe(true);
    expect(room.members.size).toBe(2);
  });

  it("deletes the room when its last participant leaves", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    store.leave(room.roomId, member.peer.peerId, "connection-1");

    expect(store.get(room.roomId)).toBeUndefined();

    expect(store.join(room.roomId, "Влад", "connection-2")).toEqual({
      ok: false,
      code: "room_not_found",
    });
  });
  it("creates a room and immediately adds its creator", () => {
    const store = new RoomStore();

    const { room, member } = store.create("Глеб", "connection-1");

    expect(store.get(room.roomId)).toBe(room);
    expect(room.members.size).toBe(1);
    expect(room.members.get(member.peer.peerId)).toBe(member);

    expect(member.peer).toMatchObject({
      name: "Глеб",
      connection: "online",
    });
    expect(member.connectionId).toBe("connection-1");

    expect(room.playback).toMatchObject({
      rev: 0,
      status: "paused",
      positionMs: 0,
      rate: 1,
      setBy: null,
    });
    expect(room.source).toBeNull();
  });

  it("assigns independent room, peer and session identifiers", () => {
    const store = new RoomStore();

    const first = store.create("Глеб", "connection-1");
    const second = store.create("Влад", "connection-2");

    const identifiers = [
      first.room.roomId,
      first.member.peer.peerId,
      first.member.sessionToken,
      second.room.roomId,
      second.member.peer.peerId,
      second.member.sessionToken,
    ];

    expect(identifiers.every((value) => value.length > 0)).toBe(true);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(first.room.members.size).toBe(1);
    expect(second.room.members.size).toBe(1);
  });

  it("builds a protocol-valid snapshot without exposing private member fields", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    const snapshot = store.snapshot(room.roomId, member.peer.peerId);

    expect(snapshot).toBeDefined();

    if (!snapshot) {
      throw new Error("Expected a room snapshot");
    }

    const parsed = parseServerMessage(JSON.stringify(snapshot));

    expect(parsed.ok).toBe(true);
    expect(snapshot.payload.you).toBe(member.peer.peerId);
    expect(snapshot.payload.sessionToken).toBe(member.sessionToken);
    expect(snapshot.payload.peers).toEqual([
      {
        peerId: member.peer.peerId,
        name: "Глеб",
        connection: "online",
      },
    ]);
  });

  it("returns no snapshot for an unknown room or participant", () => {
    const store = new RoomStore();
    const { room, member } = store.create("Глеб", "connection-1");

    expect(store.get("missing-room")).toBeUndefined();
    expect(store.snapshot("missing-room", member.peer.peerId)).toBeUndefined();
    expect(store.snapshot(room.roomId, "missing-peer")).toBeUndefined();
  });
});
