import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const manifestName = "manifest.json";

export function validateDsn(dsn) {
  assert(dsn && !/[\s'\\]/u.test(dsn), "Set a valid Bugsink DSN");
  const parsed = new URL(dsn);
  assert(
    ["https:", "http:"].includes(parsed.protocol) &&
      parsed.username &&
      parsed.pathname !== "/",
    "Invalid Bugsink DSN",
  );
  return dsn;
}

async function filesIn(directory, prefix = "") {
  const result = [];
  for (const item of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (path === manifestName) continue;
    assert(!item.isSymbolicLink(), `Unexpected symlink: ${path}`);
    if (item.isDirectory()) result.push(...(await filesIn(directory, path)));
    else result.push(path);
  }
  return result.sort();
}

export async function inspectArtifacts(directory) {
  const files = {};
  const maps = [];
  for (const path of await filesIn(directory)) {
    const data = await readFile(join(directory, path));
    files[path] = createHash("sha256").update(data).digest("hex");
    if (!path.endsWith(".js.map")) continue;
    const map = JSON.parse(data);
    const javascript = await readFile(
      join(directory, path.slice(0, -4)),
      "utf8",
    );
    assert(map.debug_id, `Missing debug ID: ${path}`);
    assert(
      javascript.includes(`//# debugId=${map.debug_id}`),
      `JavaScript/map debug ID mismatch: ${path}`,
    );
    assert(
      map.sources?.length > 0 &&
        map.sourcesContent?.length === map.sources.length &&
        map.sourcesContent.every((source) => typeof source === "string"),
      `Missing embedded source code: ${path}`,
    );
    maps.push(path);
  }
  for (const workspace of ["client", "server", "shared"]) {
    assert(
      maps.some((path) => path.startsWith(`${workspace}/dist/`)),
      `Missing source maps for ${workspace}`,
    );
  }
  for (const path of Object.keys(files).filter((path) =>
    path.endsWith(".js"),
  )) {
    assert(
      maps.includes(`${path}.map`),
      `JavaScript has no source map: ${path}`,
    );
  }
  return { files, maps };
}

export async function writeManifest(directory, release) {
  assert(
    /^[0-9a-f]{40}$/.test(release),
    "APP_RELEASE must be a full commit SHA",
  );
  const artifacts = await inspectArtifacts(directory);
  await writeFile(
    join(directory, manifestName),
    `${JSON.stringify({ release, ...artifacts }, null, 2)}\n`,
  );
  return artifacts;
}

export async function verifyArtifacts(directory, release) {
  const manifest = JSON.parse(
    await readFile(join(directory, manifestName), "utf8"),
  );
  assert.equal(
    manifest.release,
    release,
    "Release SHA does not match artifacts",
  );
  const actual = await inspectArtifacts(directory);
  assert.deepEqual(
    actual.files,
    manifest.files,
    "Release files changed after preparation",
  );
  assert.deepEqual(actual.maps, manifest.maps, "Release source maps changed");
  return manifest;
}
