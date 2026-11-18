import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { verifyArtifacts } from "./release-artifacts.mjs";

const directory = resolve(process.argv[2] ?? ".release");
await verifyArtifacts(directory, process.env.APP_RELEASE);
const { createAppServer } = await import(
  pathToFileURL(`${directory}/server/dist/app.js`).href
);
const { attachWebSocketGateway } = await import(
  pathToFileURL(`${directory}/server/dist/ws-gateway.js`).href
);
const server = createAppServer(
  pathToFileURL(`${directory}/client/dist/index.html`),
);
const gateway = attachWebSocketGateway(server);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let resolveEvent;
  const eventPromise = new Promise((resolve) => {
    resolveEvent = resolve;
  });
  // Capture all external traffic locally, including the production DSN endpoint.
  // A build check never submits its deliberate exception to Bugsink.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin) return route.continue();
    const lines = request.postData()?.split("\n") ?? [];
    for (let i = 1; i < lines.length - 1; i += 2) {
      const header = JSON.parse(lines[i]);
      if (header.type === "event") resolveEvent(JSON.parse(lines[i + 1]));
    }
    await route.fulfill({
      status: 200,
      body: "{}",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  });
  await page.goto(origin);
  await page
    .getByRole("textbox", { name: "Имя", exact: true })
    .fill("Monitoring check");
  const button = page.getByRole("button", {
    name: "Создать комнату",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const post = globalThis.Worker.prototype.postMessage;
    globalThis.Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.type === "createRoom")
        throw new Error("Monitoring build check");
      return post.call(this, message, ...rest);
    };
  });
  await button.click();
  let timer;
  const event = await Promise.race([
    eventPromise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Vue SDK did not report the test exception")),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(event.release, process.env.APP_RELEASE);
  const image = event.debug_meta?.images?.find((image) =>
    image.code_file.includes("/assets/index-"),
  );
  assert(image, "Browser SDK/filter lost the client debug ID");
  const file = basename(new URL(image.code_file).pathname);
  const map = JSON.parse(
    await readFile(`${directory}/client/dist/assets/${file}.map`, "utf8"),
  );
  assert.equal(image.debug_id, map.debug_id);
  const frames = event.exception.values
    .flatMap((exception) => exception.stacktrace.frames)
    .filter((frame) => frame.filename === image.code_file);
  const sourceMap = new SourceMap(map);
  const originalFrames = frames.map((frame) =>
    sourceMap.findEntry(frame.lineno - 1, frame.colno - 1),
  );
  const vueFrame = originalFrames.find((frame) =>
    frame.originalSource?.endsWith("/RoomEntryForm.vue"),
  );
  assert(vueFrame, "Browser event did not map back to RoomEntryForm.vue");
  const source =
    map.sourcesContent[map.sources.indexOf(vueFrame.originalSource)];
  assert(
    source.split("\n")[vueFrame.originalLine],
    "Missing original Vue code context",
  );
  console.log(
    `Browser monitoring check passed: Vue event → debug ID → RoomEntryForm.vue:${vueFrame.originalLine + 1} and original code`,
  );
} finally {
  await browser?.close();
  for (const socket of gateway.clients) socket.terminate();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
