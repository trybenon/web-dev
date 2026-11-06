import { z } from "zod";
import { defineMessage, MsSchema, PeerIdSchema } from "./common.js";

/** Размер одного куска файла для отпечатка: 1 МиБ. */
export const SAMPLE_BYTES = 1_048_576;

/** SHA-256 в виде 64 шестнадцатеричных символов в нижнем регистре. */
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Отпечаток файла v1: размер и хеши начала, середины и конца (docs/protocol.md). */
export const FingerprintSchema = z.object({
  v: z.literal(1),
  sizeBytes: z.number().int().nonnegative(),
  sampleBytes: z.literal(SAMPLE_BYTES),
  samples: z.array(Sha256HexSchema).length(3),
});

/** Что участник предлагает как источник комнаты. */
export const SourceOfferSchema = z.object({
  fingerprint: FingerprintSchema,
  /** null — браузер не смог открыть файл и узнать длительность. */
  durationMs: MsSchema.nullable(),
  /** Только подсказка новичку, что смотрят. */
  fileName: z.string().min(1).max(255),
});

/** Источник комнаты: предложение плюс кто его сделал. */
export const SourceInfoSchema = SourceOfferSchema.extend({
  proposedBy: PeerIdSchema,
});

// клиент → сервер
export const SourceProposeSchema = defineMessage(
  "source:propose",
  SourceOfferSchema,
);

export const SourceMatchedSchema = defineMessage(
  "source:matched",
  z.object({ ok: z.boolean() }),
);

// сервер → всем
export const SourceStateSchema = defineMessage(
  "source:state",
  z.object({
    /** null — источник в комнате ещё не выбран. */
    source: SourceInfoSchema.nullable(),
    /** Кто уже сверил свой файл. Кого нет в списке — ещё не сверял. */
    checks: z.array(z.object({ peerId: PeerIdSchema, ok: z.boolean() })),
  }),
);

export type Fingerprint = z.infer<typeof FingerprintSchema>;
export type SourceOffer = z.infer<typeof SourceOfferSchema>;
export type SourceInfo = z.infer<typeof SourceInfoSchema>;
