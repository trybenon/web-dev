import js from "@eslint/js";
import globals from "globals";
import vue from "eslint-plugin-vue";
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
    files: ["**/*.{js,mjs,cjs,ts,mts,vue}"],
    extends: [js.configs.recommended],
  },
  {
    files: ["**/*.{ts,mts}"],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ["client/src/**/*.{js,ts,vue}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: [
      "server/**/*.{js,ts}",
      "scripts/**/*.{js,mjs,cjs,ts,mts}",
      "*.{js,mjs,cjs,ts,mts}",
      "client/vite.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["client/src/**/*.vue"],
    extends: [tseslint.configs.recommended, vue.configs["flat/essential"]],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
]);
