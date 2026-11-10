import type { ErrorEvent, StackFrame } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { sanitizeErrorEvent } from "./monitoring.js";

function errorAt(platform: string, frame: StackFrame): ErrorEvent {
  return {
    type: undefined,
    platform,
    exception: {
      values: [{ type: "Error", stacktrace: { frames: [frame] } }],
    },
  };
}

describe("sanitizeErrorEvent", () => {
  it("убирает пользовательские данные и сохраняет место ошибки, версию и debug ID", () => {
    const url = "https://app.example/assets/index-test.js";
    const debugId = "b6804fde-acfc-5b5d-bdc8-956ac063d402";
    const frame = {
      filename: `${url}?token=test-token-123`,
      abs_path: `${url}#test-chat-text`,
      lineno: 13,
      colno: 42,
      in_app: true,
      vars: { chat: "test-chat-text" },
    };
    const filtered = sanitizeErrorEvent({
      ...errorAt("javascript", frame),
      release: "test-commit",
      request: { headers: { Authorization: "Bearer test-token-123" } },
      extra: { video: "demo-private.mkv" },
      breadcrumbs: [{ message: "test-chat-text" }],
      exception: {
        values: [
          {
            value: "test-token-123 demo-private.mkv test-chat-text",
            stacktrace: { frames: [{ in_app: false }, frame] },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: "sourcemap",
            code_file: frame.filename,
            debug_id: debugId,
          },
        ],
      },
    });

    expect(filtered).toMatchObject({
      release: "test-commit",
      fingerprint: ["client", "assets/index-test.js", "13", "42"],
      exception: {
        values: [
          {
            value: "Клиент · assets/index-test.js:13:42",
            stacktrace: {
              frames: [
                { in_app: false },
                { filename: url, abs_path: url, lineno: 13, colno: 42 },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [{ type: "sourcemap", code_file: url, debug_id: debugId }],
      },
    });

    const payload = JSON.stringify(filtered);
    for (const value of [
      "test-token-123",
      "demo-private.mkv",
      "test-chat-text",
    ]) {
      expect(payload).not.toContain(value);
    }
  });

  it("группирует повтор одной ошибки и разделяет разные позиции и платформы", () => {
    const frame = {
      filename: "http://localhost:5173/src/main.ts?run=1",
      in_app: true,
      lineno: 17,
      colno: 4,
    };
    const first = sanitizeErrorEvent(errorAt("javascript", frame));
    const repeat = sanitizeErrorEvent(
      errorAt("javascript", {
        ...frame,
        filename: "http://localhost:5173/src/main.ts?run=2",
      }),
    );
    const otherPosition = sanitizeErrorEvent(
      errorAt("javascript", { ...frame, colno: 20 }),
    );
    const server = sanitizeErrorEvent(
      errorAt("node", { ...frame, filename: "/app/server/src/main.ts" }),
    );

    expect(first?.fingerprint).toEqual(["client", "src/main.ts", "17", "4"]);
    expect(repeat?.fingerprint).toEqual(first?.fingerprint);
    expect(otherPosition?.fingerprint).not.toEqual(first?.fingerprint);
    expect(server?.fingerprint).toEqual(["server", "src/main.ts", "17", "4"]);
    expect(server?.exception?.values?.[0]?.value).toBe(
      "Сервер · src/main.ts:17:4",
    );
  });

  it("обрабатывает исключение без стека", () => {
    const filtered = sanitizeErrorEvent({
      type: undefined,
      platform: "node",
      exception: { values: [{ value: "private text" }] },
    });

    expect(filtered?.fingerprint).toEqual(["server", "unknown-location"]);
    expect(filtered?.exception?.values?.[0]?.value).toBe(
      "Сервер · ошибка приложения",
    );
  });

  it("отбрасывает события без исключений", () => {
    expect(
      sanitizeErrorEvent({ type: undefined, message: "private text" }),
    ).toBeNull();
    expect(
      sanitizeErrorEvent({ type: undefined, exception: { values: [] } }),
    ).toBeNull();
  });
});
