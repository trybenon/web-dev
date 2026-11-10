import { LIMITS } from "@watch-together/shared";
import { randomUUID } from "node:crypto";
import type {
  Peer,
  Playback,
  Presence,
  RoomId,
  ServerMessage,
  SourceInfo,
} from "@watch-together/shared";
import { serverNow } from "./clock.js";

export interface RoomMember {
  peer: Peer;
  sessionToken: string;
  connectionId: string | null;
  presence: Presence;
}

export interface Room {
  roomId: RoomId;
  members: Map<Peer["peerId"], RoomMember>;
  playback: Playback;
  source: SourceInfo | null;
}

type RoomStateMessage = Extract<ServerMessage, { type: "room:state" }>;

export type JoinResult =
  | {
      ok: true;
      room: Room;
      member: RoomMember;
    }
  | {
      ok: false;
      code: "room_not_found" | "room_full";
    };

export class RoomStore {
  private readonly rooms = new Map<RoomId, Room>();
  private readonly reconnectTimers = new Map<
    RoomMember,
    ReturnType<typeof setTimeout>
  >();

  private removeMember(room: Room, member: RoomMember): void {
    const timer = this.reconnectTimers.get(member);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(member);
    }

    room.members.delete(member.peer.peerId);
    member.connectionId = null;

    if (room.members.size === 0) {
      this.rooms.delete(room.roomId);
    }
  }
  private createMember(
    name: string,
    connectionId: string,
    now: number,
  ): RoomMember {
    return {
      peer: {
        peerId: randomUUID(),
        name,
        connection: "online",
      },
      sessionToken: randomUUID(),
      connectionId,
      presence: {
        readyState: 0,
        bufferedAheadMs: 0,
        playerState: "paused",
        hasSource: false,
        deviationMs: null,
        deviationAt: now,
        appliedRev: -1,
        rttMs: 0,
      },
    };
  }

  create(name: string, connectionId: string) {
    const roomId = randomUUID();
    const now = serverNow();
    const member = this.createMember(name, connectionId, now);
    const peerId = member.peer.peerId;
    const room: Room = {
      roomId,
      members: new Map([[peerId, member]]),
      playback: {
        rev: 0,
        status: "paused",
        positionMs: 0,
        anchorServerTime: now,
        rate: 1,
        setBy: null,
      },
      source: null,
    };

    this.rooms.set(roomId, room);

    return { room, member };
  }

  join(roomId: RoomId, name: string, connectionId: string): JoinResult {
    const room = this.rooms.get(roomId);

    if (!room) {
      return {
        ok: false,
        code: "room_not_found",
      };
    }

    const existingMember = Array.from(room.members.values()).find(
      (member) => member.connectionId === connectionId,
    );

    if (existingMember) {
      return {
        ok: true,
        room,
        member: existingMember,
      };
    }

    if (room.members.size >= LIMITS.maxPeers) {
      return {
        ok: false,
        code: "room_full",
      };
    }

    const member = this.createMember(name, connectionId, serverNow());

    room.members.set(member.peer.peerId, member);

    return {
      ok: true,
      room,
      member,
    };
  }

  leave(
    roomId: RoomId,
    peerId: Peer["peerId"],
    connectionId: string,
  ): RoomMember | undefined {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(peerId);

    if (!room || !member || member.connectionId !== connectionId) {
      return undefined;
    }

    this.removeMember(room, member);

    return member;
  }

  disconnect(
    roomId: RoomId,
    peerId: Peer["peerId"],
    connectionId: string,
  ): RoomMember | undefined {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(peerId);

    if (!room || !member || member.connectionId !== connectionId) {
      return undefined;
    }

    member.connectionId = null;
    member.peer.connection = "reconnecting";

    const timer = setTimeout(() => {
      if (
        this.rooms.get(roomId) !== room ||
        room.members.get(peerId) !== member ||
        member.connectionId !== null
      ) {
        return;
      }

      this.removeMember(room, member);
    }, 30_000);

    this.reconnectTimers.set(member, timer);
    timer.unref();

    return member;
  }

  resume(
    roomId: RoomId,
    sessionToken: string,
    connectionId: string,
  ):
    | {
        room: Room;
        member: RoomMember;
        previousConnectionId: string | null;
      }
    | undefined {
    const room = this.rooms.get(roomId);

    if (!room) {
      return undefined;
    }

    const member = Array.from(room.members.values()).find(
      (participant) => participant.sessionToken === sessionToken,
    );

    if (!member) {
      return undefined;
    }

    const previousConnectionId = member.connectionId;
    const timer = this.reconnectTimers.get(member);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(member);
    }

    member.connectionId = connectionId;
    member.peer.connection = "online";

    return {
      room,
      member,
      previousConnectionId,
    };
  }

  updatePresence(
    roomId: RoomId,
    peerId: Peer["peerId"],
    connectionId: string,
    presence: Presence,
  ): boolean {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(peerId);

    if (!member || member.connectionId !== connectionId) {
      return false;
    }

    member.presence = { ...presence };

    return true;
  }

  presenceSnapshot(
    roomId: RoomId,
  ): Extract<ServerMessage, { type: "presence:sync" }> | undefined {
    const room = this.rooms.get(roomId);

    if (!room) {
      return undefined;
    }

    return {
      type: "presence:sync",
      payload: {
        peers: Array.from(room.members.values(), (member) => ({
          ...member.presence,
          peerId: member.peer.peerId,
          connection: member.peer.connection,
        })),
      },
    };
  }

  get(roomId: RoomId): Room | undefined {
    return this.rooms.get(roomId);
  }

  snapshot(
    roomId: RoomId,
    peerId: Peer["peerId"],
  ): RoomStateMessage | undefined {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(peerId);

    if (!room || !member) {
      return undefined;
    }

    return {
      type: "room:state",
      payload: {
        roomId: room.roomId,
        you: member.peer.peerId,
        sessionToken: member.sessionToken,
        peers: Array.from(room.members.values(), (participant) => ({
          ...participant.peer,
        })),
        playback: {
          ...room.playback,
        },
        source: room.source,
      },
    };
  }
}
