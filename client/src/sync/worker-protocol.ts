/**
 * Сообщения между страницей и воркером синхронизации.
 *
 * Страница → воркер: команды интерфейса, отчёты плеера, ответы на пинги часов.
 * Воркер → страница: состояние, ошибки, команды плееру, пинги часов.
 * Все моменты времени, которые видит страница, — по её performance.now().
 */
import type {
  ClientMessage,
  Presence,
  RoomId,
  SourceOffer,
} from "@watch-together/shared";
import type { SyncError, SyncState } from "./types";

export type PlaybackIntent = Extract<
  ClientMessage,
  { type: "playback:intent" }
>["payload"];

/** Что плеер сообщает о себе. */
export interface MediaReport {
  readyState: number;
  bufferedAheadMs: number;
  playerState: Presence["playerState"];
  hasSource: boolean;
  /** Позиция видео, мс… */
  positionMs: number;
  /** …в этот момент по часам страницы. */
  atMain: number;
}

/** Что воркер велит плееру. У команд состояния есть rev — его плеер подтверждает. */
export type PlayerCommand =
  | { kind: "pause"; rev: number; positionMs: number }
  /** Встать на позицию и загрузить кадры: комната ждёт готовности. */
  | { kind: "prepare"; rev: number; positionMs: number }
  /**
   * В момент atMain головка должна стоять в positionMs и идти со скоростью
   * rate. play() вызывается на leadMs раньше: видео трогается не сразу.
   */
  | {
      kind: "play";
      rev: number;
      positionMs: number;
      atMain: number;
      rate: number;
      leadMs: number;
    }
  /** Контур подстройки: перемотать, не меняя ни паузу, ни скорость. */
  | { kind: "seek"; positionMs: number }
  /** Контур подстройки: чуть ускорить или замедлить плеер. */
  | { kind: "rate"; rate: number }
  /** Кадров давно не было (вкладка в фоне): прислать позицию сейчас. */
  | { kind: "sample" };

export type ToWorker =
  | { type: "connect"; url: string }
  | { type: "createRoom"; name: string }
  | { type: "joinRoom"; roomId: RoomId; name: string }
  | { type: "leaveRoom" }
  | { type: "intent"; intent: PlaybackIntent }
  | { type: "proposeSource"; offer: SourceOffer }
  | { type: "reportSourceMatch"; sourceRev: number; ok: boolean }
  /** Ответ на clock:ping: t1 — когда страница его получила. */
  | { type: "clock:pong"; t0: number; t1: number }
  | { type: "player:attach" }
  | { type: "player:detach" }
  | { type: "player:media"; media: MediaReport }
  /** Плеер выполнил команду этой ревизии. */
  | { type: "player:applied"; rev: number }
  /** Плееру нужна команда заново: загрузился другой файл или снят запрет на звук. */
  | { type: "player:reload" }
  /**
   * Замер для контура подстройки: на кадре показана позиция positionMs
   * в момент atMain. frame — замер с показанного кадра, а не по запросу.
   */
  | {
      type: "player:sample";
      positionMs: number;
      atMain: number;
      frame: boolean;
    }
  /** Вкладка снова на экране: браузер мог перемотать видео сам. */
  | { type: "player:visible" }
  | { type: "dispose" };

export type FromWorker =
  | { type: "state"; state: SyncState }
  /** Время сервера минус время страницы, мс. */
  | { type: "clock"; serverOffset: number }
  | { type: "error"; error: SyncError }
  | { type: "clock:ping"; t0: number }
  | { type: "player:command"; command: PlayerCommand };
