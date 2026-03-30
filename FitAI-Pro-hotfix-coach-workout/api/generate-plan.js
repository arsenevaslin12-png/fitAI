"use strict";
// api/generate-plan.js — FitAI Pro v6.0.0
// 8-week periodized program with full profile context

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

// ── 8-week periodization ────────────────────────────────────────────────────
const PHASES = [
  { week: 1, phase: "Adaptation",   desc: "Volume léger, apprentissage technique, RPE 5-6. Focus: forme correcte sur chaque mouvement." },
  { week: 2, phase: "Hypertrophie", desc: "Volume modéré, 8-12 reps, RPE 6-7. Augmenter 1 rep ou 2-5% de charge vs semaine 1." },
  { week: 3, phase: "Hypertrophie", desc: "Volume élevé, 8-12 reps, RPE 7-8. Pic de volume du cycle, séries supplémentaires." },
  { week: 4, phase: "Deload",       desc: "Décharge : réduire le volume de 40%, garder la technique. Repos actif, mobilité, récupération." },
  { week: 5, phase: "Force",        desc: "Charges lourdes, 5-6 reps, RPE 7-8. Repos plus longs (2-3 min). Exercices composés prioritaires." },
  { week: 6, phase: "Force",        desc: "Charges lourdes, 4-6 reps, RPE 8. Augmenter la charge de 2-5% vs semaine 5." },
  { week: 7, phase: "Puissance",    desc: "Intensité max, 3-5 reps sur composés + travail explosif. RPE 8-9." },
  { week: 8, phase: "Test & Récup", desc: "Test de max ou séance intense réduite + récupération. Bilan du cycle." },
];

function getPhaseInfo(weekNum) {
  return PHASES[(weekNum - 1) % 8] || PHASES[0];
}

function computeCycleWeek(existingWeeks) {
  // Count how many distinct weeks already exist → next week number
  const count = existingWeeks || 0;
  return ((count) % 8) + 1;
}

// ── Goal & level descriptions ───────────────────────────────────────────────
function getGoalDesc(goal) {
  const m = {
    prise_de_masse: "hypertrophie, surcharge progressive, gros composés",
    perte_de_poids: "déficit calorique, circuit, métabolique, HIIT",
    endurance: "cardio, séries longues, tolérance à l'effort",
    force: "exercices de base lourds, repos long, 3-6 reps",
    remise_en_forme: "progression douce, technique, adhérence",
    maintien: "variété, volume modéré, plaisir"
  };
  return m[String(goal || "").toLowerCase()] || m.remise_en_forme;
}

function getLevelDesc(level) {
  const m = {
    beginner: "débutant → exercices simples, volume modéré, 3 séances/sem max",
    debutant: "débutant → exercices simples, volume modéré, 3 séances/sem max",
    intermediate: "intermédiaire → techniques variées, 4-5 séances/sem, splits possibles",
    intermediaire: "intermédiaire → techniques variées, 4-5 séances/sem, splits possibles",
    advanced: "avancé → périodisation fine, 5-6 séances/sem, techniques avancées (drop sets, supersets)",
    avance: "avancé → périodisation fine, 5-6 séances/sem, techniques avancées (drop sets, supersets)"
  };
  return m[String(level || "").toLowerCase()] || m.beginner;
}

function getSessionCount(level) {
  const l = String(level || "").toLowerCase();
  if (l === "advanced" || l === "avance") return "5-6";
  if (l === "intermediate" || l === "intermediaire") return "4-5";
  return "3-4";
}

function buildPlanPrompt(ctx) {
  const { weight, height, goal, goalDesc, level, levelDesc, equipment, constraints,
    lastWorkoutDays, totalSessions, streak, weekNum, phase } = ctx;

  const sessRange = getSessionCount(level);

  return `Tu es un préparateur physique expert. Génère le PLAN DE LA SEMAINE ${weekNum}/8 d'un programme structuré.

═══ PROFIL ═══
- Poids: ${weight || "?"}kg | Taille: ${height || "?"}cm
- Objectif: ${goal || "remise_en_forme"} → ${goalDesc}
- Niveau: ${level || "beginner"} → ${levelDesc}
- Équipement: ${equipment || "poids du corps"}
- Contraintes/blessures: ${constraints || "aucune"}
- Séances totales réalisées: ${totalSessions}
- Streak actuel: ${streak} jours
- Dernier workout: il y a ${lastWorkoutDays} jour(s)

═══ PHASE ACTUELLE ═══
Semaine ${weekNum}/8 — Phase "${phase.phase}"
${phase.desc}

═══ STRUCTURE DU CYCLE 8 SEMAINES ═══
S1: Adaptation (volume léger, technique)
S2-S3: Hypertrophie (volume progressif, 8-12 reps)
S4: Deload (−40% volume, récupération)
S5-S6: Force (charges lourdes, 4-6 reps)
S7: Puissance (intensité max, explosivité)
S8: Test & Récupération (bilan, max, récup)

═══ RÈGLES ═══
1. ${sessRange} séances d'entraînement + ${phase.phase === "Deload" ? "3 jours OFF" : "1-2 jours OFF"}
2. Alterner intelligemment: Push/Pull/Legs/Upper/Lower/Full/Cardio/HIIT
3. Respecter la phase "${phase.phase}" : ${phase.desc}
4. Adapter au niveau "${level || "beginner"}" et à l'objectif "${goal || "remise_en_forme"}"
5. Respecter les contraintes : ${constraints || "aucune"}
6. ÉQUIPEMENT STRICT: ${/halt[eè]re|barre|salle|machine|kettlebell|banc/i.test(equipment || "") ? `Utilise UNIQUEMENT: ${equipment}. N'inclus pas d'équipement non mentionné.` : "POIDS DU CORPS UNIQUEMENT — INTERDIT: haltères, barres, kettlebell, machines. Exercices sans matériel uniquement (pompes, squats, tractions, fentes, gainage…)."}
7. Le notes doit contenir 2-3 exercices clés + consignes spécifiques à la phase
7. Si dernier workout > 5 jours : réintégration progressive

═══ FORMAT JSON STRICT (aucun markdown, aucun texte avant/après) ═══
{"plan":[
  {"day":1,"workout_type":"Push (Pecs/Épaules/Triceps)","intensity":"medium","notes":"Dvl couché 4×8, Dvl militaire 3×10, Dips 3×max — Focus technique, RPE 6-7"},
  {"day":2,"workout_type":"Cardio LISS","intensity":"easy","notes":"30min vélo ou marche rapide — Récupération active"},
  {"day":3,"workout_type":"Pull (Dos/Biceps)","intensity":"medium","notes":"Tractions 4×6, Rowing 3×10, Curl 3×12 — Contrôle excentrique"},
  {"day":4,"workout_type":"REST","intensity":"easy","notes":"Repos complet ou mobilité 15min"},
  {"day":5,"workout_type":"Legs","intensity":"hard","notes":"Squat 4×8, Presse 3×12, Fentes 3×10/jambe — Volume élevé"},
  {"day":6,"workout_type":"HIIT","intensity":"hard","notes":"20min Tabata : burpees, KB swings, mountain climbers"},
  {"day":7,"workout_type":"REST","intensity":"easy","notes":"Repos complet + étirements"}
]}

Adapte les exercices, le volume et l'intensité à la PHASE "${phase.phase}" (semaine ${weekNum}).
JSON pur uniquement.`;
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
    generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
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
    // Fetch all profile data in parallel
    const [profileRes, goalRes, lastWsRes, streakRes, weekCountRes] = await Promise.all([
      supabase.from("profiles").select("weight,height").eq("id", userId).maybeSingle(),
      supabase.from("goals").select("type,level,text,constraints,equipment").eq("user_id", userId).maybeSingle(),
      supabase.from("workout_sessions").select("created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("user_streaks").select("current_streak,total_workouts").eq("user_id", userId).maybeSingle(),
      // Count distinct weeks to determine cycle position
      supabase.from("training_schedule").select("week_start_date")
        .eq("user_id", userId).order("week_start_date", { ascending: false }).limit(50),
    ]);

    const profile = profileRes.data;
    const goal = goalRes.data;
    const lastWs = lastWsRes.data;
    const streakData = streakRes.data;

    let lastWorkoutDays = 7;
    if (lastWs?.created_at) {
      try { lastWorkoutDays = Math.max(0, Math.floor((Date.now() - new Date(lastWs.created_at).getTime()) / (24 * 3600 * 1000))); } catch {}
    }

    // Count distinct weeks already generated
    const distinctWeeks = new Set((weekCountRes.data || []).map(r => r.week_start_date)).size;
    const weekNum = computeCycleWeek(distinctWeeks);
    const phase = getPhaseInfo(weekNum);

    const goalType = goal?.type || "remise_en_forme";
    const levelVal = goal?.level || "beginner";

    const ctx = {
      weight: profile?.weight || 75,
      height: profile?.height || null,
      goal: goalType,
      goalDesc: getGoalDesc(goalType),
      level: levelVal,
      levelDesc: getLevelDesc(levelVal),
      equipment: goal?.equipment || "poids du corps",
      constraints: goal?.constraints || "aucune",
      lastWorkoutDays,
      totalSessions: streakData?.total_workouts || 0,
      streak: streakData?.current_streak || 0,
      weekNum,
      phase,
    };

    const text = await callGemini(GEMINI_API_KEY, buildPlanPrompt(ctx), 0);
    const parsed = safeJsonExtract(text);
    const plan = validatePlan(parsed);

    if (!plan) return sendJson(res, 500, { ok: false, error: "Format plan invalide retourné par Gemini. Réessayez.", requestId });

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

    return sendJson(res, 200, {
      ok: true,
      plan,
      week_start_date: weekStart,
      week_number: weekNum,
      phase: phase.phase,
      requestId,
    });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[generate-plan]", { requestId, code, msg: msg.slice(0, 150) });
    if (code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "Gemini timeout. Réessayez.", requestId });
    if (code === "DEP") return sendJson(res, 500, { ok: false, error: msg, requestId });
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) return sendJson(res, 429, { ok: false, error: "Quota Gemini atteint. Attendez 60 secondes.", retryAfter: 60, requestId });
    return sendJson(res, 502, { ok: false, error: msg || "Erreur serveur", requestId });
  }
};
