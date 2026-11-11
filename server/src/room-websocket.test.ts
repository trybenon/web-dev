import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@watch-together/shared";
import { createAppServer } from "./app.js";
import { attachWebSocketGateway } from "./ws-gateway.js";
import { RoomService } from "./room-service.js";

type Waiter = {
  matches: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  timer: ReturnType<typeof setTimeout>;
};

class TestClient {
  readonly socket: WebSocket;
  readonly events: ServerMessage[] = [];
  private readonly queue: ServerMessage[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const parsed = parseServerMessage(raw.toString());
      if (!parsed.ok)
        throw new Error(`Invalid server message: ${parsed.error}`);
      const message = parsed.message;
      this.events.push(message);
      for (const waiter of this.waiters) {
        if (waiter.matches(message)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(message);
          return;
        }
      }
      this.queue.push(message);
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async take<T extends ServerMessage["type"]>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () =>
      true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const matches = (message: ServerMessage) =>
      message.type === type &&
      predicate(message as Extract<ServerMessage, { type: T }>);
    const index = this.queue.findIndex(matches);
    if (index !== -1) {
      return this.queue.splice(index, 1)[0] as Extract<
        ServerMessage,
        { type: T }
      >;
    }
    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter: Waiter = {
        matches,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 2_000),
      };
      this.waiters.add(waiter);
    }) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  dispose(): void {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    this.socket.terminate();
  }
}

describe("Rooms through the WebSocket gateway", () => {
  let server: ReturnType<typeof createAppServer>;
  let gateway: ReturnType<typeof attachWebSocketGateway>;
  let service: RoomService;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    service = new RoomService();
    server = createAppServer();
    gateway = attachWebSocketGateway(server, {
      onMessage: service.onMessage,
      onClose: service.onClose,
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    url = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    for (const client of clients) client.dispose();
    clients.length = 0;
    for (const socket of gateway.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    service.dispose();
  });

  async function connect(): Promise<TestClient> {
    const client = new TestClient(url);
    clients.push(client);
    await once(client.socket, "open");
    return client;
  }

  async function create(name = "Creator") {
    const client = await connect();
    client.send({ type: "room:create", payload: { name } });
    const message = await client.take("room:state");
    return { client, state: message.payload };
  }

  it("creates, joins and leaves a room using separate connections", async () => {
    const first = await create();
    const second = await connect();
    second.send({
      type: "room:join",
      payload: { roomId: first.state.roomId, name: "Second" },
    });
    const joined = (await second.take("room:state")).payload;
    expect(joined.roomId).toBe(first.state.roomId);
    expect(joined.peers).toHaveLength(2);
    expect(joined.you).not.toBe(first.state.you);
    expect(joined.sessionToken).not.toBe(first.state.sessionToken);
    expect(joined.peers.every((peer) => !("sessionToken" in peer))).toBe(true);
    expect(
      (await first.client.take("room:peer_joined")).payload.peer.peerId,
    ).toBe(joined.you);
    second.send({ type: "room:leave", payload: {} });
    expect((await first.client.take("room:peer_left")).payload.peerId).toBe(
      joined.you,
    );
    second.send({ type: "sync:ping", payload: { t0: 123 } });
    expect((await second.take("sync:pong")).payload.t0).toBe(123);
  });

  it("rejects an unknown room and keeps the connection usable", async () => {
    const client = await connect();
    client.send({
      type: "room:join",
      payload: { roomId: "missing", name: "Guest" },
    });
    expect((await client.take("error")).payload.code).toBe("room_not_found");
    client.send({ type: "room:create", payload: { name: "Guest" } });
    expect((await client.take("room:state")).payload.peers).toHaveLength(1);
  });

  it("accepts four participants and rejects the fifth over the network", async () => {
    const first = await create();
    for (let i = 2; i <= 4; i++) {
      const client = await connect();
      client.send({
        type: "room:join",
        payload: { roomId: first.state.roomId, name: `Peer ${i}` },
      });
      expect((await client.take("room:state")).payload.peers).toHaveLength(i);
    }
    const fifth = await connect();
    fifth.send({
      type: "room:join",
      payload: { roomId: first.state.roomId, name: "Fifth" },
    });
    expect((await fifth.take("error")).payload.code).toBe("room_full");
    expect(fifth.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("restores the same participant after the socket closes", async () => {
    const first = await create();
    const second = await connect();
    second.send({
      type: "room:join",
      payload: { roomId: first.state.roomId, name: "Second" },
    });
    const original = (await second.take("room:state")).payload;
    const closed = once(second.socket, "close");
    second.socket.close(1000, "Test disconnect");
    await closed;
    await first.client.take("presence:sync", (message) =>
      message.payload.peers.some(
        (peer) =>
          peer.peerId === original.you && peer.connection === "reconnecting",
      ),
    );
    const replacement = await connect();
    replacement.send({
      type: "room:join",
      payload: {
        roomId: original.roomId,
        name: "Second",
        sessionToken: original.sessionToken,
      },
    });
    const restored = (await replacement.take("room:state")).payload;
    expect(restored.you).toBe(original.you);
    expect(restored.sessionToken).toBe(original.sessionToken);
    expect(restored.peers).toHaveLength(2);
    expect(
      restored.peers.find((peer) => peer.peerId === original.you)?.connection,
    ).toBe("online");
  });

  it("replaces a live socket with code 4001 without disconnecting the new owner", async () => {
    const first = await create();
    const replacement = await connect();
    const closed = once(first.client.socket, "close");
    replacement.send({
      type: "room:join",
      payload: {
        roomId: first.state.roomId,
        name: "Creator",
        sessionToken: first.state.sessionToken,
      },
    });
    const restored = (await replacement.take("room:state")).payload;
    expect(restored.you).toBe(first.state.you);
    const [code] = await closed;
    expect(code).toBe(4001);
    service.syncPresence();
    await replacement.take("presence:sync", (message) =>
      message.payload.peers.some(
        (peer) => peer.peerId === restored.you && peer.connection === "online",
      ),
    );
    replacement.send({ type: "sync:ping", payload: { t0: 321 } });
    expect((await replacement.take("sync:pong")).payload.t0).toBe(321);
  });

  it("never broadcasts playback changes into another room", async () => {
    const first = await create("First room");
    const outsider = await create("Other room");
    const second = await connect();
    second.send({
      type: "room:join",
      payload: { roomId: first.state.roomId, name: "Second" },
    });
    await second.take("room:state");
    first.client.send({
      type: "playback:intent",
      payload: { action: "seek", positionMs: 1000 },
    });
    expect((await first.client.take("playback:state")).payload.positionMs).toBe(
      1000,
    );
    expect((await second.take("playback:state")).payload.positionMs).toBe(1000);
    // Round trip after the broadcast: any earlier messages on this socket precede pong.
    outsider.client.send({ type: "sync:ping", payload: { t0: 456 } });
    await outsider.client.take("sync:pong");
    expect(
      outsider.client.events.some(
        (message) => message.type === "playback:state",
      ),
    ).toBe(false);
  });
});
