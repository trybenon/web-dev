/**
 * Настоящий SyncClient: тонкая обёртка на странице над воркером синхронизации.
 *
 * Состояние и ошибки приходят из воркера, команды уходят туда же.
 * Страница отвечает на пинги часов воркера: так воркер знает, насколько
 * его performance.now() расходится с нашим (decisions.md, 3.2).
 */
import type { SyncClient, SyncError, SyncState } from "./types";
import type {
  FromWorker,
  MediaReport,
  PlayerCommand,
  ToWorker,
} from "./worker-protocol";

/** Связь с воркером: в тестах вместо настоящего подставляется поддельный. */
export interface WorkerPort {
  post(message: ToWorker): void;
  listen(handler: (message: FromWorker) => void): void;
}

export interface SyncClientOptions {
  /** Адрес WebSocket. По умолчанию /ws на том же хосте. */
  url?: string;
  /** Запустить воркер. По умолчанию — sync.worker.ts. */
  startWorker?: () => WorkerPort;
}

/** Канал между клиентом и мостом к плееру: в публичный SyncClient не входит. */
export interface PlayerChannel {
  attach(onCommand: (command: PlayerCommand) => void): void;
  detach(): void;
  report(media: MediaReport): void;
  applied(rev: number): void;
  reload(): void;
}

const channels = new WeakMap<SyncClient, PlayerChannel>();

/** Канал к плееру для клиента из createSyncClient; у заглушки его нет. */
export function playerChannel(client: SyncClient): PlayerChannel | undefined {
  return channels.get(client);
}

function startWorker(): WorkerPort {
  const worker = new Worker(new URL("./sync.worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    post: (message) => worker.postMessage(message),
    listen(handler) {
      worker.onmessage = (event: MessageEvent<FromWorker>) =>
        handler(event.data);
    },
  };
}

function defaultUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export function createSyncClient(options: SyncClientOptions = {}): SyncClient {
  const port = (options.startWorker ?? startWorker)();
  let state: SyncState = {
    connection: "connecting",
    room: null,
    playback: null,
    hold: null,
    source: { source: null, checks: [] },
  };
  /** Время сервера минус время страницы, мс; 0 — пока не откалибровано. */
  let serverOffset = 0;
  let disposed = false;
  const listeners = new Set<(state: SyncState) => void>();
  const errorListeners = new Set<(error: SyncError) => void>();
  let onCommand: ((command: PlayerCommand) => void) | null = null;

  function send(message: ToWorker): void {
    if (!disposed) port.post(message);
  }

  port.listen((message) => {
    if (disposed) return;
    switch (message.type) {
      case "state":
        state = message.state;
        for (const listener of listeners) listener(state);
        return;
      case "clock":
        serverOffset = message.serverOffset;
        return;
      case "error":
        for (const listener of errorListeners) listener(message.error);
        return;
      case "clock:ping":
        // отвечаем сразу: в t1 — наше время приёма
        port.post({
          type: "clock:pong",
          t0: message.t0,
          t1: performance.now(),
        });
        return;
      case "player:command":
        onCommand?.(message.command);
        return;
    }
  });
  port.post({ type: "connect", url: options.url ?? defaultUrl() });

  const client: SyncClient = {
    getState: () => state,
    serverNow: () => performance.now() + serverOffset,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    createRoom: (name) => send({ type: "createRoom", name }),
    joinRoom: (roomId, name) => send({ type: "joinRoom", roomId, name }),
    leaveRoom: () => send({ type: "leaveRoom" }),
    play: () => send({ type: "intent", intent: { action: "play" } }),
    pause: () => send({ type: "intent", intent: { action: "pause" } }),
    seek: (positionMs) =>
      send({ type: "intent", intent: { action: "seek", positionMs } }),
    proposeSource: (offer) => send({ type: "proposeSource", offer }),
    reportSourceMatch: (sourceRev, ok) =>
      send({ type: "reportSourceMatch", sourceRev, ok }),
    dispose() {
      if (disposed) return;
      // воркер сам выйдет из комнаты, закроет сокет и завершится
      send({ type: "dispose" });
      disposed = true;
      onCommand = null;
      state = { ...state, connection: "closed" };
      for (const listener of listeners) listener(state);
      listeners.clear();
      errorListeners.clear();
    },
  };

  channels.set(client, {
    attach(handler) {
      onCommand = handler;
      send({ type: "player:attach" });
    },
    detach() {
      onCommand = null;
      send({ type: "player:detach" });
    },
    report: (media) => send({ type: "player:media", media }),
    applied: (rev) => send({ type: "player:applied", rev }),
    reload: () => send({ type: "player:reload" }),
  });
  return client;
}
