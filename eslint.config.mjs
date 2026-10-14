import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "docs/**",
    "spikes/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,tsx}"],
    extends: [js.configs.recommended],
  },
  {
    files: ["**/*.{ts,mts,tsx}"],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ["client/src/**/*.{js,ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "server/**/*.{js,ts}",
      "*.{js,mjs,cjs,ts,mts}",
      "client/vite.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["client/src/**/*.{ts,mts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
]);
