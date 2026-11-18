import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { verifyArtifacts } from "./release-artifacts.mjs";

const directory = resolve(process.argv[2] ?? ".release");
const runtime = resolve(process.argv[3] ?? directory);
const release = process.env.APP_RELEASE;
const manifest = await verifyArtifacts(directory, release);
if (runtime !== directory) {
  for (const path of manifest.maps) {
    await assert.rejects(
      access(`${runtime}/${path}`),
      { code: "ENOENT" },
      `Source map leaked into the runtime image: ${path}`,
    );
  }
}
for (const [path, expected] of Object.entries(manifest.files)) {
  if (!path.includes("/dist/") || path.endsWith(".map")) continue;
  const actual = createHash("sha256")
    .update(await readFile(`${runtime}/${path}`))
    .digest("hex");
  assert.equal(
    actual,
    expected,
    `Runtime file differs from uploaded build: ${path}`,
  );
}

const { sanitizeErrorEvent } = await import(
  pathToFileURL(`${runtime}/shared/dist/monitoring.js`).href
);
const { createRateLimiter } = await import(
  pathToFileURL(`${runtime}/server/dist/rate-limit.js`).href
);
let event;
Sentry.init({
  dsn: "https://public@bugsink.invalid/1",
  release,
  environment: "monitoring-build-check",
  defaultIntegrations: false,
  sendDefaultPii: false,
  beforeSend: sanitizeErrorEvent,
  transport: () => ({
    send(envelope) {
      for (const [header, payload] of envelope[1]) {
        if (header.type === "event") event = payload;
      }
      return Promise.resolve({ statusCode: 200 });
    },
    flush: () => Promise.resolve(true),
  }),
});
try {
  // Trigger a real exception in compiled application code; no test route is shipped.
  createRateLimiter({ now: null });
  assert.fail("Expected a rate limiter initialization error");
} catch (error) {
  Sentry.captureException(error);
}
await Sentry.close(2_000);
assert(event, "SDK did not deliver the test event to the in-memory transport");
assert.equal(event.release, release);
const frame = event.exception.values
  .flatMap((exception) => exception.stacktrace.frames)
  .find((item) => item.filename?.endsWith("/server/dist/rate-limit.js"));
assert(frame, "Missing application frame in the filtered SDK event");
const map = JSON.parse(
  await readFile(`${directory}/server/dist/rate-limit.js.map`, "utf8"),
);
assert(
  event.debug_meta.images.some(
    (image) =>
      image.code_file === frame.filename && image.debug_id === map.debug_id,
  ),
  "SDK/filter lost the server debug ID",
);
const original = new SourceMap(map).findEntry(
  frame.lineno - 1,
  frame.colno - 1,
);
assert(
  original.originalSource?.endsWith("/rate-limit.ts"),
  "Frame did not map to TypeScript",
);
const source = map.sourcesContent[map.sources.indexOf(original.originalSource)];
assert(
  source?.split("\n")[original.originalLine].includes("now()"),
  "Missing original TypeScript code context",
);
assert(
  !JSON.stringify(event).includes("context_line"),
  "Source context should be resolved from uploaded maps",
);
console.log(
  `Monitoring check passed: SDK event → debug ID → rate-limit.ts:${original.originalLine + 1} and original code`,
);
