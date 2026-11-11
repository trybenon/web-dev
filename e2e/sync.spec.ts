import { expect, test, type Page } from "@playwright/test";

/** Что страница проверки выставляет наружу (client/src/dev/sync-test.ts). */
interface SyncTestWindow {
  syncTest: {
    client: {
      getState(): {
        connection: string;
        room: { roomId: string; peers: unknown[] } | null;
        playback: { status: string } | null;
      };
    };
    video: HTMLVideoElement;
  };
}

/** Позиция видео и момент замера по общим для вкладок часам, мс. */
async function sample(page: Page): Promise<{ at: number; positionMs: number }> {
  return page.evaluate(() => {
    const { video } = (window as unknown as SyncTestWindow).syncTest;
    return {
      at: performance.timeOrigin + performance.now(),
      positionMs: video.currentTime * 1000,
    };
  });
}

/** Насколько b отстаёт от a: позиция a пересчитана на момент замера b. */
async function gapMs(a: Page, b: Page): Promise<number> {
  const first = await sample(a);
  const second = await sample(b);
  return first.positionMs + (second.at - first.at) - second.positionMs;
}

function state(page: Page) {
  return page.evaluate(() =>
    (window as unknown as SyncTestWindow).syncTest.client.getState(),
  );
}

function videoOf(page: Page) {
  return page.evaluate(() => {
    const { video } = (window as unknown as SyncTestWindow).syncTest;
    return { paused: video.paused, positionMs: video.currentTime * 1000 };
  });
}

test("две вкладки: общий старт, пауза и перемотка из любой", async ({
  browser,
  request,
}) => {
  // без файла Vite отвечает страницей приложения, поэтому смотрим на тип
  const demo = await request.head("/media/demo.webm");
  const isVideo = demo.headers()["content-type"]?.startsWith("video/");
  test.skip(!isVideo, "нужен деморолик client/public/media/demo.webm (#64)");

  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto("/sync-test.html");
  await b.goto("/sync-test.html");

  await a.getByRole("button", { name: "Создать комнату" }).click();
  await expect.poll(async () => (await state(a)).room?.roomId).toBeTruthy();
  const roomId = (await state(a)).room?.roomId ?? "";

  await b.getByLabel("id комнаты").fill(roomId);
  await b.getByRole("button", { name: "Войти" }).click();
  await expect.poll(async () => (await state(a)).room?.peers.length).toBe(2);

  // старт из первой вкладки
  await a.getByRole("button", { name: "Играть" }).click();
  for (const page of [a, b]) {
    await expect
      .poll(async () => (await videoOf(page)).positionMs, { timeout: 15_000 })
      .toBeGreaterThan(1_500);
  }
  expect(Math.abs(await gapMs(a, b))).toBeLessThan(150);

  // пауза из второй: обе встают на одну позицию
  await b.getByRole("button", { name: "Пауза" }).click();
  for (const page of [a, b]) {
    await expect.poll(async () => (await videoOf(page)).paused).toBe(true);
  }
  await expect
    .poll(async () => {
      const [first, second] = [await videoOf(a), await videoOf(b)];
      return Math.abs(first.positionMs - second.positionMs);
    })
    .toBeLessThan(50);

  // перемотка на паузе из второй доходит до первой
  const before = (await videoOf(a)).positionMs;
  await b.getByRole("button", { name: "+10 с" }).click();
  await expect
    .poll(async () => (await videoOf(a)).positionMs)
    .toBeGreaterThan(before + 9_000);

  // и снова вместе
  await a.getByRole("button", { name: "Играть" }).click();
  for (const page of [a, b]) {
    await expect.poll(async () => (await videoOf(page)).paused).toBe(false);
  }
  await a.waitForTimeout(1_000);
  expect(Math.abs(await gapMs(a, b))).toBeLessThan(150);

  await context.close();
});
