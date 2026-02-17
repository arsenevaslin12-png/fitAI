const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

function sendJson(res, status, payload) {
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
  if (!b) return null;
  if (typeof b === "object") return b;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return null; }
  }
  return null;
}

function buildNutritionPrompt(profile) {
  const weight = profile?.weight || 75;
  const bodyfatProxy = profile?.bodyfat_proxy || null;
  const goal = profile?.goal || "maintenance";
  const activityLevel = profile?.activity_level || "moderate";

  let bodyfatInfo = "";
  if (bodyfatProxy && bodyfatProxy > 0) {
    bodyfatInfo = `Bodyfat estimé: ${bodyfatProxy}%`;
  }

  return `Tu es FitAI Nutrition Coach. Génère des macros nutritionnelles PRÉCISES et RÉALISTES.

PROFIL:
- Poids: ${weight}kg
${bodyfatInfo}
- Objectif: ${goal}
- Niveau activité: ${activityLevel}

RÈGLES STRICTES:
1. Calories basées sur poids × facteur d'activité
2. Protéines: minimum 1.6g/kg, jusqu'à 2.2g/kg si cut
3. Lipides: minimum 0.8g/kg, max 1.2g/kg
4. Glucides: le reste des calories
5. Si cut → déficit 300-500kcal, si bulk → surplus 200-400kcal

FORMAT JSON UNIQUEMENT (pas de markdown):
{
  "calories": 2400,
  "protein": 160,
  "carbs": 280,
  "fats": 70,
  "notes": "Maintenance modéré. Ajuste selon progression."
}

Valide que:
- calories entre 1500 et 4000
- protein entre 100 et 300
- carbs entre 100 et 500
- fats entre 40 et 150

NE PAS inclure de blabla, juste le JSON pur.`;
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function validateNutrition(obj) {
  if (!obj || typeof obj !== "object") return null;

  const calories = Number(obj.calories);
  const protein = Number(obj.protein);
  const carbs = Number(obj.carbs);
  const fats = Number(obj.fats);

  if (!Number.isInteger(calories) || calories < 1500 || calories > 4000) return null;
  if (!Number.isInteger(protein) || protein < 100 || protein > 300) return null;
  if (!Number.isInteger(carbs) || carbs < 100 || carbs > 500) return null;
  if (!Number.isInteger(fats) || fats < 40 || fats > 150) return null;

  const totalCals = (protein * 4) + (carbs * 4) + (fats * 9);
  if (Math.abs(totalCals - calories) > 100) return null;

  return {
    calories,
    protein,
    carbs,
    fats,
    notes: String(obj.notes || "").trim() || "Plan généré automatiquement.",
  };
}

async function geminiGenerateNutrition(apiKey, profile) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 600 },
  });

  const prompt = buildNutritionPrompt(profile);
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  
  const parsed = safeJsonExtract(text);
  return validateNutrition(parsed);
}

module.exports = async function handler(req, res) {
  setCors(res);

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!GEMINI_API_KEY) {
    console.error("[generate-nutrition] missing GEMINI_API_KEY", { requestId });
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI", requestId });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[generate-nutrition] missing Supabase config", { requestId });
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE", requestId });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", detail: "Missing Authorization header", requestId });
  }

  const body = parseBody(req) || {};
  const goalOverride = body.goal || null;
  const activityOverride = body.activity_level || null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });
    }
    userId = user.id;
  } catch (e) {
    console.error("[generate-nutrition] auth error", { requestId, err: e.message });
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED", requestId });
  }

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("weight, kpis")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: latestScan } = await supabase
      .from("body_scans")
      .select("bodyfat_proxy")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const enrichedProfile = {
      weight: profile?.weight || 75,
      bodyfat_proxy: latestScan?.bodyfat_proxy || null,
      goal: goalOverride || "maintenance",
      activity_level: activityOverride || "moderate",
    };

    const nutrition = await geminiGenerateNutrition(GEMINI_API_KEY, enrichedProfile);

    if (!nutrition) {
      return sendJson(res, 500, { ok: false, error: "NUTRITION_GENERATION_FAILED", detail: "Invalid nutrition format", requestId });
    }

    const updateResult = await supabase
      .from("nutrition_targets")
      .update({
        calories: nutrition.calories,
        protein: nutrition.protein,
        carbs: nutrition.carbs,
        fats: nutrition.fats,
        notes: nutrition.notes,
      })
      .eq("user_id", userId)
      .select("user_id")
      .maybeSingle();

    if (!updateResult.error && updateResult.data?.user_id) {
      return sendJson(res, 200, {
        ok: true,
        nutrition,
        requestId,
      });
    }

    const insertResult = await supabase
      .from("nutrition_targets")
      .insert({
        user_id: userId,
        calories: nutrition.calories,
        protein: nutrition.protein,
        carbs: nutrition.carbs,
        fats: nutrition.fats,
        notes: nutrition.notes,
      });

    if (insertResult.error) {
      console.error("[generate-nutrition] insert error", { requestId, err: insertResult.error });
      return sendJson(res, 500, { ok: false, error: "DB_INSERT_FAILED", requestId });
    }

    return sendJson(res, 200, {
      ok: true,
      nutrition,
      requestId,
    });

  } catch (e) {
    console.error("[generate-nutrition] error", { requestId, err: e.message });
    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR", requestId });
  }
}; 
