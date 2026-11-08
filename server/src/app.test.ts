import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppServer } from "./app.js";

const html = "<!doctype html><html><body>Test page</body></html>";
const javascript = 'console.log("Test script");';
const stylesheet = "body { background: black; }";
const videoContent = "0123456789";

let server: ReturnType<typeof createAppServer>;
let temporaryDirectory: string;
let baseUrl: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "watch-together-http-"));

  const indexPath = join(temporaryDirectory, "index.html");
  await writeFile(indexPath, html);
  const assetsDirectory = join(temporaryDirectory, "assets");

  const mediaDirectory = join(temporaryDirectory, "media");

  await mkdir(mediaDirectory);
  await writeFile(join(mediaDirectory, "demo.webm"), videoContent);

  await mkdir(assetsDirectory);
  await writeFile(join(assetsDirectory, "app.js"), javascript);
  await writeFile(join(assetsDirectory, "app.css"), stylesheet);
  await writeFile(
    join(assetsDirectory, "example.bin"),
    Buffer.from([0, 127, 255]),
  );
  server = createAppServer(pathToFileURL(indexPath));
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

  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("HTTP server", () => {
  it("returns an unknown file type as binary data", async () => {
    const response = await fetch(`${baseUrl}/assets/example.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );

    const content = new Uint8Array(await response.arrayBuffer());

    expect(Array.from(content)).toEqual([0, 127, 255]);
  });
  it("returns 404 when the client build is missing", async () => {
    const indexPath = join(temporaryDirectory, "index.html");
    const backupPath = join(temporaryDirectory, "index.backup");

    await rename(indexPath, backupPath);

    try {
      const response = await fetch(`${baseUrl}/`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Client build not found");
    } finally {
      await rename(backupPath, indexPath);
    }
  });
  it("returns 404 when the demo file is missing", async () => {
    const videoPath = join(temporaryDirectory, "media", "demo.webm");
    const backupPath = join(temporaryDirectory, "media", "demo.backup");

    await rename(videoPath, backupPath);

    try {
      const response = await fetch(`${baseUrl}/media/demo.webm`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");

      const healthResponse = await fetch(`${baseUrl}/api/health`);

      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: "ok" });
    } finally {
      await rename(backupPath, videoPath);
    }
  });
  it("returns 404 when the demo path points to a directory", async () => {
    const videoPath = join(temporaryDirectory, "media", "demo.webm");
    const backupPath = join(temporaryDirectory, "media", "demo.backup");

    await rename(videoPath, backupPath);

    try {
      await mkdir(videoPath);

      const response = await fetch(`${baseUrl}/media/demo.webm`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    } finally {
      await rm(videoPath, { recursive: true, force: true });
      await rename(backupPath, videoPath);
    }
  });
  it("returns the application HTML for a client route", async () => {
    const response = await fetch(`${baseUrl}/watch`, {
      headers: {
        Accept: "text/html",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(html);
  });
  it.each([
    "/api/missing",
    "/assets/missing.js",
    "/media/missing.webm",
    "/missing.js",
  ])("returns 404 instead of HTML for %s", async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: {
        Accept: "text/html",
      },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
  it("returns the complete video when Range is absent", async () => {
    const response = await fetch(`${baseUrl}/media/demo.webm`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe(videoContent);
  });
  it.each([
    {
      range: "bytes=2-5",
      expectedBody: "2345",
      expectedContentRange: "bytes 2-5/10",
    },
    {
      range: "bytes=7-",
      expectedBody: "789",
      expectedContentRange: "bytes 7-9/10",
    },
    {
      range: "bytes=-3",
      expectedBody: "789",
      expectedContentRange: "bytes 7-9/10",
    },
    {
      range: "bytes=8-99",
      expectedBody: "89",
      expectedContentRange: "bytes 8-9/10",
    },
  ])(
    "returns a partial video for $range",
    async ({ range, expectedBody, expectedContentRange }) => {
      const response = await fetch(`${baseUrl}/media/demo.webm`, {
        headers: {
          Range: range,
        },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe("video/webm");
      expect(response.headers.get("content-range")).toBe(expectedContentRange);
      expect(response.headers.get("content-length")).toBe(
        String(expectedBody.length),
      );
      expect(await response.text()).toBe(expectedBody);
    },
  );
  it.each(["bytes=10-", "bytes=8-3", "bytes=abc-def"])(
    "returns 416 for an invalid range: %s",
    async (range) => {
      const response = await fetch(`${baseUrl}/media/demo.webm`, {
        headers: {
          Range: range,
        },
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
      expect(await response.text()).toBe("");

      const healthResponse = await fetch(`${baseUrl}/api/health`);

      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ status: "ok" });
    },
  );
  it("returns the main page for a room invitation URL", async () => {
    const response = await fetch(`${baseUrl}/?room=abc123`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(html);
  });
  it("rejects a path outside the client directory", async () => {
    const response = await fetch(`${baseUrl}/assets/..%2f..%2fprivate.txt`);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("rejects malformed URL encoding", async () => {
    const response = await fetch(`${baseUrl}/assets/%ZZ.js`);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad request");
  });

  it("rejects a null byte in a file path", async () => {
    const response = await fetch(`${baseUrl}/assets/app%00.js`);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad request");
  });
  it("returns a JavaScript asset", async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe(javascript);
  });

  it("returns a CSS asset with query parameters", async () => {
    const response = await fetch(`${baseUrl}/assets/app.css?v=123`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(await response.text()).toBe(stylesheet);
  });

  it("returns 404 for a missing asset", async () => {
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
  it("returns the main page as HTML", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(html);
  });
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
