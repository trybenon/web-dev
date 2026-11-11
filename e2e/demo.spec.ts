import { expect, test } from "@playwright/test";

test("serves and decodes the demo in Chromium", async ({ page, request }) => {
  await page.goto("/");
  const video = page.locator(".room-view video");
  await expect(video).toBeHidden();
  await page
    .getByRole("textbox", { name: "Имя", exact: true })
    .fill("Тест демо");
  await page.getByRole("button", { name: "Создать комнату" }).click();
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", "/media/demo.webm");
  const attribution = page.getByLabel("Демонстрационный ролик");
  await expect(attribution).toContainText("Grand Theft Auto VI Launch Trailer");
  await expect(
    attribution.getByRole("link", { name: "Rockstar Games" }),
  ).toHaveAttribute("href", "https://www.rockstargames.com/VI/launch-trailer");

  const response = await request.get("/media/demo.webm");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("video/webm");

  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.videoWidth),
    )
    .toBe(640);

  // Комната стартует на паузе, поэтому воспроизведение проверяем отдельно.
  const result = await page.evaluate(async () => {
    const video = document.createElement("video");
    video.src = "/media/demo.webm";
    video.muted = true;
    video.preload = "auto";
    document.body.append(video);
    try {
      const progressed = new Promise<void>((resolve, reject) => {
        video.addEventListener(
          "error",
          () =>
            reject(new Error(video.error?.message ?? "Demo playback failed")),
          { once: true },
        );
        video.addEventListener("timeupdate", () => {
          if (video.currentTime >= 0.25 && video.videoWidth > 0) resolve();
        });
      });
      await Promise.all([video.play(), progressed]);
      return {
        duration: video.duration,
        width: video.videoWidth,
        time: video.currentTime,
      };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
  });
  expect(result.duration).toBeCloseTo(90, 0);
  expect(result.width).toBe(640);
  expect(result.time).toBeGreaterThanOrEqual(0.25);
});
