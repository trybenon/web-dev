/**
 * Публичный API синхронизации для интерфейса.
 *
 * Интерфейс не работает с протоколом напрямую: он получает готовое
 * состояние комнаты и отдаёт команды. Настоящий клиент (воркер)
 * и заглушка реализуют один и тот же `SyncClient`.
 */
import type {
  ErrorCode,
  Peer,
  PeerId,
  Playback,
  Presence,
  RoomId,
  ServerMessage,
  SourceOffer,
} from "@watch-together/shared";

/**
 * Связь с сервером синхронизации
 */
export type ConnectionState =
  "connecting" | "online" | "reconnecting" | "closed";

/**
 * Участник: данные комнаты плюс последний отчет о готовности
 */
export interface PeerView extends Peer {
  /** null — отчёта о готовности ещё не было. */
  presence: Presence | null;
}

export interface RoomView {
  roomId: RoomId;
  /** Мой peerId. */
  you: PeerId;
  peers: PeerView[];
}

type Payload<T extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { type: T }
>["payload"];

/** Удержание старта: кого ждём, почему и до какого момента. */
export type HoldView = Omit<Payload<"playback:hold">, "rev">;

/** Источник комнаты и кто уже сверил свой файл. */
export type SourceView = Payload<"source:state">;

/**
 * Всё, что нужно интерфейсу. Каждое изменение приходит новым объектом.
 * Моменты времени (anchorServerTime, hold.deadline) — по часам сервера:
 * сравнивать с client.serverNow(), а не с Date.now().
 */
export interface SyncState {
  /** Сначала connecting; команды, отданные до online, уйдут после подключения. */
  connection: ConnectionState;
  /** null — не в комнате. */
  room: RoomView | null;
  /** null — не в комнате. */
  playback: Playback | null;
  /** Есть, только пока относится к текущему состоянию воспроизведения. */
  hold: HoldView | null;
  source: SourceView;
}

export interface SyncError {
  code: ErrorCode;
  /** Текст для журнала; подпись в интерфейсе выбирается по code. */
  message: string;
}

export interface SyncClient {
  getState(): SyncState;
  /** Текущий момент по часам сервера, мс: для «ждём ещё N с» и позиции по якорю. */
  serverNow(): number;
  /** Сразу вызывает listener с текущим состоянием, потом — при каждом изменении. */
  subscribe(listener: (state: SyncState) => void): () => void;
  onError(listener: (error: SyncError) => void): () => void;
  createRoom(name: string): void;
  joinRoom(roomId: RoomId, name: string): void;
  leaveRoom(): void;

  play(): void;
  pause(): void;
  seek(positionMs: number): void;

  proposeSource(offer: SourceOffer): void;
  /** sourceRev — номер источника, с которым сравнивали файл, а не текущий. */
  reportSourceMatch(sourceRev: number, ok: boolean): void;

  dispose(): void;
}

/** Связь с элементом video: создаётся при монтировании плеера. */
export interface PlayerBridge {
  /**
   * Вызвать в обработчике клика «Присоединиться»: коротко запускает video
   * и ставит на паузу, чтобы браузер разрешил звук (decisions.md, 4.10).
   */
  unlock(): Promise<void>;
  dispose(): void;
}
