import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Покрытие считается по чистому ядру. Адаптеры (воркер, main.ts, сервер)
      // тонкие и проверяются сценариями tools/measure.ts и интеграционным тестом.
      include: ['core/**/*.ts', 'shared/**/*.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      reporter: ['text', 'html'],
    },
  },
});
