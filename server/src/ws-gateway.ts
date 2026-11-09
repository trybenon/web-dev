import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import { createRateLimiter, type RateLimitOptions } from "./rate-limit.js";
import {
  LIMITS,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@watch-together/shared";

function sendMessage(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export type GatewayMessage = Exclude<ClientMessage, { type: "sync:ping" }>;

export interface GatewayClient {
  readonly connectionId: string;
  readonly roomId: string | null;

  send(message: ServerMessage): void;
  joinRoom(roomId: string): void;
  leaveRoom(): void;
  broadcast(message: ServerMessage): void;
}
interface GatewayOptions {
  rateLimit?: RateLimitOptions;
  heartbeatIntervalMs?: number;
  onMessage?: (client: GatewayClient, message: GatewayMessage) => void;
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
    let roomId: string | null = null;

    const client: GatewayClient = {
      connectionId: randomUUID(),

      get roomId() {
        return roomId;
      },

      send(message) {
        sendMessage(socket, message);
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

        for (const recipient of connections.values()) {
          if (recipient.roomId === roomId) {
            recipient.send(message);
          }
        }
      },
    };

    connections.set(socket, client);

    socket.once("close", () => {
      client.leaveRoom();
      connections.delete(socket);
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
      const receivedAt = performance.now();
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
            t2: performance.now(),
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
      try {
        options.onMessage?.(client, message);
      } catch (error) {
        console.error("WebSocket message handler error:", error);
        socket.close(1011, "Message handler failed");
      }
    });
  });

  return gateway;
}
