import { z } from "zod";
import { defineMessage } from "./common.js";

export const ErrorCodeSchema = z.enum([
  "room_not_found",
  "room_full",
  "not_joined",
  "rate_limited",
  "invalid_message",
]);

// сервер → клиенту
export const ErrorMessageSchema = defineMessage(
  "error",
  z.object({
    code: ErrorCodeSchema,
    /** Текст для журнала и отладки; интерфейс выбирает подпись по code. */
    message: z.string(),
  }),
);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
