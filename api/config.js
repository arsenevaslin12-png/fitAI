"use strict";
// api/config.js — Configuration endpoint with support for legacy anon JWT and new publishable keys.

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN,
  process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
  process.env.VERCEL_BRANCH_URL && `https://${process.env.VERCEL_BRANCH_URL}`,
].filter(Boolean);

const isDev = process.env.VERCEL_ENV === "development" || !process.env.VERCEL_ENV;

function send(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function isJwtKey(value) {
  return /^eyJ[a-zA-Z0-9_-]+\./.test(value) && value.length > 80;
}

function isPublishableKey(value) {
  return /^sb_publishable_[a-zA-Z0-9._-]+$/.test(value);
}

function pickSupabaseKey() {
  const candidates = [
    { env: "SUPABASE_ANON_KEY", value: String(process.env.SUPABASE_ANON_KEY || "").trim() },
    { env: "SUPABASE_PUBLISHABLE_KEY", value: String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim() },
    { env: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim() },
    { env: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", value: String(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "").trim() }
  ].filter((x) => x.value);

  for (const item of candidates) {
    if (isJwtKey(item.value)) return { key: item.value, type: "legacy_anon_jwt", envName: item.env };
    if (isPublishableKey(item.value)) return { key: item.value, type: "publishable", envName: item.env };
  }
  return null;
}

module.exports = function handler(req, res) {
  const origin = req.headers.origin;
  if (isDev || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    return send(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const selectedKey = pickSupabaseKey();

  if (!url || !selectedKey?.key) {
    const missing = [
      !url ? "SUPABASE_URL" : null,
      !selectedKey?.key ? "SUPABASE_ANON_KEY ou SUPABASE_PUBLISHABLE_KEY" : null
    ].filter(Boolean);
    return send(res, 500, {
      ok: false,
      error: "MISSING_ENV_VARS",
      message: `Variables d'environnement manquantes: ${missing.join(", ")}`,
      fix: "Vercel Dashboard → Settings → Environment Variables → ajoutez SUPABASE_URL et soit SUPABASE_ANON_KEY (JWT legacy), soit SUPABASE_PUBLISHABLE_KEY (sb_publishable_...)."
    });
  }

  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    return send(res, 500, {
      ok: false,
      error: "INVALID_SUPABASE_URL",
      message: "Format SUPABASE_URL invalide. Attendu: https://xxxxx.supabase.co",
      fix: "Vérifiez SUPABASE_URL dans Vercel → Settings → Environment Variables."
    });
  }

  if (!isJwtKey(selectedKey.key) && !isPublishableKey(selectedKey.key)) {
    return send(res, 500, {
      ok: false,
      error: "INVALID_SUPABASE_KEY",
      message: "La clé Supabase n'a pas un format reconnu. Formats acceptés: JWT legacy (eyJ...) ou publishable key (sb_publishable_...).",
      fix: "Utilisez la clé 'anon/public' ou la nouvelle 'publishable key' depuis Supabase Dashboard → Settings → API."
    });
  }

  return send(res, 200, {
    ok: true,
    supabaseUrl: url,
    supabaseAnonKey: selectedKey.key,
    supabaseKeyType: selectedKey.type,
    supabaseKeyEnv: selectedKey.envName
  });
};
