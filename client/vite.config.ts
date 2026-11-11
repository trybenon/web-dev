import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  build: {
    sourcemap: true,
    // e2e-сборка: тот же клиент плюс страница проверки синхронизации.
    // На домен она не попадает: обычная сборка берёт только index.html
    ...(mode === "e2e" && {
      outDir: "dist/e2e",
      rollupOptions: {
        input: {
          main: page("./index.html"),
          syncTest: page("./sync-test.html"),
        },
      },
    }),
  },
  resolve: {
    alias: {
      "@watch-together/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": {
        target: "ws://127.0.0.1:3000",
        ws: true,
      },
    },
  },
}));
