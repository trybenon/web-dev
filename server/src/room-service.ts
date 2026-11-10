/** Связывает комнаты с подключениями, сессиями и таймерами восстановления. */
import { randomUUID } from "node:crypto";
import { LIMITS, type PeerId, type RoomId } from "@watch-together/shared";
import { serverNow } from "./clock.js";
import { Room, type Outbound } from "./room.js";
import { deliverRoomMessages } from "./room-delivery.js";
import type { GatewayClient, GatewayMessage } from "./ws-gateway.js";

interface Session {
  roomId: RoomId;
  peerId: PeerId;
  token: string;
  client: GatewayClient | null;
  expiresAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

export class RoomService {
  private readonly rooms = new Map<RoomId, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<string, Session>();
  private readonly recipients = new Map<PeerId, GatewayClient>();

  constructor(private readonly now: () => number = serverNow) {}

  private publish(room: Room, messages: Outbound[]): void {
    deliverRoomMessages(room.id, messages, this.recipients);
  }

  private attach(session: Session, client: GatewayClient): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    session.expiresAt = null;
    session.client = client;
    client.joinRoom(session.roomId);
    this.connections.set(client.connectionId, session);
    this.recipients.set(session.peerId, client);
  }

  private add(room: Room, name: string, client: GatewayClient): void {
    if (room.size >= LIMITS.maxPeers) {
      client.send({
        type: "error",
        payload: {
          code: "room_full",
          message: "The room is full",
        },
      });
      return;
    }
    const session: Session = {
      roomId: room.id,
      peerId: randomUUID(),
      token: randomUUID(),
      client: null,
      expiresAt: null,
    };
    const messages = room.join(session.peerId, name, session.token);
    this.sessions.set(session.token, session);
    this.attach(session, client);
    this.publish(room, messages);
    // До первого отчёта считаем, что участник ещё не выбрал видео.
    this.publish(
      room,
      room.presence(
        session.peerId,
        {
          readyState: 0,
          bufferedAheadMs: 0,
          playerState: "paused",
          hasSource: false,
          deviationMs: null,
          deviationAt: this.now(),
          appliedRev: -1,
          rttMs: 0,
        },
        this.now(),
      ),
    );
    this.publish(room, [room.presenceSync()]);
  }

  private remove(session: Session): void {
    if (this.sessions.get(session.token) !== session) return;
    if (session.timer !== undefined) clearTimeout(session.timer);
    this.sessions.delete(session.token);
    if (session.client) {
      this.connections.delete(session.client.connectionId);
      session.client.leaveRoom();
    }
    this.recipients.delete(session.peerId);
    session.client = null;
    const room = this.rooms.get(session.roomId);
    if (!room) return;
    this.publish(room, room.leave(session.peerId, this.now()));
    if (room.size === 0) this.rooms.delete(room.id);
    else this.publish(room, [room.presenceSync()]);
  }

  onMessage = (client: GatewayClient, message: GatewayMessage): void => {
    if (message.type === "room:create") {
      if (this.connections.has(client.connectionId)) return;
      const room = new Room(randomUUID(), this.now());
      this.rooms.set(room.id, room);
      this.add(room, message.payload.name, client);
      return;
    }
    if (message.type === "room:join") {
      if (this.connections.has(client.connectionId)) return;
      const { roomId, name, sessionToken } = message.payload;
      let session = sessionToken ? this.sessions.get(sessionToken) : undefined;
      if (session && session.roomId !== roomId) session = undefined;
      if (
        session &&
        session.expiresAt !== null &&
        this.now() >= session.expiresAt
      ) {
        this.remove(session);
        session = undefined;
      }
      const room = this.rooms.get(roomId);
      if (!room) {
        client.send({
          type: "error",
          payload: {
            code: "room_not_found",
            message: "Room not found",
          },
        });
        return;
      }
      if (session) {
        const oldClient = session.client;
        if (oldClient) {
          this.connections.delete(oldClient.connectionId);
          oldClient.leaveRoom();
        }
        this.attach(session, client);
        this.publish(room, room.reconnect(session.peerId));
        oldClient?.close(1000, "Session replaced");
      } else {
        // Неизвестный или истёкший токен: обычный вход с новой личностью.
        this.add(room, name, client);
      }
      return;
    }
    const session = this.connections.get(client.connectionId);
    if (!session) {
      if (message.type !== "room:leave")
        client.send({
          type: "error",
          payload: {
            code: "not_joined",
            message: "Join a room first",
          },
        });
      return;
    }
    const room = this.rooms.get(session.roomId);
    if (!room) return;
    switch (message.type) {
      case "room:leave":
        this.remove(session);
        return;
      case "presence:update":
        this.publish(
          room,
          room.presence(session.peerId, message.payload, this.now()),
        );
        return;
      case "playback:intent":
        this.publish(
          room,
          room.intent(session.peerId, message.payload, this.now()),
        );
        return;
      case "source:propose":
        this.publish(
          room,
          room.proposeSource(session.peerId, message.payload, this.now()),
        );
        return;
      case "source:matched":
        this.publish(
          room,
          room.matchSource(
            session.peerId,
            message.payload.sourceRev,
            message.payload.ok,
          ),
        );
        return;
    }
  };

  onClose = (client: GatewayClient): void => {
    const session = this.connections.get(client.connectionId);
    if (!session || session.client !== client) return;
    this.connections.delete(client.connectionId);
    this.recipients.delete(session.peerId);
    session.client = null;
    session.expiresAt = this.now() + 30_000;
    const room = this.rooms.get(session.roomId);
    if (room) this.publish(room, room.disconnect(session.peerId, this.now()));
    session.timer = setTimeout(() => {
      if (session.client === null) this.remove(session);
    }, 30_000);
    session.timer.unref();
  };

  tick(): void {
    const now = this.now();
    for (const room of this.rooms.values()) this.publish(room, room.tick(now));
  }

  syncPresence(): void {
    for (const room of this.rooms.values())
      this.publish(room, [room.presenceSync()]);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.timer !== undefined) clearTimeout(session.timer);
    }
    this.sessions.clear();
    this.connections.clear();
    this.recipients.clear();
    this.rooms.clear();
  }
}
