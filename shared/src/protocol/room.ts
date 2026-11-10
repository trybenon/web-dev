import { z } from "zod";
import {
  ConnectionSchema,
  defineMessage,
  NameSchema,
  PeerIdSchema,
  RoomIdSchema,
  SessionTokenSchema,
} from "./common.js";
import { PlaybackSchema } from "./playback.js";
import { SourceInfoSchema } from "./source.js";

/** Участник комнаты, как его видят остальные. */
export const PeerSchema = z.object({
  peerId: PeerIdSchema,
  name: NameSchema,
  connection: ConnectionSchema,
});

// клиент → сервер
export const RoomCreateSchema = defineMessage(
  "room:create",
  z.object({ name: NameSchema }),
);

export const RoomJoinSchema = defineMessage(
  "room:join",
  z.object({
    roomId: RoomIdSchema,
    name: NameSchema,
    /** Есть только при возвращении после обрыва. */
    sessionToken: SessionTokenSchema.optional(),
  }),
);

export const RoomLeaveSchema = defineMessage("room:leave", z.object({}));

// сервер → клиенту
export const RoomStateSchema = defineMessage(
  "room:state",
  z.object({
    roomId: RoomIdSchema,
    /** Мой peerId. */
    you: PeerIdSchema,
    sessionToken: SessionTokenSchema,
    peers: z.array(PeerSchema),
    playback: PlaybackSchema,
    source: SourceInfoSchema.nullable(),
  }),
);

export const RoomPeerJoinedSchema = defineMessage(
  "room:peer_joined",
  z.object({ peer: PeerSchema }),
);

export const RoomPeerLeftSchema = defineMessage(
  "room:peer_left",
  z.object({ peerId: PeerIdSchema }),
);

export type Peer = z.infer<typeof PeerSchema>;
