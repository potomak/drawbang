import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // Ignore build output and deps
  {
    ignores: [
      "dist/**",
      "dist-lambda/**",
      "node_modules/**",
      "dev-bucket/**",
      ".muse/**",
      "coverage/**",
    ],
  },
  // Don't report unused eslint-disable comments as errors — codebase has many
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  // Base JS + TS recommended
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // JS files (infra scripts, vite config, etc.) — Node globals, no TS
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Legacy static browser scripts — vanilla JS, browser globals, no TS checks
  {
    files: ["static/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // React + hooks for TS/TSX files
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      // React 17+ JSX runtime — no need to import React for JSX
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
      // Hooks rules are the value of the React plugin for agents
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Keep noisy TS rules as warnings until the codebase is cleaned
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      // Prettier owns formatting — don't double-enforce via ESLint
      "no-undef": "off",
      "no-empty": "off",
      "prefer-const": "off",
    },
  },
  // Test files can use `any` and non-null assertions more freely
  {
    files: ["test/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
