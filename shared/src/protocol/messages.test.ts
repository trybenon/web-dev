import { describe, expect, it } from "vitest";
import {
  clientExamples,
  invalidClientMessages,
  invalidServerMessages,
  serverExamples,
} from "../fixtures/messages.js";
import {
  ClientMessageSchema,
  parseClientMessage,
  parseServerMessage,
  ServerMessageSchema,
} from "./messages.js";

/** Все значения поля type, которые знает схема. */
function typesOf(
  schema: typeof ClientMessageSchema | typeof ServerMessageSchema,
) {
  return schema.options.map((option) => option.shape.type.value);
}

describe("ClientMessageSchema", () => {
  it.each(Object.entries(clientExamples))(
    "принимает пример %s",
    (_, message) => {
      expect(ClientMessageSchema.safeParse(message).success).toBe(true);
    },
  );

  it.each(invalidClientMessages)("отклоняет: $why", ({ data }) => {
    expect(ClientMessageSchema.safeParse(data).success).toBe(false);
  });

  it("на каждый тип есть корректный пример", () => {
    const covered = Object.values(clientExamples).map((m) => m.type);
    expect(new Set(covered)).toEqual(new Set(typesOf(ClientMessageSchema)));
  });

  it("обрезает пробелы в имени", () => {
    const result = ClientMessageSchema.parse({
      type: "room:create",
      payload: { name: "  Аня  " },
    });
    expect(result).toEqual({ type: "room:create", payload: { name: "Аня" } });
  });
});

describe("ServerMessageSchema", () => {
  it.each(Object.entries(serverExamples))(
    "принимает пример %s",
    (_, message) => {
      expect(ServerMessageSchema.safeParse(message).success).toBe(true);
    },
  );

  it.each(invalidServerMessages)("отклоняет: $why", ({ data }) => {
    expect(ServerMessageSchema.safeParse(data).success).toBe(false);
  });

  it("на каждый тип есть корректный пример", () => {
    const covered = Object.values(serverExamples).map((m) => m.type);
    expect(new Set(covered)).toEqual(new Set(typesOf(ServerMessageSchema)));
  });

  it("типы клиента и сервера не пересекаются", () => {
    const server = new Set(typesOf(ServerMessageSchema));
    const both = typesOf(ClientMessageSchema).filter((t) => server.has(t));
    expect(both).toEqual([]);
  });
});

describe("parseClientMessage", () => {
  it("разбирает корректную строку", () => {
    const raw = JSON.stringify(clientExamples.playbackIntent);
    expect(parseClientMessage(raw)).toEqual({
      ok: true,
      message: clientExamples.playbackIntent,
    });
  });

  it("не бросает исключение на не-JSON", () => {
    expect(parseClientMessage("{oops")).toEqual({
      ok: false,
      error: "сообщение не является JSON",
    });
  });

  it("объясняет, какое поле не прошло проверку", () => {
    const raw = JSON.stringify({
      type: "playback:intent",
      payload: { action: "stop", positionMs: 0 },
    });
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("payload.action");
    }
  });

  it("выбрасывает лишние поля", () => {
    const raw = JSON.stringify({
      type: "sync:ping",
      payload: { t0: 1, extra: true },
      extra: true,
    });
    expect(parseClientMessage(raw)).toEqual({
      ok: true,
      message: { type: "sync:ping", payload: { t0: 1 } },
    });
  });
});

describe("parseServerMessage", () => {
  it("разбирает корректную строку", () => {
    const raw = JSON.stringify(serverExamples.roomState);
    expect(parseServerMessage(raw)).toEqual({
      ok: true,
      message: serverExamples.roomState,
    });
  });

  it("отклоняет сообщение клиента", () => {
    const raw = JSON.stringify(clientExamples.syncPing);
    expect(parseServerMessage(raw).ok).toBe(false);
  });
});
