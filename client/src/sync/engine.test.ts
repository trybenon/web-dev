import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClientMessageSchema,
  serverExamples,
  type ClientMessage,
  type Playback,
  type ServerMessage,
} from "@watch-together/shared";
import { SyncEngine, type Socket, type SocketEvents } from "./engine";
import type { SyncState } from "./types";
import type { FromWorker, MediaReport, PlayerCommand } from "./worker-protocol";

/** Сервер впереди воркера на столько, мс. */
const SERVER = 1_000_000;
/** Страница впереди воркера на столько, мс. */
const PAGE = 250;

class FakeSocket implements Socket {
  readonly sent: ClientMessage[] = [];
  closed = false;
  private readonly events: SocketEvents;

  constructor(events: SocketEvents) {
    this.events = events;
  }

  send(data: string): void {
    // всё, что уходит на сервер, обязано проходить схему протокола
    this.sent.push(ClientMessageSchema.parse(JSON.parse(data)));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.events.onOpen();
  }

  receive(message: ServerMessage): void {
    this.events.onMessage(JSON.stringify(message));
  }

  drop(code = 1006): void {
    this.events.onClose(code);
  }

  /** Прислать что угодно, даже не по протоколу. */
  raw(data: string): void {
    this.events.onMessage(data);
  }

  ofType<T extends ClientMessage["type"]>(type: T) {
    return this.sent.filter(
      (m): m is Extract<ClientMessage, { type: T }> => m.type === type,
    );
  }
}

let sockets: FakeSocket[];
let posted: FromWorker[];
let engine: SyncEngine;
/** Сколько пингов сервера и страницы уже отвечено. */
let answered: { server: number; page: number };

const socket = () => sockets[sockets.length - 1];
const now = () => Date.now();

function state(): SyncState {
  const states = posted.filter((m) => m.type === "state");
  return states[states.length - 1].state;
}

/** Команды плееру, кроме просьб прислать позицию — их считает sampleRequests. */
function commands(): PlayerCommand[] {
  return posted.flatMap((m) =>
    m.type === "player:command" && m.command.kind !== "sample"
      ? [m.command]
      : [],
  );
}

function sampleRequests(): number {
  return posted.filter(
    (m) => m.type === "player:command" && m.command.kind === "sample",
  ).length;
}

/** Ответить на все пинги: сервер и страница отвечают мгновенно. */
function answerPings(): void {
  const serverPings = socket()?.ofType("sync:ping") ?? [];
  for (const ping of serverPings.slice(answered.server)) {
    const t0 = ping.payload.t0;
    socket().receive({
      type: "sync:pong",
      payload: { t0, t1: t0 + SERVER, t2: t0 + SERVER },
    });
  }
  answered.server = serverPings.length;
  const pagePings = posted.flatMap((m) => (m.type === "clock:ping" ? [m] : []));
  for (const ping of pagePings.slice(answered.page)) {
    engine.handle({ type: "clock:pong", t0: ping.t0, t1: ping.t0 + PAGE });
  }
  answered.page = pagePings.length;
}

/** Подключиться и откалибровать часы: восемь быстрых пингов. */
function connect(): void {
  engine.handle({ type: "connect", url: "ws://test/ws" });
  socket().open();
  calibrate();
}

function calibrate(): void {
  for (let i = 0; i < 8; i++) {
    answerPings();
    vi.advanceTimersByTime(150);
  }
  answerPings();
}

/** Войти в комнату из примеров: я — Петя. */
function joinExample(
  playback: Playback = serverExamples.playbackStateInitial.payload,
): void {
  engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Петя" });
  socket().receive({
    ...serverExamples.roomState,
    payload: { ...serverExamples.roomState.payload, playback, source: null },
  });
}

function media(changes: Partial<MediaReport> = {}): MediaReport {
  return {
    readyState: 4,
    bufferedAheadMs: 5_000,
    playerState: "paused",
    hasSource: true,
    positionMs: 0,
    atMain: now() + PAGE,
    ...changes,
  };
}

function playing(positionMs: number, anchorServerTime: number): Playback {
  return {
    rev: 5,
    status: "playing",
    positionMs,
    anchorServerTime,
    rate: 1,
    setBy: "peer-anya",
  };
}

function makeEngine(userAgent?: string): SyncEngine {
  return new SyncEngine({
    post: (m) => posted.push(m),
    openSocket: (_url, events) => {
      const s = new FakeSocket(events);
      sockets.push(s);
      answered.server = 0;
      return s;
    },
    now,
    random: () => 0.5,
    userAgent,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  sockets = [];
  posted = [];
  answered = { server: 0, page: 0 };
  engine = makeEngine();
});

afterEach(() => {
  engine.handle({ type: "dispose" });
  vi.useRealTimers();
});

describe("SyncEngine: соединение", () => {
  it("online — только когда ответили и сервер, и страница", () => {
    engine.handle({ type: "connect", url: "ws://test/ws" });
    expect(posted.some((m) => m.type === "clock:ping")).toBe(true);
    socket().open();
    expect(socket().ofType("sync:ping")).toHaveLength(1);
    answerPings();
    expect(state().connection).toBe("online");
    const clock = posted.filter((m) => m.type === "clock").pop();
    expect(clock).toEqual({ type: "clock", serverOffset: SERVER - PAGE });
  });

  it("команды до подключения уходят сразу после него", () => {
    engine.handle({ type: "connect", url: "ws://test/ws" });
    engine.handle({ type: "createRoom", name: "Аня" });
    socket().open();
    expect(socket().ofType("room:create")).toHaveLength(0);
    answerPings();
    expect(socket().ofType("room:create")).toEqual([
      { type: "room:create", payload: { name: "Аня" } },
    ]);
  });

  it("повторный connect не открывает второй сокет", () => {
    connect();
    engine.handle({ type: "connect", url: "ws://test/ws" });
    expect(sockets).toHaveLength(1);
  });

  it("обрыв: reconnecting, пауза, возвращение по токену", () => {
    connect();
    joinExample();
    socket().drop();
    expect(state().connection).toBe("reconnecting");
    expect(state().room?.you).toBe("peer-petya"); // комнату пока помним
    vi.advanceTimersByTime(374); // 500 мс × (0.5 + 0.5 / 2)
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    socket().open();
    expect(socket().sent[0]).toEqual({
      type: "room:join",
      payload: { roomId: "k7f3q", name: "Петя", sessionToken: "s-9f2c1e7a" },
    });
    answerPings();
    expect(state().connection).toBe("online");
  });

  it("паузы между попытками растут до 10 секунд", () => {
    connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const started = now();
      socket().drop();
      while (sockets.length === i + 1) vi.advanceTimersByTime(1);
      delays.push(now() - started);
    }
    expect(delays).toEqual([375, 750, 1_500, 3_000, 6_000, 7_500, 7_500]);
  });

  it("закрытие 4001 — closed и без переподключения", () => {
    connect();
    joinExample();
    socket().drop(4001);
    expect(state().connection).toBe("closed");
    expect(state().room).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("15 секунд тишины — рвёт соединение и подключается заново", () => {
    connect();
    vi.advanceTimersByTime(14_000);
    expect(socket().closed).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(sockets[0].closed).toBe(true);
    expect(state().connection).toBe("reconnecting");
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(2);
  });

  it("dispose: выходит из комнаты, закрывает сокет и снимает таймеры", () => {
    connect();
    joinExample();
    engine.handle({ type: "dispose" });
    expect(socket().ofType("room:leave")).toHaveLength(1);
    expect(socket().closed).toBe(true);
    expect(state().connection).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    engine.handle({ type: "createRoom", name: "Аня" });
    expect(socket().ofType("room:create")).toHaveLength(0);
  });

  it("сообщения не по протоколу пропускает", () => {
    connect();
    const before = posted.length;
    socket().raw("{oops");
    socket().raw(JSON.stringify({ type: "room:destroy" }));
    expect(posted).toHaveLength(before);
    expect(socket().closed).toBe(false);
  });
});

describe("SyncEngine: комната", () => {
  it("room:state даёт комнату, воспроизведение и источник", () => {
    connect();
    engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Петя" });
    socket().receive(serverExamples.roomState);
    const s = state();
    expect(s.room).toEqual({
      roomId: "k7f3q",
      you: "peer-petya",
      peers: [
        {
          peerId: "peer-anya",
          name: "Аня",
          connection: "online",
          presence: null,
        },
        {
          peerId: "peer-petya",
          name: "Петя",
          connection: "online",
          presence: null,
        },
      ],
    });
    expect(s.playback).toEqual(serverExamples.roomState.payload.playback);
    expect(s.source).toEqual({
      source: serverExamples.roomState.payload.source,
      checks: [],
    });
    socket().receive(serverExamples.sourceState);
    expect(state().source).toEqual(serverExamples.sourceState.payload);
  });

  it("повторный вход, пока ждём ответа или уже в комнате, ничего не шлёт", () => {
    connect();
    engine.handle({ type: "createRoom", name: "Аня" });
    engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Аня" });
    expect(socket().ofType("room:create")).toHaveLength(1);
    expect(socket().ofType("room:join")).toHaveLength(0);
  });

  it("обрыв до ответа на вход: запрос уходит снова после подключения", () => {
    connect();
    engine.handle({ type: "createRoom", name: "Аня" });
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    answerPings();
    expect(socket().ofType("room:create")).toEqual([
      { type: "room:create", payload: { name: "Аня" } },
    ]);
    socket().receive({
      ...serverExamples.roomState,
      payload: { ...serverExamples.roomState.payload, you: "peer-anya" },
    });
    expect(state().room?.you).toBe("peer-anya");
  });

  it("ошибка входа снимает ожидание: можно войти снова", () => {
    connect();
    engine.handle({ type: "joinRoom", roomId: "nope", name: "Аня" });
    socket().receive({
      type: "error",
      payload: { code: "room_not_found", message: "Room not found" },
    });
    expect(posted).toContainEqual({
      type: "error",
      error: { code: "room_not_found", message: "Room not found" },
    });
    engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Аня" });
    expect(socket().ofType("room:join")).toHaveLength(2);
  });

  it("вход с пустым id не уходит на сервер и не мешает войти снова", () => {
    connect();
    engine.handle({ type: "joinRoom", roomId: "", name: "Аня" });
    expect(socket().ofType("room:join")).toHaveLength(0);
    expect(posted).toContainEqual({
      type: "error",
      error: {
        code: "invalid_message",
        message: "Вход не прошёл проверку: payload.roomId",
      },
    });
    engine.handle({ type: "createRoom", name: "  Аня " });
    expect(socket().ofType("room:create")).toEqual([
      { type: "room:create", payload: { name: "Аня" } },
    ]);
  });

  it("сервер выбросил вход (invalid_message, rate_limited) — можно войти снова", () => {
    connect();
    for (const code of ["invalid_message", "rate_limited"] as const) {
      engine.handle({ type: "createRoom", name: "Аня" });
      socket().receive({ type: "error", payload: { code, message: code } });
    }
    engine.handle({ type: "createRoom", name: "Аня" });
    expect(socket().ofType("room:create")).toHaveLength(3);
  });

  it("участники входят, выходят и присылают отчёты", () => {
    connect();
    joinExample();
    socket().receive({
      type: "room:peer_joined",
      payload: {
        peer: { peerId: "peer-vasya", name: "Вася", connection: "online" },
      },
    });
    expect(state().room?.peers.map((p) => p.peerId)).toEqual([
      "peer-anya",
      "peer-petya",
      "peer-vasya",
    ]);
    socket().receive(serverExamples.presenceSync);
    const anya = state().room?.peers[0];
    expect(anya?.presence?.appliedRev).toBe(7);
    expect(state().room?.peers[1].connection).toBe("reconnecting");
    socket().receive({
      type: "room:peer_left",
      payload: { peerId: "peer-anya" },
    });
    expect(state().room?.peers.map((p) => p.peerId)).toEqual([
      "peer-petya",
      "peer-vasya",
    ]);
  });

  it("после переподключения отчёты участников не теряются", () => {
    connect();
    joinExample();
    socket().receive(serverExamples.presenceSync);
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    socket().receive(serverExamples.roomState);
    expect(state().room?.peers[0].presence?.appliedRev).toBe(7);
  });

  it("опоздавшее состояние старой ревизии не применяется", () => {
    connect();
    joinExample(serverExamples.playbackState.payload); // rev 7
    socket().receive({
      type: "playback:state",
      payload: { ...serverExamples.playbackStateInitial.payload, rev: 6 },
    });
    expect(state().playback?.rev).toBe(7);
  });

  it("удержание видно, только пока оно про текущую ревизию", () => {
    connect();
    joinExample();
    const waiting = {
      ...serverExamples.playbackState.payload,
      rev: 8,
      status: "waiting" as const,
    };
    socket().receive({ type: "playback:state", payload: waiting });
    socket().receive(serverExamples.playbackHold); // rev 8
    expect(state().hold).toEqual({
      waitingFor: ["peer-petya"],
      reason: "buffering",
      deadline: 1_008_000,
    });
    socket().receive({
      type: "playback:state",
      payload: { ...waiting, rev: 9, status: "playing" },
    });
    expect(state().hold).toBeNull();
    socket().receive(serverExamples.playbackHold); // опоздал: rev 8
    expect(state().hold).toBeNull();
  });

  it("leaveRoom шлёт room:leave и забывает комнату", () => {
    connect();
    joinExample();
    engine.handle({ type: "leaveRoom" });
    expect(socket().ofType("room:leave")).toHaveLength(1);
    expect(state().room).toBeNull();
    expect(state().playback).toBeNull();
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    expect(socket().ofType("room:join")).toHaveLength(0); // токен забыт
  });

  it("выход до ответа на вход: опоздавший room:state не возвращает в комнату", () => {
    connect();
    engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Петя" });
    engine.handle({ type: "leaveRoom" });
    expect(socket().ofType("room:leave")).toHaveLength(1);
    socket().receive(serverExamples.roomState);
    expect(state().room).toBeNull();
  });

  it("выход во время возвращения по токену: ответ на возвращение пропускается", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({ type: "player:media", media: media() });
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open(); // ушёл room:join с токеном
    engine.handle({ type: "leaveRoom" });
    socket().receive(serverExamples.roomState); // ответ на возвращение
    expect(state().room).toBeNull();
    answerPings(); // связь есть: уходит отложенный room:leave
    expect(socket().ofType("room:leave")).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(socket().ofType("presence:update")).toHaveLength(0);
  });

  it("несколько брошенных входов подряд: все их ответы пропускаются", () => {
    connect();
    joinExample();
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    answerPings();
    engine.handle({ type: "leaveRoom" }); // бросили возвращение
    engine.handle({ type: "createRoom", name: "Петя" });
    engine.handle({ type: "leaveRoom" }); // и новый вход
    expect(socket().ofType("room:leave")).toHaveLength(2);
    socket().receive({
      type: "error",
      payload: { code: "room_not_found", message: "Room not found" },
    });
    socket().receive(serverExamples.roomState);
    expect(state().room).toBeNull();
    expect(posted.some((m) => m.type === "error")).toBe(false);
    // а ответ на свежий вход уже настоящий
    engine.handle({ type: "createRoom", name: "Петя" });
    socket().receive(serverExamples.roomState);
    expect(state().room?.you).toBe("peer-petya");
  });

  it("обрыв после выхода: ответов старого сокета больше не ждём", () => {
    connect();
    engine.handle({ type: "createRoom", name: "Петя" });
    engine.handle({ type: "leaveRoom" }); // ответ на вход уже не нужен…
    socket().drop(); // …и не придёт
    vi.advanceTimersByTime(375);
    socket().open();
    answerPings();
    engine.handle({ type: "createRoom", name: "Петя" });
    socket().receive(serverExamples.roomState);
    expect(state().room?.you).toBe("peer-petya");
  });

  it("not_joined, пока мы в комнате: верим серверу и выходим из неё", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({ type: "player:media", media: media() });
    const notJoined = {
      code: "not_joined" as const,
      message: "Join a room first",
    };
    socket().receive({ type: "error", payload: notJoined });
    expect(state().room).toBeNull();
    expect(posted).toContainEqual({ type: "error", error: notJoined });
    const reports = socket().ofType("presence:update").length;
    vi.advanceTimersByTime(3_000);
    expect(socket().ofType("presence:update")).toHaveLength(reports);
  });

  it("not_joined во время возвращения по токену комнату не трогает", () => {
    connect();
    joinExample();
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    socket().receive({
      type: "error",
      payload: { code: "not_joined", message: "Join a room first" },
    });
    expect(state().room?.roomId).toBe("k7f3q");
  });

  it("выход, пока вход ещё в очереди, ничего не шлёт", () => {
    engine.handle({ type: "connect", url: "ws://test/ws" });
    engine.handle({ type: "joinRoom", roomId: "k7f3q", name: "Петя" });
    engine.handle({ type: "leaveRoom" });
    socket().open();
    answerPings();
    expect(socket().ofType("room:join")).toHaveLength(0);
    expect(socket().ofType("room:leave")).toHaveLength(0);
  });

  it("комнату закрыли, пока нас не было: ошибка и выход из комнаты", () => {
    connect();
    joinExample();
    socket().drop();
    vi.advanceTimersByTime(375);
    socket().open();
    socket().receive({
      type: "error",
      payload: { code: "room_not_found", message: "Room not found" },
    });
    expect(state().room).toBeNull();
    expect(posted.filter((m) => m.type === "error")).toHaveLength(1);
  });

  it("намерения и источник уходят на сервер", () => {
    connect();
    joinExample();
    engine.handle({
      type: "intent",
      intent: { action: "seek", positionMs: 5_000 },
    });
    engine.handle({
      type: "proposeSource",
      offer: serverExamples.sourceState.payload.source,
    });
    engine.handle({ type: "reportSourceMatch", sourceRev: 3, ok: true });
    expect(socket().sent.map((m) => m.type)).toEqual(
      expect.arrayContaining([
        "playback:intent",
        "source:propose",
        "source:matched",
      ]),
    );
    expect(socket().ofType("source:matched")[0].payload).toEqual({
      sourceRev: 3,
      ok: true,
    });
  });
});

describe("SyncEngine: плеер", () => {
  it("команду шлёт только после калибровки часов", () => {
    engine.handle({ type: "connect", url: "ws://test/ws" });
    engine.handle({ type: "player:attach" });
    socket().open();
    answerPings(); // по одному замеру
    joinExample();
    expect(commands()).toEqual([]);
    calibrate();
    expect(commands()).toEqual([{ kind: "pause", rev: 0, positionMs: 0 }]);
  });

  it("waiting — prepare, playing — play с моментом по часам страницы", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    socket().receive({
      type: "playback:state",
      payload: { ...playing(3_000, 0), rev: 1, status: "waiting" },
    });
    // якорь через 500 мс по часам сервера
    const anchor = now() + SERVER + 500;
    socket().receive({
      type: "playback:state",
      payload: playing(3_000, anchor),
    });
    expect(commands().slice(-2)).toEqual([
      { kind: "prepare", rev: 1, positionMs: 3_000 },
      {
        kind: "play",
        rev: 5,
        positionMs: 3_000,
        atMain: now() + PAGE + 500,
        rate: 1,
        leadMs: 40,
      },
    ]);
  });

  it("одну ревизию не повторяет, а снимок и reload присылают команду заново", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    socket().receive(serverExamples.playbackStateInitial);
    expect(commands()).toHaveLength(1);
    engine.handle({ type: "player:reload" });
    expect(commands()).toHaveLength(2);
    socket().receive({
      ...serverExamples.roomState,
      payload: {
        ...serverExamples.roomState.payload,
        playback: serverExamples.playbackStateInitial.payload,
      },
    });
    expect(commands()).toHaveLength(3);
  });

  it("отчёт о готовности: раз в секунду, после подтверждения и при смене плеера", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    expect(socket().ofType("presence:update")).toHaveLength(0); // без отчёта плеера не шлём
    engine.handle({ type: "player:media", media: media() });
    const reports = () => socket().ofType("presence:update");
    expect(reports()).toHaveLength(1);
    expect(reports()[0].payload).toMatchObject({
      readyState: 4,
      hasSource: true,
      playerState: "paused",
      appliedRev: -1,
      deviationMs: 0, // стоим там же, где комната
    });
    engine.handle({ type: "player:applied", rev: 0 });
    expect(reports()[1].payload.appliedRev).toBe(0);
    engine.handle({ type: "player:applied", rev: 99 }); // не та ревизия
    expect(reports()).toHaveLength(2);
    engine.handle({ type: "player:media", media: media({ positionMs: 10 }) });
    expect(reports()).toHaveLength(2); // состояние то же — ждём секунду
    vi.advanceTimersByTime(1_000);
    expect(reports()).toHaveLength(3);
    engine.handle({
      type: "player:media",
      media: media({ playerState: "seeking" }),
    });
    expect(reports()).toHaveLength(4);
  });

  it("файл пропал — подтверждение сбрасывается до новой загрузки", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({ type: "player:media", media: media() });
    engine.handle({ type: "player:applied", rev: 0 });
    engine.handle({
      type: "player:media",
      media: media({ hasSource: false, readyState: 0 }),
    });
    const reports = socket().ofType("presence:update");
    expect(reports[reports.length - 1].payload).toMatchObject({
      hasSource: false,
      appliedRev: -1,
    });
  });

  it("в игре сообщает отклонение по отчёту плеера, а сам отчёт ничего не перематывает", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    const anchor = now() + SERVER + 200;
    socket().receive({ type: "playback:state", payload: playing(0, anchor) });
    vi.advanceTimersByTime(3_500); // прошло 3,3 с игры
    const atMain = now() + PAGE;
    const last = () => socket().ofType("presence:update").pop()?.payload;
    // плеер показывает 3,2 с вместо 3,3 — отстаёт на 100 мс
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing", positionMs: 3_200, atMain }),
    });
    expect(last()).toMatchObject({
      deviationMs: 100,
      deviationAt: now() + SERVER,
    });
    // отстал на 2,3 с: в отчёте честно, а перематывает только контур по кадрам
    engine.handle({
      type: "player:media",
      media: media({ playerState: "buffering", positionMs: 1_000, atMain }),
    });
    expect(last()?.deviationMs).toBe(2_300);
    expect(commands().some((c) => c.kind === "seek")).toBe(false);
  });

  it("без файла и с несовпавшим файлом отклонение null", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    const anchor = now() + SERVER + 200;
    socket().receive({ type: "playback:state", payload: playing(0, anchor) });
    vi.advanceTimersByTime(3_500); // комната на 3,3 с
    const last = () => socket().ofType("presence:update").pop()?.payload;
    const atMain = now() + PAGE;
    const report = (changes: Partial<MediaReport>) =>
      engine.handle({
        type: "player:media",
        media: media({ playerState: "playing", atMain, ...changes }),
      });
    report({ hasSource: false, positionMs: 0 });
    expect(last()?.deviationMs).toBeNull();
    expect(commands().some((c) => c.kind === "seek")).toBe(false);
    // файл есть, но сверка с источником комнаты не прошла
    const source = serverExamples.sourceState.payload.source;
    socket().receive({
      type: "source:state",
      payload: { source, checks: [{ peerId: "peer-petya", ok: false }] },
    });
    report({ positionMs: 3_200 });
    expect(last()?.deviationMs).toBeNull();
    // моя сверка прошла (чужая неудача не в счёт) — сравнивать есть с чем
    socket().receive({
      type: "source:state",
      payload: {
        source,
        checks: [
          { peerId: "peer-anya", ok: false },
          { peerId: "peer-petya", ok: true },
        ],
      },
    });
    vi.advanceTimersByTime(1_000);
    expect(last()?.deviationMs).toBe(100);
  });

  it("на паузе, при подготовке и до старта отклонение честное", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample(); // пауза на 0
    const last = () => socket().ofType("presence:update").pop()?.payload;
    engine.handle({
      type: "player:media",
      media: media({ positionMs: 12 }),
    });
    expect(last()?.deviationMs).toBe(-12); // чуть впереди комнаты
    // комната готовится к 3 с, а плеер ещё перематывается с 1 с
    socket().receive({
      type: "playback:state",
      payload: { ...playing(3_000, 0), rev: 1, status: "waiting" },
    });
    engine.handle({
      type: "player:media",
      media: media({ playerState: "seeking", positionMs: 1_000 }),
    });
    expect(last()?.deviationMs).toBe(2_000);
    // старт через 5 с: до него комната стоит на 3 с, как и плеер
    socket().receive({
      type: "playback:state",
      payload: playing(3_000, now() + SERVER + 5_000),
    });
    engine.handle({
      type: "player:media",
      media: media({ positionMs: 3_000 }),
    });
    expect(last()?.deviationMs).toBe(0);
  });

  it("старый отчёт: отклонение уходит с моментом замера", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    const anchor = now() + SERVER + 200;
    socket().receive({ type: "playback:state", payload: playing(0, anchor) });
    vi.advanceTimersByTime(3_500); // комната на 3,3 с
    // замер 2,1 с назад (вкладка подвисла): комната была на 1,2 с, плеер на 0
    const atMain = now() + PAGE - 2_100;
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing", positionMs: 0, atMain }),
    });
    expect(socket().ofType("presence:update").pop()?.payload).toMatchObject({
      deviationMs: 1_200,
      deviationAt: now() - 2_100 + SERVER,
    });
  });

  it("detach: без плеера команды не шлёт", () => {
    connect();
    engine.handle({ type: "player:attach" });
    engine.handle({ type: "player:detach" });
    joinExample();
    expect(commands()).toEqual([]);
  });
});

describe("SyncEngine: контур подстройки", () => {
  /** Когда комната проходит позицию 0, по часам воркера. */
  let anchorAt: number;
  /** Где комната сейчас, мс. */
  const roomNow = () => now() - anchorAt;

  /** Комната играет с нуля; старт и молчание контура после него позади. */
  function startPlaying(): void {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing" }),
    });
    anchorAt = now() + 200;
    socket().receive({
      type: "playback:state",
      payload: playing(0, anchorAt + SERVER),
    });
    vi.advanceTimersByTime(600);
  }

  /** Показан кадр: плеер отстаёт от комнаты на errorMs. */
  function frame(errorMs: number): void {
    engine.handle({
      type: "player:sample",
      positionMs: roomNow() - errorMs,
      atMain: now() + PAGE,
      frame: true,
    });
  }

  /** Кадры каждые 20 мс, пока контур не решит что-то сделать или не пройдёт ms. */
  function framesUntilDecision(errorMs: number, ms = 2_000): PlayerCommand[] {
    const before = commands().length;
    for (let t = 0; t < ms && commands().length === before; t += 20) {
      vi.advanceTimersByTime(20);
      frame(errorMs);
    }
    return commands().slice(before);
  }

  const lastPlay = () =>
    commands()
      .filter((c) => c.kind === "play")
      .pop() as Extract<PlayerCommand, { kind: "play" }>;

  it("отстаём на 100 мс — ускоряет плеер на 2 %, дальше не дёргает", () => {
    startPlaying();
    expect(framesUntilDecision(100)).toEqual([{ kind: "rate", rate: 1.02 }]);
    expect(framesUntilDecision(100, 1_000)).toEqual([]);
  });

  it("ушли на 900 мс — перематывает с опережением, скорость обычная", () => {
    startPlaying();
    expect(framesUntilDecision(900)).toEqual([
      { kind: "rate", rate: 1 },
      { kind: "seek", positionMs: roomNow() + 60 },
    ]);
    // это дело одного плеера: комната ничего не узнаёт
    expect(socket().ofType("playback:intent")).toEqual([]);
  });

  it("замеры первых 100 мс после старта не в счёт: плеер ещё трогается", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing" }),
    });
    anchorAt = now() + 200;
    socket().receive({
      type: "playback:state",
      payload: playing(0, anchorAt + SERVER),
    });
    vi.advanceTimersByTime(200); // старт
    const before = commands().length;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20);
      frame(900); // головка ещё стоит
    }
    vi.advanceTimersByTime(200); // контур отмолчал
    framesUntilDecision(900, 40);
    // в счёт пошли только три последних кадра, решать ещё не по чему
    expect(commands().slice(before)).toEqual([]);
  });

  it("пока плеер перематывается, замеры не в счёт, а накопленные сброшены", () => {
    startPlaying();
    const before = commands().length;
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20);
      frame(900); // набралось на решение…
    }
    // …но плеер начал перематываться: накопленное больше не в счёт
    engine.handle({
      type: "player:media",
      media: media({ playerState: "seeking" }),
    });
    framesUntilDecision(900, 300); // пока перематывается, кадры не в счёт
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing" }),
    });
    framesUntilDecision(0, 400); // перемотался туда, где комната
    expect(commands().slice(before)).toEqual([]);
    expect(framesUntilDecision(900).map((c) => c.kind)).toEqual([
      "rate",
      "seek",
    ]);
  });

  it("вкладка вернулась на экран — секунду не измеряет", () => {
    startPlaying();
    engine.handle({ type: "player:visible" });
    expect(framesUntilDecision(900, 900)).toEqual([]);
    expect(framesUntilDecision(900).map((c) => c.kind)).toEqual([
      "rate",
      "seek",
    ]);
  });

  it("новая команда комнаты сначала возвращает обычную скорость", () => {
    startPlaying();
    framesUntilDecision(100); // скорость 1.02
    socket().receive({
      type: "playback:state",
      payload: { ...playing(5_000, 0), rev: 6, status: "paused" },
    });
    expect(commands().slice(-2)).toEqual([
      { kind: "rate", rate: 1 },
      { kind: "pause", rev: 6, positionMs: 5_000 },
    ]);
  });

  it("кадров нет — сам спрашивает позицию раз в 100 мс", () => {
    startPlaying();
    const before = sampleRequests();
    vi.advanceTimersByTime(300);
    expect(sampleRequests() - before).toBe(3);
    frame(0); // пошли кадры — спрашивать незачем
    const after = sampleRequests();
    vi.advanceTimersByTime(400);
    expect(sampleRequests()).toBe(after);
    // файла нет — и спрашивать, и подстраивать нечего
    engine.handle({
      type: "player:media",
      media: media({ playerState: "paused", hasSource: false }),
    });
    const noFile = sampleRequests();
    vi.advanceTimersByTime(1_000);
    expect(sampleRequests()).toBe(noFile);
  });

  it("опережение старта подбирает по первому замеру после старта", () => {
    startPlaying();
    expect(lastPlay().leadMs).toBe(40);
    framesUntilDecision(60); // тронулись на 60 мс позже комнаты
    socket().receive({
      type: "playback:state",
      payload: { ...playing(0, now() + SERVER + 200), rev: 6 },
    });
    expect(lastPlay().leadMs).toBe(70); // поправка на половину промаха
  });

  it("в Safari только перемотки: скорость не трогает", () => {
    engine.handle({ type: "dispose" });
    engine = makeEngine(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    );
    startPlaying();
    expect(framesUntilDecision(100, 1_000)).toEqual([]);
    expect(framesUntilDecision(200).map((c) => c.kind)).toEqual([
      "rate",
      "seek",
    ]);
    expect(commands().filter((c) => c.kind === "rate")).toEqual([
      { kind: "rate", rate: 1 },
    ]);
  });

  it("поздний вход: комната не останавливается, плеер стартует с её позиции", () => {
    connect();
    engine.handle({ type: "player:attach" });
    // комната играет уже 5 с
    joinExample(playing(0, now() + SERVER - 5_000));
    expect(commands()).toEqual([
      {
        kind: "play",
        rev: 5,
        positionMs: 5_150,
        atMain: now() + PAGE + 150,
        rate: 1,
        leadMs: 40,
      },
    ]);
    expect(socket().ofType("playback:intent")).toEqual([]);
  });

  it("скорость контура — поправка к скорости комнаты", () => {
    connect();
    engine.handle({ type: "player:attach" });
    joinExample();
    engine.handle({
      type: "player:media",
      media: media({ playerState: "playing" }),
    });
    anchorAt = now() + 200;
    socket().receive({
      type: "playback:state",
      payload: { ...playing(0, anchorAt + SERVER), rate: 2 },
    });
    vi.advanceTimersByTime(600);
    // при скорости 2 комната идёт вдвое быстрее
    const before = commands().length;
    for (let t = 0; t < 2_000 && commands().length === before; t += 20) {
      vi.advanceTimersByTime(20);
      engine.handle({
        type: "player:sample",
        positionMs: 2 * roomNow() - 100,
        atMain: now() + PAGE,
        frame: true,
      });
    }
    expect(commands().slice(before)).toEqual([{ kind: "rate", rate: 2.04 }]);
  });
});
