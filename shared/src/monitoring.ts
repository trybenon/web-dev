import type { ErrorEvent } from "@sentry/core";

// фильтрация данных

function cleanCodePath(path: string): string {
  return path.replace(/[?#].*$/, "");
}

function buildFingerprint(event: ErrorEvent): string[] {
  const source = event.platform === "node" ? "server" : "client";
  const frames = event.exception?.values?.at(-1)?.stacktrace?.frames ?? [];
  const frame = [...frames]
    .reverse()
    .find((item) => item.in_app && item.filename);

  const codePath = cleanCodePath(frame?.filename ?? "")
    .replaceAll("\\", "/")
    .match(/(?:^|\/)((?:src|dist|assets)\/[\w./-]+\.(?:[cm]?[jt]s|vue))$/)?.[1];

  if (!codePath) return [source, "unknown-location"];

  return [
    source,
    codePath,
    String(frame?.lineno ?? 0),
    String(frame?.colno ?? 0),
  ];
}

export function sanitizeErrorEvent(event: ErrorEvent): ErrorEvent | null {
  const exceptions = event.exception?.values;
  if (!exceptions?.length) return null;
  const fingerprint = buildFingerprint(event);
  const [source, codePath, line, column] = fingerprint;
  const label = source === "server" ? "Сервер" : "Клиент";
  const title =
    codePath === "unknown-location"
      ? `${label} · ошибка приложения`
      : `${label} · ${codePath}:${line}:${column}`;
  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    fingerprint,
    release: event.release,
    exception: {
      values: exceptions.map((exception) => ({
        type: "Error",
        value: title,
        stacktrace: {
          frames: exception.stacktrace?.frames?.map((frame) => ({
            filename: frame.filename && cleanCodePath(frame.filename),
            abs_path: frame.abs_path && cleanCodePath(frame.abs_path),
            lineno: frame.lineno,
            colno: frame.colno,
            in_app: frame.in_app,
          })),
        },
      })),
    },
    debug_meta: {
      images: event.debug_meta?.images
        ?.filter((image) => image.type === "sourcemap")
        .map((image) => ({
          type: "sourcemap",
          code_file: cleanCodePath(image.code_file),
          debug_id: image.debug_id,
        })),
    },
  };
}
