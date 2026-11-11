import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@watch-together/shared": fileURLToPath(
        new URL("./shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "client/src/**/*.test.ts",
      "server/src/**/*.test.ts",
      "shared/src/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "client/src/**/*.{ts,vue}",
        "server/src/**/*.ts",
        "shared/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "client/src/main.ts",
        // служебная страница и оболочка воркера проверяются e2e-тестом
        "client/src/dev/**",
        "client/src/sync/sync.worker.ts",
        "server/src/index.ts",
        "shared/src/index.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
