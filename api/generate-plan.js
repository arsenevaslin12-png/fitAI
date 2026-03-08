"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];
const GEMINI_TIMEOUT_MS = 20000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error("GEMINI_TIMEOUT"), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function safeJsonExtract(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function validatePlan(raw) {
  if (!raw || !Array.isArray(raw.plan)) return null;
  const plan = raw.plan
    .map((row) => ({
      day: Number(row.day),
      workout_type: String(row.workout_type || "").trim(),
      intensity: String(row.intensity || "medium").trim(),
      notes: String(row.notes || "").trim()
    }))
    .filter((row) => Number.isInteger(row.day) && row.day >= 1 && row.day <= 7 && row.workout_type);
  if (plan.length !== 7) return null;
  return plan.sort((a, b) => a.day - b.day);
}

function fallbackPlan() {
  return [
    { day: 1, workout_type: "Push haut du corps", intensity: "medium", notes: "Volume modéré" },
    { day: 2, workout_type: "Cardio LISS", intensity: "easy", notes: "30 minutes" },
    { day: 3, workout_type: "Pull dos/biceps", intensity: "medium", notes: "Technique propre" },
    { day: 4, workout_type: "Recovery", intensity: "easy", notes: "Mobilité + marche" },
    { day: 5, workout_type: "Leg day", intensity: "hard", notes: "Focus squat/fentes" },
    { day: 6, workout_type: "HIIT court", intensity: "hard", notes: "20 minutes" },
    { day: 7, workout_type: "OFF", intensity: "easy", notes: "Repos complet" }
  ];
}

function buildPrompt(profile) {
  return `Génère un plan hebdomadaire fitness en JSON strict.
Format unique:
{"plan":[{"day":1,"workout_type":"Push","intensity":"medium","notes":"..."}]}
Contraintes:
- 7 jours exactement
- 1 à 2 jours OFF/recovery
- Profil: ${JSON.stringify(profile)}
- AUCUN markdown.`;
}

async function callGemini(apiKey, profile) {
  const client = new GoogleGenerativeAI(apiKey);
  let lastErr;

  for (const modelName of MODELS) {
    try {
      const model = client.getGenerativeModel({
        model: process.env.GEMINI_MODEL || modelName,
        generationConfig: { temperature: 0.5, maxOutputTokens: 900 }
      });
      const prompt = buildPrompt(profile);
      const response = await withTimeout(model.generateContent(prompt), GEMINI_TIMEOUT_MS);
      const text = response?.response?.text?.() || "";
      const parsed = validatePlan(safeJsonExtract(text));
      if (parsed) return { plan: parsed, model: modelName };
      lastErr = new Error("INVALID_PLAN_FORMAT");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("PLAN_GENERATION_FAILED");
}

function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}

async function loadProfile(supabase, userId) {
  const byUser = await supabase.from("profiles").select("weight,kpis,equipment,last_workout_date").eq("user_id", userId).maybeSingle();
  if (!byUser.error && byUser.data) return byUser.data;
  const byId = await supabase.from("profiles").select("weight,kpis,equipment,last_workout_date").eq("id", userId).maybeSingle();
  return byId.data || null;
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", requestId });

  const { GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG", requestId });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const auth = await supabase.auth.getUser(token);
  const userId = auth?.data?.user?.id;
  if (!userId) return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });

  try {
    const profile = await loadProfile(supabase, userId);
    const body = parseBody(req);
    const ai = await callGemini(GEMINI_API_KEY, { ...profile, ...body.profileOverrides });
    const weekStart = getWeekStartDate();

    await supabase.from("training_schedule").delete().eq("user_id", userId).eq("week_start_date", weekStart);
    const rows = ai.plan.map((r) => ({ ...r, day_of_week: r.day, status: "planned", user_id: userId, week_start_date: weekStart }));
    const insert = await supabase.from("training_schedule").insert(rows);
    if (insert.error) throw insert.error;

    return sendJson(res, 200, { ok: true, requestId, week_start_date: weekStart, plan: ai.plan, model: ai.model });
  } catch (e) {
    const fallback = fallbackPlan();
    return sendJson(res, 200, { ok: true, requestId, plan: fallback, fallback: true, error: String(e.message || "generation_failed") });
  }
};
