/**
 * Комната на сервере — чистая машина состояний
 *
 * Модуль не знает про сокеты и таймеры: каждый метод получает текущее
 * время по часам сервера и возвращает список исходящих сообщений.
 * Адаптер (#19) рассылает их по соединениям и регулярно зовёт tick.
 */
import type {
  PeerId,
  Playback,
  RoomId,
  ServerMessage,
} from "@watch-together/shared";

/** Исходящее сообщение: кому и что. */
export interface Outbound{
  to: PeerId | 'all',
  except?: PeerId,
  msg: ServerMessage
}

export class Room {
  readonly id: RoomId;
  private state: Playback;

  constructor(id: RoomId, now: number) {
    this.id = id;
    this.state = {
      rev: 0,
      status: "paused",
      positionMs: 0,
      anchorServerTime: now,
      rate: 1,
      setBy: null,
    };
  }

  /** Копия: снаружи состояние комнаты не поменять. */
  get playback(): Playback {
    return { ...this.state };
  }

  /** Где головка должна быть в момент now. */
  positionAt(now: number): number {
    const s = this.state;
    if (s.status !== "playing") return s.positionMs;
    return s.positionMs + Math.max(0, now - s.anchorServerTime) * s.rate;
  }


}