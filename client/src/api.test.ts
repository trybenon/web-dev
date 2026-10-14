import { afterEach, describe, expect, it, vi } from "vitest";
import { getHealth } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getHealth", () => {
  it("requests the health endpoint and returns its response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getHealth();

    expect(fetchMock).toHaveBeenCalledWith("/api/health");
    expect(result).toEqual({ status: "ok" });
  });

  it("rejects when the server returns an unsuccessful HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(getHealth()).rejects.toThrow("Server returned HTTP 503");
  });

  it("propagates a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Network unavailable")),
    );

    await expect(getHealth()).rejects.toThrow("Network unavailable");
  });
});
