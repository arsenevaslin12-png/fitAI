"use strict";

const js = require("@eslint/js");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  // ── Ignores ────────────────────────────────────────────────────────────────
  {
    ignores: ["node_modules/**", "download/**", "*.zip"]
  },

  // ── API — Node.js CommonJS ─────────────────────────────────────────────────
  {
    files: ["api/**/*.js", "*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly"
      }
    },
    rules: {
      // Erreurs bloquantes
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-prototype-builtins": "error",

      // Avertissements qualité
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Autorisé dans ce projet
      "no-constant-condition": ["error", { checkLoops: false }]
    }
  },

  // ── Frontend — Browser globals ─────────────────────────────────────────────
  {
    files: ["public/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        FileReader: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        performance: "readonly",
        alert: "readonly",
        confirm: "readonly",
        // Supabase (chargé via CDN)
        supabase: "readonly",
        // Variables globales app
        SUPABASE_URL: "readonly",
        SUPABASE_ANON_KEY: "readonly"
      }
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // console.log accepté côté browser (conditionné à __FITAI_DEBUG__)
      "no-console": "off"
    }
  }
];
