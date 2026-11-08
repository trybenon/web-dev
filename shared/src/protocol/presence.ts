import { z } from "zod";
import {
  ConnectionSchema,
  defineMessage,
  MsSchema,
  PeerIdSchema,
  ServerTimeSchema,
} from "./common.js";

/** Отчёт клиента о готовности (docs/sync-start.md, раздел 3). */
export const PresenceSchema = z.object({
  /** readyState элемента video. */
  readyState: z.number().int().min(0).max(4),
  bufferedAheadMs: MsSchema,
  playerState: z.enum(["playing", "paused", "buffering", "seeking"]),
  hasSource: z.boolean(),
  /** Плюс — отстаём от комнаты, минус — опережаем, null — сравнивать не с чем. */
  deviationMs: z.number().nullable(),
  /** Момент замера отклонения по серверным часам. */
  deviationAt: ServerTimeSchema,
  /** Ревизия, к которой плеер уже подготовлен; −1 — ещё ничего не применял. */
  appliedRev: z.number().int().min(-1),
  /** Больше 10 с не бывает; без предела один клиент отодвинул бы старт для всех. */
  rttMs: MsSchema.max(10_000),
});

/** То же по одному участнику в рассылке сервера. */
export const PeerPresenceSchema = PresenceSchema.extend({
  peerId: PeerIdSchema,
  connection: ConnectionSchema,
});

// клиент → сервер, раз в секунду и при каждой смене состояния
export const PresenceUpdateSchema = defineMessage(
  "presence:update",
  PresenceSchema,
);

// сервер → всем
export const PresenceSyncSchema = defineMessage(
  "presence:sync",
  z.object({ peers: z.array(PeerPresenceSchema) }),
);

export type Presence = z.infer<typeof PresenceSchema>;
export type PeerPresence = z.infer<typeof PeerPresenceSchema>;
