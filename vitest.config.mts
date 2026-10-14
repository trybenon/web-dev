import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
  },
});
