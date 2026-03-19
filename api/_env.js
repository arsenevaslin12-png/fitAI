"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// api/_env.js — Central environment validation for FitAI
//
// Run at cold-start (module load) AND per-request via assertEnv(res).
// If any critical variable is missing → logs loudly + returns 503 JSON.
// The server NEVER attempts to serve requests with a broken configuration.
// ─────────────────────────────────────────────────────────────────────────────

const CRITICAL = [
  {
    name: "SUPABASE_URL",
    get: () => String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    test: (v) => /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(v),
    hint: "Format attendu: https://xxxxxx.supabase.co\n       → Supabase Dashboard → Settings → API → Project URL"
  },
  {
    name: "SUPABASE_ANON_KEY (ou SUPABASE_PUBLISHABLE_KEY)",
    get: () => (
      process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || ""
    ).trim(),
    test: (v) => v.length > 30,
    hint: "Supabase Dashboard → Settings → API → anon/public key\n       ou nouvelle publishable key (sb_publishable_...)"
  },
  {
    name: "GEMINI_API_KEY",
    get: () => String(process.env.GEMINI_API_KEY || "").trim(),
    test: (v) => v.length > 10,
    hint: "Clé depuis Google AI Studio: https://aistudio.google.com/app/apikey"
  }
];

// ── Module-level check (runs once on Vercel cold-start) ──────────────────────
const MISSING = CRITICAL.filter((item) => !item.test(item.get()));

if (MISSING.length > 0) {
  const lines = [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  ❌  FITAI — CONFIGURATION INVALIDE — REQUÊTES REFUSÉES (503)  ║",
    "╚══════════════════════════════════════════════════════════════════╝",
    "",
    `${MISSING.length} variable(s) manquante(s) ou invalide(s) :`,
    "",
    ...MISSING.map((item) => `  ❌  ${item.name}\n       → ${item.hint}`),
    "",
    "ACTION REQUISE:",
    "  → Vercel Dashboard → votre projet → Settings → Environment Variables",
    "  → Ajoutez ou corrigez les variables listées ci-dessus",
    "  → Cliquez sur 'Redeploy' pour relancer",
    "",
    "Toutes les requêtes retourneront HTTP 503 jusqu'à correction.",
    ""
  ];
  // Use process.stderr for maximum visibility in Vercel logs
  process.stderr.write(lines.join("\n") + "\n");
}

// ── Per-request guard ─────────────────────────────────────────────────────────
// Usage in any handler: `if (assertEnv(res)) return;`
// Returns true (and sends 503) if config is broken, false if all good.
function assertEnv(res) {
  if (MISSING.length === 0) return false;

  if (res && !res.writableEnded) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({
      ok: false,
      error: "SERVER_MISCONFIGURED",
      message: `Serveur mal configuré. Variable(s) manquante(s) : ${MISSING.map((m) => m.name).join(", ")}.`,
      missing: MISSING.map((m) => ({ variable: m.name, hint: m.hint.split("\n")[0] })),
      fix: "Vercel Dashboard → Settings → Environment Variables → ajoutez les variables manquantes → Redeploy."
    }));
  }
  return true;
}

module.exports = { assertEnv, MISSING };
