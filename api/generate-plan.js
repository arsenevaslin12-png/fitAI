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

function getWeekStartDate() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  return monday.toISOString().split("T")[0];
}

function buildPlanPrompt(profile) {
  const recovery = profile?.kpis?.recovery || 70;
  const weight = profile?.weight || 75;
  const equipment = profile?.equipment || {};
  const lastWorkoutDays = profile?.last_workout_days || 7;

  const equipList = Object.entries(equipment)
    .filter(([k, v]) => v)
    .map(([k]) => k)
    .join(", ") || "bodyweight";

  return `Tu es FitAI Coach. Génère un plan hebdomadaire (7 jours) STRUCTURÉ et RÉALISTE.

PROFIL:
- Recovery: ${recovery}/100
- Poids: ${weight}kg
- Équipement: ${equipList}
- Dernier workout: il y a ${lastWorkoutDays} jours

RÈGLES STRICTES:
1. Si recovery < 60 → max 2 séances intenses, 3 recovery/cardio léger
2. Si recovery > 80 → max 4 séances intenses
3. Alterner types: Push/Pull/Legs/Cardio/Recovery
4. TOUJOURS inclure 1-2 jours OFF complets
5. Répartir l'intensité: easy/medium/hard/killer

FORMAT JSON UNIQUEMENT (pas de markdown):
{
  "plan": [
    {
      "day": 1,
      "workout_type": "Push (Chest/Shoulders/Triceps)",
      "intensity": "medium",
      "notes": "Volume modéré, focus technique"
    },
    {
      "day": 2,
      "workout_type": "Cardio LISS",
      "intensity": "easy",
      "notes": "30min marche rapide ou vélo"
    }
  ]
}

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

function validatePlan(obj) {
  if (!obj || !Array.isArray(obj.plan)) return null;
  if (obj.plan.length !== 7) return null;

  const validated = obj.plan.map((item, idx) => {
    if (!item || typeof item !== "object") return null;
    
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;

    const workoutType = String(item.workout_type || "").trim();
    if (!workoutType) return null;

    const intensity = String(item.intensity || "medium").trim();
    const notes = String(item.notes || "").trim();

    return {
      day,
      workout_type: workoutType,
      intensity,
      notes,
    };
  }).filter(Boolean);

  if (validated.length !== 7) return null;

  return validated;
}

async function geminiGeneratePlan(apiKey, profile) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 1200 },
  });

  const prompt = buildPlanPrompt(profile);
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  
  const parsed = safeJsonExtract(text);
  return validatePlan(parsed);
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
    console.error("[generate-plan] missing GEMINI_API_KEY", { requestId });
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI", requestId });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[generate-plan] missing Supabase config", { requestId });
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE", requestId });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", detail: "Missing Authorization header", requestId });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });
    }
    userId = user.id;
  } catch (e) {
    console.error("[generate-plan] auth error", { requestId, err: e.message });
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED", requestId });
  }

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("kpis, weight, equipment, last_workout_date")
      .eq("user_id", userId)
      .maybeSingle();

    const lastWorkoutDate = profile?.last_workout_date;
    let lastWorkoutDays = 7;
    if (lastWorkoutDate) {
      try {
        const diff = Date.now() - new Date(lastWorkoutDate).getTime();
        lastWorkoutDays = Math.floor(diff / (24 * 3600 * 1000));
      } catch {}
    }

    const enrichedProfile = {
      ...profile,
      last_workout_days: lastWorkoutDays,
    };

    const plan = await geminiGeneratePlan(GEMINI_API_KEY, enrichedProfile);

    if (!plan) {
      return sendJson(res, 500, { ok: false, error: "PLAN_GENERATION_FAILED", detail: "Invalid plan format", requestId });
    }

    const weekStart = getWeekStartDate();

    const { error: deleteError } = await supabase
      .from("training_schedule")
      .delete()
      .eq("user_id", userId)
      .eq("week_start_date", weekStart);

    if (deleteError) {
      console.error("[generate-plan] delete error", { requestId, err: deleteError });
    }

    const rows = plan.map((item) => ({
      user_id: userId,
      day_of_week: item.day,
      workout_type: item.workout_type,
      intensity: item.intensity,
      status: "planned",
      notes: item.notes,
      week_start_date: weekStart,
    }));

    const { error: insertError } = await supabase
      .from("training_schedule")
      .insert(rows);

    if (insertError) {
      console.error("[generate-plan] insert error", { requestId, err: insertError });
      return sendJson(res, 500, { ok: false, error: "DB_INSERT_FAILED", requestId });
    }

    return sendJson(res, 200, {
      ok: true,
      plan,
      week_start_date: weekStart,
      requestId,
    });

  } catch (e) {
    console.error("[generate-plan] error", { requestId, err: e.message });
    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR", requestId });
  }
};
