import { SAMPLE_BYTES, type Fingerprint } from "@watch-together/shared";

type SourceFingerprint = {
  fingerprint: {
    v: number;
    sizeBytes: number;
    sampleBytes: number;
    samples: readonly string[];
  };
  durationMs: number | null;
};

export type FingerprintComparison =
  | { kind: "match" }
  | { kind: "incomparable" }
  | {
      kind: "mismatch";
      duration: "similar" | "different" | "unknown";
    };

const DURATION_TOLERANCE_MS = 1_000;

export async function fingerprintFile(file: Blob): Promise<Fingerprint> {
  const length = Math.min(file.size, SAMPLE_BYTES);
  const lastStart = file.size - length;
  const starts = [0, Math.floor(lastStart / 2), lastStart];

  const samples = await Promise.all(
    starts.map(async (start) => {
      const bytes = await file.slice(start, start + length).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }),
  );

  return { v: 1, sizeBytes: file.size, sampleBytes: SAMPLE_BYTES, samples };
}

export function compareFingerprints(
  left: SourceFingerprint,
  right: SourceFingerprint,
): FingerprintComparison {
  const a = left.fingerprint;
  const b = right.fingerprint;

  if (a.v !== 1 || b.v !== 1) return { kind: "incomparable" };

  if (
    a.sizeBytes === b.sizeBytes &&
    a.sampleBytes === b.sampleBytes &&
    a.samples.length === b.samples.length &&
    a.samples.every((sample, index) => sample === b.samples[index])
  ) {
    return { kind: "match" };
  }

  if (left.durationMs === null || right.durationMs === null) {
    return { kind: "mismatch", duration: "unknown" };
  }

  const gap = Math.abs(left.durationMs - right.durationMs);
  return {
    kind: "mismatch",
    duration: gap <= DURATION_TOLERANCE_MS ? "similar" : "different",
  };
}
