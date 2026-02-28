"use strict";
// api/config.js — retourne TOUJOURS du JSON, jamais du HTML

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const url = process.env.SUPABASE_URL || "";
  const anon = process.env.SUPABASE_ANON_KEY || "";

  if (!url || !anon) {
    const missing = [!url && "SUPABASE_URL", !anon && "SUPABASE_ANON_KEY"].filter(Boolean);
    res.statusCode = 500;
    return res.end(JSON.stringify({
      ok: false,
      error: "Variables d'environnement manquantes dans Vercel: " + missing.join(", "),
      fix: "Vercel Dashboard → votre projet → Settings → Environment Variables → ajouter ces variables → Redeploy"
    }));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, supabaseUrl: url, supabaseAnonKey: anon }));
};
