import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // сервер комнат: без него страница синхронизации не подключится
      command:
        "npm run build --workspace=shared && npm run dev --workspace=server",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      // собранный клиент, как в продакшене, плюс страница проверки синхронизации;
      // /api и /ws vite preview пересылает серверу, как и в разработке
      command:
        "npm run build:e2e --workspace=client && npm run preview:e2e --workspace=client",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
