"use strict";

const { createClient } = require("@supabase/supabase-js");
const {
  sendJson,
  setCors,
  parseBody,
  sanitizeInput,
  getIp,
  checkRateLimit,
  generateWorkoutPlan
} = require("./_coach-core");
const {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  normalizeGeminiError
} = require("./_gemini");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Méthode non autorisée" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { ok: false, error: "SUPABASE config manquante" });
  }

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendJson(res, 401, { ok: false, error: "Token invalide" });
  } catch {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED" });
  }

  const limit = checkRateLimit("workout", getIp(req), 8, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: `Trop de générations. Réessayez dans ${limit.retryAfterSec}s.` });
  }

  const body = parseBody(req);
  const message = sanitizeInput(body.prompt || body.message || "", 1600);
  if (!message) return sendJson(res, 400, { ok: false, error: "Le champ 'prompt' est requis" });

  const profile = {
    goal: sanitizeInput(body.goal || body.goalContext?.type || "", 60),
    level: sanitizeInput(body.level || body.goalContext?.level || "beginner", 30),
    equipment: sanitizeInput(body.equipment || "poids du corps", 200),
    injuries: sanitizeInput(body.injuries || body.goalContext?.constraints || "", 300),
    weight: Number(body.weight || 0) || null,
    height: Number(body.height || 0) || null,
    sleep_hours: Number(body.sleep_hours || 0) || null,
    recovery_score: Number(body.recovery_score || 0) || null
  };

  try {
    const result = await generateWorkoutPlan({
      apiKey: String(process.env.GEMINI_API_KEY || "").trim(),
      message,
      history: Array.isArray(body.history) ? body.history : [],
      profile,
      goalContext: body.goalContext || {}
    });

    return sendJson(res, 200, {
      ok: true,
      data: result.data,
      fallback: !!result.fallback,
      meta: result.error ? { note: result.error } : undefined,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL
    });
  } catch (error) {
    const info = normalizeGeminiError(error);
    console.error("[workout]", info.code, info.message.slice(0, 200));
    return sendJson(res, info.status, {
      ok: false,
      error: info.message,
      error_code: info.code,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL
    });
  }
};
