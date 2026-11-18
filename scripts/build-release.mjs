import assert from "node:assert/strict";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateDsn, writeManifest } from "./release-artifacts.mjs";

const release = process.env.APP_RELEASE;
const dsn = validateDsn(process.env.BUGSINK_DSN);
assert(
  /^[0-9a-f]{40}$/.test(release ?? ""),
  "Set APP_RELEASE to a full commit SHA",
);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

// Clear generated outputs to avoid shipping JavaScript from deleted source files.
for (const directory of [
  ".release",
  "client/dist",
  "server/dist",
  "shared/dist",
]) {
  await rm(directory, { recursive: true, force: true });
}
run("npm", ["run", "build"], {
  ...process.env,
  VITE_BUGSINK_DSN: dsn,
  VITE_APP_RELEASE: release,
});
for (const workspace of ["client", "server", "shared"]) {
  await mkdir(`.release/${workspace}`, { recursive: true });
  await cp(`${workspace}/package.json`, `.release/${workspace}/package.json`);
  await cp(`${workspace}/dist`, `.release/${workspace}/dist`, {
    recursive: true,
  });
}
run(process.execPath, [
  resolve("node_modules/@sentry/cli/bin/sentry-cli"),
  "sourcemaps",
  "inject",
  ".release/client/dist",
  ".release/server/dist",
  ".release/shared/dist",
]);
const { maps } = await writeManifest(".release", release);
console.log(
  `Prepared ${release}: ${maps.length} source maps with embedded source code`,
);
