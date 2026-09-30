/**
 * Протокол обмена клиент ↔ сервер для спайка синхронизации.
 *
 * Здесь только erasable-синтаксис TypeScript (никаких enum и namespace):
 * файл исполняется напрямую Node ≥ 22.18 и отдаётся в браузер после
 * удаления типов. В реальном проекте этот файл переезжает в `shared/`.
 */

export const PlaybackStatus = {
  Paused: 'paused',
  Waiting: 'waiting',
  Playing: 'playing',
} as const;
export type PlaybackStatus = (typeof PlaybackStatus)[keyof typeof PlaybackStatus];

export type IntentAction = 'play' | 'pause' | 'seek';

/** Авторитетное состояние воспроизведения комнаты. */
export interface PlaybackState {
  /** Монотонный номер ревизии. Клиент отбрасывает всё, что меньше применённого. */
  rev: number;
  status: PlaybackStatus;
  /** Позиция в видеоряде, мс. */
  positionMs: number;
  /**
   * Момент по серверным часам, в который головка должна быть в positionMs.
   * Заполнен только в статусе playing.
   */
  anchorServerTime: number | null;
  /** Скорость комнаты (не путать с локальной коррекцией дрейфа). */
  rate: number;
  /** Кто вызвал изменение; нужно клиенту, чтобы не реагировать на своё эхо. */
  setBy: string | null;
}

export interface Presence {
  /** readyState элемента video, 0–4. */
  readyState: number;
  /** Сколько мс забуферено впереди текущей позиции. */
  bufferedAheadMs: number;
  hasSource: boolean;
  /** Отклонение от позиции комнаты, мс (плюс — отстаём). */
  deviationMs: number;
  /**
   * Ревизия состояния, к которой клиент уже подготовил плеер.
   * Без неё барьер отпустит старт по устаревшему «готов», присланному
   * ещё до перемотки на новую позицию.
   */
  appliedRev: number;
  /** Круговая задержка до сервера по оценке клиента, мс. Нужна для расчёта якоря. */
  rttMs: number;
}

export interface PeerInfo {
  peerId: string;
  name: string;
  presence: Presence;
}

// ─── Клиент → сервер ────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'room:join'; roomId: string; name: string }
  /** t0 — время отправки по часам клиента. */
  | { type: 'sync:ping'; id: number; t0: number }
  | { type: 'playback:intent'; action: IntentAction; positionMs: number }
  | { type: 'presence:update'; presence: Presence };

// ─── Сервер → клиент ────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'room:state'; you: string; peers: PeerInfo[]; playback: PlaybackState }
  | { type: 'room:peer_joined'; peer: PeerInfo }
  | { type: 'room:peer_left'; peerId: string }
  /**
   * Четыре метки NTP: t0 — отправка клиентом (эхо), t1 — приём сервером,
   * t2 — отправка сервером, t3 клиент снимает сам при получении.
   */
  | { type: 'sync:pong'; id: number; t0: number; t1: number; t2: number }
  | { type: 'playback:state'; playback: PlaybackState }
  | { type: 'playback:hold'; waitingFor: string[]; deadline: number }
  | { type: 'presence:sync'; peers: PeerInfo[] }
  | { type: 'error'; code: ErrorCode; message: string };

export type ErrorCode = 'room_full' | 'bad_request' | 'not_joined' | 'rate_limited';

export const LIMITS = {
  maxPeers: 4,
  maxMessageBytes: 64 * 1024,
} as const;

/** Узкая проверка входящего сообщения. В проекте её заменит схема zod. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

  switch (m.type) {
    case 'room:join':
      return str(m.roomId) && str(m.name, 32) ? { type: 'room:join', roomId: m.roomId, name: m.name } : null;
    case 'sync:ping':
      return num(m.id) && num(m.t0) ? { type: 'sync:ping', id: m.id, t0: m.t0 } : null;
    case 'playback:intent':
      return (m.action === 'play' || m.action === 'pause' || m.action === 'seek') && num(m.positionMs) && m.positionMs >= 0
        ? { type: 'playback:intent', action: m.action, positionMs: m.positionMs }
        : null;
    case 'presence:update': {
      const p = m.presence as Record<string, unknown> | undefined;
      if (
        !p ||
        !num(p.readyState) ||
        !num(p.bufferedAheadMs) ||
        typeof p.hasSource !== 'boolean' ||
        !num(p.deviationMs) ||
        !num(p.appliedRev) ||
        !num(p.rttMs)
      ) {
        return null;
      }
      return {
        type: 'presence:update',
        presence: {
          readyState: p.readyState,
          bufferedAheadMs: p.bufferedAheadMs,
          hasSource: p.hasSource,
          deviationMs: p.deviationMs,
          appliedRev: p.appliedRev,
          rttMs: Math.max(0, Math.min(p.rttMs, 10_000)),
        },
      };
    }
    default:
      return null;
  }
}
