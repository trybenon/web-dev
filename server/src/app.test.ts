import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppServer } from "./app.js";

const server = createAppServer();
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Could not determine server port");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

describe("HTTP server", () => {
  it("returns health status as JSON", async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for an unknown path", async () => {
    const response = await fetch(`${baseUrl}/unknown`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("does not accept POST at the health endpoint", async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});
