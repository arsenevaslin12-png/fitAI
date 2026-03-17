"use strict";
// api/generate-nutrition.js — FitAI Pro v5.0.0
// Fixed: profiles PK is "id" not "user_id", timeout, model fallback

const TIMEOUT = 25000;
const MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];

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

function buildNutritionPrompt(profile) {
  const weight = profile.weight || 75;
  const height = profile.height || 178;
  const goal = profile.goal || "maintenance";
  const activityLevel = profile.activity_level || "moderate";
  const bodyfat = profile.bodyfat_proxy;

  let bf = "";
  if (bodyfat && bodyfat > 0) bf = `Bodyfat estime: ${bodyfat}%\n`;

  return `Tu es FitAI Nutrition Coach. Genere des macros nutritionnelles PRECISES et REALISTES.

PROFIL:
- Poids: ${weight}kg
- Taille: ${height}cm
${bf}- Objectif: ${goal}
- Niveau activite: ${activityLevel}

REGLES STRICTES:
1. Utilise l'equation Mifflin-St Jeor pour estimer le metabolisme de base
2. Proteines: minimum 1.6g/kg, jusqu'a 2.2g/kg si cut
3. Lipides: minimum 0.8g/kg, max 1.2g/kg
4. Glucides: le reste des calories
5. Si cut: deficit 300-500kcal, si bulk: surplus 200-400kcal

FORMAT JSON UNIQUEMENT (pas de markdown):
{"calories":2400,"protein":160,"carbs":280,"fats":70,"notes":"Maintenance modere. Ajuste selon progression."}

Valide que:
- calories entre 1200 et 5000
- protein entre 80 et 350
- carbs entre 50 et 600
- fats entre 30 et 200

NE PAS inclure de blabla, juste le JSON pur.`;
}

function validateNutrition(obj) {
  if (!obj || typeof obj !== "object") return null;
  const calories = Math.round(Number(obj.calories));
  const protein = Math.round(Number(obj.protein));
  const carbs = Math.round(Number(obj.carbs));
  const fats = Math.round(Number(obj.fats));
  if (!calories || calories < 1200 || calories > 5000) return null;
  if (!protein || protein < 80 || protein > 350) return null;
  if (!carbs || carbs < 50 || carbs > 600) return null;
  if (!fats || fats < 30 || fats > 200) return null;
  return {
    calories, protein, carbs, fats,
    notes: String(obj.notes || "").trim() || "Plan genere automatiquement."
  };
}

async function callGemini(apiKey, prompt, modelIndex) {
  const G = getAI();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "DEP" });

  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  const model = new G(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.5, maxOutputTokens: 600 }
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

  if (!GEMINI_API_KEY) return sendJson(res, 500, { ok: false, error: "GEMINI_API_KEY manquant dans Vercel", requestId });
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

  const body = parseBody(req);

  try {
    // profiles PK is "id", not "user_id"
    const { data: profile } = await supabase
      .from("profiles").select("weight, height").eq("id", userId).maybeSingle();

    const { data: latestScan } = await supabase
      .from("body_scans").select("bodyfat_proxy")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();

    const enrichedProfile = {
      weight: profile?.weight || 75,
      height: profile?.height || 178,
      bodyfat_proxy: latestScan?.bodyfat_proxy || null,
      goal: body.goal || "maintenance",
      activity_level: body.activity_level || "moderate",
    };

    const text = await callGemini(GEMINI_API_KEY, buildNutritionPrompt(enrichedProfile), 0);
    const parsed = safeJsonExtract(text);
    const nutrition = validateNutrition(parsed);

    if (!nutrition) return sendJson(res, 500, { ok: false, error: "Format nutrition invalide retourne par Gemini. Reessayez.", requestId });

    // Upsert into nutrition_targets
    const { error: upsertErr } = await supabase
      .from("nutrition_targets")
      .upsert({
        user_id: userId,
        calories: nutrition.calories,
        protein: nutrition.protein,
        carbs: nutrition.carbs,
        fats: nutrition.fats,
        notes: nutrition.notes,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });

    if (upsertErr) {
      console.error("[generate-nutrition] upsert error", { requestId, err: upsertErr.message });
    }

    return sendJson(res, 200, { ok: true, nutrition, requestId });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[generate-nutrition]", { requestId, code, msg: msg.slice(0, 150) });
    if (code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "Gemini timeout. Reessayez.", requestId });
    if (code === "DEP") return sendJson(res, 500, { ok: false, error: msg, requestId });
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) return sendJson(res, 429, { ok: false, error: "Quota Gemini atteint. Attendez 60 secondes.", retryAfter: 60, requestId });
    if (msg.includes("API key") || msg.includes("403")) return sendJson(res, 502, { ok: false, error: "Cle Gemini invalide.", requestId });
    return sendJson(res, 502, { ok: false, error: msg || "Erreur serveur", requestId });
  }
};
