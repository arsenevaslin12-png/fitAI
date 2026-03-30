"use strict";
// api/config.js — Configuration endpoint with security

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN,
  process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
  process.env.VERCEL_BRANCH_URL && `https://${process.env.VERCEL_BRANCH_URL}`,
].filter(Boolean);

// Fallback to * only in development
const isDev = process.env.VERCEL_ENV === "development" || !process.env.VERCEL_ENV;

module.exports = function handler(req, res) {
  // CORS with origin validation
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
  
  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED" }));
  }

  const url = (process.env.SUPABASE_URL || "").trim();
  const anon = (process.env.SUPABASE_ANON_KEY || "").trim();

  // Check env vars exist
  if (!url || !anon) {
    const missing = [!url && "SUPABASE_URL", !anon && "SUPABASE_ANON_KEY"].filter(Boolean);
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false,
      error: "MISSING_ENV_VARS",
      message: "Variables d'environnement manquantes: " + missing.join(", "),
      fix: "Vercel Dashboard → Settings → Environment Variables → ajouter ces variables → Redeploy"
    }));
  }

  // Validate Supabase URL format
  const urlPattern = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i;
  const cleanUrl = url.replace(/\/+$/, "");

  if (!urlPattern.test(cleanUrl)) {
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false,
      error: "INVALID_SUPABASE_URL",
      message: "Format SUPABASE_URL invalide. Attendu: https://xxxxx.supabase.co",
      fix: "Vérifiez SUPABASE_URL dans Vercel → Settings → Environment Variables"
    }));
  }

  // Validate anon key format (JWT)
  if (!anon.startsWith("eyJ") || anon.length < 100) {
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false,
      error: "INVALID_ANON_KEY",
      message: "Format SUPABASE_ANON_KEY invalide (doit être un JWT)",
      fix: "Vérifiez SUPABASE_ANON_KEY dans Vercel → Settings → Environment Variables"
    }));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    supabaseUrl: cleanUrl,
    supabaseAnonKey: anon
  }));
};
