import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createAppServer } from "./app.js";
import {
  attachWebSocketGateway,
  type GatewayClient,
  type GatewayMessage,
} from "./ws-gateway.js";
import {
  LIMITS,
  clientExamples,
  invalidClientMessages,
  parseServerMessage,
  type ServerMessage,
} from "@watch-together/shared";

let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachWebSocketGateway>;
let address: string;
let rateTime: number;

const clients = new Set<WebSocket>();
const onMessage =
  vi.fn<
    (client: GatewayClient, message: GatewayMessage) => void | Promise<void>
  >();
const onClose = vi.fn<(client: GatewayClient) => void | Promise<void>>();

beforeEach(async () => {
  onMessage.mockReset();
  onClose.mockReset();
  rateTime = 0;

  server = createAppServer();

  gateway = attachWebSocketGateway(server, {
    onMessage,
    onClose,
    heartbeatIntervalMs: 100,
    rateLimit: {
      limit: 3,
      now: () => rateTime,
    },
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;

  const serverAddress = server.address();

  if (serverAddress === null || typeof serverAddress === "string") {
    throw new Error("Could not determine server port");
  }

  address = `ws://127.0.0.1:${serverAddress.port}/ws`;
});

afterEach(async () => {
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();

  for (const socket of gateway.clients) {
    socket.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    gateway.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

async function connectClient(): Promise<WebSocket> {
  const client = new WebSocket(address);
  clients.add(client);

  await once(client, "open");

  return client;
}

async function exchange(
  client: WebSocket,
  data: string | Buffer,
): Promise<ServerMessage> {
  const response = once(client, "message");

  client.send(data);

  const [raw] = await response;
  const result = parseServerMessage(raw.toString());

  if (!result.ok) {
    throw new Error(`Invalid server response: ${result.error}`);
  }

  return result.message;
}

function ping(t0: number): string {
  return JSON.stringify({
    type: "sync:ping",
    payload: { t0 },
  });
}

function acknowledgeMessage(client: GatewayClient) {
  client.send({
    type: "sync:pong",
    payload: {
      t0: 0,
      t1: 0,
      t2: 0,
    },
  });
}

async function connectWithContext() {
  const socket = await connectClient();
  const callIndex = onMessage.mock.calls.length;

  await exchange(socket, JSON.stringify(clientExamples.roomCreate));

  const call = onMessage.mock.calls[callIndex];

  if (!call) {
    throw new Error("Message handler was not called");
  }

  return {
    socket,
    context: call[0],
  };
}

function observeRoomBroadcasts(socket: WebSocket) {
  const received = vi.fn();

  socket.on("message", (raw) => {
    const result = parseServerMessage(raw.toString());

    if (result.ok && result.message.type === "room:peer_left") {
      received(result.message);
    }
  });

  return received;
}

const roomBroadcast: ServerMessage = {
  type: "room:peer_left",
  payload: {
    peerId: "test-peer",
  },
};
describe("WebSocket gateway", () => {
  it("broadcasts from the gateway only to the selected room", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const first = await connectWithContext();
    const otherRoom = await connectWithContext();
    const outside = await connectWithContext();

    first.context.joinRoom("room-a");
    otherRoom.context.joinRoom("room-b");

    const firstReceived = observeRoomBroadcasts(first.socket);
    const otherReceived = observeRoomBroadcasts(otherRoom.socket);
    const outsideReceived = observeRoomBroadcasts(outside.socket);

    gateway.broadcastToRoom("room-a", roomBroadcast);

    await Promise.all([
      exchange(first.socket, ping(1)),
      exchange(otherRoom.socket, ping(2)),
      exchange(outside.socket, ping(3)),
    ]);

    expect(firstReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
    expect(otherReceived).not.toHaveBeenCalled();
    expect(outsideReceived).not.toHaveBeenCalled();
  });
  it("broadcasts from the gateway after a room participant disconnects", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const departed = await connectWithContext();
    const remaining = await connectWithContext();
    const otherRoom = await connectWithContext();

    departed.context.joinRoom("room-a");
    remaining.context.joinRoom("room-a");
    otherRoom.context.joinRoom("room-b");

    const remainingReceived = observeRoomBroadcasts(remaining.socket);
    const otherReceived = observeRoomBroadcasts(otherRoom.socket);

    const closed = once(departed.socket, "close");
    departed.socket.close();
    await closed;

    await vi.waitFor(() => {
      expect(departed.context.roomId).toBeNull();
    });

    gateway.broadcastToRoom("room-a", roomBroadcast);

    await Promise.all([
      exchange(remaining.socket, ping(1)),
      exchange(otherRoom.socket, ping(2)),
    ]);

    expect(remainingReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
    expect(otherReceived).not.toHaveBeenCalled();
  });
  it.each([
    {
      code: undefined,
      reason: undefined,
      expectedCode: 1000,
      expectedReason: "",
    },
    {
      code: 4001,
      reason: "Session replaced",
      expectedCode: 4001,
      expectedReason: "Session replaced",
    },
  ])(
    "closes a client from server code with code $expectedCode",
    async ({ code, reason, expectedCode, expectedReason }) => {
      onMessage.mockImplementation(acknowledgeMessage);

      const { socket, context } = await connectWithContext();

      context.joinRoom("room-a");

      const closed = once(socket, "close");

      context.close(code, reason);
      context.close(code, reason);

      const [receivedCode, receivedReason] = await closed;

      expect(receivedCode).toBe(expectedCode);
      expect(receivedReason.toString()).toBe(expectedReason);

      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(context.roomId).toBeNull();
      });

      const anotherClient = await connectClient();
      const response = await exchange(anotherClient, ping(123));

      expect(response).toMatchObject({
        type: "sync:pong",
        payload: {
          t0: 123,
        },
      });
    },
  );
  it("notifies the close handler before clearing room membership", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const { socket, context } = await connectWithContext();

    context.joinRoom("room-a");

    let roomAtClose: string | null = null;

    onClose.mockImplementation((client) => {
      roomAtClose = client.roomId;
    });

    const closed = once(socket, "close");
    socket.close();
    await closed;

    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(context.roomId).toBeNull();
    });

    expect(onClose).toHaveBeenCalledWith(context);
    expect(roomAtClose).toBe("room-a");
  });
  it.each(["sync", "async"] as const)(
    "cleans up after a %s close handler error and keeps serving clients",
    async (mode) => {
      onMessage.mockImplementation(acknowledgeMessage);

      const { socket, context } = await connectWithContext();

      context.joinRoom("room-a");

      const failure = new Error("Test close handler failure");

      onClose.mockImplementation(() => {
        if (mode === "async") {
          return Promise.reject(failure);
        }

        throw failure;
      });

      const closed = once(socket, "close");
      socket.close();
      await closed;

      await vi.waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(context.roomId).toBeNull();
      });

      const anotherClient = await connectClient();
      const response = await exchange(anotherClient, ping(123));

      expect(response).toMatchObject({
        type: "sync:pong",
        payload: {
          t0: 123,
        },
      });
    },
  );
  it.each(["sync", "async"] as const)(
    "closes the affected connection after a %s handler error and keeps serving clients",
    async (mode) => {
      const failure = new Error("Test handler failure");

      onMessage.mockImplementation(() => {
        if (mode === "async") {
          return Promise.reject(failure);
        }

        throw failure;
      });

      const client = await connectClient();
      const closed = once(client, "close");

      client.send(JSON.stringify(clientExamples.roomCreate));

      const [code, reason] = await closed;

      expect(code).toBe(1011);
      expect(reason.toString()).toBe("Message handler failed");

      const anotherClient = await connectClient();

      const response = await exchange(
        anotherClient,
        JSON.stringify(clientExamples.syncPing),
      );

      expect(response).toMatchObject({
        type: "sync:pong",
        payload: {
          t0: clientExamples.syncPing.payload.t0,
        },
      });
    },
  );
  it.each(invalidClientMessages)(
    "rejects a shared invalid example: $why",
    async ({ data }) => {
      const client = await connectClient();

      const response = await exchange(client, JSON.stringify(data));

      expect(response).toMatchObject({
        type: "error",
        payload: {
          code: "invalid_message",
        },
      });

      expect(onMessage).not.toHaveBeenCalled();

      const pong = await exchange(
        client,
        JSON.stringify(clientExamples.syncPing),
      );

      expect(pong).toMatchObject({
        type: "sync:pong",
        payload: {
          t0: clientExamples.syncPing.payload.t0,
        },
      });

      expect(client.readyState).toBe(WebSocket.OPEN);
    },
  );
  it.each([
    clientExamples.playbackIntent,
    clientExamples.presenceUpdate,
    clientExamples.sourcePropose,
    clientExamples.sourceMatched,
  ])("rejects $type outside a room", async (message) => {
    const client = await connectClient();

    const response = await exchange(client, JSON.stringify(message));

    expect(response).toMatchObject({
      type: "error",
      payload: {
        code: "not_joined",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
  it("rejects a playback intent before joining and keeps the connection usable", async () => {
    const client = await connectClient();

    const response = await exchange(
      client,
      JSON.stringify({
        type: "playback:intent",
        payload: {
          action: "play",
        },
      }),
    );

    expect(response).toMatchObject({
      type: "error",
      payload: {
        code: "not_joined",
      },
    });

    expect(onMessage).not.toHaveBeenCalled();

    const pong = await exchange(client, ping(123));

    expect(pong).toMatchObject({
      type: "sync:pong",
      payload: {
        t0: 123,
      },
    });
  });
  it("silently ignores leaving when the client is outside a room", async () => {
    const client = await connectClient();
    const received = vi.fn();

    client.on("message", received);

    client.send(
      JSON.stringify({
        type: "room:leave",
        payload: {},
      }),
    );

    await exchange(client, ping(123));

    expect(onMessage).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      type: "room:create",
      payload: {
        name: "Test user",
      },
    },
    {
      type: "room:join",
      payload: {
        roomId: "another-room",
        name: "Test user",
      },
    },
  ])("ignores $type when already in a room", async (message) => {
    onMessage.mockImplementation(acknowledgeMessage);

    const { socket, context } = await connectWithContext();

    context.joinRoom("room-a");
    onMessage.mockClear();

    const received = vi.fn();
    socket.on("message", received);

    socket.send(JSON.stringify(message));

    await exchange(socket, ping(123));

    expect(onMessage).not.toHaveBeenCalled();
    expect(context.roomId).toBe("room-a");
    expect(received).toHaveBeenCalledTimes(1);
  });
  it("broadcasts only to clients in the same room", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const first = await connectWithContext();
    const second = await connectWithContext();
    const otherRoom = await connectWithContext();
    const outside = await connectWithContext();

    first.context.joinRoom("room-a");
    second.context.joinRoom("room-a");
    otherRoom.context.joinRoom("room-b");

    const firstReceived = observeRoomBroadcasts(first.socket);
    const secondReceived = observeRoomBroadcasts(second.socket);
    const otherReceived = observeRoomBroadcasts(otherRoom.socket);
    const outsideReceived = observeRoomBroadcasts(outside.socket);

    first.context.broadcast(roomBroadcast);

    await Promise.all([
      exchange(first.socket, ping(1)),
      exchange(second.socket, ping(2)),
      exchange(otherRoom.socket, ping(3)),
      exchange(outside.socket, ping(4)),
    ]);

    expect(firstReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
    expect(secondReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
    expect(otherReceived).not.toHaveBeenCalled();
    expect(outsideReceived).not.toHaveBeenCalled();
  });
  it("stops room broadcasts after leaving and ignores broadcasts outside a room", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const first = await connectWithContext();
    const second = await connectWithContext();

    first.context.joinRoom("room-a");
    second.context.joinRoom("room-a");

    const firstReceived = observeRoomBroadcasts(first.socket);
    const secondReceived = observeRoomBroadcasts(second.socket);

    second.context.leaveRoom();

    expect(second.context.roomId).toBeNull();

    first.context.broadcast(roomBroadcast);

    await Promise.all([
      exchange(first.socket, ping(1)),
      exchange(second.socket, ping(2)),
    ]);

    expect(firstReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
    expect(secondReceived).not.toHaveBeenCalled();

    firstReceived.mockClear();

    second.context.broadcast(roomBroadcast);

    await Promise.all([
      exchange(first.socket, ping(3)),
      exchange(second.socket, ping(4)),
    ]);

    expect(firstReceived).not.toHaveBeenCalled();
    expect(secondReceived).not.toHaveBeenCalled();
  });
  it("clears room membership when a connection closes", async () => {
    onMessage.mockImplementation(acknowledgeMessage);

    const disconnected = await connectWithContext();
    const remaining = await connectWithContext();

    disconnected.context.joinRoom("room-a");
    remaining.context.joinRoom("room-a");

    const remainingReceived = observeRoomBroadcasts(remaining.socket);

    const closed = once(disconnected.socket, "close");
    disconnected.socket.close();
    await closed;

    await vi.waitFor(() => {
      expect(disconnected.context.roomId).toBeNull();
    });

    disconnected.context.broadcast(roomBroadcast);

    await exchange(remaining.socket, ping(1));

    expect(remainingReceived).not.toHaveBeenCalled();

    remaining.context.broadcast(roomBroadcast);

    await exchange(remaining.socket, ping(2));

    expect(remainingReceived).toHaveBeenCalledExactlyOnceWith(roomBroadcast);
  });
  it("passes a valid room message to the handler and sends its response", async () => {
    onMessage.mockImplementation((client) => {
      client.send({
        type: "error",
        payload: {
          code: "room_full",
          message: "Test handler response",
        },
      });
    });

    const client = await connectClient();

    const message = {
      type: "room:create",
      payload: {
        name: "Глеб",
      },
    };

    const response = await exchange(client, JSON.stringify(message));

    expect(onMessage).toHaveBeenCalledTimes(1);

    const [context, receivedMessage] = onMessage.mock.calls[0]!;

    expect(context.connectionId).toEqual(expect.any(String));
    expect(context.connectionId.length).toBeGreaterThan(0);
    expect(receivedMessage).toEqual(message);

    expect(response).toEqual({
      type: "error",
      payload: {
        code: "room_full",
        message: "Test handler response",
      },
    });
  });

  it("does not pass malformed messages or clock pings to the handler", async () => {
    const client = await connectClient();

    const invalidResponse = await exchange(client, "{oops");

    expect(invalidResponse).toMatchObject({
      type: "error",
      payload: {
        code: "invalid_message",
      },
    });

    const pingResponse = await exchange(client, ping(123));

    expect(pingResponse).toMatchObject({
      type: "sync:pong",
      payload: {
        t0: 123,
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });
  it("keeps a client connected when it responds to heartbeat pings", async () => {
    const client = await connectClient();

    await once(client, "ping");

    const firstResponse = await exchange(client, ping(100));

    expect(firstResponse).toMatchObject({
      type: "sync:pong",
      payload: { t0: 100 },
    });

    await once(client, "ping");

    const secondResponse = await exchange(client, ping(200));

    expect(secondResponse).toMatchObject({
      type: "sync:pong",
      payload: { t0: 200 },
    });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
  it("disconnects a client that does not respond to heartbeat pings", async () => {
    const client = new WebSocket(address, {
      autoPong: false,
    });

    clients.add(client);

    const closed = once(client, "close");

    await once(client, "open");

    const [code] = await closed;

    expect(code).toBe(1006);

    const anotherClient = await connectClient();
    const response = await exchange(anotherClient, ping(300));

    expect(response).toMatchObject({
      type: "sync:pong",
      payload: { t0: 300 },
    });
  });
  it("rejects excess messages and allows requests in the next window", async () => {
    const client = await connectClient();

    for (const t0 of [1, 2, 3]) {
      const response = await exchange(client, ping(t0));

      expect(response).toMatchObject({
        type: "sync:pong",
        payload: { t0 },
      });
    }

    const rejected = await exchange(client, ping(4));

    expect(rejected).toMatchObject({
      type: "error",
      payload: {
        code: "rate_limited",
      },
    });
    expect(client.readyState).toBe(WebSocket.OPEN);

    rateTime = 1000;

    const recovered = await exchange(client, ping(5));

    expect(recovered).toMatchObject({
      type: "sync:pong",
      payload: { t0: 5 },
    });
  });
  it("does not apply one client's rate limit to another client", async () => {
    const first = await connectClient();
    const second = await connectClient();

    for (const t0 of [1, 2, 3]) {
      await exchange(first, ping(t0));
    }

    const rejected = await exchange(first, ping(4));

    expect(rejected).toMatchObject({
      type: "error",
      payload: {
        code: "rate_limited",
      },
    });

    const secondResponse = await exchange(second, ping(100));

    expect(secondResponse).toMatchObject({
      type: "sync:pong",
      payload: { t0: 100 },
    });
  });
  it("closes an oversized message with 1009 and keeps the server alive", async () => {
    const client = await connectClient();
    const closed = once(client, "close");

    const oversizedMessage = "x".repeat(LIMITS.maxWsMessageBytes + 1024);

    client.send(oversizedMessage);

    const [code] = await closed;

    expect(code).toBe(1009);

    const anotherClient = await connectClient();
    const pong = await exchange(anotherClient, ping(999));

    expect(pong).toMatchObject({
      type: "sync:pong",
      payload: { t0: 999 },
    });
  });
  it("responds to a valid ping", async () => {
    const client = await connectClient();

    const message = await exchange(client, ping(123));

    expect(message.type).toBe("sync:pong");

    if (message.type !== "sync:pong") {
      throw new Error("Expected sync:pong");
    }

    expect(message.payload.t0).toBe(123);
    expect(message.payload.t1).toBeGreaterThanOrEqual(0);
    expect(message.payload.t2).toBeGreaterThanOrEqual(message.payload.t1);
  });

  it.each([
    {
      name: "malformed JSON",
      raw: "{oops",
    },
    {
      name: "an unknown message type",
      raw: JSON.stringify({
        type: "unknown:message",
        payload: {},
      }),
    },
  ])("rejects $name and keeps the connection usable", async ({ raw }) => {
    const client = await connectClient();

    const errorMessage = await exchange(client, raw);

    expect(errorMessage).toMatchObject({
      type: "error",
      payload: {
        code: "invalid_message",
      },
    });

    const pong = await exchange(client, ping(456));

    expect(pong).toMatchObject({
      type: "sync:pong",
      payload: { t0: 456 },
    });
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects a binary message and keeps the connection usable", async () => {
    const client = await connectClient();

    const errorMessage = await exchange(client, Buffer.from(ping(123)));

    expect(errorMessage).toMatchObject({
      type: "error",
      payload: {
        code: "invalid_message",
      },
    });

    const pong = await exchange(client, ping(789));

    expect(pong).toMatchObject({
      type: "sync:pong",
      payload: { t0: 789 },
    });
  });

  it("serves two connected clients independently", async () => {
    const first = await connectClient();
    const second = await connectClient();

    const [firstResponse, secondResponse] = await Promise.all([
      exchange(first, ping(111)),
      exchange(second, ping(222)),
    ]);

    expect(firstResponse).toMatchObject({
      type: "sync:pong",
      payload: { t0: 111 },
    });
    expect(secondResponse).toMatchObject({
      type: "sync:pong",
      payload: { t0: 222 },
    });
  });
});
