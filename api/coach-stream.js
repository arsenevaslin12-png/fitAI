"use strict";

const { createClient } = require("@supabase/supabase-js");
const {
  setCors,
  parseBody,
  sanitizeInput,
  detectIntent,
  buildConversationPrompt,
  makeProfileSummary,
  getIp,
  checkRateLimit
} = require("./_coach-core");
const { callGeminiStream, normalizeGeminiError } = require("./_gemini");
const { assertEnv } = require("./_env");

// ── SSE helper ────────────────────────────────────────────────────────────────
function sseWrite(res, data) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseDone(res) {
  if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
}

function formatHistory(history = []) {
  const items = Array.isArray(history) ? history.slice(-6) : [];
  if (!items.length) return "";
  return items.map(item => {
    const role = (item.role === "assistant" || item.role === "ai" || item.role === "coach") ? "Coach" : "Toi";
    return `${role}: ${String(item.content || "").slice(0, 150)}`;
  }).join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (assertEnv(res)) return;
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  // SSE headers — must be set before any body parsing
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders(); // Critical for Vercel: sends headers immediately so SSE starts

  try {
    const ip = getIp(req);
    const limit = checkRateLimit("coach-stream", ip, 8, 15_000);
    if (!limit.ok) {
      sseWrite(res, { error: `Trop de requêtes — patientez ${limit.retryAfterSec}s.` });
      return sseDone(res);
    }

    // ── Auth réelle ────────────────────────────────────────────────────────
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) { sseWrite(res, { error: "Non authentifié." }); return sseDone(res); }
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const { data: { user }, error } = await sb.auth.getUser(token);
        if (error || !user) { sseWrite(res, { error: "Token invalide." }); return sseDone(res); }
      } catch {
        sseWrite(res, { error: "Erreur d'authentification." }); return sseDone(res);
      }
    }

    // Parse body: try req.body (Vercel pre-parsed) then fallback to stream reading
    let body = parseBody(req);
    if (!body.message) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) body = JSON.parse(raw);
      } catch { /* keep body as-is */ }
    }
    const rawMessage = sanitizeInput(String(body.message || ""), 1000);
    if (!rawMessage) { sseWrite(res, { error: "Message vide." }); return sseDone(res); }

    const profile = body.profile || {};
    const history = Array.isArray(body.history) ? body.history : [];
    const goalCtx = body.goalContext || {};

    // Utilise buildConversationPrompt depuis _coach-core (même qualité que coach.js)
    const intent = detectIntent(rawMessage, "");
    const prompt = buildConversationPrompt(intent, rawMessage, history, profile, goalCtx);

    const apiKey = process.env.GEMINI_API_KEY;
    await callGeminiStream({
      apiKey,
      prompt,
      temperature: 0.7,
      maxOutputTokens: 900,
      timeoutMs: 25000,
      onChunk: (text) => sseWrite(res, { text })
    });

    sseDone(res);
  } catch (err) {
    const info = normalizeGeminiError(err);
    sseWrite(res, { error: info.message || "Erreur temporaire — réessayez." });
    sseDone(res);
  }
};
