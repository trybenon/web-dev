import { describe, expect, it } from "vitest";
import { Room, type Outbound } from "./room.js";
import {
  clientExamples,
  ServerMessageSchema,
  type Presence,
} from "@watch-together/shared";

/** Типы сообщений по порядку — так проще сравнивать. */
const types = (out: Outbound[]): string[] => out.map((o) => o.msg.type);

/**
 * Комната для тестов. Каждое сообщение, которое вернул её метод,
 * проверяется схемой протокола: не прошло — тест падает с разбором zod.
 */
function newRoom(now = 0): Room {
  return new Proxy(new Room("r", now), {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        for (const item of [result].flat()) {
          if (isOutbound(item)) ServerMessageSchema.parse(item.msg);
        }
        return result;
      };
    },
  });
}

function isOutbound(item: unknown): item is Outbound {
  return typeof item === "object" && item !== null && "msg" in item;
}

/** Комната с участниками p1…pn, создана в момент 0. */
function roomWith(n: number): Room {
  const room = newRoom();
  for (let i = 1; i <= n; i++) room.join(`p${i}`, `P${i}`, `token-${i}`);
  return room;
}

/** Отчёт «готов к ревизии rev»: файл есть, буфера с запасом. */
function ready(rev: number, extra: Partial<Presence> = {}): Presence {
  return {
    readyState: 4,
    bufferedAheadMs: 5_000,
    playerState: "paused",
    hasSource: true,
    deviationMs: 0,
    deviationAt: 0,
    appliedRev: rev,
    rttMs: 0,
    ...extra,
  };
}

const offer = clientExamples.sourcePropose.payload;

describe("Room: начальное состояние", () => {
  it("новая комната на паузе в начале, якорь - момент создания", () => {
    const room = newRoom(1_000);
    expect(room.playback).toEqual({
      rev: 0,
      status: "paused",
      positionMs: 0,
      anchorServerTime: 1_000,
      rate: 1,
      setBy: null,
    });
  });
  it("playback отдает копию, снаружи состояние не поменять", () => {
    const room = newRoom(0);
    room.playback.positionMs = 99;
    expect(room.playback.positionMs).toBe(0);
  });
  it("на паузе позиция стоит", () => {
    expect(newRoom(0).positionAt(60_000)).toBe(0);
  });
});

describe("Room: вход и выход", () => {
  it("новичок получает снимок, остальные — уведомление", () => {
    const room = newRoom(0);
    room.join("a", "Аня", "token-a");
    const out = room.join("b", "Боря", "token-b");
    expect(types(out)).toEqual(["room:state", "room:peer_joined"]);
    expect(out[0]).toMatchObject({
      to: "b",
      msg: {
        payload: {
          roomId: "r",
          you: "b",
          sessionToken: "token-b",
          peers: [
            { peerId: "a", name: "Аня", connection: "online" },
            { peerId: "b", name: "Боря", connection: "online" },
          ],
          source: null,
        },
      },
    });
    expect(out[1]).toMatchObject({
      to: "all",
      except: "b",
      msg: { payload: { peer: { peerId: "b", name: "Боря" } } },
    });
    expect(room.size).toBe(2);
  });

  it("повторный вход игнорируется", () => {
    expect(roomWith(1).join("p1", "P1", "token-1")).toEqual([]);
  });

  it("пятый участник получает room_full", () => {
    const room = roomWith(4);
    const out = room.join("p5", "P5", "token-5");
    expect(out).toMatchObject([
      { to: "p5", msg: { type: "error", payload: { code: "room_full" } } },
    ]);
    expect(room.size).toBe(4);
  });

  it("выход: всем room:peer_left; выход незнакомца — пустой список", () => {
    const room = roomWith(2);
    expect(room.leave("p2", 0)).toMatchObject([
      { to: "all", msg: { type: "room:peer_left", payload: { peerId: "p2" } } },
    ]);
    expect(room.size).toBe(1);
    expect(room.leave("x", 0)).toEqual([]);
  });
});

describe("Room: намерения", () => {
  it("намерение не участника — not_joined", () => {
    const out = newRoom(0).intent("x", { action: "play" }, 0);
    expect(out).toMatchObject([
      { to: "x", msg: { type: "error", payload: { code: "not_joined" } } },
    ]);
  });

  it("если файла нет ни у кого, запуск без ожидания: waiting, потом playing", () => {
    const room = roomWith(2);
    const out = room.intent("p1", { action: "play" }, 1_000);
    expect(types(out)).toEqual(["playback:state", "playback:state"]);
    expect(out).toMatchObject([
      { msg: { payload: { rev: 1, status: "waiting" } } },
      { msg: { payload: { rev: 2, status: "playing" } } },
    ]);
    // якорь не раньше чем через 300 мс
    expect(room.playback).toMatchObject({
      anchorServerTime: 1_300,
      setBy: "p1",
    });
  });

  it("пауза во время игры запоминает позицию по якорю", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0); // якорь 300
    expect(room.positionAt(1_300)).toBe(1_000);
    room.intent("p1", { action: "pause" }, 1_300);
    expect(room.playback).toMatchObject({
      status: "paused",
      positionMs: 1_000,
      anchorServerTime: 1_300,
    });
  });

  it("до якоря позиция стоит", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0);
    expect(room.positionAt(100)).toBe(0);
  });

  it("перемотка на паузе просто сдвигает позицию", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "seek", positionMs: 5_000 }, 0);
    expect(room.playback).toMatchObject({
      rev: 1,
      status: "paused",
      positionMs: 5_000,
    });
  });

  it("повторные play и pause ничего не меняют", () => {
    const room = roomWith(1);
    expect(room.intent("p1", { action: "pause" }, 0)).toEqual([]);
    room.intent("p1", { action: "play" }, 1_000);
    expect(room.intent("p1", { action: "play" }, 2_000)).toEqual([]);
  });

  it("каждое изменение увеличивает rev", () => {
    const room = roomWith(1);
    const revs = [room.playback.rev];
    room.intent("p1", { action: "seek", positionMs: 100 }, 0);
    revs.push(room.playback.rev);
    room.intent("p1", { action: "play" }, 1_000);
    revs.push(room.playback.rev);
    expect(revs).toEqual([0, 1, 3]); // play: waiting (2) → playing (3)
  });

  it("вход посреди просмотра не трогает воспроизведение", () => {
    const room = roomWith(1);
    room.intent("p1", { action: "play" }, 0);
    const before = room.playback;
    room.join("p2", "P2", "token-2");
    expect(room.playback).toEqual(before);
  });
});

describe("Room: барьер готовности", () => {
  it("ждёт всех с файлом; старое «готов» до перемотки не засчитывается", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    room.presence("p2", ready(0), 0);
    const out = room.intent("p1", { action: "play" }, 1_000);
    expect(types(out)).toEqual(["playback:state", "playback:hold"]);
    const waitRev = room.playback.rev;
    expect(out[1]).toMatchObject({
      msg: {
        payload: {
          rev: waitRev,
          waitingFor: ["p1", "p2"],
          reason: "buffering",
          deadline: 11_000,
        },
      },
    });

    // отчёт с прошлой ревизией не отпускает барьер
    expect(room.presence("p1", ready(waitRev - 1), 1_100)).toEqual([]);
    // p1 готов к новой ревизии: ждём только p2, и все об этом узнают
    expect(room.presence("p1", ready(waitRev), 1_200)).toMatchObject([
      { msg: { type: "playback:hold", payload: { waitingFor: ["p2"] } } },
    ]);
    // мало буфера — ещё не готов
    const thin = ready(waitRev, { bufferedAheadMs: 500 });
    expect(room.presence("p2", thin, 1_300)).toEqual([]);

    const out2 = room.presence("p2", ready(waitRev, { rttMs: 250 }), 1_400);
    expect(types(out2)).toEqual(["playback:state"]);
    // якорь: наибольший RTT + 200 мс, но не меньше 300
    expect(room.playback).toMatchObject({
      status: "playing",
      anchorServerTime: 1_400 + 450,
      setBy: "p1",
    });
  });

  it("по дедлайну стартует без отставших", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    room.presence("p2", ready(0), 0);
    room.intent("p1", { action: "play" }, 1_000);
    expect(room.tick(5_000)).toEqual([]);
    const out = room.tick(1_000 + room.config.barrierTimeoutMs);
    expect(types(out)).toEqual(["playback:state"]);
    expect(room.playback.status).toBe("playing");
    expect(room.tick(99_999)).toEqual([]);
  });

  it("выход участника, которого ждали, отпускает барьер", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    room.presence("p2", ready(0), 0);
    room.intent("p1", { action: "play" }, 1_000);
    room.presence("p1", ready(room.playback.rev), 1_100);
    const out = room.leave("p2", 1_200);
    expect(types(out)).toEqual(["room:peer_left", "playback:state"]);
    expect(room.playback.status).toBe("playing");
  });

  it("наблюдатель без файла комнату не держит", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    room.presence("p2", ready(0, { hasSource: false }), 0);
    room.intent("p1", { action: "play" }, 0);
    expect(room.waitingFor).toEqual(["p1"]);
  });

  it("отчёт незнакомца игнорируется", () => {
    expect(newRoom(0).presence("x", ready(0), 0)).toEqual([]);
  });

  it("пауза во время ожидания снимает барьер и оставляет позицию", () => {
    const room = roomWith(1);
    room.presence("p1", ready(0), 0);
    room.intent("p1", { action: "seek", positionMs: 5_000 }, 0);
    room.intent("p1", { action: "play" }, 1_000);
    expect(room.playback.status).toBe("waiting");
    room.intent("p1", { action: "pause" }, 2_000);
    expect(room.playback).toMatchObject({
      status: "paused",
      positionMs: 5_000,
    });
    expect(room.waitingFor).toEqual([]);
  });

  it("перемотка во время игры проходит через барьер", () => {
    const room = roomWith(1);
    room.presence("p1", ready(0), 0);
    room.intent("p1", { action: "play" }, 0);
    room.presence("p1", ready(room.playback.rev), 100);
    expect(room.playback.status).toBe("playing");
    const out = room.intent(
      "p1",
      { action: "seek", positionMs: 60_000 },
      1_000,
    );
    expect(types(out)).toEqual(["playback:state", "playback:hold"]);
    expect(out[1]).toMatchObject({ msg: { payload: { reason: "seeking" } } });
    expect(room.playback).toMatchObject({
      status: "waiting",
      positionMs: 60_000,
    });
  });

  it("presenceSync рассылает всех; кто не отчитался — с пустым отчётом", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    expect(room.presenceSync()).toMatchObject({
      to: "all",
      msg: {
        type: "presence:sync",
        payload: {
          peers: [
            { peerId: "p1", connection: "online", hasSource: true },
            {
              peerId: "p2",
              connection: "online",
              hasSource: false,
              appliedRev: -1,
              deviationMs: null,
            },
          ],
        },
      },
    });
  });
});

describe("Room: источник", () => {
  it("смена источника: номер растёт, сверки сброшены, пауза в начале", () => {
    const room = roomWith(2);
    room.intent("p1", { action: "play" }, 0);
    room.matchSource("p2", 0, true); // источника ещё нет — отброшено

    const out = room.proposeSource("p1", offer, 1_000);
    expect(types(out)).toEqual(["source:state", "playback:state"]);
    expect(out[0]).toMatchObject({
      to: "all",
      msg: {
        payload: { source: { rev: 1, proposedBy: "p1" }, checks: [] },
      },
    });
    expect(room.playback).toMatchObject({
      status: "paused",
      positionMs: 0,
      setBy: "p1",
    });
    expect(types(room.proposeSource("p2", offer, 2_000))).toEqual([
      "source:state",
      "playback:state",
    ]);
  });

  it("сверка только для текущего номера; повторная заменяет прежнюю", () => {
    const room = roomWith(2);
    room.proposeSource("p1", offer, 0);
    room.proposeSource("p1", offer, 0); // теперь номер 2
    expect(room.matchSource("p2", 1, true)).toEqual([]);
    room.matchSource("p2", 2, false);
    const out = room.matchSource("p2", 2, true);
    expect(out).toMatchObject([
      { msg: { payload: { checks: [{ peerId: "p2", ok: true }] } } },
    ]);
  });

  it("источник от незнакомца — not_joined", () => {
    const room = newRoom(0);
    expect(types(room.proposeSource("x", offer, 0))).toEqual(["error"]);
    expect(types(room.matchSource("x", 1, true))).toEqual(["error"]);
  });

  it("новичок получает сверки отдельным source:state", () => {
    const room = roomWith(1);
    room.proposeSource("p1", offer, 0);
    room.matchSource("p1", 1, true);
    const out = room.join("p2", "P2", "token-2");
    expect(types(out)).toEqual([
      "room:state",
      "source:state",
      "room:peer_joined",
    ]);
    expect(out[1]).toMatchObject({
      to: "p2",
      msg: { payload: { checks: [{ peerId: "p1", ok: true }] } },
    });
  });

  it("после выхода участника его сверки нет у новичка", () => {
    const room = roomWith(2);
    room.proposeSource("p1", offer, 0);
    room.matchSource("p1", 1, true);
    room.matchSource("p2", 1, true);
    room.leave("p2", 0);
    const out = room.join("p3", "P3", "token-3");
    expect(out[1]).toMatchObject({
      to: "p3",
      msg: {
        type: "source:state",
        payload: { checks: [{ peerId: "p1", ok: true }] },
      },
    });
  });

  it("перемотка на паузе не уходит дальше конца фильма", () => {
    const room = roomWith(1);
    room.proposeSource("p1", { ...offer, durationMs: 60_000 }, 0);
    room.intent("p1", { action: "seek", positionMs: 120_000 }, 1_000);
    expect(room.playback).toMatchObject({
      status: "paused",
      positionMs: 60_000,
    });
  });

  it("перемотка во время игры тоже упирается в конец фильма", () => {
    const room = roomWith(1);
    room.proposeSource("p1", { ...offer, durationMs: 60_000 }, 0);
    room.intent("p1", { action: "play" }, 0);
    expect(room.playback.status).toBe("playing");
    room.intent("p1", { action: "seek", positionMs: 120_000 }, 1_000);
    expect(room.playback.positionMs).toBe(60_000);
  });

  it("пауза после конца фильма ставит головку на конец", () => {
    const room = roomWith(1);
    room.proposeSource("p1", { ...offer, durationMs: 60_000 }, 0);
    room.intent("p1", { action: "play" }, 0);
    room.intent("p1", { action: "pause" }, 90_000);
    expect(room.playback.positionMs).toBe(60_000);
  });

  it("у конца ролика не требует буфера больше оставшегося", () => {
    const room = roomWith(1);
    room.proposeSource("p1", { ...offer, durationMs: 60_000 }, 0);
    room.presence("p1", ready(room.playback.rev), 0);
    room.intent("p1", { action: "seek", positionMs: 59_000 }, 0);
    room.intent("p1", { action: "play" }, 0);
    // до конца 1 с: 900 мс в буфере хватает, хотя порог — 2 с
    const near = ready(room.playback.rev, { bufferedAheadMs: 900 });
    expect(types(room.presence("p1", near, 100))).toEqual(["playback:state"]);
    expect(room.playback.status).toBe("playing");
  });
});

describe("Room: обрыв связи", () => {
  it("обрыв: место держим, статус reconnecting, барьер больше не ждёт", () => {
    const room = roomWith(2);
    room.presence("p1", ready(0), 0);
    room.presence("p2", ready(0), 0);
    room.intent("p1", { action: "play" }, 1_000);
    room.presence("p1", ready(room.playback.rev), 1_100);

    const out = room.disconnect("p2", 1_200);
    expect(types(out)).toEqual(["presence:sync", "playback:state"]);
    expect(out[0]).toMatchObject({
      msg: {
        payload: { peers: [{}, { peerId: "p2", connection: "reconnecting" }] },
      },
    });
    expect(room.size).toBe(2);
    expect(room.playback.status).toBe("playing");
  });

  it("возвращение: снова online и свежий снимок с тем же токеном", () => {
    const room = roomWith(2);
    room.disconnect("p2", 0);
    const out = room.reconnect("p2");
    expect(types(out)).toEqual(["room:state", "presence:sync"]);
    expect(out[0]).toMatchObject({
      to: "p2",
      msg: {
        payload: {
          you: "p2",
          sessionToken: "token-2",
          peers: [{}, { peerId: "p2", connection: "online" }],
        },
      },
    });
  });

  it("обрыв и возвращение до первого отчёта видны остальным", () => {
    const room = roomWith(2);
    expect(room.disconnect("p2", 0)).toMatchObject([
      {
        to: "all",
        msg: {
          type: "presence:sync",
          payload: {
            peers: [
              { peerId: "p1" },
              { peerId: "p2", connection: "reconnecting" },
            ],
          },
        },
      },
    ]);
    const back = room.reconnect("p2");
    expect(back[1]).toMatchObject({
      to: "all",
      msg: { payload: { peers: [{}, { peerId: "p2", connection: "online" }] } },
    });
  });

  it("повторный обрыв и обрыв незнакомца ничего не делают", () => {
    const room = roomWith(1);
    room.disconnect("p1", 0);
    expect(room.disconnect("p1", 0)).toEqual([]);
    expect(room.disconnect("x", 0)).toEqual([]);
    expect(room.reconnect("x")).toEqual([]);
  });
});

describe("Room: снимок во время ожидания", () => {
  it.each(["join", "reconnect"] as const)(
    "%s передаёт текущее удержание лично, после состояния и источника",
    (operation) => {
      const room = roomWith(1);
      room.proposeSource("p1", offer, 0);
      room.presence("p1", ready(0), 0);
      const started = room.intent("p1", { action: "play" }, 1_000);
      const hold = started.find((item) => item.msg.type === "playback:hold");
      if (!hold) throw new Error("Expected hold");
      const before = room.playback;
      const waitingFor = room.waitingFor;

      const out =
        operation === "join"
          ? room.join("p2", "P2", "token-2")
          : room.reconnect("p1");
      const recipient = operation === "join" ? "p2" : "p1";
      const personal = out.filter((item) => item.to === recipient);

      expect(types(personal)).toEqual([
        "room:state",
        "source:state",
        "playback:hold",
      ]);
      expect(personal[2]).toEqual({ to: recipient, msg: hold.msg });
      expect(
        out.some(
          (item) => item.to === "all" && item.msg.type === "playback:hold",
        ),
      ).toBe(false);
      expect(room.playback).toEqual(before);
      expect(room.waitingFor).toEqual(waitingFor);
      // Дедлайн исходного удержания не сдвигается при получении снимка.
      expect(room.tick(10_999)).toEqual([]);
      expect(types(room.tick(11_000))).toEqual(["playback:state"]);
    },
  );
});
