import { z } from "zod";

/**Пределы протокола. Сервер проверяет их, клиент может показать заранее. */
export const LIMITS = {
  maxPeers: 4,
  maxNameLength: 32,
  /** Предел одного сообщения протокола по WebSocket, байт. Больше — сервер рвёт соединение не разбирая. */
  maxWsMessageBytes: 64 * 1024,
} as const;

/**Идентификатор участника. Выдает сервер при входе. */
export const PeerIdSchema = z.string().min(1).max(64);

/** Идентификатор комнаты. Выдаёт сервер при создании, попадает в ссылку. */
export const RoomIdSchema = z.string().min(1).max(64);

/**Токен сессии для возобновления после обрыва. Хранится только в памяти воркера. */
export const SessionTokenSchema = z.string().min(1).max(128);

/**Отображение имени участника.*/
export const NameSchema = z.string().trim().min(1).max(LIMITS.maxNameLength);

/**Момент по серверным часа, мс. */
export const ServerTimeSchema = z.number().nonnegative();

/**Позиция видеоряда или длительность, мс. Дробные значения допустимы.*/
export const MsSchema = z.number().nonnegative();

/**Номер ревизии воспроизведения. */
export const RevSchema = z.number().int().nonnegative();

/**На связи ли участник: reconnecting - оборвался, сервер держит место 30 сек */
export const ConnectionSchema = z.enum(["online", "reconnecting"]);

/**
 * Собирает схему сообщения в конверте `{ type, payload }`.
 *
 * T запоминает конкретную строку, а не просто стринг,
 * по ней TS отличает сообщения друг от друга.
 */
export function defineMessage<T extends string, P extends z.ZodType>(
  type: T,
  payload: P,
) {
  return z.object({ type: z.literal(type), payload });
}

export type PeerId = z.infer<typeof PeerIdSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
