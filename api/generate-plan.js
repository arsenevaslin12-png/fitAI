"use strict";
// api/generate-plan.js — FitAI Pro v5.0.0
// Fixed: profiles PK is "id" not "user_id", timeout, model fallback

const TIMEOUT = 25000;
const MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite"];

let _AI = null;
function getAI() {
  if (_AI) return _AI;
  try { _AI = require("@google/generative-ai").GoogleGenerativeAI; return _AI; } catch { return null; }
}
const { createClient } = require("@supabase/supabase-js");

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b || {};
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function getWeekStartDate() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  return monday.toISOString().split("T")[0];
}

function buildPlanPrompt(profile) {
  const weight = profile?.weight || 75;
  const lastWorkoutDays = profile?.last_workout_days || 7;

  return `Tu es FitAI Coach. Genere un plan hebdomadaire (7 jours) STRUCTURE et REALISTE.

PROFIL:
- Poids: ${weight}kg
- Dernier workout: il y a ${lastWorkoutDays} jours

REGLES STRICTES:
1. Alterner types: Push/Pull/Legs/Cardio/Recovery
2. TOUJOURS inclure 1-2 jours OFF complets
3. Repartir l'intensite: easy/medium/hard
4. Maximum 4 seances intenses par semaine

FORMAT JSON UNIQUEMENT (pas de markdown):
{"plan":[{"day":1,"workout_type":"Push (Chest/Shoulders/Triceps)","intensity":"medium","notes":"Volume modere, focus technique"},{"day":2,"workout_type":"Cardio LISS","intensity":"easy","notes":"30min marche rapide ou velo"},{"day":3,"workout_type":"Pull (Back/Biceps)","intensity":"medium","notes":""},{"day":4,"workout_type":"REST","intensity":"easy","notes":"Repos actif"},{"day":5,"workout_type":"Legs","intensity":"hard","notes":"Squats + accessoires"},{"day":6,"workout_type":"HIIT","intensity":"hard","notes":"20min intervals"},{"day":7,"workout_type":"REST","intensity":"easy","notes":"Repos complet"}]}

NE PAS inclure de blabla, juste le JSON pur.`;
}

function validatePlan(obj) {
  if (!obj || !Array.isArray(obj.plan)) return null;
  if (obj.plan.length !== 7) return null;
  const validated = obj.plan.map(function (item) {
    if (!item || typeof item !== "object") return null;
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;
    const workoutType = String(item.workout_type || "").trim();
    if (!workoutType) return null;
    return {
      day: day,
      workout_type: workoutType,
      intensity: String(item.intensity || "medium").trim(),
      notes: String(item.notes || "").trim(),
    };
  }).filter(Boolean);
  if (validated.length !== 7) return null;
  return validated;
}

async function callGemini(apiKey, prompt, modelIndex) {
  const G = getAI();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "DEP" });

  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  const model = new G(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
  });

  let tid;
  const tOut = new Promise((_, rej) => {
    tid = setTimeout(() => rej(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT);
  });

  const call = model.generateContent(prompt)
    .then(r => { clearTimeout(tid); const t = r?.response?.text; return typeof t === "function" ? t() : String(t || ""); })
    .catch(async err => {
      clearTimeout(tid);
      const msg = String(err?.message || "");
      if ((msg.includes("404") || msg.includes("not found") || msg.includes("not supported")) && modelIndex + 1 < MODELS.length) {
        return callGemini(apiKey, prompt, modelIndex + 1);
      }
      throw err;
    });

  return Promise.race([call, tOut]);
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!GEMINI_API_KEY) return sendJson(res, 500, { ok: false, error: "GEMINI_API_KEY manquant", requestId });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return sendJson(res, 500, { ok: false, error: "SUPABASE config manquante", requestId });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis", requestId });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendJson(res, 401, { ok: false, error: "Token invalide", requestId });
    userId = user.id;
  } catch (e) {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED", requestId });
  }

  try {
    // profiles PK is "id", not "user_id"
    const { data: profile } = await supabase
      .from("profiles").select("weight").eq("id", userId).maybeSingle();

    // Get last workout date
    const { data: lastWs } = await supabase
      .from("workout_sessions").select("created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();

    let lastWorkoutDays = 7;
    if (lastWs?.created_at) {
      try { lastWorkoutDays = Math.max(0, Math.floor((Date.now() - new Date(lastWs.created_at).getTime()) / (24 * 3600 * 1000))); } catch {}
    }

    const enrichedProfile = {
      weight: profile?.weight || 75,
      last_workout_days: lastWorkoutDays,
    };

    const text = await callGemini(GEMINI_API_KEY, buildPlanPrompt(enrichedProfile), 0);
    const parsed = safeJsonExtract(text);
    const plan = validatePlan(parsed);

    if (!plan) return sendJson(res, 500, { ok: false, error: "Format plan invalide retourne par Gemini. Reessayez.", requestId });

    const weekStart = getWeekStartDate();

    // Delete existing plan for this week
    await supabase.from("training_schedule").delete().eq("user_id", userId).eq("week_start_date", weekStart);

    // Insert new plan
    const rows = plan.map(function (item) {
      return {
        user_id: userId,
        day_of_week: item.day,
        workout_type: item.workout_type,
        intensity: item.intensity,
        status: "planned",
        notes: item.notes,
        week_start_date: weekStart,
      };
    });

    const { error: insertError } = await supabase.from("training_schedule").insert(rows);
    if (insertError) {
      console.error("[generate-plan] insert error", { requestId, err: insertError.message });
      return sendJson(res, 500, { ok: false, error: "DB_INSERT_FAILED", requestId });
    }

    return sendJson(res, 200, { ok: true, plan, week_start_date: weekStart, requestId });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[generate-plan]", { requestId, code, msg: msg.slice(0, 150) });
    if (code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "Gemini timeout. Reessayez.", requestId });
    if (code === "DEP") return sendJson(res, 500, { ok: false, error: msg, requestId });
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) return sendJson(res, 429, { ok: false, error: "Quota Gemini atteint. Attendez 60 secondes.", retryAfter: 60, requestId });
    return sendJson(res, 502, { ok: false, error: msg || "Erreur serveur", requestId });
  }
};
