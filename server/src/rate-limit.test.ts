import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("message rate limiter", () => {
  it("allows messages up to the limit and rejects the next", () => {
    const check = createRateLimiter({
      limit: 2,
      now: () => 0,
    });

    expect(check()).toEqual({ allowed: true, notify: false });
    expect(check()).toEqual({ allowed: true, notify: false });
    expect(check()).toEqual({ allowed: false, notify: true });
    expect(check()).toEqual({ allowed: false, notify: false });
  });

  it("allows messages again after the window expires", () => {
    let time = 0;
    const check = createRateLimiter({
      limit: 1,
      now: () => time,
    });

    expect(check().allowed).toBe(true);
    expect(check().allowed).toBe(false);

    time = 1000;

    expect(check().allowed).toBe(true);
  });

  it("does not notify more often than once per second", () => {
    let time = 0;
    const check = createRateLimiter({
      limit: 1,
      windowMs: 10_000,
      now: () => time,
    });

    expect(check().allowed).toBe(true);
    expect(check()).toEqual({ allowed: false, notify: true });

    time = 999;

    expect(check()).toEqual({ allowed: false, notify: false });

    time = 1000;

    expect(check()).toEqual({ allowed: false, notify: true });
  });

  it("keeps client limits independent", () => {
    const first = createRateLimiter({ limit: 1, now: () => 0 });
    const second = createRateLimiter({ limit: 1, now: () => 0 });

    expect(first().allowed).toBe(true);
    expect(first().allowed).toBe(false);
    expect(second().allowed).toBe(true);
  });
});
