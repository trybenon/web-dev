import { expect, test } from "@playwright/test";

test("serves and decodes the licensed demo in Chromium", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Открыть деморолик" }),
  ).toHaveAttribute("href", "/media/demo.webm");
  await expect(page.getByRole("link", { name: "CC BY 3.0" })).toBeVisible();

  const response = await request.get("/media/demo.webm");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("video/webm");

  // Проверяем реальное декодирование файла, независимо от будущего плеера #48.
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
  expect(result.duration).toBeCloseTo(30, 0);
  expect(result.width).toBe(640);
  expect(result.time).toBeGreaterThanOrEqual(0.25);
});
