import { expect, test } from "@playwright/test";

test("opens the home page and shows its heading", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Совместный просмотр видео",
      exact: true,
    }),
  ).toBeVisible();
});
