"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// api/_env.js — Zod-based environment validation for FitAI
//
// Runs at cold-start (module load) AND per-request via assertEnv(res).
// If any critical variable is missing/invalid → HTTP 503 + clear error message.
// Build WILL log loudly so the issue is visible in Vercel logs immediately.
// ─────────────────────────────────────────────────────────────────────────────

const { z } = require("zod");

const EnvSchema = z.object({
  SUPABASE_URL: z
    .string({ required_error: "SUPABASE_URL manquante" })
    .regex(/^https:\/\/[a-z0-9-]+\.supabase\.co$/i, {
      message: "SUPABASE_URL invalide — format attendu: https://xxxxxx.supabase.co"
    }),

  SUPABASE_ANON_KEY: z
    .string({ required_error: "SUPABASE_ANON_KEY manquante" })
    .min(30, "SUPABASE_ANON_KEY trop courte (< 30 chars) — vérifiez la clé anon/public"),

  GEMINI_API_KEY: z
    .string({ required_error: "GEMINI_API_KEY manquante" })
    .min(10, "GEMINI_API_KEY trop courte — vérifiez votre clé Google AI Studio")
});

// ── Body schema validators (reusable in API routes) ──────────────────────────

const RecipeBodySchema = z.object({
  ingredients: z.string().min(2, "ingredients requis").max(2000),
  goal: z.enum(["equilibre", "hyperproteine", "low_carb", "prise_de_masse", "seche"]).default("equilibre"),
  targetKcal: z.number().int().min(100).max(5000).default(500)
}).strict();

const BodyscanBodySchema = z.object({
  user_id: z.string().uuid("user_id doit être un UUID"),
  image_path: z.string().min(1, "image_path requis").max(500)
}).strict();

const CoachBodySchema = z.object({
  message: z.string().min(1).max(1000),
  history: z.array(z.object({ role: z.string(), content: z.string() })).max(20).optional(),
  profile: z.record(z.unknown()).optional(),
  goalContext: z.record(z.unknown()).optional()
});

// ── Read env (with multi-key support for SUPABASE_ANON_KEY) ──────────────────
function readEnv() {
  return {
    SUPABASE_URL: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    SUPABASE_ANON_KEY: (
      process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ""
    ).trim(),
    GEMINI_API_KEY: (process.env.GEMINI_API_KEY || "").trim()
  };
}

// ── Module-level validation (runs once at cold-start) ────────────────────────
const _envResult = EnvSchema.safeParse(readEnv());
const MISSING_ERRORS = _envResult.success ? [] : _envResult.error.errors;

if (MISSING_ERRORS.length > 0) {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  ❌  FITAI — CONFIGURATION INVALIDE — REQUÊTES REFUSÉES (503)  ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    `${MISSING_ERRORS.length} erreur(s) de configuration détectée(s) par Zod :`,
    "",
    ...MISSING_ERRORS.map((e) => `  ❌  [${e.path.join(".")}] ${e.message}`),
    "",
    "ACTION REQUISE:",
    "  → Vercel Dashboard → votre projet → Settings → Environment Variables",
    "  → Ajoutez ou corrigez les variables listées ci-dessus",
    "  → Cliquez sur 'Redeploy' pour relancer",
    ""
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

// ── Per-request guard ─────────────────────────────────────────────────────────
function assertEnv(res) {
  if (MISSING_ERRORS.length === 0) return false;

  if (res && !res.writableEnded) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({
      ok: false,
      error: "SERVER_MISCONFIGURED",
      message: `Serveur mal configuré. ${MISSING_ERRORS.length} variable(s) invalide(s).`,
      errors: MISSING_ERRORS.map((e) => ({ field: e.path.join("."), message: e.message })),
      fix: "Vercel Dashboard → Settings → Environment Variables → corrigez les variables → Redeploy."
    }));
  }
  return true;
}

// ── Schema validators for route bodies ───────────────────────────────────────
function validateBody(schema, body, res) {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };

  const errors = result.error.errors.map((e) => `[${e.path.join(".")}] ${e.message}`);
  if (res && !res.writableEnded) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({
      ok: false,
      error: "INVALID_REQUEST",
      message: `Paramètres invalides: ${errors.join("; ")}`,
      errors
    }));
  }
  return { ok: false, errors };
}

module.exports = {
  assertEnv,
  validateBody,
  MISSING_ERRORS,
  RecipeBodySchema,
  BodyscanBodySchema,
  CoachBodySchema
};
