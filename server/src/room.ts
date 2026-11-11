/**
 * Комната на сервере — чистая машина состояний
 *
 * Модуль не знает про сокеты и таймеры: каждый метод получает текущее
 * время по часам сервера и возвращает список исходящих сообщений.
 * Адаптер (#19) рассылает их по соединениям и регулярно зовёт tick.
 * Так барьер, дедлайн и якорь проверяются тестами без сети и ожидания.
 *
 * Правила (docs/sync-start.md, docs/protocol.md):
 * - управление общее: намерение принимается от любого участника;
 * - любое изменение воспроизведения увеличивает rev;
 * - запуск и перемотка во время игры проходят через барьер с дедлайном;
 * - вход новичка и подвисание барьер не поднимают;
 * - готовность засчитывается только для текущей ревизии (appliedRev);
 * - якорь с запасом: max(300 мс, наибольший RTT + 200 мс).
 */
import { LIMITS } from "@watch-together/shared";
import type {
  ClientMessage,
  ErrorCode,
  PeerId,
  PeerPresence,
  Peer,
  Playback,
  Presence,
  RoomId,
  ServerMessage,
  SourceInfo,
  SourceOffer,
} from "@watch-together/shared";

export interface RoomConfig {
  maxPeers: number;
  /** Сколько барьер ждёт отстающих, мс. */
  barrierTimeoutMs: number;
  /** Наименьший запас до якоря, мс. */
  minLeadMs: number;
  /** Добавка к наибольшему RTT: на обработку и планирование запуска, мс. */
  leadExtraMs: number;
  /** Сколько видео впереди должно лежать в буфере, чтобы считаться готовым, мс. */
  readyBufferMs: number;
  /** Погрешность длительности и буфера у конца ролика, мс. */
  endSlackMs: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxPeers: LIMITS.maxPeers,
  barrierTimeoutMs: 10_000,
  minLeadMs: 300,
  leadExtraMs: 200,
  readyBufferMs: 2_000,
  endSlackMs: 250,
};
/** Что хочет участник: play, pause или seek с позицией. */
export type PlaybackIntent = Extract<
  ClientMessage,
  { type: "playback:intent" }
>["payload"];

/** Почему держим старт: ждём буфер после запуска или после перемотки. */
type HoldReason = "buffering" | "seeking";

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
  /** null — отчёта о готовности ещё не было. */
  presence: Presence | null;
}

/**
 * Пустой отчёт для presence:sync, пока участник ни разу не отчитался.
 * Каждое поле значит «ничего не знаем»: файла нет, ничего не применял,
 * отклонения нет. Так статус соединения доходит до всех и без отчёта.
 */
const NO_PRESENCE: Presence = {
  readyState: 0,
  bufferedAheadMs: 0,
  playerState: "paused",
  hasSource: false,
  deviationMs: null,
  deviationAt: 0,
  appliedRev: -1,
  rttMs: 0,
};

interface Barrier {
  waitingFor: Set<PeerId>;
  deadline: number;
  reason: HoldReason;
}
export class Room {
  readonly id: RoomId;
  readonly config: RoomConfig;
  private readonly members = new Map<PeerId, Member>();
  private state: Playback;
  private barrier: Barrier | null = null;
  /** Источник комнаты; null — ещё не выбран. */
  private source: SourceInfo | null = null;
  private checks: { peerId: PeerId; ok: boolean }[] = [];

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

  get waitingFor(): PeerId[] {
    return this.barrier ? [...this.barrier.waitingFor] : [];
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
      presence: null,
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

  leave(peerId: PeerId, now: number): Outbound[] {
    if (!this.members.delete(peerId)) return [];
    // сверка ушедшего больше ни о ком не говорит: новичок её видеть не должен
    this.checks = this.checks.filter((c) => c.peerId !== peerId);
    return [
      { to: "all", msg: { type: "room:peer_left", payload: { peerId } } },
      ...this.release(now),
    ];
  }

  /**
   * Соединение оборвалось: место держим, барьер этого участника больше
   * не ждёт. Через 30 с без возвращения адаптер зовёт leave.
   */
  disconnect(peerId: PeerId, now: number): Outbound[] {
    const member = this.members.get(peerId);
    if (!member || member.connection === "reconnecting") return [];
    member.connection = "reconnecting";
    return [this.presenceSync(), ...this.release(now)];
  }

  /** Вернулся с токеном: снова на связи и получает свежий снимок. */
  reconnect(peerId: PeerId): Outbound[] {
    const member = this.members.get(peerId);
    if (!member) return [];
    member.connection = "online";
    return [...this.snapshot(member), this.presenceSync()];
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
        return this.start(this.state.positionMs, peerId, "buffering", now);
      }
      case "pause": {
        if (status === "paused") return [];
        this.barrier = null;
        return this.commit({
          status: "paused",
          // на waiting positionAt вернёт позицию, куда собирались
          positionMs: this.clampPosition(this.positionAt(now)),
          anchorServerTime: now,
          setBy: peerId,
        });
      }

      case "seek": {
        const positionMs = this.clampPosition(intent.positionMs);
        if (status === "paused") {
          return this.commit({
            status: "paused",
            positionMs,
            anchorServerTime: now,
            setBy: peerId,
          });
        }
        return this.start(positionMs, peerId, "seeking", now);
      }
    }
  }

  presence(peerId: PeerId, presence: Presence, now: number): Outbound[] {
    const member = this.members.get(peerId);
    if (!member) return [];
    member.presence = presence;
    return this.release(now);
  }

  /** Адаптер зовёт регулярно: истёк ли дедлайн барьера. */
  tick(now: number): Outbound[] {
    if (!this.barrier || now < this.barrier.deadline) return [];
    // не дождались: стартуем без отставших, они догонят сами
    return this.startPlaying(this.state.positionMs, this.state.setBy, now);
  }
  /** Готовность и связь всех участников — адаптер рассылает раз в секунду. */
  presenceSync(): Outbound {
    const peers: PeerPresence[] = [];
    for (const m of this.members.values()) {
      peers.push({
        ...(m.presence ?? NO_PRESENCE),
        peerId: m.peerId,
        connection: m.connection,
      });
    }
    return { to: "all", msg: { type: "presence:sync", payload: { peers } } };
  }
  proposeSource(peerId: PeerId, offer: SourceOffer, now: number): Outbound[] {
    if (!this.members.has(peerId)) {
      return [error(peerId, "not_joined", "Сначала войдите в комнату")];
    }
    this.source = {
      ...offer,
      rev: (this.source?.rev ?? 0) + 1,
      proposedBy: peerId,
    };
    this.checks = [];
    this.barrier = null;
    // новый фильм — с начала и на паузе
    return [
      { to: "all", msg: this.sourceState() },
      ...this.commit({
        status: "paused",
        positionMs: 0,
        anchorServerTime: now,
        setBy: peerId,
      }),
    ];
  }

  matchSource(peerId: PeerId, sourceRev: number, ok: boolean): Outbound[] {
    if (!this.members.has(peerId)) {
      return [error(peerId, "not_joined", "Сначала войдите в комнату")];
    }
    // ответ про прошлый фильм молча отбрасываем
    if (!this.source || this.source.rev !== sourceRev) return [];
    // от каждого участника одна сверка: новая заменяет прежнюю
    this.checks = [
      ...this.checks.filter((c) => c.peerId !== peerId),
      { peerId, ok },
    ];
    return [{ to: "all", msg: this.sourceState() }];
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
    // в room:state сверок нет: новичку их отдельным сообщением
    if (this.source) out.push({ to: member.peerId, msg: this.sourceState() });
    return out;
  }
  /** Позиция в пределах фильма: дальше конца не перемотать и не уехать. */
  private clampPosition(ms: number): number {
    // длительность неизвестна — ограничивать нечем
    const end = this.source?.durationMs ?? Infinity;
    return Math.round(Math.min(ms, end));
  }

  /** Запас до якоря: команда должна дойти до самого медленного. */
  private leadMs(): number {
    let maxRtt = 0;
    for (const m of this.members.values()) {
      if (m.presence) maxRtt = Math.max(maxRtt, m.presence.rttMs);
    }
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

  private sourceState(): ServerMessage {
    return {
      type: "source:state",
      payload: { source: this.source, checks: this.checks },
    };
  }
  private startPlaying(
    positionMs: number,
    setBy: PeerId | null,
    now: number,
  ): Outbound[] {
    this.barrier = null;
    return this.commit({
      status: "playing",
      positionMs,
      anchorServerTime: now + this.leadMs(),
      setBy,
    });
  } /** Запуск: сначала waiting, потом playing  */
  /** Запуск через барьер: waiting, удержание, потом playing. */
  private start(
    positionMs: number,
    setBy: PeerId,
    reason: HoldReason,
    now: number,
  ): Outbound[] {
    const out = this.commit({
      status: "waiting",
      positionMs,
      anchorServerTime: now,
      setBy,
    });
    const waitingFor = new Set(
      [...this.members.values()]
        .filter((m) => this.holds(m))
        .map((m) => m.peerId),
    );
    // ждать некого: ни у кого нет файла
    if (waitingFor.size === 0) {
      return [...out, ...this.startPlaying(positionMs, setBy, now)];
    }
    this.barrier = {
      waitingFor,
      deadline: now + this.config.barrierTimeoutMs,
      reason,
    };
    return [...out, this.hold(this.barrier)];
  }

  /** Вычеркнуть готовых и ушедших; если ждать больше некого — старт. */
  private release(now: number): Outbound[] {
    const barrier = this.barrier;
    if (!barrier) return [];
    const before = barrier.waitingFor.size;
    // копия: удаляем из множества, по которому идём
    for (const peerId of [...barrier.waitingFor]) {
      const m = this.members.get(peerId);
      if (!m || !this.holds(m) || this.isReady(m)) {
        barrier.waitingFor.delete(peerId);
      }
    }
    if (barrier.waitingFor.size === 0) {
      return this.startPlaying(this.state.positionMs, this.state.setBy, now);
    }
    // список ожидания сократился — пусть интерфейс покажет, кого ещё ждём
    return barrier.waitingFor.size < before ? [this.hold(barrier)] : [];
  }

  private hold(barrier: Barrier): Outbound {
    return {
      to: "all",
      msg: {
        type: "playback:hold",
        payload: {
          rev: this.state.rev,
          waitingFor: [...barrier.waitingFor],
          reason: barrier.reason,
          deadline: barrier.deadline,
        },
      },
    };
  }

  /** Держит ли участник старт: наблюдатель без файла комнату не держит. */
  private holds(m: Member): boolean {
    return m.connection === "online" && m.presence?.hasSource === true;
  }

  private isReady(m: Member): boolean {
    const p = m.presence;
    return (
      p !== null &&
      // готов к текущей ревизии, а не к той, что была до перемотки
      p.appliedRev >= this.state.rev &&
      p.hasSource &&
      p.readyState >= 3 &&
      p.bufferedAheadMs >= this.requiredBufferMs()
    );
  }

  private requiredBufferMs(): number {
    const durationMs = this.source?.durationMs;
    if (durationMs != null) {
      // у конца ролика больше оставшегося в буфер не положить
      const leftMs =
        durationMs - this.state.positionMs - this.config.endSlackMs;
      return Math.max(0, Math.min(this.config.readyBufferMs, leftMs));
    }
    return this.config.readyBufferMs;
  }
}

function toPeer(m: Member): Peer {
  return { peerId: m.peerId, name: m.name, connection: m.connection };
}

function error(to: PeerId, code: ErrorCode, message: string): Outbound {
  return { to, msg: { type: "error", payload: { code, message } } };
}
