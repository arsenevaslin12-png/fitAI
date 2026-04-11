"use strict";
// api/generate-full-program.js — FitAI
// Generates a complete periodized program with real exercises, phases, and progressions.

const { createClient } = require("@supabase/supabase-js");
const { callGeminiText, extractJson } = require("./_gemini");
const { setCors, sendJson, parseBody } = require("./_coach-core");

const TIMEOUT_MS = 28000;

// Rate limit: 3 full programs per hour per user (expensive call)
const _buckets = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const prev = _buckets.get(userId) || [];
  const recent = prev.filter(ts => now - ts < 3_600_000);
  if (recent.length >= 3) return false;
  recent.push(now);
  _buckets.set(userId, recent);
  return true;
}

function getGoalLabel(goal) {
  return {
    prise_de_masse: "prise de masse musculaire (hypertrophie + force)",
    seche: "sèche (préserver le muscle, perdre la graisse)",
    perte_de_poids: "perte de poids",
    force: "développement de la force",
    endurance: "endurance et cardio",
    remise_en_forme: "remise en forme générale",
    maintien: "maintien du niveau",
    equilibre: "équilibre corps + cardio"
  }[String(goal || "").toLowerCase()] || "remise en forme générale";
}

function getLevelLabel(level) {
  return {
    beginner: "débutant",
    debutant: "débutant",
    intermediate: "intermédiaire",
    intermediaire: "intermédiaire",
    advanced: "avancé",
    avance: "avancé"
  }[String(level || "").toLowerCase()] || "débutant";
}

function buildPrompt({ weeks, goal, goalLabel, level, levelLabel, equipment, constraints,
                       age, weight, height, daysPerWeek, bodyFocus }) {

  const hasWeights = /halt[eè]re|barre|salle|machine|kettlebell|banc/i.test(equipment || "");
  const equipNote = hasWeights
    ? `Matériel disponible : ${equipment}. Utilise UNIQUEMENT ce matériel.`
    : "POIDS DU CORPS UNIQUEMENT — interdit : haltères, barres, machines. Exercices sans équipement.";

  // Build phase structure based on duration
  let phaseDesc;
  if (weeks <= 4) {
    phaseDesc = `4 semaines en 2 phases : S1-S2 Apprentissage (3 séries, 8-12 reps, RPE 7), S3-S4 Hypertrophie (4 séries, 6-10 reps, RPE 7-8)`;
  } else if (weeks <= 8) {
    phaseDesc = `${weeks} semaines en 3 phases : S1-S3 Adaptation (3 séries, 8-12 reps, RPE 7), S4-S5 Hypertrophie (4 séries, 6-10 reps, RPE 7-8), S6-${weeks} Force (4 séries, 5-8 reps, RPE 8) + Déload semaine 4`;
  } else {
    phaseDesc = `12 semaines en 4 phases + 1 déload :
- S1-S3 : Apprentissage — 3 séries × 8-12 reps, RPE 7-8, repos 90s, +1-2 reps/semaine
- S4-S6 : Hypertrophie — 4 séries × 6-10 reps, RPE 7-8, repos 100s, charge +10%
- S7 : Déload — 3 séries × 6-8 reps, RPE 5-6, repos 90s (récupération)
- S8-S9 : Force — 4 séries × 5-8 reps, RPE 8, repos 120s, charge max
- S10-S12 : Définition/Intensification — 4 séries × 5-8 reps, RPE 8, repos 120s, charge max +5%`;
  }

  const sessionsPerWeek = Math.min(5, Math.max(2, daysPerWeek || 3));
  const splitNote = sessionsPerWeek === 3
    ? "Split 3 jours : Lundi Upper, Mercredi Lower, Vendredi Upper Focus (bras/épaules)"
    : sessionsPerWeek === 4
    ? "Split 4 jours : Lundi Push, Mercredi Pull, Vendredi Legs, Samedi Core/Cardio"
    : "Split 2 jours : Mercredi Full Body A, Samedi Full Body B";

  return `Tu es un préparateur physique expert. Génère un programme complet et RÉEL de ${weeks} semaines.

PROFIL :
- Âge : ${age || "non renseigné"} ans | Poids : ${weight || "?"}kg | Taille : ${height || "?"}cm
- Objectif : ${goalLabel}
- Niveau : ${levelLabel}
- ${equipNote}
${constraints ? `- Contraintes/blessures : ${constraints}` : ""}
${bodyFocus ? `- Focus corps prioritaire : ${bodyFocus}` : ""}

STRUCTURE :
- Durée : ${weeks} semaines
- Fréquence : ${sessionsPerWeek} séances/semaine
- ${splitNote}
- Durée réelle par séance : 30-38 min (honnête, pas 45-60 min artificiels)

PHASES :
${phaseDesc}

RÈGLES ABSOLUES :
1. Les exercices doivent correspondre EXACTEMENT à l'objectif et au niveau
2. Chaque bloc a 4-6 exercices avec muscle cible clair
3. "duration_sec" = durée d'effort en secondes (pas le repos)
4. Le finisher est court (1 série max) et intense
5. Les notes sont courtes, techniques, actionnables (max 8 mots)
6. Si débutant → exercices simples, peu d'isolation, technique prioritaire
7. Si avancé → exercices composés lourds, supersets possibles, intensité haute

RÉPONDS UNIQUEMENT en JSON valide (aucun texte avant/après, aucun markdown) :
{
  "title": "Programme ${weeks} semaines — ${goalLabel}",
  "weeks": ${weeks},
  "sessions_per_week": ${sessionsPerWeek},
  "nutrition_note": "<conseil nutrition court et personnalisé, max 120 chars>",
  "coach_intro": "<1 phrase de présentation du programme, personnalisée au profil>",
  "phases": [
    {
      "weeks": [1, 2, 3],
      "name": "Apprentissage",
      "sets": 3,
      "reps": "8-12",
      "rpe": "7-8",
      "rest_sec": 90,
      "progression": "<comment progresser cette phase en 1 phrase>",
      "deload": false
    }
  ],
  "weekly_days": {
    "1": "upper",
    "3": "lower",
    "5": "upper_focus"
  },
  "sessions": {
    "upper": {
      "name": "<nom de la séance>",
      "duration_min": 35,
      "warmup": [
        {"n": "<exercice>", "reps": "10", "note": "<conseil court>"}
      ],
      "blocks": [
        {
          "name": "<nom du bloc>",
          "exercises": [
            {"n": "<exercice>", "m": "<muscle>", "note": "<conseil court>", "duration_sec": 40}
          ]
        }
      ],
      "finisher": {"n": "<exercice>", "m": "<muscle>", "reps": "max", "note": "<conseil court>"}
    }
  }
}

EXEMPLES de sessions valides selon le split :
- Split 3j → sessions : "upper", "lower", "upper_focus"
- Split 4j → sessions : "push", "pull", "legs", "core"
- Split 2j → sessions : "fullbody_a", "fullbody_b"

Adapte les weekly_days et sessions au split choisi (${splitNote}).
Chaque session doit avoir 2-3 blocs + finisher. Total exercices par séance : 7-10.
JSON pur, strict, sans texte avant ou après.`;
}

function validateProgram(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) return null;
  if (!obj.sessions || typeof obj.sessions !== "object") return null;
  if (!obj.weekly_days || typeof obj.weekly_days !== "object") return null;
  const sessionKeys = Object.keys(obj.sessions);
  if (sessionKeys.length === 0) return null;

  // Validate each session has blocks with exercises
  for (const key of sessionKeys) {
    const s = obj.sessions[key];
    if (!s || !Array.isArray(s.blocks)) return null;
    if (s.blocks.length === 0) return null;
  }
  // Validate phases have required fields
  for (const p of obj.phases) {
    if (!Array.isArray(p.weeks) || !p.name || !p.sets) return null;
  }
  return obj;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return sendJson(res, 503, { ok: false, error: "SERVER_MISCONFIGURED" });
  if (!GEMINI_API_KEY)
    return sendJson(res, 503, { ok: false, error: "GEMINI_API_KEY manquant" });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendJson(res, 401, { ok: false, error: "Token invalide" });
    userId = user.id;
  } catch {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED" });
  }

  if (!checkRateLimit(userId)) {
    return sendJson(res, 429, { ok: false, error: "Limite atteinte : 3 programmes par heure. Réessaie plus tard." });
  }

  const body = parseBody(req);

  // Fetch user profile + goal if not supplied in body
  const [profileRes, goalRes] = await Promise.allSettled([
    supabase.from("profiles").select("weight,height,age").eq("id", userId).maybeSingle(),
    supabase.from("goals").select("type,level,constraints,equipment").eq("user_id", userId).maybeSingle()
  ]);
  const profile = (profileRes.status === "fulfilled" ? profileRes.value.data : null) || {};
  const goal = (goalRes.status === "fulfilled" ? goalRes.value.data : null) || {};

  // Build context — body params override DB values
  const weeks = Math.min(16, Math.max(4, parseInt(body.weeks || 12, 10) || 12));
  const goalType = String(body.goal || goal.type || "remise_en_forme");
  const level = String(body.level || goal.level || "beginner");
  const equipment = String(body.equipment || goal.equipment || "poids du corps");
  const constraints = String(body.constraints || goal.constraints || "");
  const age = Number(body.age || profile.age || 0) || null;
  const weight = Number(body.weight || profile.weight || 0) || null;
  const height = Number(body.height || profile.height || 0) || null;
  const daysPerWeek = Math.min(5, Math.max(2, parseInt(body.days_per_week || 3, 10) || 3));
  const bodyFocus = String(body.body_focus || "").slice(0, 80);

  const prompt = buildPrompt({
    weeks, goal: goalType, goalLabel: getGoalLabel(goalType),
    level, levelLabel: getLevelLabel(level),
    equipment, constraints, age, weight, height, daysPerWeek, bodyFocus
  });

  try {
    const raw = await callGeminiText({
      apiKey: GEMINI_API_KEY,
      prompt,
      temperature: 0.5,
      maxOutputTokens: 3500,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
      mimeType: "application/json"
    });

    const text = typeof raw?.text === "string" ? raw.text : "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = extractJson(text);
    }

    const program = validateProgram(parsed);
    if (!program) {
      return sendJson(res, 200, { ok: false, error: "FORMAT_INVALID", detail: "Gemini a retourné un format invalide. Réessaie." });
    }

    // Sanitize output lengths
    program.title = String(program.title || "").slice(0, 120);
    program.nutrition_note = String(program.nutrition_note || "").slice(0, 200);
    program.coach_intro = String(program.coach_intro || "").slice(0, 300);
    program.weeks = weeks;
    program.sessions_per_week = daysPerWeek;
    program.generated_at = Date.now();
    program.goal = goalType;
    program.level = level;

    sendJson(res, 200, { ok: true, program });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("429") || msg.includes("quota")) {
      return sendJson(res, 200, { ok: false, error: "QUOTA_EXCEEDED", detail: "Gemini en surcharge. Réessaie dans 1 min." });
    }
    if (err?.code === "TIMEOUT" || msg.includes("TIMEOUT")) {
      return sendJson(res, 200, { ok: false, error: "TIMEOUT", detail: "Gemini a mis trop de temps. Réessaie." });
    }
    sendJson(res, 200, { ok: false, error: "AI_UNAVAILABLE", detail: "Programme IA indisponible. Réessaie." });
  }
};
