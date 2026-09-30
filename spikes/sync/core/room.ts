/**
 * Состояние комнаты на сервере — чистая машина состояний.
 *
 * Модуль не знает про сокеты и таймеры: каждый метод получает текущее
 * время и возвращает список исходящих сообщений. Адаптер (server/main.ts)
 * рассылает их по соединениям. Так барьер, дедлайн и расчёт якоря
 * проверяются unit-тестами без сети и без реального ожидания.
 *
 * Правила, которые здесь закреплены:
 *  - Управление общее: намерение принимается от любого участника.
 *  - Любое изменение состояния увеличивает rev.
 *  - Старт и явная перемотка проходят через барьер готовности с дедлайном.
 *  - Вход нового участника и подвисание барьер НЕ поднимают.
 *  - Готовность засчитывается только для той ревизии, к которой клиент
 *    подготовился (presence.appliedRev), иначе старое «готов», присланное
 *    до перемотки, отпустит барьер раньше времени.
 *  - Якорь назначается с запасом: max(300 мс, наибольший RTT + 200 мс).
 */
import type {
  IntentAction,
  PeerInfo,
  PlaybackState,
  Presence,
  ServerMessage,
} from '../shared/protocol.ts';

export interface RoomConfig {
  maxPeers: number;
  barrierTimeoutMs: number;
  minLeadMs: number;
  leadExtraMs: number;
  readyBufferMs: number;
  minIntentIntervalMs: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxPeers: 4,
  barrierTimeoutMs: 10_000,
  minLeadMs: 300,
  leadExtraMs: 200,
  readyBufferMs: 2_000,
  minIntentIntervalMs: 200,
};

export interface Outbound {
  /** Кому: конкретному участнику или всем. */
  to: string | 'all';
  /** При рассылке всем — кроме этого участника. */
  except?: string;
  msg: ServerMessage;
}

interface Member {
  peerId: string;
  name: string;
  presence: Presence;
  lastIntentAt: number;
}

interface Barrier {
  waitingFor: Set<string>;
  deadline: number;
  positionMs: number;
  setBy: string;
}

export const EMPTY_PRESENCE: Presence = {
  readyState: 0,
  bufferedAheadMs: 0,
  hasSource: false,
  deviationMs: 0,
  appliedRev: -1,
  rttMs: 0,
};

export class Room {
  readonly id: string;
  readonly cfg: RoomConfig;
  private members = new Map<string, Member>();
  private barrier: Barrier | null = null;
  private state: PlaybackState = {
    rev: 0,
    status: 'paused',
    positionMs: 0,
    anchorServerTime: null,
    rate: 1,
    setBy: null,
  };

  constructor(id: string, cfg: Partial<RoomConfig> = {}) {
    this.id = id;
    this.cfg = { ...DEFAULT_ROOM_CONFIG, ...cfg };
  }

  get playback(): PlaybackState {
    return { ...this.state };
  }

  get size(): number {
    return this.members.size;
  }

  get waitingFor(): string[] {
    return this.barrier ? [...this.barrier.waitingFor] : [];
  }

  /** Позиция комнаты в момент now по серверным часам. */
  positionAt(now: number): number {
    const s = this.state;
    if (s.status !== 'playing' || s.anchorServerTime === null) return s.positionMs;
    return s.positionMs + Math.max(0, now - s.anchorServerTime) * s.rate;
  }

  join(peerId: string, name: string): Outbound[] {
    if (this.members.has(peerId)) return [];
    if (this.members.size >= this.cfg.maxPeers) {
      return [{ to: peerId, msg: { type: 'error', code: 'room_full', message: 'Комната заполнена' } }];
    }
    const member: Member = { peerId, name, presence: { ...EMPTY_PRESENCE }, lastIntentAt: -Infinity };
    this.members.set(peerId, member);
    // Вход не трогает воспроизведение: новичок сам перемотается к комнате.
    return [
      { to: peerId, msg: { type: 'room:state', you: peerId, peers: this.peers(), playback: this.playback } },
      { to: 'all', except: peerId, msg: { type: 'room:peer_joined', peer: toInfo(member) } },
    ];
  }

  leave(peerId: string, now: number): Outbound[] {
    if (!this.members.delete(peerId)) return [];
    const out: Outbound[] = [{ to: 'all', msg: { type: 'room:peer_left', peerId } }];
    if (this.barrier) {
      this.barrier.waitingFor.delete(peerId);
      out.push(...this.tryRelease(now));
    }
    return out;
  }

  intent(peerId: string, action: IntentAction, positionMs: number, now: number): Outbound[] {
    const member = this.members.get(peerId);
    if (!member) return [{ to: peerId, msg: { type: 'error', code: 'not_joined', message: 'Сначала войдите в комнату' } }];
    if (now - member.lastIntentAt < this.cfg.minIntentIntervalMs) {
      return [{ to: peerId, msg: { type: 'error', code: 'rate_limited', message: 'Слишком часто' } }];
    }
    member.lastIntentAt = now;

    const status = this.state.status;
    switch (action) {
      case 'play':
        if (status !== 'paused') return [];
        return this.startBarrier(this.state.positionMs, peerId, now);
      case 'pause': {
        if (status === 'paused') return [];
        const pos = status === 'waiting' ? this.state.positionMs : this.positionAt(now);
        this.barrier = null;
        return this.commit({ status: 'paused', positionMs: Math.round(pos), anchorServerTime: null, setBy: peerId });
      }
      case 'seek': {
        const pos = Math.max(0, Math.round(positionMs));
        if (status === 'paused') {
          return this.commit({ status: 'paused', positionMs: pos, anchorServerTime: null, setBy: peerId });
        }
        return this.startBarrier(pos, peerId, now);
      }
    }
  }

  presence(peerId: string, presence: Presence, now: number): Outbound[] {
    const member = this.members.get(peerId);
    if (!member) return [];
    member.presence = presence;
    return this.barrier ? this.tryRelease(now) : [];
  }

  /** Вызывается адаптером периодически: дедлайн барьера. */
  tick(now: number): Outbound[] {
    if (this.barrier && now >= this.barrier.deadline) {
      // Не дождались: стартуем без отставших, они догонят сами.
      const b = this.barrier;
      return this.startPlaying(b.positionMs, b.setBy, now);
    }
    return [];
  }

  /** Снимок присутствия для периодической рассылки. */
  presenceSync(): Outbound {
    return { to: 'all', msg: { type: 'presence:sync', peers: this.peers() } };
  }

  // ─── внутреннее ───────────────────────────────────────────────────

  private isReady(m: Member): boolean {
    const p = m.presence;
    return (
      p.appliedRev >= this.state.rev &&
      p.hasSource &&
      p.readyState >= 3 &&
      p.bufferedAheadMs >= this.cfg.readyBufferMs
    );
  }

  private startBarrier(positionMs: number, setBy: string, now: number): Outbound[] {
    const out = this.commit({ status: 'waiting', positionMs, anchorServerTime: null, setBy });
    // Ждём только тех, у кого есть источник: наблюдатель без файла не держит комнату.
    const waitingFor = new Set(
      [...this.members.values()].filter((m) => m.presence.hasSource).map((m) => m.peerId),
    );
    if (waitingFor.size === 0) {
      // Ждать некого (ни у кого нет файла): барьер не нужен.
      return [...out, ...this.startPlaying(positionMs, setBy, now)];
    }
    this.barrier = { waitingFor, deadline: now + this.cfg.barrierTimeoutMs, positionMs, setBy };
    out.push({ to: 'all', msg: { type: 'playback:hold', waitingFor: [...waitingFor], deadline: this.barrier.deadline } });
    return out;
  }

  private tryRelease(now: number): Outbound[] {
    const b = this.barrier;
    if (!b) return [];
    for (const id of [...b.waitingFor]) {
      const m = this.members.get(id);
      if (!m || this.isReady(m)) b.waitingFor.delete(id);
    }
    if (b.waitingFor.size > 0) return [];
    return this.startPlaying(b.positionMs, b.setBy, now);
  }

  private startPlaying(positionMs: number, setBy: string, now: number): Outbound[] {
    this.barrier = null;
    return this.commit({ status: 'playing', positionMs, anchorServerTime: now + this.leadMs(), setBy });
  }

  /** Запас до якоря: команда должна дойти до самого медленного и дать ему подготовиться. */
  leadMs(): number {
    let maxRtt = 0;
    for (const m of this.members.values()) maxRtt = Math.max(maxRtt, m.presence.rttMs);
    return Math.max(this.cfg.minLeadMs, Math.round(maxRtt + this.cfg.leadExtraMs));
  }

  private commit(patch: Omit<PlaybackState, 'rev' | 'rate'>): Outbound[] {
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    return [{ to: 'all', msg: { type: 'playback:state', playback: this.playback } }];
  }

  private peers(): PeerInfo[] {
    return [...this.members.values()].map(toInfo);
  }
}

function toInfo(m: Member): PeerInfo {
  return { peerId: m.peerId, name: m.name, presence: { ...m.presence } };
}
