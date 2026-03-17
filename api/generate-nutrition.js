"use strict";

// api/generate-nutrition.js
// Fixed: no longer requires SUPABASE_SERVICE_ROLE_KEY — uses anon key + user JWT.

const { createClient } = require("@supabase/supabase-js");
const {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  extractJson,
  callGeminiText,
  normalizeGeminiError
} = require("./_gemini");

const GEMINI_TIMEOUT_MS = 18000;

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

// Pick anon/publishable key — no service role key needed
function pickAnonKey() {
  return (
    String(process.env.SUPABASE_ANON_KEY || "").trim() ||
    String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim() ||
    String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim() ||
    String(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "").trim() ||
    ""
  );
}

function validateNutrition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const nutrition = {
    calories: Math.round(Number(raw.calories)),
    protein: Math.round(Number(raw.protein)),
    carbs: Math.round(Number(raw.carbs)),
    fats: Math.round(Number(raw.fats)),
    notes: String(raw.notes || "").trim() || "Plan généré automatiquement."
  };
  if (!Number.isFinite(nutrition.calories) || nutrition.calories < 1200 || nutrition.calories > 4500) return null;
  if (!Number.isFinite(nutrition.protein) || nutrition.protein < 70 || nutrition.protein > 320) return null;
  if (!Number.isFinite(nutrition.carbs) || nutrition.carbs < 50 || nutrition.carbs > 550) return null;
  if (!Number.isFinite(nutrition.fats) || nutrition.fats < 30 || nutrition.fats > 180) return null;
  return nutrition;
}

function fallbackNutrition(weight = 75, goal = "maintenance", activity = "moderate") {
  const activityFactor = activity === "high" ? 34 : activity === "low" ? 28 : 31;
  const base = Math.round(weight * activityFactor);
  const normalizedGoal = String(goal || "maintenance").toLowerCase();
  const calories = normalizedGoal === "cut" || normalizedGoal === "perte_de_poids"
    ? base - 350
    : normalizedGoal === "bulk" || normalizedGoal === "prise_de_masse"
      ? base + 250
      : base;
  const protein = Math.round(weight * (normalizedGoal.includes("cut") || normalizedGoal.includes("perte") ? 2.1 : 1.8));
  const fats = Math.round(weight * 0.9);
  const carbs = Math.max(100, Math.round((calories - (protein * 4 + fats * 9)) / 4));
  return { calories, protein, carbs, fats, notes: "Plan nutrition de secours généré automatiquement." };
}

function buildPrompt(profile) {
  return `Tu es un nutritionniste sportif.
Génère des objectifs de macros en JSON strict.

RÈGLES:
- adapte au poids, à l'objectif et à l'activité
- donne calories, protéines, glucides, lipides
- ajoute une note courte pratique
- aucun markdown
- aucune phrase hors JSON

FORMAT UNIQUE:
{"calories":2400,"protein":160,"carbs":280,"fats":70,"notes":"..."}

PROFIL:
${JSON.stringify(profile)}`;
}

async function callGemini(apiKey, profile) {
  const result = await callGeminiText({
    apiKey,
    prompt: buildPrompt(profile),
    temperature: 0.35,
    maxOutputTokens: 500,
    timeoutMs: GEMINI_TIMEOUT_MS,
    retries: 1
  });
  // Try extracting JSON — tolerant parsing
  const parsed = extractJson(result.text);
  const nutrition = validateNutrition(parsed);
  if (!nutrition) {
    // Last-ditch: try relaxing bounds slightly
    if (parsed && typeof parsed === "object") {
      const relaxed = {
        calories: Math.round(Math.max(1200, Math.min(4500, Number(parsed.calories) || 2000))),
        protein:  Math.round(Math.max(70,   Math.min(320,  Number(parsed.protein)  || 140))),
        carbs:    Math.round(Math.max(50,   Math.min(550,  Number(parsed.carbs)    || 240))),
        fats:     Math.round(Math.max(30,   Math.min(180,  Number(parsed.fats)     || 70))),
        notes:    String(parsed.notes || "Plan généré par IA.").trim()
      };
      return { nutrition: relaxed, model: result.model };
    }
    throw new Error("INVALID_NUTRITION_JSON");
  }
  return { nutrition, model: result.model };
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", requestId });

  const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const ANON_KEY = pickAnonKey();

  if (!SUPABASE_URL || !ANON_KEY) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_MISCONFIG_SUPABASE",
      message: "Variables manquantes: SUPABASE_URL et SUPABASE_ANON_KEY (ou SUPABASE_PUBLISHABLE_KEY). Configurez-les dans Vercel → Settings → Environment Variables.",
      requestId
    });
  }

  // Verify JWT using anon key — Supabase auth server validates the token
  const authClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  const userId = authData?.user?.id;
  if (authError || !userId) {
    return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });
  }

  // User-scoped client: passes JWT so RLS policies apply correctly
  const supabase = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });

  const body = parseBody(req);
  const { GEMINI_API_KEY } = process.env;

  try {
    const { data: profileData } = await supabase
      .from("profiles")
      .select("weight")
      .eq("id", userId)
      .maybeSingle();

    const payload = {
      weight: Number(profileData?.weight || 75),
      goal: String(body.goal || "maintenance"),
      activity_level: String(body.activity_level || "moderate")
    };

    const result = GEMINI_API_KEY
      ? await callGemini(GEMINI_API_KEY, payload)
      : { nutrition: fallbackNutrition(payload.weight, payload.goal, payload.activity_level), model: "fallback:no-key" };

    const upsert = await supabase.from("nutrition_targets").upsert({
      user_id: userId,
      calories: result.nutrition.calories,
      protein:  result.nutrition.protein,
      carbs:    result.nutrition.carbs,
      fats:     result.nutrition.fats,
      notes:    result.nutrition.notes,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    if (upsert.error) {
      // DB save failed but we still have the nutrition — return it anyway
      console.error("[generate-nutrition] upsert error:", upsert.error.message);
    }

    return sendJson(res, 200, {
      ok: true,
      requestId,
      nutrition: result.nutrition,
      model: result.model,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL,
      saved: !upsert.error
    });

  } catch (e) {
    const fallback = fallbackNutrition(
      75,
      String(body.goal || "maintenance"),
      String(body.activity_level || "moderate")
    );
    const info = normalizeGeminiError(e);
    return sendJson(res, 200, {
      ok: true,
      requestId,
      nutrition: fallback,
      fallback: true,
      error: info.message,
      error_code: info.code,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL
    });
  }
};
