export const SAMPLE_BYTES = 1024 * 1024;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sampleRanges(size, sampleBytes = SAMPLE_BYTES) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Некорректный размер файла");
  const length = Math.min(size, sampleBytes);
  const lastStart = size - length;
  return [0, Math.floor(lastStart / 2), lastStart].map((start) => ({ start, end: start + length }));
}

export async function videoDurationMs(file, timeoutMs = 15000) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "metadata";
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Браузер не прочитал метаданные за 15 секунд")), timeoutMs);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          reject(new Error("У видео неизвестная продолжительность"));
        } else {
          resolve(Math.round(video.duration * 1000));
        }
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Браузер не поддерживает формат видео или не может прочитать метаданные"));
      };
      video.src = url;
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function fingerprintFile(file, durationMs, now = () => performance.now()) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("Некорректная длительность");
  const ranges = sampleRanges(file.size);
  const started = now();
  const samples = [];
  for (const { start, end } of ranges) {
    const bytes = await file.slice(start, end).arrayBuffer();
    samples.push(toHex(await crypto.subtle.digest("SHA-256", bytes)));
  }
  return {
    fingerprint: {
      sizeBytes: file.size,
      durationMs,
      sampleBytes: SAMPLE_BYTES,
      samples,
    },
    hashTimeMs: Math.round(now() - started),
    bytesRead: ranges.reduce((total, { start, end }) => total + end - start, 0),
  };
}
