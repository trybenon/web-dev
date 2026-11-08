import { z } from "zod";
import {
  defineMessage,
  MsSchema,
  PeerIdSchema,
  RevSchema,
  ServerTimeSchema,
} from "./common.js";

/** Авторитетное состояние воспроизведения комнаты (docs/sync-start.md, раздел 3). */
export const PlaybackSchema = z.object({
  rev: RevSchema,
  status: z.enum(["playing", "paused", "waiting"]),
  /** В момент anchorServerTime головка должна стоять в positionMs. */
  positionMs: MsSchema,
  anchorServerTime: ServerTimeSchema,
  rate: z.number().positive(),
  /** Кто вызвал изменение; null — начальное состояние, никто ещё не менял. */
  setBy: PeerIdSchema.nullable(),
});

// клиент => сервер
export const PlaybackIntentSchema = defineMessage(
  "playback:intent",
  // позицию несёт только перемотка: play и pause сервер считает сам
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("play") }),
    z.object({ action: z.literal("pause") }),
    z.object({ action: z.literal("seek"), positionMs: MsSchema }),
  ]),
);

// сервер => всем
export const PlaybackStateSchema = defineMessage(
  "playback:state",
  PlaybackSchema,
);

export const PlaybackHoldSchema = defineMessage(
  "playback:hold",
  z.object({
    /** Ревизия состояния waiting, к которой относится удержание. */
    rev: RevSchema,
    waitingFor: z.array(PeerIdSchema),
    reason: z.enum(["buffering", "seeking", "no-source"]),
    deadline: ServerTimeSchema,
  }),
);

export type Playback = z.infer<typeof PlaybackSchema>;
export type PlaybackStatus = Playback["status"];
