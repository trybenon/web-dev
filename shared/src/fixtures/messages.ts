/**
 * Примеры сообщений протокола.
 *
 * Корректные — по одному на каждый тип: их можно брать в тесты сервера
 * и клиента и как образец того, что приходит по сети.
 * Некорректные — то, что схема обязана отклонить.
 */
import type { ClientMessage, ServerMessage } from "../protocol/messages.js";
import type { Fingerprint, SourceInfo } from "../protocol/source.js";
import type { Playback } from "../protocol/playback.js";

const fingerprint: Fingerprint = {
  v: 1,
  sizeBytes: 1_468_006_400,
  sampleBytes: 1_048_576,
  samples: [
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  ],
};

const source: SourceInfo = {
  fingerprint,
  durationMs: 5_400_000,
  fileName: "film.mkv",
  proposedBy: "peer-anya",
};

const playback: Playback = {
  rev: 7,
  status: "playing",
  positionMs: 125_000,
  anchorServerTime: 1_000_450,
  rate: 1,
  setBy: "peer-anya",
};

export const clientExamples = {
  roomCreate: { type: "room:create", payload: { name: "Аня" } },
  roomJoin: { type: "room:join", payload: { roomId: "k7f3q", name: "Петя" } },
  roomJoinAfterDrop: {
    type: "room:join",
    payload: { roomId: "k7f3q", name: "Петя", sessionToken: "s-9f2c1e7a" },
  },
  roomLeave: { type: "room:leave", payload: {} },
  syncPing: { type: "sync:ping", payload: { t0: 5321.4 } },
  playbackIntent: {
    type: "playback:intent",
    payload: { action: "seek", positionMs: 600_000 },
  },
  presenceUpdate: {
    type: "presence:update",
    payload: {
      readyState: 4,
      bufferedAheadMs: 8_000,
      playerState: "playing",
      hasSource: true,
      deviationMs: 12,
      deviationAt: 1_000_500,
      appliedRev: 7,
      rttMs: 48,
    },
  },
  presenceUpdateNoSource: {
    type: "presence:update",
    payload: {
      readyState: 0,
      bufferedAheadMs: 0,
      playerState: "paused",
      hasSource: false,
      deviationMs: null,
      deviationAt: 1_000_500,
      appliedRev: 7,
      rttMs: 95,
    },
  },
  sourcePropose: {
    type: "source:propose",
    payload: { fingerprint, durationMs: 5_400_000, fileName: "film.mkv" },
  },
  sourceMatched: { type: "source:matched", payload: { ok: true } },
} satisfies Record<string, ClientMessage>;

export const serverExamples = {
  roomState: {
    type: "room:state",
    payload: {
      roomId: "k7f3q",
      you: "peer-petya",
      sessionToken: "s-9f2c1e7a",
      peers: [
        { peerId: "peer-anya", name: "Аня", connection: "online" },
        { peerId: "peer-petya", name: "Петя", connection: "online" },
      ],
      playback,
      source,
    },
  },
  roomPeerJoined: {
    type: "room:peer_joined",
    payload: {
      peer: { peerId: "peer-petya", name: "Петя", connection: "online" },
    },
  },
  roomPeerLeft: { type: "room:peer_left", payload: { peerId: "peer-petya" } },
  syncPong: {
    type: "sync:pong",
    payload: { t0: 5321.4, t1: 1_000_020, t2: 1_000_021 },
  },
  playbackState: { type: "playback:state", payload: playback },
  playbackHold: {
    type: "playback:hold",
    payload: {
      waitingFor: ["peer-petya"],
      reason: "buffering",
      deadline: 1_008_000,
    },
  },
  presenceSync: {
    type: "presence:sync",
    payload: {
      peers: [
        {
          peerId: "peer-anya",
          connection: "online",
          readyState: 4,
          bufferedAheadMs: 8_000,
          playerState: "playing",
          hasSource: true,
          deviationMs: 0,
          deviationAt: 1_000_500,
          appliedRev: 7,
          rttMs: 30,
        },
        {
          peerId: "peer-petya",
          connection: "reconnecting",
          readyState: 2,
          bufferedAheadMs: 0,
          playerState: "buffering",
          hasSource: true,
          deviationMs: 1_500,
          deviationAt: 1_000_480,
          appliedRev: 7,
          rttMs: 140,
        },
      ],
    },
  },
  sourceState: {
    type: "source:state",
    payload: { source, checks: [{ peerId: "peer-petya", ok: true }] },
  },
  error: {
    type: "error",
    payload: { code: "room_full", message: "В комнате уже 4 участника" },
  },
} satisfies Record<string, ServerMessage>;

/** Пример корректного отчёта о присутствии — основа для «испорченных». */
const presence = clientExamples.presenceUpdate.payload;

export const invalidClientMessages: { why: string; data: unknown }[] = [
  { why: "не объект", data: "room:join" },
  { why: "нет конверта", data: { roomId: "k7f3q", name: "Петя" } },
  { why: "неизвестный тип", data: { type: "room:destroy", payload: {} } },
  { why: "нет payload", data: { type: "sync:ping" } },
  {
    why: "серверное сообщение от клиента",
    data: { type: "room:peer_left", payload: { peerId: "peer-petya" } },
  },
  {
    why: "пустое имя",
    data: { type: "room:create", payload: { name: "   " } },
  },
  {
    why: "имя длиннее 32 символов",
    data: { type: "room:create", payload: { name: "а".repeat(33) } },
  },
  {
    why: "неизвестное действие",
    data: {
      type: "playback:intent",
      payload: { action: "stop", positionMs: 0 },
    },
  },
  {
    why: "отрицательная позиция",
    data: {
      type: "playback:intent",
      payload: { action: "seek", positionMs: -1 },
    },
  },
  {
    why: "deviationMs строкой",
    data: {
      type: "presence:update",
      payload: { ...presence, deviationMs: "12" },
    },
  },
  {
    why: "deviationMs пропущено, а не null",
    data: {
      type: "presence:update",
      payload: { ...presence, deviationMs: undefined },
    },
  },
  {
    why: "readyState больше 4",
    data: { type: "presence:update", payload: { ...presence, readyState: 5 } },
  },
  {
    why: "дробная ревизия",
    data: {
      type: "presence:update",
      payload: { ...presence, appliedRev: 1.5 },
    },
  },
  {
    why: "отпечаток версии 2",
    data: {
      type: "source:propose",
      payload: {
        fingerprint: { ...fingerprint, v: 2 },
        durationMs: null,
        fileName: "film.mkv",
      },
    },
  },
  {
    why: "в отпечатке два куска вместо трёх",
    data: {
      type: "source:propose",
      payload: {
        fingerprint: {
          ...fingerprint,
          samples: fingerprint.samples.slice(0, 2),
        },
        durationMs: null,
        fileName: "film.mkv",
      },
    },
  },
  {
    why: "хеш заглавными буквами",
    data: {
      type: "source:propose",
      payload: {
        fingerprint: {
          ...fingerprint,
          samples: fingerprint.samples.map((s) => s.toUpperCase()),
        },
        durationMs: null,
        fileName: "film.mkv",
      },
    },
  },
];

export const invalidServerMessages: { why: string; data: unknown }[] = [
  {
    why: "отрицательная ревизия",
    data: { type: "playback:state", payload: { ...playback, rev: -1 } },
  },
  {
    why: "неизвестный статус",
    data: {
      type: "playback:state",
      payload: { ...playback, status: "stopped" },
    },
  },
  {
    why: "нулевая скорость",
    data: { type: "playback:state", payload: { ...playback, rate: 0 } },
  },
  {
    why: "в pong нет t2",
    data: { type: "sync:pong", payload: { t0: 1, t1: 2 } },
  },
  {
    why: "неизвестный код ошибки",
    data: { type: "error", payload: { code: "oops", message: "?" } },
  },
  {
    why: "неизвестное состояние связи",
    data: {
      type: "room:peer_joined",
      payload: { peer: { peerId: "p", name: "Петя", connection: "offline" } },
    },
  },
];
