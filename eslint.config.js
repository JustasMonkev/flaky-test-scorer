import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "report/**", ".real-playwright-*/**"],
  },
  {
    files: ["dist/**/*.js"],
    languageOptions: { globals: globals.node },
    rules: eslint.configs.recommended.rules,
  },
];
