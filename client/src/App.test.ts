// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import { createPinia, disposePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import {
  createPlayerBridge,
  createStubSyncClient,
  createSyncClient,
  STUB_ROOM_IDS,
} from "./sync";

vi.mock("./sync", async (importOriginal) => {
  const sync = await importOriginal<typeof import("./sync")>();
  return { ...sync, createSyncClient: vi.fn(), createPlayerBridge: vi.fn() };
});

const latencyMs = 10;
const unlock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const dispose = vi.fn();
let pinia: ReturnType<typeof createPinia>;
let unmountApp: (() => void) | undefined;

function mountApp(client = createStubSyncClient({ latencyMs })) {
  vi.mocked(createSyncClient).mockReturnValue(client);
  vi.mocked(createPlayerBridge).mockReturnValue({ unlock, dispose });
  const app = mount(App, { global: { plugins: [pinia, ElementPlus] } });
  unmountApp = () => app.unmount();
  return app;
}

async function submitName(app: ReturnType<typeof mountApp>, name: string) {
  await vi.advanceTimersByTimeAsync(latencyMs);
  await app.get('input[aria-label="Имя"]').setValue(name);
  await app.get("form").trigger("submit");
  await vi.advanceTimersByTimeAsync(latencyMs);
}

async function setVideoDuration(
  app: ReturnType<typeof mountApp>,
  duration: number,
) {
  const video = app.get("video");
  Object.defineProperty(video.element, "duration", {
    configurable: true,
    value: duration,
  });
  await video.trigger("durationchange");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  pinia = createPinia();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  unmountApp?.();
  unmountApp = undefined;
  disposePinia(pinia);
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("App", () => {
  it("unlocks the same video before creating a room", async () => {
    const client = createStubSyncClient({ latencyMs });
    const createRoom = vi.spyOn(client, "createRoom");
    const app = mountApp(client);
    const video = app.get("video");

    expect(app.get("h1").text()).toBe("Добро пожаловать!");
    expect(app.get(".room-view").attributes("style")).toContain(
      "display: none",
    );
    expect(createPlayerBridge).toHaveBeenCalledWith(client, video.element);

    await submitName(app, "Семён");

    expect(unlock).toHaveBeenCalledBefore(createRoom);
    expect(app.find("form").exists()).toBe(false);
    expect(app.get("video").element).toBe(video.element);
    expect(app.get(".room-view").attributes("style")).not.toContain(
      "display: none",
    );
  });

  it("sends play and pause commands from the player button", async () => {
    const holdMs = 10;
    const client = createStubSyncClient({ latencyMs, holdMs });
    const play = vi.spyOn(client, "play");
    const pause = vi.spyOn(client, "pause");
    const app = mountApp(client);
    await submitName(app, "Семён");

    await app.get('button[aria-label="Играть"]').trigger("click");
    expect(play).toHaveBeenCalledExactlyOnceWith();

    await vi.advanceTimersByTimeAsync(latencyMs + holdMs);
    await app.get('button[aria-label="Пауза"]').trigger("click");
    expect(pause).toHaveBeenCalledExactlyOnceWith();
  });

  it("toggles shared playback with Space", async () => {
    const holdMs = 10;
    const client = createStubSyncClient({ latencyMs, holdMs });
    const play = vi.spyOn(client, "play");
    const pause = vi.spyOn(client, "pause");
    const app = mountApp(client);
    await submitName(app, "Семён");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", cancelable: true }),
    );
    expect(play).toHaveBeenCalledExactlyOnceWith();

    await vi.advanceTimersByTimeAsync(latencyMs + holdMs);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", cancelable: true }),
    );
    expect(pause).toHaveBeenCalledExactlyOnceWith();
  });
  it("seeks forward and backward by 15 seconds", async () => {
    const client = createStubSyncClient({ latencyMs });
    const seek = vi.spyOn(client, "seek");
    const app = mountApp(client);
    await submitName(app, "Семён");
    await setVideoDuration(app, 60);

    await app.get('button[aria-label="Вперёд на 15 секунд"]').trigger("click");
    expect(seek).toHaveBeenNthCalledWith(1, 15_000);

    await vi.advanceTimersByTimeAsync(latencyMs);
    await app.get('button[aria-label="Назад на 15 секунд"]').trigger("click");
    expect(seek).toHaveBeenNthCalledWith(2, 0);
    expect(seek).toHaveBeenCalledTimes(2);
  });

  it("sends one seek command when the timeline change is committed", async () => {
    const client = createStubSyncClient({ latencyMs });
    const seek = vi.spyOn(client, "seek");
    const app = mountApp(client);
    await submitName(app, "Семён");
    await setVideoDuration(app, 60);

    const slider = app.get('input[aria-label="Позиция видео"]');
    const input = slider.element as HTMLInputElement;

    input.value = "5";
    await slider.trigger("input");
    input.value = "12.5";
    await slider.trigger("input");
    expect(seek).not.toHaveBeenCalled();

    await slider.trigger("change");
    expect(seek).toHaveBeenCalledExactlyOnceWith(12_500);
  });

  it("does not send room commands from native video events", async () => {
    const client = createStubSyncClient({ latencyMs });
    const play = vi.spyOn(client, "play");
    const pause = vi.spyOn(client, "pause");
    const seek = vi.spyOn(client, "seek");
    const app = mountApp(client);
    await submitName(app, "Семён");

    const video = app.get("video");
    for (const event of [
      "play",
      "pause",
      "seeking",
      "seeked",
      "timeupdate",
      "ended",
    ]) {
      await video.trigger(event);
    }

    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it("disposes the player bridge when the app is unmounted", async () => {
    const app = mountApp();
    await submitName(app, "Семён");
    expect(dispose).not.toHaveBeenCalled();

    app.unmount();
    unmountApp = undefined;

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shows the demo title and official source next to the video", async () => {
    const app = mountApp();
    expect(app.find('[aria-label="Демонстрационный ролик"]').exists()).toBe(
      false,
    );
    await submitName(app, "Семён");

    const attribution = app.get('[aria-label="Демонстрационный ролик"]');
    expect(attribution.text()).toContain("Grand Theft Auto VI Launch Trailer");
    expect(
      attribution
        .get('a[href="https://www.rockstargames.com/VI/launch-trailer"]')
        .text(),
    ).toBe("Rockstar Games");
  });

  it("skips the waiting notice when a seek completes in under 200 ms", async () => {
    window.history.replaceState(null, "", "/?room=test-room");
    const client = createStubSyncClient({ latencyMs, holdMs: 100 });
    const app = mountApp(client);
    const notice = () => app.find(".room-view-playback-notice");
    await submitName(app, "Семён");

    client.seek(5_000);
    await vi.advanceTimersByTimeAsync(latencyMs);
    expect(client.getState().hold?.waitingFor).toEqual(["peer-anya"]);
    expect(notice().exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(client.getState().hold).toBeNull();
    expect(notice().exists()).toBe(false);
  });

  it("shows one notice after 200 ms of waiting and removes it as soon as the wait ends", async () => {
    window.history.replaceState(null, "", "/?room=test-room");
    const client = createStubSyncClient({ latencyMs, holdMs: 300 });
    const app = mountApp(client);
    const notice = () => app.find(".room-view-playback-notice");
    await submitName(app, "Семён");

    client.seek(5_000);
    await vi.advanceTimersByTimeAsync(latencyMs + 199);
    expect(notice().exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(notice().text()).toContain("Ждём: Аня");

    await vi.advanceTimersByTimeAsync(100);
    expect(notice().exists()).toBe(false);

    client.seek(10_000);
    await vi.advanceTimersByTimeAsync(latencyMs + 200);
    expect(notice().text()).toContain("Ждём: Аня");
    client.pause();
    await vi.advanceTimersByTimeAsync(latencyMs);
    expect(
      app.findAll(".room-view-playback-notice").map((item) => item.text()),
    ).toEqual(["Семён поставил(а) паузу"]);

    client.play();
    await vi.advanceTimersByTimeAsync(latencyMs);
    expect(notice().exists()).toBe(false);
  });

  it("joins by invitation and shows all four participants in settings", async () => {
    window.history.replaceState(null, "", "/?room=test-room");
    const client = createStubSyncClient({ latencyMs });
    const subscribe = client.subscribe;
    vi.spyOn(client, "subscribe").mockImplementation((listener) =>
      subscribe((state) => {
        if (!state.room) {
          listener(state);
          return;
        }

        listener({
          ...state,
          room: {
            ...state.room,
            peers: [
              ...state.room.peers,
              {
                peerId: "third",
                name: "Борис",
                connection: "reconnecting",
                presence: null,
              },
              {
                peerId: "fourth",
                name: "Вера",
                connection: "online",
                presence: null,
              },
            ],
          },
        });
      }),
    );
    const joinRoom = vi.spyOn(client, "joinRoom");
    const app = mountApp(client);

    await submitName(app, "Семён");
    expect(joinRoom).toHaveBeenCalledWith("test-room", "Семён");
    await app.get('button[aria-label="Настройки"]').trigger("click");

    const settings = app.get('[aria-label="Настройки комнаты"]');
    const rows = settings.findAll("li");
    const names = rows.map((row) => row.get("span").text());

    expect(rows).toHaveLength(4);
    expect(names).toContain("Семён (вы)");
    expect(names).toContain("Вера");
    expect(
      rows[names.indexOf("Борис")]?.get(".participant-list-status").text(),
    ).toBe("Переподключается");
  });

  it.each([
    [STUB_ROOM_IDS.full, "Комната заполнена. В ней уже четыре участника."],
    [STUB_ROOM_IDS.missing, "Комната не найдена. Проверьте ссылку."],
  ])("shows the join error for room %s", async (roomId, message) => {
    window.history.replaceState(null, "", `/?room=${roomId}`);
    const app = mountApp();

    await submitName(app, "Семён");

    expect(app.get('[role="alert"]').text()).toBe(message);
    expect(app.find("form").exists()).toBe(true);
  });

  it("returns to room creation after leaving an invited room", async () => {
    window.history.replaceState(null, "", "/?room=test-room");
    const app = mountApp();

    await submitName(app, "Семён");
    await app.get('button[aria-label="Выйти из комнаты"]').trigger("click");
    await vi.advanceTimersByTimeAsync(latencyMs);

    expect(new URLSearchParams(window.location.search).has("room")).toBe(false);
    expect(app.get('button[type="submit"]').text()).toBe("Создать комнату");
    expect(app.get(".room-view").attributes("style")).toContain(
      "display: none",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shows a retry message when attempts are rate limited", async () => {
    window.history.replaceState(null, "", "/?room=test-room");
    const client = createStubSyncClient({ latencyMs });
    const onError = vi.spyOn(client, "onError");
    vi.spyOn(client, "joinRoom").mockImplementation(() => {
      const [listener] = onError.mock.calls[0];
      listener({ code: "rate_limited", message: "internal rate limit" });
    });
    const app = mountApp(client);

    await submitName(app, "Семён");

    expect(app.get('[role="alert"]').text()).toBe(
      "Слишком много попыток. Попробуйте чуть позже.",
    );
    expect(app.find("form").exists()).toBe(true);
  });
});
