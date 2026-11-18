import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  validateDsn,
  verifyArtifacts,
  writeManifest,
} from "./release-artifacts.mjs";

const release = "a".repeat(40);
const debugId = "12345678-1234-1234-1234-123456789abc";
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "release-artifacts-"));
  for (const workspace of ["client", "server", "shared"]) {
    const dist = join(directory, workspace, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(
      join(dist, "main.js"),
      `throw Error();\n//# debugId=${debugId}\n`,
    );
    await writeFile(
      join(dist, "main.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../src/main.ts"],
        sourcesContent: ["throw Error();"],
        debug_id: debugId,
      }),
    );
  }
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("release artifacts", () => {
  it("detects changed JavaScript after preparation", async () => {
    await writeManifest(directory, release);
    await expect(verifyArtifacts(directory, release)).resolves.toMatchObject({
      release,
    });
    await writeFile(
      join(directory, "server/dist/main.js"),
      `changed();\n//# debugId=${debugId}\n`,
    );
    await expect(verifyArtifacts(directory, release)).rejects.toThrow(
      "Release files changed",
    );
  });
  it("rejects another SHA and mismatched debug IDs", async () => {
    await writeManifest(directory, release);
    await expect(verifyArtifacts(directory, "b".repeat(40))).rejects.toThrow(
      "Release SHA",
    );
    await writeFile(join(directory, "client/dist/main.js"), "changed();");
    await expect(writeManifest(directory, release)).rejects.toThrow(
      "debug ID mismatch",
    );
  });
  it("requires embedded source code for code context", async () => {
    const path = join(directory, "server/dist/main.js.map");
    const map = JSON.parse(await readFile(path, "utf8"));
    delete map.sourcesContent;
    await writeFile(path, JSON.stringify(map));
    await expect(writeManifest(directory, release)).rejects.toThrow(
      "embedded source code",
    );
  });
  it("requires source maps for every workspace", async () => {
    await rm(join(directory, "shared/dist/main.js.map"));
    await expect(writeManifest(directory, release)).rejects.toThrow(
      "Missing source maps for shared",
    );
  });
  it("rejects DSN environment-file injection", () => {
    expect(validateDsn("https://public@bugsink.example/1$literal")).toContain(
      "$literal",
    );
    for (const invalid of [
      undefined,
      "",
      "https://bugsink.example/",
      "https://public@host/1\nTOKEN=bad",
      "https://public@host/1'",
    ]) {
      expect(() => validateDsn(invalid)).toThrow();
    }
  });
});
