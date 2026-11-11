import { FingerprintSchema, SAMPLE_BYTES } from "@watch-together/shared";
import { describe, expect, it } from "vitest";
import { compareFingerprints, fingerprintFile } from "./fingerprint";

const aHash =
  "9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360";
const bHash =
  "e56ec8dc1862be6c09c53620cbc0f00f639de2a51c882745fbbc4e144714b3c2";
const cHash =
  "c5a3e27d1ed0f894843bca3a5473c4bf0f76a19b6830a2e491292591613a12bf";
const abHash =
  "efe5447833ae7a5f6d44f033c97a1004b11504d6c1ac3e6d0ed7b0a07588efd3";
const abcHash =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const emptyHash =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function chunk(letter: string) {
  return new Uint8Array(SAMPLE_BYTES).fill(letter.charCodeAt(0));
}

describe("fingerprintFile", () => {
  it("matches the protocol and hashes the beginning, center and end", async () => {
    const file = new Blob(["a", "x", "b", "y", "c"].map(chunk));
    const result = await fingerprintFile(file);

    expect(FingerprintSchema.parse(result)).toEqual({
      v: 1,
      sizeBytes: 5 * SAMPLE_BYTES,
      sampleBytes: SAMPLE_BYTES,
      samples: [aHash, bHash, cHash],
    });
  });

  it("uses overlapping samples for a file smaller than 3 MiB", async () => {
    const file = new Blob([chunk("a"), chunk("b")]);

    expect((await fingerprintFile(file)).samples).toEqual([
      aHash,
      abHash,
      bHash,
    ]);
  });

  it.each([
    ["abc", abcHash],
    ["", emptyHash],
  ])("keeps three sample hashes for a small blob (%j)", async (text, hash) => {
    const result = await fingerprintFile(new Blob([text]));

    expect(result.sizeBytes).toBe(text.length);
    expect(result.samples).toEqual([hash, hash, hash]);
  });
});

describe("compareFingerprints", () => {
  const fingerprint = {
    v: 1,
    sizeBytes: 3,
    sampleBytes: SAMPLE_BYTES,
    samples: [abcHash, abcHash, abcHash],
  };
  const different = {
    ...fingerprint,
    samples: [abcHash, abcHash, emptyHash],
  };

  it("matches the same fingerprint independently of duration", () => {
    expect(
      compareFingerprints(
        { fingerprint, durationMs: null },
        { fingerprint, durationMs: 20_000 },
      ),
    ).toEqual({ kind: "match" });
  });

  it("returns incomparable for different versions", () => {
    expect(
      compareFingerprints(
        { fingerprint, durationMs: 20_000 },
        { fingerprint: { ...fingerprint, v: 2 }, durationMs: 20_000 },
      ),
    ).toEqual({ kind: "incomparable" });
  });

  it.each([
    [19_000, "similar"],
    [21_000, "similar"],
    [21_001, "different"],
    [null, "unknown"],
  ] as const)(
    "classifies a mismatch with duration %s",
    (durationMs, duration) => {
      expect(
        compareFingerprints(
          { fingerprint, durationMs: 20_000 },
          { fingerprint: different, durationMs },
        ),
      ).toEqual({ kind: "mismatch", duration });
    },
  );

  it.each([
    { ...fingerprint, sizeBytes: 4 },
    { ...fingerprint, sampleBytes: SAMPLE_BYTES / 2 },
  ])("detects a difference in fingerprint metadata", (other) => {
    expect(
      compareFingerprints(
        { fingerprint, durationMs: null },
        { fingerprint: other, durationMs: null },
      ),
    ).toEqual({ kind: "mismatch", duration: "unknown" });
  });
});
