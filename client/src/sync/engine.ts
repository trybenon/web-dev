/**
 * Ядро воркера синхронизации: соединение с сервером, часы, состояние комнаты,
 * команды плееру и контур подстройки, который держит плеер рядом с комнатой.
 *
 * Само ядро не знает ни про воркер, ни про WebSocket: сокет открывает
 * функция openSocket, а страница получает сообщения через post. Поэтому
 * его можно проверить тестами без браузера. В воркере его оборачивает
 * sync.worker.ts.
 */
import {
  ClientMessageSchema,
  parseServerMessage,
  type ClientMessage,
  type Playback,
  type ServerMessage,
} from "@watch-together/shared";
import { DriftController, isWebKitOnly, type Decision } from "./controller";
import { ServerClock } from "./server-clock";
import { errorAt, planStart, positionAt, type Clocks } from "./timeline";
import type {
  ConnectionState,
  HoldView,
  PeerView,
  RoomView,
  SourceView,
  SyncState,
} from "./types";
import type {
  FromWorker,
  MediaReport,
  PlayerCommand,
  ToWorker,
} from "./worker-protocol";

/** Что ядру нужно от открытого сокета. */
export interface Socket {
  send(data: string): void;
  close(): void;
}

/** Что сокет сообщает ядру. */
export interface SocketEvents {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
}

export interface EngineOptions {
  /** Отправить сообщение странице. */
  post: (message: FromWorker) => void;
  /** Открыть сокет; события придут в events. */
  openSocket: (url: string, events: SocketEvents) => Socket;
  /** Монотонные часы воркера. */
  now?: () => number;
  /** Случайное число от 0 до 1: разброс пауз между переподключениями. */
  random?: () => number;
  /** User-Agent браузера: в Safari контур только перематывает (decisions.md, 4.8). */
  userAgent?: string;
}

/** Сервер закрыл соединение: с нашим токеном вошла другая вкладка. */
const CLOSE_REPLACED = 4001;
/** Столько, мс, от сервера ни слова — соединение мёртвое (decisions.md, 2.11). */
const DEAD_AFTER_MS = 15_000;
/** Как часто проверять соединение и слать отчёт о готовности, мс. */
const TICK_MS = 1_000;
/** Сколько замеров часов ждём до первой команды плееру. */
const SERVER_ANSWERS_TO_APPLY = 4;
const PAGE_ANSWERS_TO_APPLY = 3;
/** Как часто контур подстройки принимает решение, мс. */
const CONTROL_MS = 100;
/** Кадров нет дольше этого, мс, — спрашиваем позицию сами (sync-drift.md, 2). */
const FRAMES_STALE_MS = 500;
/** Замеры раньше этого, мс, после старта ничего не значат: плеер трогается. */
const SAMPLES_AFTER_START_MS = 100;
/** После старта контур молчит ещё столько, мс. */
const START_SETTLE_MS = 300;
/** Перемотка или буферизация: столько, мс, не измеряем (sync-drift.md, 6). */
const BUSY_HOLD_MS = 500;
/** Вкладка вернулась из фона: столько, мс, не измеряем. */
const VISIBLE_HOLD_MS = 1_000;
/** Сколько команд держим, пока нет связи. */
const MAX_QUEUE = 50;

const EMPTY_SOURCE: SourceView = { source: null, checks: [] };

export class SyncEngine {
  private readonly post: (message: FromWorker) => void;
  private readonly openSocket: EngineOptions["openSocket"];
  private readonly now: () => number;
  private readonly random: () => number;
  /** Часы сервера. */
  private readonly serverClock: ServerClock;
  /** Часы страницы: у воркера и окна разный ноль performance.now(). */
  private readonly pageClock: ServerClock;
  /** Контур подстройки: решает, подкрутить скорость или перемотать. */
  private readonly controller: DriftController;

  private url: string | null = null;
  private socket: Socket | null = null;
  /** Номер текущего сокета: события брошенных сокетов не обрабатываем. */
  private generation = 0;
  private socketOpen = false;
  private connection: ConnectionState = "connecting";
  private everOnline = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeardAt = 0;
  /** Команды, отданные без связи: уйдут, когда соединение заработает. */
  private queue: ClientMessage[] = [];

  private room: RoomView | null = null;
  private myName = "";
  private sessionToken: string | null = null;
  /** Отправили room:create или room:join и ждём ответа. */
  private entryPending = false;
  /** Сам запрос на вход: если связь оборвётся до ответа, отправим его снова. */
  private entryMessage: ClientMessage | null = null;
  /**
   * Сколько ответов ещё придёт на вход и возвращение, от которых мы уже
   * отказались: вышли, не дождавшись ответа. Сервер отвечает по порядку,
   * поэтому это всегда самые ранние из ожидаемых ответов.
   */
  private staleEntryAnswers = 0;
  /** Вернулись по токену и ждём room:state. */
  private rejoining = false;
  private playback: Playback | null = null;
  private hold: { rev: number; view: HoldView } | null = null;
  private source: SourceView = EMPTY_SOURCE;

  private playerAttached = false;
  private media: MediaReport | null = null;
  /** Последняя ревизия, которую плеер подтвердил; −1 — ничего. */
  private appliedRev = -1;
  /** Ревизия последней команды плееру; −1 — команду надо отправить заново. */
  private commandRev = -1;
  /** Когда плеер стартует по последней команде play, по часам воркера. */
  private startAt = Infinity;
  /** Когда пришёл последний замер с кадра, по часам воркера. */
  private lastFrameAt = -Infinity;

  constructor(options: EngineOptions) {
    this.post = options.post;
    this.openSocket = options.openSocket;
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.serverClock = new ServerClock(
      (t0) => this.sendNow({ type: "sync:ping", payload: { t0 } }),
      this.now,
    );
    this.pageClock = new ServerClock(
      (t0) => this.post({ type: "clock:ping", t0 }),
      this.now,
    );
    this.controller = new DriftController({
      seekOnly: isWebKitOnly(options.userAgent ?? ""),
    });
  }

  /** Сообщение от страницы. */
  handle(message: ToWorker): void {
    if (this.disposed) return;
    switch (message.type) {
      case "connect":
        this.connect(message.url);
        return;
      case "createRoom":
        this.enter({ type: "room:create", payload: { name: message.name } });
        return;
      case "joinRoom":
        this.enter({
          type: "room:join",
          payload: { roomId: message.roomId, name: message.name },
        });
        return;
      case "leaveRoom":
        this.leave();
        return;
      case "intent":
        this.send({ type: "playback:intent", payload: message.intent });
        return;
      case "proposeSource":
        this.send({ type: "source:propose", payload: message.offer });
        return;
      case "reportSourceMatch":
        this.send({
          type: "source:matched",
          payload: { sourceRev: message.sourceRev, ok: message.ok },
        });
        return;
      case "clock:pong":
        // страница отвечает сразу, поэтому приём и отправка — одна метка
        this.pageClock.onPong(message.t0, message.t1, message.t1);
        this.onClockAnswer();
        return;
      case "player:attach":
        this.playerAttached = true;
        this.commandRev = -1;
        this.apply();
        return;
      case "player:detach":
        this.playerAttached = false;
        this.media = null;
        this.appliedRev = -1;
        this.commandRev = -1;
        return;
      case "player:media":
        this.onMedia(message.media);
        return;
      case "player:applied":
        // подтверждение устаревшей команды готовности не даёт
        if (this.playback && message.rev === this.playback.rev) {
          this.appliedRev = message.rev;
          this.sendPresence();
        }
        return;
      case "player:reload":
        this.appliedRev = -1;
        this.commandRev = -1;
        this.apply();
        this.sendPresence();
        return;
      case "player:sample":
        this.onSample(message.positionMs, message.atMain, message.frame);
        return;
      case "player:visible":
        // Chrome после фона включает видеодорожку своей перемоткой
        this.controller.hold(this.now(), VISIBLE_HOLD_MS);
        return;
      case "dispose":
        this.dispose();
        return;
    }
  }

  // ─── соединение ──────────────────────────────────────────────────

  private connect(url: string): void {
    if (this.url !== null) return;
    this.url = url;
    this.pageClock.start();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.controlTimer = setInterval(() => this.control(), CONTROL_MS);
    this.open();
  }

  private open(): void {
    if (this.url === null) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.socket = this.openSocket(this.url, {
      onOpen: () => {
        if (current()) this.onOpen();
      },
      onMessage: (data) => {
        if (current()) this.onMessage(data);
      },
      onClose: (code) => {
        if (current()) this.onClose(code);
      },
    });
  }

  private onOpen(): void {
    this.socketOpen = true;
    this.lastHeardAt = this.now();
    if (this.room && this.sessionToken) {
      // возвращаемся тем же участником: в ответ придёт свежий room:state
      this.rejoining = true;
      this.sendNow({
        type: "room:join",
        payload: {
          roomId: this.room.roomId,
          name: this.myName,
          sessionToken: this.sessionToken,
        },
      });
    }
    this.serverClock.start();
  }

  private onMessage(data: string): void {
    this.lastHeardAt = this.now();
    const parsed = parseServerMessage(data);
    // сообщение не по протоколу — пропускаем, соединение не рвём
    if (parsed.ok) this.dispatch(parsed.message);
  }

  private onClose(code: number): void {
    this.socket = null;
    this.socketOpen = false;
    this.rejoining = false;
    // ответы на этот сокет уже не придут
    this.staleEntryAnswers = 0;
    this.serverClock.stop();
    const entry = this.entryMessage;
    if (this.entryPending && entry && !this.queue.includes(entry)) {
      // ответ на вход потерялся вместе с соединением: повторим после подключения
      this.queue.unshift(entry);
    }
    if (code === CLOSE_REPLACED) {
      // с этим токеном вошли из другого места: возвращаться некуда
      this.shutDown();
      return;
    }
    this.connection = this.everOnline ? "reconnecting" : "connecting";
    this.emit();
    const delay =
      Math.min(10_000, 500 * 2 ** this.reconnectAttempt) *
      (0.5 + this.random() / 2);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  /** Раз в секунду: жив ли сервер, и отчёт о готовности. */
  private tick(): void {
    if (this.socketOpen && this.now() - this.lastHeardAt > DEAD_AFTER_MS) {
      // полуоткрытое соединение может не закрываться минутами: рвём сами
      const socket = this.socket;
      this.generation += 1;
      socket?.close();
      this.onClose(1006);
      return;
    }
    this.sendPresence();
  }

  /** Пришёл ответ часам сервера или страницы. */
  private onClockAnswer(): void {
    if (
      this.socketOpen &&
      this.connection !== "online" &&
      this.serverClock.answers > 0 &&
      this.pageClock.answers > 0
    ) {
      this.connection = "online";
      this.everOnline = true;
      this.reconnectAttempt = 0;
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) this.sendNow(message);
      this.emit();
    }
    const clocks = this.clocks();
    if (clocks) {
      this.post({
        type: "clock",
        serverOffset: clocks.serverOffset - clocks.mainOffset,
      });
    }
    this.apply();
  }

  // ─── сообщения сервера ───────────────────────────────────────────

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case "sync:pong": {
        const { t0, t1, t2 } = message.payload;
        this.serverClock.onPong(t0, t1, t2);
        this.onClockAnswer();
        return;
      }
      case "room:state":
        this.onRoomState(message.payload);
        return;
      case "room:peer_joined": {
        if (!this.room) return;
        const peer = message.payload.peer;
        this.setPeers([
          ...this.room.peers.filter((p) => p.peerId !== peer.peerId),
          { ...peer, presence: null },
        ]);
        return;
      }
      case "room:peer_left":
        if (!this.room) return;
        this.setPeers(
          this.room.peers.filter((p) => p.peerId !== message.payload.peerId),
        );
        return;
      case "playback:state":
        this.onPlayback(message.payload);
        return;
      case "playback:hold": {
        if (!this.room) return;
        const { rev, ...view } = message.payload;
        this.hold = { rev, view };
        this.emit();
        return;
      }
      case "presence:sync": {
        if (!this.room) return;
        const reports = new Map(
          message.payload.peers.map((p) => [p.peerId, p]),
        );
        this.setPeers(
          this.room.peers.map((peer) => {
            const report = reports.get(peer.peerId);
            if (!report) return peer;
            const { peerId, connection, ...presence } = report;
            return { peerId, name: peer.name, connection, presence };
          }),
        );
        return;
      }
      case "source:state":
        if (!this.room) return;
        this.source = message.payload;
        this.emit();
        return;
      case "error":
        this.onError(message.payload);
        return;
    }
  }

  private onRoomState(
    payload: Extract<ServerMessage, { type: "room:state" }>["payload"],
  ): void {
    if (this.staleEntryAnswers > 0) {
      // ответ на вход или возвращение, из которого мы уже вышли:
      // room:leave ушёл следом, и сервер нас уберёт
      this.staleEntryAnswers -= 1;
      return;
    }
    this.entryPending = false;
    this.entryMessage = null;
    this.rejoining = false;
    const previous = this.room;
    const sameRoom =
      previous?.roomId === payload.roomId && previous.you === payload.you;
    this.room = {
      roomId: payload.roomId,
      you: payload.you,
      peers: payload.peers.map((peer) => ({
        ...peer,
        // после переподключения не теряем отчёты, пока не пришли новые
        presence:
          (sameRoom &&
            previous.peers.find((p) => p.peerId === peer.peerId)?.presence) ||
          null,
      })),
    };
    this.myName =
      payload.peers.find((p) => p.peerId === payload.you)?.name ?? this.myName;
    this.sessionToken = payload.sessionToken;
    if (!sameRoom) this.appliedRev = -1;
    this.playback = payload.playback;
    if (this.hold?.rev !== payload.playback.rev) this.hold = null;
    const checks =
      this.source.source?.rev === payload.source?.rev ? this.source.checks : [];
    this.source = payload.source
      ? { source: payload.source, checks: sameRoom ? checks : [] }
      : EMPTY_SOURCE;
    // снимок применяем всегда, даже если ревизия та же: плеер мог уйти
    this.commandRev = -1;
    this.emit();
    this.apply();
    this.sendPresence();
  }

  private onPlayback(next: Playback): void {
    if (!this.room) return;
    if (this.playback && next.rev < this.playback.rev) return; // опоздавшее
    this.playback = next;
    if (this.hold && this.hold.rev !== next.rev) this.hold = null;
    this.emit();
    this.apply();
  }

  private onError(
    error: Extract<ServerMessage, { type: "error" }>["payload"],
  ): void {
    const entryFailed =
      error.code === "room_not_found" || error.code === "room_full";
    if (entryFailed && this.staleEntryAnswers > 0) {
      // отказ на вход, из которого мы уже вышли: сообщать не о чем
      this.staleEntryAnswers -= 1;
      return;
    }
    if (entryFailed) {
      this.entryPending = false;
      this.entryMessage = null;
      if (this.rejoining) {
        // место не дождалось нас, а комнату закрыли или заняли
        this.clearRoom();
        this.emit();
      }
    } else if (
      error.code === "invalid_message" ||
      error.code === "rate_limited"
    ) {
      // сервер мог выбросить и запрос на вход, ничего на него не ответив:
      // не ждём вечно, даём войти снова
      this.entryPending = false;
      this.entryMessage = null;
    } else if (error.code === "not_joined" && this.room && !this.rejoining) {
      // сервер нас в комнате не числит, а мы её показываем и раз в секунду
      // шлём отчёт: верим серверу и выходим из комнаты
      this.clearRoom();
      this.emit();
    }
    this.post({ type: "error", error });
  }

  // ─── команды интерфейса ──────────────────────────────────────────

  private enter(message: ClientMessage): void {
    // как на сервере: повторный вход из комнаты не делает ничего
    if (this.room || this.entryPending) return;
    // та же схема, что на сервере: неверный вход (пустой id, пустое имя)
    // не уходит и не оставляет нас ждать ответа
    const checked = ClientMessageSchema.safeParse(message);
    if (!checked.success) {
      const fields = checked.error.issues.map((i) => i.path.join("."));
      this.post({
        type: "error",
        error: {
          code: "invalid_message",
          message: `Вход не прошёл проверку: ${fields.join(", ")}`,
        },
      });
      return;
    }
    this.entryPending = true;
    this.entryMessage = checked.data;
    this.send(checked.data);
  }

  private leave(): void {
    if (!this.room && !this.entryPending) return;
    // вход, который ещё не ушёл, просто забываем
    const queuedEntry = this.queue.some(
      (m) => m.type === "room:create" || m.type === "room:join",
    );
    this.queue = this.queue.filter(
      (m) => m.type !== "room:create" && m.type !== "room:join",
    );
    if (!queuedEntry) {
      // на ушедший вход или возвращение по токену ответ ещё придёт:
      // его надо пропустить, иначе он снова покажет комнату
      if (this.entryPending || this.rejoining) this.staleEntryAnswers += 1;
      this.send({ type: "room:leave", payload: {} });
    }
    this.clearRoom();
    this.emit();
  }

  private clearRoom(): void {
    this.room = null;
    this.sessionToken = null;
    this.entryPending = false;
    this.entryMessage = null;
    this.rejoining = false;
    this.playback = null;
    this.hold = null;
    this.source = EMPTY_SOURCE;
    this.appliedRev = -1;
    this.commandRev = -1;
    this.startAt = Infinity;
  }

  private dispose(): void {
    if (this.socketOpen && (this.room || this.entryPending)) {
      // выходим сразу, чтобы сервер не держал место 30 секунд
      this.sendNow({ type: "room:leave", payload: {} });
    }
    this.shutDown();
  }

  /** Окончательно закрыть соединение и остановить таймеры. */
  private shutDown(): void {
    this.disposed = true;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    this.socketOpen = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.tickTimer);
    clearInterval(this.controlTimer);
    this.serverClock.stop();
    this.pageClock.stop();
    this.queue = [];
    this.clearRoom();
    this.connection = "closed";
    this.emit();
  }

  // ─── плеер ───────────────────────────────────────────────────────

  private clocks(): Clocks | null {
    const serverOffset = this.serverClock.offset();
    const mainOffset = this.pageClock.offset();
    if (serverOffset === null || mainOffset === null) return null;
    return { serverOffset, mainOffset };
  }

  /** Отправить плееру команду для текущего состояния, если ещё не отправляли. */
  private apply(): void {
    const playback = this.playback;
    if (!playback || !this.room || !this.playerAttached) return;
    if (playback.rev === this.commandRev) return;
    const clocks = this.clocks();
    // без калибровки якорь не перевести в часы страницы: дождёмся замеров
    if (
      !clocks ||
      this.serverClock.answers < SERVER_ANSWERS_TO_APPLY ||
      this.pageClock.answers < PAGE_ANSWERS_TO_APPLY
    ) {
      return;
    }
    this.commandRev = playback.rev;
    this.startAt = Infinity;
    const now = this.now();
    const { rev, positionMs } = playback;
    let command: PlayerCommand;
    switch (playback.status) {
      case "paused":
        command = { kind: "pause", rev, positionMs };
        break;
      case "waiting":
        command = { kind: "prepare", rev, positionMs };
        break;
      case "playing": {
        // поздний вход тоже здесь: якорь в прошлом, и planStart назначает
        // старт чуть впереди с позиции, где комната будет в этот момент
        const plan = planStart(playback, now, clocks);
        this.startAt = plan.atMain - clocks.mainOffset;
        command = {
          kind: "play",
          rev,
          positionMs: plan.positionMs,
          atMain: plan.atMain,
          rate: playback.rate,
          leadMs: this.controller.startLeadMs,
        };
        break;
      }
    }
    // новая команда комнаты: скорость к 1, контур молчит, пока плеер её
    // выполняет; промах прошлой перемотки уже ничего не скажет (sync-drift.md, 6)
    const settleMs =
      playback.status === "playing" ? this.startAt - now + START_SETTLE_MS : 0;
    this.execute(this.controller.suspend(now, settleMs), playback, clocks);
    if (playback.status === "playing") this.controller.noteStart();
    this.command(command);
  }

  private onMedia(media: MediaReport): void {
    const before = this.media;
    this.media = media;
    // файл сменился или пропал: старое подтверждение больше не считается
    if (before?.hasSource && !media.hasSource) this.appliedRev = -1;
    // перематывается или ждёт данных: на это время контур не измеряет
    if (!isBusy(before) && isBusy(media)) {
      this.controller.hold(this.now(), BUSY_HOLD_MS);
    }
    if (
      !before ||
      before.hasSource !== media.hasSource ||
      before.playerState !== media.playerState
    ) {
      this.sendPresence();
    }
  }

  /**
   * Насколько плеер отстаёт от комнаты по последнему отчёту плеера.
   * null — только когда сравнивать не с чем: нет файла или он не совпал
   * с источником комнаты. В остальное время отклонение честное: и на паузе,
   * и при подготовке, и пока плеер стоит, а комната идёт. Свежесть замера
   * получатель решает сам по моменту at (protocol.md, «Присутствие»).
   */
  private deviation(): { errorMs: number; at: number } | null {
    const { media, playback } = this;
    const clocks = this.clocks();
    if (!media || !playback || !clocks) return null;
    if (!media.hasSource || this.fileMismatch()) return null;
    const { atWorker, errorMs } = errorAt(
      playback,
      media.positionMs,
      media.atMain,
      clocks,
    );
    return { errorMs, at: atWorker + clocks.serverOffset };
  }

  /** Мой файл сверили с источником комнаты, и он не совпал. */
  private fileMismatch(): boolean {
    const you = this.room?.you;
    return this.source.checks.some((c) => c.peerId === you && !c.ok);
  }

  /** Замер позиции для контура: с показанного кадра или по нашему запросу. */
  private onSample(positionMs: number, atMain: number, frame: boolean): void {
    if (frame) this.lastFrameAt = this.now();
    const playback = this.playback;
    const clocks = this.clocks();
    if (!clocks || playback?.status !== "playing") return;
    if (playback.rev !== this.commandRev || isBusy(this.media)) return;
    if (this.fileMismatch()) return;
    const { atWorker, errorMs } = errorAt(playback, positionMs, atMain, clocks);
    // до старта и в первые мгновения после него ошибка ничего не значит
    if (atWorker < this.startAt + SAMPLES_AFTER_START_MS) return;
    this.controller.addSample(atWorker, errorMs);
  }

  /** Раз в 100 мс: решение контура подстройки (sync-drift.md, 4). */
  private control(): void {
    const playback = this.playback;
    const clocks = this.clocks();
    const now = this.now();
    if (!clocks || playback?.status !== "playing" || !this.playerAttached) {
      return;
    }
    // без файла или с чужим файлом подстраивать не к чему — по той же
    // причине отклонение в отчёте null (protocol.md, «Присутствие»)
    if (!this.media?.hasSource || this.fileMismatch()) return;
    if (playback.rev !== this.commandRev || now < this.startAt) return;
    // кадров нет (вкладка в фоне или браузер без rVFC): спрашиваем позицию сами
    if (now - this.lastFrameAt > FRAMES_STALE_MS) {
      this.command({ kind: "sample" });
    }
    this.execute(this.controller.decide(now), playback, clocks);
  }

  /**
   * Выполнить решение контура. Его скорость — поправка к скорости комнаты.
   * Ни перемотка, ни скорость не уходят на сервер: это дело одного плеера.
   */
  private execute(
    decision: Decision,
    playback: Playback,
    clocks: Clocks,
  ): void {
    if (decision.kind === "rate") {
      this.command({ kind: "rate", rate: playback.rate * decision.rate });
    } else if (decision.kind === "seek") {
      // после перемотки — снова обычная скорость
      this.command({ kind: "rate", rate: playback.rate });
      const at = this.now() + clocks.serverOffset + decision.leadMs;
      this.command({ kind: "seek", positionMs: positionAt(playback, at) });
    }
  }

  private command(command: PlayerCommand): void {
    this.post({ type: "player:command", command });
  }

  /** Отчёт о готовности: раз в секунду и при каждой смене состояния плеера. */
  private sendPresence(): void {
    const media = this.media;
    const serverNow = this.serverClock.serverNow();
    if (!media || !this.room || this.connection !== "online") return;
    if (serverNow === null) return;
    const deviation = this.deviation();
    this.sendNow({
      type: "presence:update",
      payload: {
        readyState: Math.min(4, Math.max(0, Math.round(media.readyState))),
        bufferedAheadMs: Math.max(0, Math.round(media.bufferedAheadMs)),
        playerState: media.playerState,
        hasSource: media.hasSource,
        deviationMs: deviation ? Math.round(deviation.errorMs) : null,
        deviationAt: Math.max(0, deviation?.at ?? serverNow),
        appliedRev: this.appliedRev,
        // без предела один клиент отодвинул бы старт для всех
        rttMs: Math.min(10_000, Math.round(this.serverClock.rtt() ?? 0)),
      },
    });
  }

  // ─── отправка ────────────────────────────────────────────────────

  /** Команда интерфейса: сразу, если есть связь, иначе — в очередь. */
  private send(message: ClientMessage): void {
    if (this.connection === "online") {
      this.sendNow(message);
      return;
    }
    this.queue.push(message);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  private sendNow(message: ClientMessage): void {
    if (this.socketOpen) this.socket?.send(JSON.stringify(message));
  }

  private setPeers(peers: PeerView[]): void {
    if (!this.room) return;
    this.room = { ...this.room, peers };
    this.emit();
  }

  private emit(): void {
    const { playback, hold } = this;
    const state: SyncState = {
      connection: this.connection,
      room: this.room,
      playback,
      // удержание показываем, только пока оно про текущую ревизию
      hold: hold && playback && hold.rev === playback.rev ? hold.view : null,
      source: this.source,
    };
    this.post({ type: "state", state });
  }
}

/** Плеер перематывается или ждёт данных. */
function isBusy(media: MediaReport | null): boolean {
  return media?.playerState === "seeking" || media?.playerState === "buffering";
}
