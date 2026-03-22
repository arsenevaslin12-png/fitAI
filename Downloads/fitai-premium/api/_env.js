"use strict";

const { z } = require("zod");

function isJwtKey(value) {
  return /^eyJ[a-zA-Z0-9_-]+\./.test(String(value || "")) && String(value || "").length > 80;
}

function isPublishableKey(value) {
  return /^sb_publishable_[a-zA-Z0-9._-]+$/.test(String(value || ""));
}

const EnvSchema = z.object({
  SUPABASE_URL: z
    .string({ required_error: "SUPABASE_URL manquante" })
    .regex(/^https:\/\/[a-z0-9-]+\.supabase\.co$/i, {
      message: "SUPABASE_URL invalide — format attendu: https://xxxxxx.supabase.co"
    }),
  SUPABASE_PUBLIC_KEY: z.string({ required_error: "SUPABASE public key manquante" }).refine(
    (value) => isJwtKey(value) || isPublishableKey(value),
    "Clé Supabase invalide — formats acceptés: JWT legacy (eyJ...) ou publishable key (sb_publishable_...)"
  ),
  GEMINI_API_KEY: z.string().optional().default("")
});

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

function pickSupabasePublicKey() {
  const key = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    ""
  ).trim();
  return key;
}

function readEnv() {
  return {
    SUPABASE_URL: (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    SUPABASE_PUBLIC_KEY: pickSupabasePublicKey(),
    GEMINI_API_KEY: (process.env.GEMINI_API_KEY || "").trim()
  };
}

const _envResult = EnvSchema.safeParse(readEnv());
const MISSING_ERRORS = _envResult.success ? [] : _envResult.error.errors;

if (MISSING_ERRORS.length > 0) {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  ❌  FITAI — CONFIGURATION INVALIDE — REQUÊTES REFUSÉES (503)  ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    `${MISSING_ERRORS.length} erreur(s) de configuration détectée(s) :`,
    "",
    ...MISSING_ERRORS.map((e) => `  ❌  [${e.path.join(".")}] ${e.message}`),
    "",
    "ACTION REQUISE:",
    "  → Vercel Dashboard → Settings → Environment Variables",
    "  → Ajoutez ou corrigez SUPABASE_URL + la clé publique Supabase",
    "  → GEMINI_API_KEY reste optionnelle sur les routes avec fallback",
    ""
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

function assertEnv(res, options = {}) {
  const requireGemini = !!options.requireGemini;
  const runtime = readEnv();
  const runtimeErrors = [];

  if (MISSING_ERRORS.length > 0) runtimeErrors.push(...MISSING_ERRORS);
  if (requireGemini && !runtime.GEMINI_API_KEY) {
    runtimeErrors.push({ path: ["GEMINI_API_KEY"], message: "GEMINI_API_KEY manquante" });
  }

  if (runtimeErrors.length === 0) return false;

  if (res && !res.writableEnded) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({
      ok: false,
      error: "SERVER_MISCONFIGURED",
      message: `Serveur mal configuré. ${runtimeErrors.length} variable(s) invalide(s).`,
      errors: runtimeErrors.map((e) => ({ field: e.path.join("."), message: e.message })),
      fix: "Vercel Dashboard → Settings → Environment Variables → corrigez les variables → Redeploy."
    }));
  }
  return true;
}

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
  CoachBodySchema,
  pickSupabasePublicKey,
  isJwtKey,
  isPublishableKey
};
