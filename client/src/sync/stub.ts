/**
 * Заглушка SyncClient для разработки интерфейса без сервера.
 *
 * Живёт в памяти и отвечает с задержкой, как настоящий сервер: данные
 * берёт из примеров протокола. Особые id комнат для проверки ошибок —
 * `STUB_ROOM_IDS`.
 */
import {
  NameSchema,
  PresenceSchema,
  serverExamples,
} from "@watch-together/shared";
import type { ErrorCode, RoomId, Playback } from "@watch-together/shared";
import type {
  PeerView,
  PlayerBridge,
  RoomView,
  SyncClient,
  SyncError,
  SyncState,
} from "./types";
import { positionAt } from "./timeline";

export const STUB_ROOM_IDS = {
  /** joinRoom в эту комнату → room_not_found. */
  missing: "missing",
  /** joinRoom в эту комнату → room_full. */
  full: "full",
} as const;

export interface StubOptions {
  /** Задержка «сети», мс. */
  latencyMs?: number;
  /** Сколько длится удержание старта перед воспроизведением, мс. */
  holdMs?: number;
}
const EMPTY_SOURCE: SyncState["source"] = { source: null, checks: [] };

/** Комната из примеров протокола, где я — второй участник. */
function joinedRoom(roomId: RoomId, name: string): RoomView {
  const snapshot = serverExamples.roomState.payload;
  const reports = serverExamples.presenceSync.payload.peers;
  const peers: PeerView[] = snapshot.peers.map((peer) => {
    const report = reports.find((r) => r.peerId === peer.peerId);
    return {
      ...peer,
      name: peer.peerId === snapshot.you ? name : peer.name,
      // parse отбрасывает лишние поля peerId и connection
      presence: report ? PresenceSchema.parse(report) : null,
    };
  });
  return { roomId, you: snapshot.you, peers };
}

/** Источник из примеров: в нём уже есть сверка peer-petya, а это «я» — убираем. */
function joinedSource(): SyncState["source"] {
  const { source, checks } = serverExamples.sourceState.payload;
  const you = serverExamples.roomState.payload.you;
  return { source, checks: checks.filter((c) => c.peerId !== you) };
}

export function createStubSyncClient(options: StubOptions = {}): SyncClient {
  const latencyMs = options.latencyMs ?? 100;
  const holdMs = options.holdMs ?? 1500;
  let state: SyncState = {
    connection: "connecting",
    room: null,
    playback: null,
    hold: null,
    source: EMPTY_SOURCE,
  };
  const listeners = new Set<(state: SyncState) => void>();
  const errorListeners = new Set<(error: SyncError) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  /** Выполнить action через ms, если клиент ещё жив. */
  function after(ms: number, action: () => void): void {
    if (disposed) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, ms);
    timers.add(timer);
  }

  /** Как сервер: команда применяется к состоянию на момент «прихода». */
  function send(action: () => void): void {
    after(latencyMs, action);
  }

  /** Новое состояние — новым объектом, и сразу всем подписчикам. */
  function update(changes: Partial<SyncState>): void {
    state = { ...state, ...changes };
    for (const listener of listeners) {
      listener(state);
    }
  }

  function fail(code: ErrorCode, message: string): void {
    for (const listener of errorListeners) listener({ code, message });
  }

  /** Команда комнаты: вне комнаты — not_joined, как на сервере. */
  function inRoom(action: (room: RoomView, playback: Playback) => void): void {
    send(() => {
      if (!state.room || !state.playback) {
        fail("not_joined", "Сначала войдите в комнату");
        return;
      }
      action(state.room, state.playback);
    });
  }

  /** Новая ревизия состояния: как сервер, ставит якорь и автора. */
  function commit(
    room: RoomView,
    prev: Playback,
    changes: Partial<Playback>,
  ): void {
    update({
      playback: {
        ...prev,
        ...changes,
        rev: prev.rev + 1,
        anchorServerTime: Date.now(),
        setBy: room.you,
      },
      hold: null,
    });
  }

  /** play и seek во время игры проходят через барьер: waiting → playing. */
  function startWithHold(
    room: RoomView,
    prev: Playback,
    positionMs: number,
  ): void {
    commit(room, prev, { status: "waiting", positionMs });
    const waitingRev = prev.rev + 1;
    const others = room.peers.filter((p) => p.peerId !== room.you);
    update({
      hold: {
        waitingFor: others.map((p) => p.peerId),
        reason: "buffering",
        deadline: Date.now() + 10_000,
      },
    });
    after(holdMs, () => {
      const current = state.playback;
      if (!state.room || !current || current.rev !== waitingRev) return;
      commit(state.room, current, { status: "playing" });
    });
  }
  // Подключение к «серверу» — тоже с задержкой, как у настоящего клиента.
  after(latencyMs, () => update({ connection: "online" }));

  return {
    getState: () => state,
    serverNow: () => Date.now(),
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
    createRoom(name) {
      send(() => {
        if (state.room) return; // как сервер: повторный вход из комнаты игнорируется
        const parsed = NameSchema.safeParse(name);
        if (!parsed.success) {
          fail("invalid_message", "Имя от 1 до 32 символов");
          return;
        }
        const you = "peer-you";
        update({
          room: {
            roomId: `stub-${Date.now().toString(36)}`,
            you,
            peers: [
              {
                peerId: you,
                name: parsed.data,
                connection: "online",
                presence: null,
              },
            ],
          },
          playback: {
            ...serverExamples.playbackStateInitial.payload,
            anchorServerTime: Date.now(),
          },
          hold: null,
          source: EMPTY_SOURCE,
        });
      });
    },

    joinRoom(roomId, name) {
      send(() => {
        if (state.room) return; // как сервер: повторный вход из комнаты игнорируется
        if (roomId === STUB_ROOM_IDS.missing) {
          fail("room_not_found", "Комнаты нет");
          return;
        }
        if (roomId === STUB_ROOM_IDS.full) {
          fail("room_full", "В комнате уже 4 участника");
          return;
        }
        update({
          room: joinedRoom(roomId, name),
          // якорь из примеров переносим на «сейчас», иначе позиция улетит на годы вперёд
          playback: {
            ...serverExamples.roomState.payload.playback,
            anchorServerTime: Date.now(),
          },
          hold: null,
          source: joinedSource(),
        });
      });
    },

    leaveRoom() {
      send(() => {
        if (!state.room) return;
        update({
          room: null,
          playback: null,
          hold: null,
          source: EMPTY_SOURCE,
        });
      });
    },

    play() {
      inRoom((room, prev) => {
        if (prev.status !== "paused") {
          return;
        }
        startWithHold(room, prev, prev.positionMs);
      });
    },

    pause() {
      inRoom((room, prev) => {
        if (prev.status === "paused") {
          return;
        }
        commit(room, prev, {
          status: "paused",
          positionMs: positionAt(prev, Date.now()),
        });
      });
    },

    seek(positionMs) {
      inRoom((room, prev) => {
        if (prev.status === "paused") {
          commit(room, prev, { positionMs: positionMs });
        } else {
          startWithHold(room, prev, positionMs);
        }
      });
    },

    proposeSource(offer) {
      inRoom((room, prev) => {
        const rev = (state.source.source?.rev ?? 0) + 1;
        update({
          source: {
            source: { ...offer, rev, proposedBy: room.you },
            checks: [],
          },
        });
        commit(room, prev, { status: "paused", positionMs: 0 });
      });
    },

    reportSourceMatch(sourceRev, ok): void {
      inRoom((room) => {
        const { source, checks } = state.source;
        if (!source || source.rev !== sourceRev) return;
        update({
          source: {
            source,
            checks: [
              ...checks.filter((c) => c.peerId !== room.you),
              { peerId: room.you, ok },
            ],
          },
        });
      });
    },
    dispose() {
      if (disposed) return;
      update({ connection: "closed" });
      disposed = true;
      // отменяем недошедшие ответы
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listeners.clear();
      errorListeners.clear();
    },
  };
}

/** Что заглушке нужно от элемента video. */
export type VideoLike = Pick<
  HTMLVideoElement,
  "currentTime" | "paused" | "play" | "pause"
>;

/**
 * Наивный мост: ставит video в состояние комнаты без часов и подстройки.
 * Настоящий мост с синхронизацией появится в #5.
 */
export function createStubPlayerBridge(
  client: SyncClient,
  video: VideoLike,
): PlayerBridge {
  function apply({ playback }: SyncState): void {
    if (!playback) return;
    const target = positionAt(playback, client.serverNow()) / 1000;
    if (Math.abs(video.currentTime - target) > 1) video.currentTime = target;
    if (playback.status === "playing" && video.paused) {
      video.play().catch(() => {
        // автозапуск запрещён до жеста пользователя — для этого есть unlock()
      });
    } else if (playback.status !== "playing" && !video.paused) {
      video.pause();
    }
  }

  const unsubscribe = client.subscribe(apply);
  return {
    async unlock() {
      try {
        await video.play();
        video.pause();
      } catch {
        // браузер не дал запустить: значит, вызвали не из обработчика клика
      }
      apply(client.getState());
    },
    dispose: unsubscribe,
  };
}
