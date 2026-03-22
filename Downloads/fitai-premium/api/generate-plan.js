"use strict";

const { callGeminiText, extractJson, DEFAULT_MODEL, FALLBACK_MODEL } = require("./_gemini");

const TIMEOUT_MS = 3200;

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
  return `Tu es FitAI Coach. Génère un plan hebdomadaire de 7 jours, réaliste et progressif.
Réponds UNIQUEMENT en JSON valide.

PROFIL:
- Poids: ${weight}kg
- Dernier entraînement: il y a ${lastWorkoutDays} jours

RÈGLES:
- Alterne renforcement, cardio léger, mobilité et repos.
- 1 à 2 jours OFF obligatoires.
- Pas plus de 4 jours difficiles.
- Notes courtes et utiles.

FORMAT EXACT:
{"plan":[{"day":1,"workout_type":"Full Body","intensity":"medium","notes":"Technique et régularité"}]}
`;
}

function fallbackWeeklyPlan() {
  return [
    { day: 1, workout_type: "Full Body", intensity: "medium", notes: "Mouvements de base, technique propre" },
    { day: 2, workout_type: "Cardio LISS", intensity: "easy", notes: "20 à 30 min" },
    { day: 3, workout_type: "Upper Body", intensity: "medium", notes: "Poussée + tirage" },
    { day: 4, workout_type: "REST", intensity: "easy", notes: "Repos actif" },
    { day: 5, workout_type: "Lower Body", intensity: "medium", notes: "Jambes + gainage" },
    { day: 6, workout_type: "Mobilité / Core", intensity: "easy", notes: "20 min de mobilité" },
    { day: 7, workout_type: "REST", intensity: "easy", notes: "Repos complet" }
  ];
}

function validatePlan(obj) {
  if (!obj || !Array.isArray(obj.plan) || obj.plan.length !== 7) return null;
  const out = obj.plan.map((item) => {
    if (!item || typeof item !== "object") return null;
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;
    const workoutType = String(item.workout_type || "").trim();
    if (!workoutType) return null;
    const intensity = ["easy", "medium", "hard"].includes(String(item.intensity || "").trim()) ? String(item.intensity).trim() : "medium";
    return { day, workout_type: workoutType, intensity, notes: String(item.notes || "").trim() };
  }).filter(Boolean);
  return out.length === 7 ? out : null;
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let createClient;
  try {
    ({ createClient } = require("@supabase/supabase-js"));
  } catch {
    return sendJson(res, 500, { ok: false, error: "SUPABASE_CLIENT_MISSING", requestId });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 200, { ok: true, plan: fallbackWeeklyPlan(), week_start_date: getWeekStartDate(), fallback: true, requestId, error: "SUPABASE config manquante", model_default: DEFAULT_MODEL, model_fallback: FALLBACK_MODEL });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis", requestId });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendJson(res, 401, { ok: false, error: "Token invalide", requestId });
    userId = user.id;
  } catch {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED", requestId });
  }

  try {
    const [{ data: profile }, { data: lastWs }] = await Promise.all([
      supabase.from("profiles").select("weight").eq("id", userId).maybeSingle(),
      supabase.from("workout_sessions").select("created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    ]);

    let lastWorkoutDays = 7;
    if (lastWs?.created_at) {
      try { lastWorkoutDays = Math.max(0, Math.floor((Date.now() - new Date(lastWs.created_at).getTime()) / (24 * 3600 * 1000))); } catch {}
    }

    const enrichedProfile = { weight: profile?.weight || 75, last_workout_days: lastWorkoutDays };

    let plan = fallbackWeeklyPlan();
    let fallback = true;
    if (GEMINI_API_KEY) {
      try {
        const result = await callGeminiText({ apiKey: GEMINI_API_KEY, prompt: buildPlanPrompt(enrichedProfile), temperature: 0.35, maxOutputTokens: 700, timeoutMs: TIMEOUT_MS, retries: 1 });
        const parsed = extractJson(result.text);
        const validated = validatePlan(parsed);
        if (validated) { plan = validated; fallback = false; }
      } catch (e) {
        console.warn("[generate-plan] fallback:", String(e?.message || e));
      }
    }

    const weekStart = getWeekStartDate();
    await supabase.from("training_schedule").delete().eq("user_id", userId).eq("week_start_date", weekStart);

    const rows = plan.map((item) => ({
      user_id: userId,
      day_of_week: item.day,
      workout_type: item.workout_type,
      intensity: item.intensity,
      status: "planned",
      notes: item.notes,
      week_start_date: weekStart
    }));

    const { error: insertError } = await supabase.from("training_schedule").insert(rows);
    if (insertError) {
      console.error("[generate-plan] insert error", { requestId, err: insertError.message });
      return sendJson(res, 200, { ok: true, plan, week_start_date: weekStart, requestId, fallback: true, error: "DB_INSERT_FAILED", model_default: DEFAULT_MODEL, model_fallback: FALLBACK_MODEL });
    }

    return sendJson(res, 200, { ok: true, plan, week_start_date: weekStart, requestId, fallback, model_default: DEFAULT_MODEL, model_fallback: FALLBACK_MODEL });
  } catch (e) {
    const msg = String(e?.message || "GENERATION_FAILED");
    console.error("[generate-plan]", { requestId, msg: msg.slice(0, 150) });
    return sendJson(res, 200, { ok: true, plan: fallbackWeeklyPlan(), week_start_date: getWeekStartDate(), requestId, fallback: true, error: msg, model_default: DEFAULT_MODEL, model_fallback: FALLBACK_MODEL });
  }
};
