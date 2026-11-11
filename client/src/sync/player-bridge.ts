/**
 * Мост между воркером синхронизации и элементом video.
 *
 * Выполняет команды воркера (пауза, подготовка, старт в нужный момент,
 * перемотка, скорость) и докладывает, что с плеером: позиция, буфер,
 * готовность. Для контура подстройки шлёт замер позиции с каждого
 * показанного кадра. Своей математики синхронизации у моста нет.
 *
 * События video никогда не превращаются в команды комнаты (decisions.md, 2.8):
 * иначе пауза, пришедшая от сервера, вернулась бы на сервер как пауза
 * пользователя, и комнату начало бы трясти.
 */
import { playerChannel } from "./client";
import { bufferedAheadMs } from "./timeline";
import type { PlayerBridge, SyncClient } from "./types";
import type { MediaReport, PlayerCommand } from "./worker-protocol";

/** Что показано на кадре и когда (requestVideoFrameCallback). */
export interface FrameInfo {
  /** Метка кадра в видео, с. */
  readonly mediaTime: number;
  /** Когда кадр покажут, по performance.now() страницы. */
  readonly expectedDisplayTime: number;
}

/** Документ, в котором живёт video: нужен, чтобы знать, видна ли вкладка. */
export interface BridgeDocument {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Что мосту нужно от video. HTMLVideoElement подходит как есть. */
export interface BridgeVideo {
  currentTime: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly currentSrc: string;
  readonly error: unknown;
  readonly buffered: {
    readonly length: number;
    start(index: number): number;
    end(index: number): number;
  };
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  /** Есть не во всех браузерах: без него воркер сам спрашивает позицию. */
  requestVideoFrameCallback?(
    callback: (now: number, frame: FrameInfo) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
  readonly ownerDocument?: BridgeDocument | null;
}

/** Стоящий плеер: ближе этого, мс, к нужной позиции — не перематываем. */
const PAUSED_TOLERANCE_MS = 20;
/** Играющий плеер: перемотка заметна глазу, поэтому допуск шире, мс. */
const PLAYING_TOLERANCE_MS = 150;
/** Как часто докладывать воркеру, мс. */
const REPORT_MS = 250;
/** readyState: есть текущий кадр / есть данные и дальше. */
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

/** События, после которых состояние плеера могло измениться. */
const MEDIA_EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "progress",
  "play",
  "pause",
  "seeking",
  "seeked",
  "ended",
  "emptied",
];

type PlayCommand = Extract<PlayerCommand, { kind: "play" }>;

/**
 * Подключить video к комнате. Клиент — только из createSyncClient:
 * у заглушки нет воркера, для неё есть createStubPlayerBridge.
 */
export function createPlayerBridge(
  client: SyncClient,
  video: BridgeVideo,
): PlayerBridge {
  const channel = playerChannel(client);
  if (!channel) {
    throw new Error(
      "createPlayerBridge работает с клиентом из createSyncClient, а не с заглушкой",
    );
  }
  const port = channel;

  /** Последняя команда состояния: пауза, подготовка или старт. */
  let current: Extract<PlayerCommand, { rev: number }> | null = null;
  /** Ревизия, выполнение которой ещё не подтвердили воркеру. */
  let unconfirmed: number | null = null;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  /** Видео остановилось за данными: событие waiting без playing после него. */
  let stalled = false;
  let disposed = false;

  function hasSource(): boolean {
    return video.currentSrc !== "" && !video.error;
  }

  function seekIfFar(positionMs: number, toleranceMs: number): void {
    if (Math.abs(video.currentTime * 1000 - positionMs) > toleranceMs) {
      video.currentTime = positionMs / 1000;
    }
  }

  function start(command: PlayCommand): void {
    const now = performance.now();
    if (video.paused) {
      // опоздали к якорю — начинаем с того места, где комната будет при старте
      const lateMs = Math.max(0, now + command.leadMs - command.atMain);
      seekIfFar(
        command.positionMs + lateMs * command.rate,
        PAUSED_TOLERANCE_MS,
      );
      if (video.playbackRate !== command.rate) {
        video.playbackRate = command.rate;
      }
      video.play().catch(() => {
        // автозапуск запрещён до клика: интерфейс вызовет unlock()
      });
    } else {
      // уже играет (снимок после переподключения): поправляем только большой разрыв
      seekIfFar(
        command.positionMs + (now - command.atMain) * command.rate,
        PLAYING_TOLERANCE_MS,
      );
    }
  }

  function execute(command: PlayerCommand): void {
    switch (command.kind) {
      case "seek":
        video.currentTime = command.positionMs / 1000;
        report();
        return;
      case "rate":
        if (video.playbackRate !== command.rate) {
          video.playbackRate = command.rate;
        }
        return;
      case "sample":
        if (!video.paused) {
          port.sample(video.currentTime * 1000, performance.now(), false);
        }
        return;
    }
    clearTimeout(playTimer);
    current = command;
    unconfirmed = command.rev;
    if (command.kind === "play") {
      const delay = command.atMain - command.leadMs - performance.now();
      if (delay > 0) {
        // встаём на позицию заранее, чтобы к старту кадры уже были
        if (video.paused) seekIfFar(command.positionMs, PAUSED_TOLERANCE_MS);
        playTimer = setTimeout(() => start(command), delay);
      } else {
        start(command);
      }
    } else {
      video.pause();
      seekIfFar(command.positionMs, PAUSED_TOLERANCE_MS);
    }
    confirm();
    report();
  }

  /** Подтвердить команду, когда плеер действительно её выполнил. */
  function confirm(): void {
    if (unconfirmed === null || current === null) return;
    if (!hasSource() || video.seeking) return;
    const needed =
      current.kind === "prepare" ? HAVE_FUTURE_DATA : HAVE_CURRENT_DATA;
    if (video.readyState < needed) return;
    port.applied(unconfirmed);
    unconfirmed = null;
  }

  function playerState(): MediaReport["playerState"] {
    if (video.seeking) return "seeking";
    if (video.paused) return "paused";
    return stalled ? "buffering" : "playing";
  }

  function report(): void {
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push([video.buffered.start(i), video.buffered.end(i)]);
    }
    port.report({
      readyState: video.readyState,
      bufferedAheadMs: bufferedAheadMs(ranges, video.currentTime),
      playerState: playerState(),
      hasSource: hasSource(),
      positionMs: video.currentTime * 1000,
      atMain: performance.now(),
    });
  }

  const handlers: Array<[string, () => void]> = [
    ...MEDIA_EVENTS.map((type): [string, () => void] => [type, update]),
    [
      "waiting",
      () => {
        stalled = true;
        update();
      },
    ],
    [
      "playing",
      () => {
        stalled = false;
        update();
      },
    ],
    [
      "loadstart",
      () => {
        // новый файл: старое подтверждение не в силе, воркер пришлёт команду заново
        clearTimeout(playTimer);
        stalled = false;
        current = null;
        unconfirmed = null;
        port.reload();
        report();
      },
    ],
  ];

  function update(): void {
    confirm();
    report();
  }

  for (const [type, handler] of handlers) {
    video.addEventListener(type, handler);
  }
  const reportTimer = setInterval(update, REPORT_MS);

  // замер с каждого показанного кадра: точная пара «что показано — когда»
  // (sync-drift.md, «Источник позиции»)
  let frameHandle: number | undefined;
  function onFrame(_now: number, frame: FrameInfo): void {
    if (disposed) return;
    if (!video.paused) {
      port.sample(frame.mediaTime * 1000, frame.expectedDisplayTime, true);
    }
    frameHandle = video.requestVideoFrameCallback?.(onFrame);
  }
  frameHandle = video.requestVideoFrameCallback?.(onFrame);

  // вкладка вернулась из фона: Chrome мог сам перемотать видеодорожку
  const doc = video.ownerDocument ?? null;
  function onVisibility(): void {
    if (doc?.visibilityState === "visible") port.visible();
  }
  doc?.addEventListener("visibilitychange", onVisibility);

  port.attach(execute);
  report();

  return {
    unlock() {
      if (disposed) return Promise.resolve();
      // Safari разрешает звук только элементу, запущенному прямо в обработчике
      // клика, поэтому play() и pause() — синхронно (decisions.md, 4.10)
      const attempt = video.play();
      video.pause();
      attempt.catch(() => {
        // pause() прерывает play() — так и задумано
      });
      // старт мог сорваться из-за запрета автозапуска: просим команду заново
      port.reload();
      return Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(playTimer);
      clearInterval(reportTimer);
      for (const [type, handler] of handlers) {
        video.removeEventListener(type, handler);
      }
      if (frameHandle !== undefined) {
        video.cancelVideoFrameCallback?.(frameHandle);
      }
      doc?.removeEventListener("visibilitychange", onVisibility);
      port.detach();
    },
  };
}
