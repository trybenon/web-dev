/**
 * Синхронный просмотр целиком: три отдельных браузера против настоящего
 * сервера и собранного клиента (страница проверки client/sync-test.html,
 * собирается только для e2e). Деморолик — WebM из client/public/media.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

/** Что страница проверки выставляет наружу (client/src/dev/sync-test.ts). */
interface SyncTestWindow {
  syncTest: {
    client: {
      getState(): {
        connection: string;
        room: { roomId: string; peers: unknown[] } | null;
        playback: { status: string; rev: number } | null;
      };
      dispose(): void;
    };
    video: HTMLVideoElement;
  };
}

/** Позиция видео и момент замера по общим для всех окон часам, мс. */
function sample(page: Page) {
  return page.evaluate(() => {
    const { video } = (window as unknown as SyncTestWindow).syncTest;
    return {
      at: performance.timeOrigin + performance.now(),
      positionMs: video.currentTime * 1000,
      paused: video.paused,
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

/** Отдельный браузер со своими cookie и хранилищем — как другой человек. */
async function openPage(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/** Ждать, пока видео на странице не уйдёт дальше positionMs. */
async function playsPast(page: Page, positionMs: number): Promise<void> {
  await expect
    .poll(async () => (await sample(page)).positionMs, { timeout: 15_000 })
    .toBeGreaterThan(positionMs);
}

test("синхронный просмотр: старт, пауза, поздний вход и удержание", async ({
  browser,
}) => {
  test.setTimeout(60_000);

  // первый создаёт комнату; кнопка заодно разрешает звук (unlock в клике)
  const a = await openPage(browser, "/sync-test.html");
  await a.getByRole("button", { name: "Создать комнату" }).click();
  await expect.poll(async () => (await state(a)).room?.roomId).toBeTruthy();
  const link = (await a.locator("#link").getAttribute("href")) ?? "";
  expect(link).toContain("?room=");

  // второй входит по ссылке
  const b = await openPage(browser, link);
  await b.getByRole("button", { name: "Войти" }).click();
  await expect.poll(async () => (await state(a)).room?.peers.length).toBe(2);

  // первый запускает — у второго играет, расхождение меньше 0,5 с
  await a.getByRole("button", { name: "Играть" }).click();
  await playsPast(a, 1_500);
  await playsPast(b, 1_500);
  expect(Math.abs(await gapMs(a, b))).toBeLessThan(500);

  // второй ставит паузу — у первого пауза, обе на одной позиции
  await b.getByRole("button", { name: "Пауза" }).click();
  for (const page of [a, b]) {
    await expect.poll(async () => (await sample(page)).paused).toBe(true);
  }
  await expect
    .poll(async () => {
      const [first, second] = [await sample(a), await sample(b)];
      return Math.abs(first.positionMs - second.positionMs);
    })
    .toBeLessThan(50);

  // снова вместе
  await a.getByRole("button", { name: "Играть" }).click();
  for (const page of [a, b]) {
    await expect.poll(async () => (await sample(page)).paused).toBe(false);
  }

  // третий входит посреди просмотра: комната не останавливается
  const c = await openPage(browser, link);
  const before = { state: await state(a), sample: await sample(a) };
  await c.getByRole("button", { name: "Войти" }).click();
  await expect.poll(async () => (await state(a)).room?.peers.length).toBe(3);
  // стартует сразу с позиции комнаты, а не с начала и не с места входа
  await expect
    .poll(async () => (await sample(c)).paused, { timeout: 10_000 })
    .toBe(false);
  expect(Math.abs(await gapMs(a, c))).toBeLessThan(500);
  await playsPast(c, before.sample.positionMs + 500);
  const after = { state: await state(a), sample: await sample(a) };
  expect(after.state.playback).toMatchObject({
    status: "playing",
    rev: before.state.playback?.rev,
  });
  // у первого всё это время шло видео: позиция ушла на столько же, сколько прошло времени
  const played = after.sample.positionMs - before.sample.positionMs;
  expect(played).toBeGreaterThan(after.sample.at - before.sample.at - 300);

  // второго сбили на полторы секунды вперёд — контур возвращает его к комнате
  await b.evaluate(() => {
    (window as unknown as SyncTestWindow).syncTest.video.currentTime += 1.5;
  });
  expect(Math.abs(await gapMs(a, b))).toBeGreaterThan(1_000);
  await expect
    .poll(async () => Math.abs(await gapMs(a, b)), {
      timeout: 8_000,
      intervals: [250],
    })
    .toBeLessThan(150);

  // выходим по-человечески: сервер освобождает места, сокеты закрываются чисто
  for (const page of [a, b, c]) {
    await page.evaluate(() =>
      (window as unknown as SyncTestWindow).syncTest.client.dispose(),
    );
  }
});
