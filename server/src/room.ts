/**
 * Комната на сервере — чистая машина состояний
 *
 * Модуль не знает про сокеты и таймеры: каждый метод получает текущее
 * время по часам сервера и возвращает список исходящих сообщений.
 * Адаптер (#19) рассылает их по соединениям и регулярно зовёт tick.
 */
import { LIMITS } from "@watch-together/shared";
import type {
  ClientMessage,
  ErrorCode,
  PeerId,
  Peer,
  Playback,
  RoomId,
  ServerMessage,
  SourceInfo,
} from "@watch-together/shared";


export interface RoomConfig {
  maxPeers: number;
  /** Наименьший запас до якоря, мс. */
  minLeadMs: number;
  /** Добавка к наибольшему RTT: на обработку и планирование запуска, мс. */
  leadExtraMs: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxPeers: LIMITS.maxPeers,
  minLeadMs: 300,
  leadExtraMs: 200,
};
/** Что хочет участник: play, pause или seek с позицией. */
export type PlaybackIntent = Extract<
  ClientMessage,
  { type: "playback:intent" }
>["payload"];

/** Исходящее сообщение: кому и что. */
export interface Outbound {
  /** Конкретному участнику или всем в комнате. */
  to: PeerId | "all";
  /** При рассылке всем — кроме этого участника. */
  except?: PeerId;
  msg: ServerMessage;
}

interface Member {
  peerId: PeerId;
  name: string;
  sessionToken: string;
  connection: Peer["connection"];
}

export class Room {
  readonly id: RoomId;
  readonly config: RoomConfig;
  private readonly members = new Map<PeerId, Member>();
  private state: Playback;
  private source: SourceInfo | null = null;

  constructor(id: RoomId, now: number, config: Partial<RoomConfig> = {}) {
    this.id = id;
    this.config = { ...DEFAULT_ROOM_CONFIG, ...config };
    this.state = {
      rev: 0,
      status: "paused",
      positionMs: 0,
      anchorServerTime: now,
      rate: 1,
      setBy: null,
    };
  }

  get size(): number {
    return this.members.size;
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

  join(peerId: PeerId, name: string, sessionToken: string): Outbound[] {
    if (this.members.has(peerId)) return [];
    if (this.members.size >= this.config.maxPeers) {
      return [error(peerId, "room_full", "В комнате уже четыре участника")];
    }
    const member: Member = {
      peerId,
      name,
      sessionToken,
      connection: "online",
    };
    this.members.set(peerId, member);
    // вход не трогает воспроизведение: новичок сам перемотается к комнате
    return [
      ...this.snapshot(member),
      {
        to: "all",
        except: peerId,
        msg: { type: "room:peer_joined", payload: { peer: toPeer(member) } },
      },
    ];
  }

  leave(peerId: PeerId): Outbound[] {
    if (!this.members.delete(peerId)) return [];
    return [
      { to: "all", msg: { type: "room:peer_left", payload: { peerId } } },
    ];
  }

  intent(peerId: PeerId, intent: PlaybackIntent, now: number): Outbound[] {
    if (!this.members.has(peerId)) {
      return [error(peerId, "not_joined", "Сначала войдите в комнату")];
    }
    const status = this.state.status;
    switch (intent.action) {
      case "play": {
        if (status !== "paused") {
          return [];
        }
        return this.start(this.state.positionMs, peerId, now);
      }
      case "pause": {
        if (status === "paused") return [];
        return this.commit({
          status: "paused",
          // на waiting positionAt вернёт позицию, куда собирались
          positionMs: Math.round(this.positionAt(now)),
          anchorServerTime: now,
          setBy: peerId,
        });
      }

      case "seek": {
        const positionMs = Math.round(intent.positionMs);
        if (status === "paused") {
          return this.commit({
            status: "paused",
            positionMs,
            anchorServerTime: now,
            setBy: peerId,
          });
        }
        return this.start(positionMs, peerId, now);
      }
    }
  }

  // ─── внутреннее ───────────────────────────────────────────────────
  private snapshot(member: Member): Outbound[] {
    const out: Outbound[] = [
      {
        to: member.peerId,
        msg: {
          type: "room:state",
          payload: {
            roomId: this.id,
            you: member.peerId,
            sessionToken: member.sessionToken,
            peers: [...this.members.values()].map(toPeer),
            playback: this.playback,
            source: this.source,
          },
        },
      },
    ];
    return out;
  }
  /** Запас до якоря: команда должна дойти до самого медленного. */
  private leadMs(): number {
    const maxRtt = 0;
    return Math.max(
      this.config.minLeadMs,
      Math.round(maxRtt + this.config.leadExtraMs),
    );
  }
  /** Любое изменение воспроизведения — новая ревизия и рассылка всем. */
  private commit(changes: Omit<Playback, "rev" | "rate">): Outbound[] {
    this.state = { ...this.state, ...changes, rev: this.state.rev + 1 };
    return [
      {
        to: "all",
        msg: { type: "playback:state", payload: this.playback },
      },
    ];
  }
  private startPlaying(
    positionMs: number,
    setBy: PeerId,
    now: number,
  ): Outbound[] {
    return this.commit({
      status: "playing",
      positionMs,
      anchorServerTime: now + this.leadMs(),
      setBy,
    });
  } /** Запуск: сначала waiting, потом playing  */
  private start(positionMs: number, setBy: PeerId, now: number): Outbound[] {
    const out = this.commit({
      status: "waiting",
      positionMs,
      anchorServerTime: now,
      setBy,
    });
    return [...out, ...this.startPlaying(positionMs, setBy, now)];
  }
}


function toPeer(m: Member): Peer{
  return {peerId: m.peerId, name: m.name, connection: m.connection};
}

function error(to: PeerId, code: ErrorCode, message: string): Outbound {
  return { to, msg: { type: "error", payload: { code, message } } };
}