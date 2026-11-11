/**
 * Точка входа синхронизации для интерфейса: импортируйте отсюда.
 *
 * createSyncClient и createPlayerBridge — настоящие: воркер, сервер, часы.
 * Заглушки остаются для тестов интерфейса и работы без сервера;
 * их мост работает только с заглушкой, а настоящий — только с настоящим клиентом.
 */
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
export type { SyncClientOptions } from "./client";
export type { BridgeVideo } from "./player-bridge";
export type { StubOptions, VideoLike } from "./stub";
export {
  createStubPlayerBridge,
  createStubSyncClient,
  STUB_ROOM_IDS,
} from "./stub";
export { positionAt } from "./timeline";
export { createSyncClient } from "./client";
export { createPlayerBridge } from "./player-bridge";
