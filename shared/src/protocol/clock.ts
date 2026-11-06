import { z } from "zod";
import { defineMessage, ServerTimeSchema } from "./common.js";

// клиент → сервер: t0 — момент отправки по монотонным часам клиента
export const SyncPingSchema = defineMessage(
  "sync:ping",
  z.object({ t0: z.number() }),
);

// сервер → клиенту: t0 без изменений, t1 — приём, t2 — отправка по часам сервера
export const SyncPongSchema = defineMessage(
  "sync:pong",
  z.object({
    t0: z.number(),
    t1: ServerTimeSchema,
    t2: ServerTimeSchema,
  }),
);
