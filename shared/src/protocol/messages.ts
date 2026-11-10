import { z } from "zod";
import { SyncPingSchema, SyncPongSchema } from "./clock.js";
import { ErrorMessageSchema } from "./error.js";
import {
  PlaybackHoldSchema,
  PlaybackIntentSchema,
  PlaybackStateSchema,
} from "./playback.js";
import { PresenceSyncSchema, PresenceUpdateSchema } from "./presence.js";
import {
  RoomCreateSchema,
  RoomJoinSchema,
  RoomLeaveSchema,
  RoomPeerJoinedSchema,
  RoomPeerLeftSchema,
  RoomStateSchema,
} from "./room.js";
import {
  SourceMatchedSchema,
  SourceProposeSchema,
  SourceStateSchema,
} from "./source.js";

/** Всё, что клиент может прислать серверу. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  RoomCreateSchema,
  RoomJoinSchema,
  RoomLeaveSchema,
  SyncPingSchema,
  PlaybackIntentSchema,
  PresenceUpdateSchema,
  SourceProposeSchema,
  SourceMatchedSchema,
]);

/** Всё, что сервер может прислать клиенту. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  RoomStateSchema,
  RoomPeerJoinedSchema,
  RoomPeerLeftSchema,
  SyncPongSchema,
  PlaybackStateSchema,
  PlaybackHoldSchema,
  PresenceSyncSchema,
  SourceStateSchema,
  ErrorMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Итог разбора: либо сообщение, либо текст ошибки.
 *  Исключений не бросает. */
export type ParseResult<T> =
  | {
      ok: true;
      message: T;
    }
  | {
      ok: false;
      error: string;
    };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "сообщение не является JSON" };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: z.prettifyError(result.error),
    };
  }
  return {
    ok: true,
    message: result.data,
  };
}

/** Разбор на сервере: строка из WebSocket => проверенное сообщение клиента. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, raw);
}

/** Разбор в воркере: строка из WebSocket => проверенное сообщение сервера. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw);
}
