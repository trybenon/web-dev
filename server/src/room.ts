/**
 * Комната на сервере — чистая машина состояний
 *
 * Модуль не знает про сокеты и таймеры: каждый метод получает текущее
 * время по часам сервера и возвращает список исходящих сообщений.
 * Адаптер (#19) рассылает их по соединениям и регулярно зовёт tick.
 */
import { LIMITS } from "@watch-together/shared";
import type {
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
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxPeers: LIMITS.maxPeers,
};

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

  // ─── внутреннее ───────────────────────────────────────────────────
  private snapshot(member: Member): Outbound[]{
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
}

function toPeer(m: Member): Peer{
  return {peerId: m.peerId, name: m.name, connection: m.connection};
}

function error(to: PeerId, code: ErrorCode, message: string): Outbound {
  return { to, msg: { type: "error", payload: { code, message } } };
}