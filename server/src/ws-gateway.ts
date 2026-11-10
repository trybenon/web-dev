import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { serverNow } from "./clock.js";
import { WebSocket, WebSocketServer } from "ws";
import { createRateLimiter, type RateLimitOptions } from "./rate-limit.js";
import {
  LIMITS,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type RoomId,
} from "@watch-together/shared";

function sendMessage(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export type GatewayMessage = Exclude<ClientMessage, { type: "sync:ping" }>;

export interface GatewayClient {
  readonly connectionId: string;
  readonly roomId: RoomId | null;
  close(code?: number, reason?: string): void;
  send(message: ServerMessage): void;
  joinRoom(roomId: RoomId): void;
  leaveRoom(): void;
  broadcast(message: ServerMessage): void;
}
interface GatewayOptions {
  rateLimit?: RateLimitOptions;
  heartbeatIntervalMs?: number;
  onMessage?: (
    client: GatewayClient,
    message: GatewayMessage,
  ) => void | Promise<void>;
  onClose?: (client: GatewayClient) => void | Promise<void>;
}
export function attachWebSocketGateway(
  server: Server,
  options: GatewayOptions = {},
) {
  const gateway = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: LIMITS.maxWsMessageBytes,
    perMessageDeflate: false,
  });
  const connections = new Map<WebSocket, GatewayClient>();
  function broadcastToRoom(targetRoomId: RoomId, message: ServerMessage): void {
    for (const recipient of connections.values()) {
      if (recipient.roomId === targetRoomId) {
        recipient.send(message);
      }
    }
  }
  const alive = new WeakSet<WebSocket>();

  const heartbeat = setInterval(() => {
    for (const socket of gateway.clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }

      alive.delete(socket);
      socket.ping();
    }
  }, options.heartbeatIntervalMs ?? 15_000);

  heartbeat.unref();

  gateway.once("close", () => {
    clearInterval(heartbeat);
  });

  gateway.on("error", (error) => {
    console.error("WebSocket server error:", error.message);
  });

  gateway.on("connection", (socket) => {
    let roomId: RoomId | null = null;

    const client: GatewayClient = {
      connectionId: randomUUID(),

      get roomId() {
        return roomId;
      },

      send(message) {
        sendMessage(socket, message);
      },
      close(code = 1000, reason = "") {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        }
      },

      joinRoom(nextRoomId) {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        roomId = nextRoomId;
      },

      leaveRoom() {
        roomId = null;
      },
      broadcast(message) {
        if (roomId === null || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        broadcastToRoom(roomId, message);
      },
    };

    connections.set(socket, client);

    socket.once("close", () => {
      const reportCloseError = (error: unknown) => {
        console.error("WebSocket close handler error:", error);
      };

      try {
        const pending = options.onClose?.(client);

        Promise.resolve(pending).catch(reportCloseError);
      } catch (error) {
        reportCloseError(error);
      } finally {
        client.leaveRoom();
        connections.delete(socket);
      }
    });
    alive.add(socket);

    socket.on("pong", () => {
      alive.add(socket);
    });
    const checkRate = createRateLimiter(options.rateLimit);
    socket.on("error", (error) => {
      console.error("WebSocket connection error:", error.message);
    });

    socket.on("message", (data, isBinary) => {
      const receivedAt = serverNow();
      const decision = checkRate();

      if (!decision.allowed) {
        if (decision.notify) {
          sendMessage(socket, {
            type: "error",
            payload: {
              code: "rate_limited",
              message: "Too many messages",
            },
          });
        }

        return;
      }

      if (isBinary) {
        sendMessage(socket, {
          type: "error",
          payload: {
            code: "invalid_message",
            message: "Expected a text JSON message",
          },
        });
        return;
      }

      const result = parseClientMessage(data.toString());

      if (!result.ok) {
        sendMessage(socket, {
          type: "error",
          payload: {
            code: "invalid_message",
            message: "Invalid client message",
          },
        });
        return;
      }

      const message = result.message;

      if (message.type === "sync:ping") {
        sendMessage(socket, {
          type: "sync:pong",
          payload: {
            t0: message.payload.t0,
            t1: receivedAt,
            t2: serverNow(),
          },
        });
        return;
      }
      const isRoomEntry =
        message.type === "room:create" || message.type === "room:join";

      if (client.roomId === null) {
        if (message.type === "room:leave") {
          return;
        }

        if (!isRoomEntry) {
          client.send({
            type: "error",
            payload: {
              code: "not_joined",
              message: "Join a room before sending this message",
            },
          });

          return;
        }
      } else if (isRoomEntry) {
        return;
      }
      const fail = (error: unknown) => {
        console.error("WebSocket message handler error:", error);

        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1011, "Message handler failed");
        }
      };

      try {
        const pending = options.onMessage?.(client, message);

        Promise.resolve(pending).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  });

  return Object.assign(gateway, {
    broadcastToRoom,
  });
}
