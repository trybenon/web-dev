/**
 * Точка входа синхронизации для интерфейса: импортируйте отсюда.
 *
 * Пока воркера нет (#5), createSyncClient и createPlayerBridge — заглушки.
 * Настоящая реализация заменит их здесь же, интерфейс останется прежним.
 */
import { createStubPlayerBridge, createStubSyncClient } from "./stub";

export type {
  ConnectionState,
  HoldView,
  PeerView,
  PlayerBridge,
  RoomView,
  SourceView,
  SyncClient,
  SyncError,
  SyncState,
} from "./types";
// Заглушки — для тестов интерфейса: они останутся заглушками и после #5.
export type { StubOptions, VideoLike } from "./stub";
export {
  createStubPlayerBridge,
  createStubSyncClient,
  positionAt,
  STUB_ROOM_IDS,
} from "./stub";

/** Для приложения. Пока воркера нет (#5) — заглушка, потом настоящий клиент. */
export const createSyncClient = createStubSyncClient;
export const createPlayerBridge = createStubPlayerBridge;
