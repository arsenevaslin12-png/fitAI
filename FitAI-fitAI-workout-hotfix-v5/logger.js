"use strict";
// api/workout.js — FitAI Pro v2.0 — Enhanced AI Coach

const TIMEOUT = 25000;
const MAX_PROMPT_LENGTH = 2000;

const MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
];

let _AI = null;
const getAI = () => {
  if (_AI) return _AI;
  try { _AI = require("@google/generative-ai").GoogleGenerativeAI; return _AI; }
  catch { return null; }
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function send(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

function sanitizeInput(input, maxLength = 1000) {
  if (typeof input !== "string") return "";
  return input
    .slice(0, maxLength)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+=/gi, "")
    .trim();
}

function extractJSON(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(s.slice(a, z + 1)); } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ══════════════════════════════════════════════════════════════════════════════

function getLevelDescription(level) {
  const descriptions = {
    beginner: "Moins de 6 mois d'entraînement. Focus: technique et habitude.",
    debutant: "Moins de 6 mois d'entraînement. Focus: technique et habitude.",
    intermediate: "6-24 mois d'entraînement. Maîtrise les mouvements de base.",
    intermediaire: "6-24 mois d'entraînement. Maîtrise les mouvements de base.",
    advanced: "2+ ans d'entraînement. Excellente technique, cherche optimisation.",
    avance: "2+ ans d'entraînement. Excellente technique, cherche optimisation."
  };
  return descriptions[level?.toLowerCase()] || descriptions.beginner;
}

function getGoalDescription(goal) {
  const goals = {
    prise_de_masse: "Développer la masse musculaire. Favoriser exercices composés, charges lourdes, 8-12 reps.",
    perte_de_poids: "Perdre du gras. Circuits, supersets, cardio intégré, 12-20 reps.",
    endurance: "Améliorer l'endurance. Travail cardio, séries longues, peu de repos.",
    force: "Développer la force. Charges lourdes, 3-6 reps, repos longs.",
    remise_en_forme: "Remise en forme générale. Programme équilibré, progression douce.",
    maintien: "Maintenir la condition actuelle. Programme modéré et varié.",
    muay_thai: "Conditionnement arts martiaux. Explosivité, cardio, core.",
    flexibility: "Améliorer la souplesse. Stretching, mobilité, yoga."
  };
  return goals[goal?.toLowerCase()] || goals.remise_en_forme;
}

function buildAdvancedPrompt(userRequest, profile) {
  const systemContext = `Tu es un coach fitness certifié avec 15 ans d'expérience.
Tu crées des programmes d'entraînement scientifiquement fondés et adaptés.

RÈGLES ABSOLUES:
1. Respecte TOUJOURS les blessures et limitations mentionnées
2. Adapte l'intensité au niveau exact de l'utilisateur
3. Inclus TOUJOURS un échauffement progressif (5-10 min) et une récupération (5 min)
4. Varie les groupes musculaires si plusieurs jours sont prévus
5. Indique des alternatives pour chaque exercice principal
6. Ne dépasse JAMAIS la durée demandée

PROFIL UTILISATEUR:
- Objectif: ${profile.goal || "remise en forme"} → ${getGoalDescription(profile.goal)}
- Niveau: ${profile.level || "débutant"} → ${getLevelDescription(profile.level)}
- Équipement disponible: ${profile.equipment || "poids du corps uniquement"}
- Jours d'entraînement/semaine: ${profile.days_per_week || 3}
- Durée souhaitée par séance: ${profile.session_duration || 45} minutes
- Blessures/Limitations: ${profile.injuries || "aucune connue"}
${profile.age ? `- Âge: ${profile.age} ans` : ""}
${profile.experience_years ? `- Expérience: ${profile.experience_years} ans` : ""}`;

  const outputFormat = `
RÉPONDS UNIQUEMENT en JSON valide, aucun texte avant ou après, aucun markdown:
{
  "title": "Nom de la séance (court et motivant)",
  "type": "strength|cardio|hiit|flexibility|functional|recovery",
  "target_muscles": ["groupe1", "groupe2"],
  "level": "beginner|intermediate|advanced",
  "duration_min": 45,
  "calories_estimate": 350,
  "intensity": "low|medium|high",
  "equipment_needed": ["équipement1", "équipement2"],
  "warmup": {
    "duration_min": 8,
    "exercises": [
      {"name": "Exercice", "duration_sec": 60, "reps": null, "notes": "Instructions"}
    ]
  },
  "main_workout": {
    "structure": "straight_sets|supersets|circuits|emom|amrap",
    "rounds": 3,
    "rest_between_rounds_sec": 90,
    "exercises": [
      {
        "name": "Nom de l'exercice",
        "sets": 4,
        "reps": "10-12",
        "rest_sec": 60,
        "tempo": "2-0-2",
        "rpe": 7,
        "tips": "Conseil technique important",
        "alternatives": ["Alternative 1", "Alternative 2"]
      }
    ]
  },
  "cooldown": {
    "duration_min": 5,
    "exercises": [
      {"name": "Étirement", "duration_sec": 45, "side": "each|both"}
    ]
  },
  "coach_notes": "Conseils de progression et notes importantes",
  "next_session_suggestion": "Type de séance recommandée pour la prochaine fois"
}`;

  return `${systemContext}\n\nDEMANDE DE L'UTILISATEUR: ${userRequest}\n\n${outputFormat}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// NORMALIZE OUTPUT
// ══════════════════════════════════════════════════════════════════════════════

function normalizeWorkoutOutput(raw) {
  const p = (raw && typeof raw === "object") ? raw : {};

  // Build blocks from new structure
  let blocks = [];

  // Warmup block
  if (p.warmup && Array.isArray(p.warmup.exercises)) {
    const warmupItems = p.warmup.exercises.map(e => {
      let line = String(e.name || "Exercice");
      if (e.duration_sec) line += ` — ${Math.round(e.duration_sec / 60)} min`;
      else if (e.reps) line += ` — ${e.reps} reps`;
      if (e.notes) line += `. ${e.notes}`;
      return line;
    });
    blocks.push({
      title: "Échauffement",
      duration_sec: (p.warmup.duration_min || 8) * 60,
      items: warmupItems,
      rpe: "3-4"
    });
  }

  // Main workout block
  if (p.main_workout && Array.isArray(p.main_workout.exercises)) {
    const mainItems = p.main_workout.exercises.map(e => {
      let line = String(e.name || "Exercice");
      if (e.sets && e.reps) line += ` — ${e.sets}×${e.reps}`;
      else if (e.duration_sec) line += ` — ${e.duration_sec}s`;
      if (e.rest_sec) line += ` (repos ${e.rest_sec}s)`;
      if (e.tips) line += `. ${e.tips}`;
      return line;
    });

    const structure = p.main_workout.structure || "straight_sets";
    const structureLabel = {
      straight_sets: "Séries classiques",
      supersets: "Supersets",
      circuits: "Circuit",
      emom: "EMOM",
      amrap: "AMRAP"
    }[structure] || "Principal";

    blocks.push({
      title: structureLabel,
      duration_sec: Math.max(1200, mainItems.length * 120),
      items: mainItems,
      rpe: p.intensity === "high" ? "8-9" : p.intensity === "low" ? "5-6" : "7-8",
      structure,
      rounds: p.main_workout.rounds,
      rest_between_rounds_sec: p.main_workout.rest_between_rounds_sec
    });
  }

  // Cooldown block
  if (p.cooldown && Array.isArray(p.cooldown.exercises)) {
    const cooldownItems = p.cooldown.exercises.map(e => {
      let line = String(e.name || "Étirement");
      if (e.duration_sec) line += ` — ${e.duration_sec}s`;
      if (e.side === "each") line += " (chaque côté)";
      return line;
    });
    blocks.push({
      title: "Récupération",
      duration_sec: (p.cooldown.duration_min || 5) * 60,
      items: cooldownItems,
      rpe: "2-3"
    });
  }

  // Fallback if no blocks were created
  if (!blocks.length) {
    // Try legacy format
    if (Array.isArray(p.blocks) && p.blocks.length > 0) {
      blocks = p.blocks.map(b => ({
        title: String(b.title || "Bloc"),
        duration_sec: typeof b.duration_sec === "number" ? b.duration_sec : 300,
        items: Array.isArray(b.items) ? b.items.map(String) : [],
        rpe: String(b.rpe || "6-7")
      }));
    } else {
      // Ultimate fallback
      blocks = [
        { title: "Échauffement", duration_sec: 480, items: ["Mobilité articulaire 5min", "Cardio léger 3min"], rpe: "4-5" },
        { title: "Corps principal", duration_sec: 1200, items: ["3×10 exercice principal", "3×12 accessoire", "2×15 gainage"], rpe: "7-8" },
        { title: "Récupération", duration_sec: 300, items: ["Étirements 4min", "Respiration abdominale"], rpe: "2-3" }
      ];
    }
  }

  // Build notes
  const notesParts = [
    p.coach_notes || "",
    p.calories_estimate ? `🔥 ~${p.calories_estimate} kcal estimées` : "",
    p.next_session_suggestion ? `📅 Prochaine séance: ${p.next_session_suggestion}` : ""
  ].filter(Boolean);

  return {
    title: String(p.title || "Séance personnalisée"),
    type: String(p.type || "strength"),
    level: String(p.level || "intermediate"),
    intensity: ["low", "medium", "high"].includes(p.intensity) ? p.intensity : "medium",
    duration: typeof p.duration_min === "number" ? p.duration_min : Math.round(blocks.reduce((a, b) => a + b.duration_sec, 0) / 60),
    calories_estimate: p.calories_estimate || null,
    target_muscles: Array.isArray(p.target_muscles) ? p.target_muscles : [],
    equipment_needed: Array.isArray(p.equipment_needed) ? p.equipment_needed : [],
    notes: notesParts.join(" · "),
    created_at: new Date().toISOString(),
    blocks,
    // Keep detailed structure for future use
    _detailed: {
      warmup: p.warmup || null,
      main_workout: p.main_workout || null,
      cooldown: p.cooldown || null
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI API
// ══════════════════════════════════════════════════════════════════════════════

async function callGemini(key, prompt, modelIndex) {
  const G = getAI();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "DEP" });

  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  console.log("[workout] Using model:", modelName);

  const model = new G(key).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.6, maxOutputTokens: 2000 }
  });

  let tid;
  const tOut = new Promise((_, r) => {
    tid = setTimeout(() => r(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT);
  });

  const call = model.generateContent(prompt)
    .then(res => {
      clearTimeout(tid);
      const t = res?.response?.text;
      return typeof t === "function" ? t() : String(t || "");
    })
    .catch(async err => {
      clearTimeout(tid);
      const msg = String(err?.message || "");
      // Try fallback model
      if ((msg.includes("404") || msg.includes("not found") || msg.includes("not supported")) && modelIndex + 1 < MODELS.length) {
        console.warn("[workout] Model unavailable, fallback to:", MODELS[modelIndex + 1]);
        return callGemini(key, prompt, modelIndex + 1);
      }
      throw err;
    });

  return Promise.race([call, tOut]);
}

async function generateWithRetry(key, prompt, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const text = await callGemini(key, prompt, 0);
      const parsed = extractJSON(text);

      if (parsed) {
        return { ok: true, data: parsed };
      }

      lastError = new Error("Invalid JSON response from AI");
    } catch (e) {
      lastError = e;

      // Don't retry on auth/quota errors
      const msg = String(e?.message || "");
      if (msg.includes("403") || msg.includes("API key") || msg.includes("429")) {
        break;
      }

      // Exponential backoff
      if (i < maxRetries - 1) {
        await sleep(Math.pow(2, i) * 500);
      }
    }
  }

  return { ok: false, error: lastError?.message || "Generation failed" };
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════════

module.exports = async function(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Méthode non autorisée" });

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return send(res, 500, { ok: false, error: "GEMINI_API_KEY absent dans Vercel → Settings → Environment Variables" });

  const body = parseBody(req);

  // Sanitize and validate input
  const prompt = sanitizeInput(body.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) return send(res, 400, { ok: false, error: "Le champ 'prompt' est requis" });

  // Build profile from request + goalContext
  const goalContext = body.goalContext || {};
  const profile = {
    goal: sanitizeInput(body.goal || goalContext.type || "", 50),
    level: sanitizeInput(body.level || goalContext.level || "beginner", 20),
    equipment: sanitizeInput(body.equipment || "poids du corps", 200),
    days_per_week: Math.min(7, Math.max(1, parseInt(body.days_per_week) || 3)),
    session_duration: Math.min(180, Math.max(15, parseInt(body.duration) || 45)),
    injuries: sanitizeInput(body.injuries || goalContext.constraints || "aucune", 300),
    age: body.age ? Math.min(120, Math.max(10, parseInt(body.age))) : null,
    experience_years: body.experience_years ? Math.min(50, Math.max(0, parseInt(body.experience_years))) : null
  };

  try {
    const fullPrompt = buildAdvancedPrompt(prompt, profile);
    const result = await generateWithRetry(KEY, fullPrompt, 3);

    if (!result.ok) {
      return send(res, 502, { ok: false, error: result.error });
    }

    const workout = normalizeWorkoutOutput(result.data);
    return send(res, 200, { ok: true, data: workout });

  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "Erreur");
    console.error("[workout]", { code, msg: msg.slice(0, 180) });

    if (code === "TIMEOUT") return send(res, 504, { ok: false, error: "Gemini timeout. Réessayez." });
    if (code === "DEP") return send(res, 500, { ok: false, error: msg });
    if (msg.includes("429") || msg.includes("quota")) return send(res, 429, { ok: false, error: "Quota Gemini dépassé. Attendez quelques secondes." });
    if (msg.includes("API key") || msg.includes("403")) return send(res, 502, { ok: false, error: "Clé Gemini invalide. Vérifiez GEMINI_API_KEY." });
    return send(res, 502, { ok: false, error: msg });
  }
};
