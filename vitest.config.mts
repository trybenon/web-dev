import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "client/src/**/*.test.ts",
      "server/src/**/*.test.ts",
      "shared/src/**/*.test.ts",
    ],
  },
});
