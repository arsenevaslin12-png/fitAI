"use strict";
// api/generate-full-program.js — FitAI
// Generates a complete periodized program with real exercises, phases, and progressions.

const { createClient } = require("@supabase/supabase-js");
const { callGeminiText, extractJson } = require("./_gemini");
const { setCors, sendJson, parseBody } = require("./_coach-core");

const TIMEOUT_MS = 55000;

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
    force: "développement de la force max",
    endurance: "endurance et cardio",
    remise_en_forme: "remise en forme générale",
    maintien: "maintien du niveau actuel",
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

// Exercise bank by muscle group, goal and equipment — used to steer Gemini quality
function getExerciseBank(hasWeights, goal) {
  if (!hasWeights) {
    return {
      upper: ["Pompes déclinées", "Pompes diamant", "Pompes archer", "Dips entre chaises",
              "Pompes pike", "Planche abdominale", "Gainage latéral", "Superman dos"],
      lower: ["Squat bulgare", "Fentes avant alternées", "Pont fessier unilatéral",
              "Squat sumo", "Nordic curl", "Step-up chaise", "Calf raises unilatéral"],
      core:  ["Crunch bicycle", "Mountain climbers", "Hollow body hold", "L-sit chaise",
              "Dragon flag progression", "Pallof press élastique"]
    };
  }
  const mass = /prise_de_masse|force/.test(goal);
  return {
    compound: mass
      ? ["Développé couché barre", "Rowing barre pronation", "Squat barre haute", "Soulevé de terre",
         "Développé militaire barre", "Tractions lestées", "Développé incliné haltères", "Hip thrust barre"]
      : ["Développé couché haltères", "Rowing haltères unilatéral", "Goblet squat", "Soulevé de terre roumain",
         "Développé épaules haltères", "Tractions assistées", "Fentes marchées haltères"],
    isolation: ["Curl barre EZ", "Curl haltères alterné", "Extension triceps poulie haute", "Kickback triceps",
                "Élévations latérales haltères", "Leg extension", "Leg curl", "Crunch câble", "Face pull poulie"],
    core: ["Crunch câble poulie", "Relevé de jambes suspendu", "Gainage planche", "Russian twist lest",
           "Ab wheel rollout", "Pallof press poulie"]
  };
}

function buildPrompt({ weeks, goal, goalLabel, level, levelLabel, equipment, constraints,
                       age, weight, height, daysPerWeek, bodyFocus }) {

  const hasWeights = /halt[eè]re|barre|salle|machine|kettlebell|banc|haltère/i.test(equipment || "");
  const equipNote = hasWeights
    ? `Matériel disponible : ${equipment}. Utilise UNIQUEMENT ce matériel.`
    : "POIDS DU CORPS UNIQUEMENT — absolument interdit : haltères, barres, machines, kettlebells. Exercices au poids du corps uniquement.";

  const bank = getExerciseBank(hasWeights, goal);
  const bankExamples = hasWeights
    ? `Exemples d'exercices de qualité pour ce profil :
  - Composés : ${bank.compound.slice(0, 5).join(", ")}
  - Isolation : ${bank.isolation.slice(0, 5).join(", ")}
  - Core : ${bank.core.slice(0, 4).join(", ")}`
    : `Exemples d'exercices poids du corps :
  - Haut du corps : ${bank.upper.join(", ")}
  - Bas du corps : ${bank.lower.join(", ")}
  - Core : ${bank.core.join(", ")}`;

  // Phase structure by duration
  let phaseDesc, weeklyProgression;
  if (weeks <= 4) {
    phaseDesc = `2 phases :
- S1-S2 : Fondations — 3 séries × 10-12 reps, RPE 7, repos 75s, tempo 2-1-2-0 (apprendre le mouvement)
- S3-S4 : Intensification — 4 séries × 8-10 reps, RPE 7-8, repos 90s, tempo 3-1-2-0 (charge +5%)`;
    weeklyProgression = `S1 : tester les charges · S2 : +1-2 reps · S3 : +5% charge · S4 : charge max RPE 8`;
  } else if (weeks <= 8) {
    phaseDesc = `3 phases :
- S1-S3 : Adaptation — 3 séries × 10-12 reps, RPE 7, repos 75s, tempo 2-0-2-0 (technique prioritaire)
- S4 : Déload — 2 séries × 10 reps, RPE 5-6, repos 90s (récupération obligatoire)
- S5-S6 : Hypertrophie — 4 séries × 8-10 reps, RPE 7-8, repos 90s, tempo 3-1-2-0 (charge +10%)
- S7-${weeks} : Force-Hypertrophie — 4 séries × 5-8 reps, RPE 8-9, repos 120s (charges lourdes)`;
    weeklyProgression = `S1 : calibration charges · S2-S3 : +1 rep/sem · S4 : déload · S5 : +10% · S6 : +5% · S7-S8 : charges max`;
  } else {
    phaseDesc = `4 phases + 1 déload :
- S1-S3 : Apprentissage — 3 séries × 10-15 reps, RPE 6-7, repos 75s, tempo 2-1-2-0
  → Progression : +1-2 reps par semaine, ne pas forcer la charge
- S4-S6 : Hypertrophie — 4 séries × 8-12 reps, RPE 7-8, repos 90-100s, tempo 3-1-2-0
  → Progression : +5% charge S4→S5, +5% S5→S6, ajouter 1 série si RPE < 7
- S7 : Déload — 3 séries × 8-10 reps, RPE 5-6, repos 90s (charge -30%, technique parfaite)
- S8-S9 : Force — 4 séries × 5-8 reps, RPE 8-9, repos 120s, tempo 3-1-1-0
  → Progression : charge max (80-85% 1RM), +2.5kg si toutes les reps complètes
- S10-S12 : Intensification — 4-5 séries × 4-6 reps, RPE 9, repos 150s, tempo 3-0-1-0
  → Progression : charge max (87-92% 1RM) · dernière semaine : test 1RM sur composés principaux`;
    weeklyProgression = `S1-3 : +1-2 reps/sem · S4-6 : +5%/sem · S7 : déload -30% · S8-9 : 80-85%1RM · S10-12 : 87-92%1RM`;
  }

  const sessionsPerWeek = Math.min(5, Math.max(2, daysPerWeek || 3));
  let splitNote, splitExample;
  if (sessionsPerWeek >= 4) {
    splitNote = "Split 4 jours PPL+Core : Lundi Push, Mercredi Pull, Vendredi Legs, Samedi Core/Finishers";
    splitExample = `"weekly_days": {"1":"push","3":"pull","5":"legs","6":"core"}`;
  } else if (sessionsPerWeek === 3) {
    splitNote = "Split 3 jours Upper/Lower/Upper : Lundi Upper A, Mercredi Lower, Vendredi Upper B (focus bras/épaules)";
    splitExample = `"weekly_days": {"1":"upper_a","3":"lower","5":"upper_b"}`;
  } else {
    splitNote = "Split 2 jours Full Body : Mercredi Full Body A (dominante Pectoraux+Quadri), Samedi Full Body B (dominante Dos+Ischio)";
    splitExample = `"weekly_days": {"3":"fullbody_a","6":"fullbody_b"}`;
  }

  const isIntermediate = /interm|avancé|advanced/.test(levelLabel);
  const tempoRule = isIntermediate
    ? "Tempo OBLIGATOIRE pour chaque exercice composé (format X-X-X-X : excentrique-pause basse-concentrique-pause haute)"
    : "Tempo simple pour les composés (ex: 2-1-2-0 = 2s descente, 1s pause, 2s montée, 0s pause haute)";

  return `Tu es un préparateur physique expert niveau compétition (NSCA-CSCS). Génère un programme COMPLET et PROFESSIONNEL de ${weeks} semaines.

━━━ PROFIL ATHLÈTE ━━━
- Âge : ${age ? `${age} ans` : "non renseigné"} | Poids : ${weight ? `${weight}kg` : "?"} | Taille : ${height ? `${height}cm` : "?"}
- Objectif prioritaire : ${goalLabel}
- Niveau : ${levelLabel}
- ${equipNote}
${constraints ? `- Contraintes/blessures : ${constraints} → adapter les exercices en conséquence` : ""}
${bodyFocus ? `- Focus corps prioritaire : ${bodyFocus} → 40% du volume sur ce groupe` : ""}

━━━ STRUCTURE DU PROGRAMME ━━━
- Durée totale : ${weeks} semaines
- Fréquence : ${sessionsPerWeek} séances/semaine
- Split : ${splitNote}
- Durée réelle par séance : 35-45 min (pas d'artifice)

━━━ PÉRIODISATION ━━━
${phaseDesc}

━━━ RÈGLES QUALITÉ ABSOLUES ━━━
1. EXERCICES RÉELS UNIQUEMENT : noms complets et précis (ex: "Développé couché haltères" pas "exercice pectoraux")
2. ${tempoRule}
3. Chaque exercice a ses propres sets/reps SI différents de la phase (ex: composés 4×5, isolation 3×12)
4. load_note = indication de charge PRATIQUE ("80% 1RM", "RPE 8", "poids où tu fais 3 reps de plus", "max technique")
5. Les notes sont TECHNIQUES et ACTIONNABLES : "omoplates serrées, coudes à 45°, descente contrôlée 3s"
6. Finisher = 1 exercice INTENSE, court, douloureux au bon sens (max 3 min)
7. Warmup = 3-4 exercices SPÉCIFIQUES à la séance (pas génériques)
8. INTERDIT : "Exercice X", "Mouvement Y", noms génériques, exercices sans matériel si hasWeights=true

${bankExamples}

━━━ PROGRESSION SEMAINE PAR SEMAINE ━━━
${weeklyProgression}

━━━ FORMAT JSON OBLIGATOIRE (sans texte avant/après, sans markdown) ━━━
{
  "title": "Programme ${weeks} semaines — ${goalLabel}",
  "weeks": ${weeks},
  "sessions_per_week": ${sessionsPerWeek},
  "goal": "${goal}",
  "level": "${level}",
  "nutrition_note": "<conseil nutrition PERSONNALISÉ et précis, max 140 chars — pas de banalité>",
  "coach_intro": "<présentation engageante du programme, ce qui le rend unique pour CE profil, max 200 chars>",
  "phases": [
    {
      "weeks": [1, 2, 3],
      "name": "Apprentissage",
      "sets": 3,
      "reps": "10-12",
      "rpe": "6-7",
      "rest_sec": 75,
      "tempo": "2-1-2-0",
      "load_guideline": "Charge à 65-70% du 1RM estimé, ou RPE 6-7 sur les séries de travail",
      "progression": "Ajouter 1-2 reps par semaine. Quand tu atteins la borne haute → augmenter la charge de 5%.",
      "deload": false
    },
    {
      "weeks": [7],
      "name": "Déload",
      "sets": 3,
      "reps": "8-10",
      "rpe": "5-6",
      "rest_sec": 90,
      "tempo": "2-0-2-0",
      "load_guideline": "Réduire les charges de 30-40%. Priorité à la technique parfaite.",
      "progression": "Semaine de récupération — ne pas chercher la progression, écouter le corps.",
      "deload": true
    }
  ],
  "weekly_days": {
    "1": "upper_a",
    "3": "lower",
    "5": "upper_b"
  },
  "sessions": {
    "upper_a": {
      "name": "Upper A — Pecs & Triceps",
      "focus": "Pectoraux, Triceps, Épaules antérieures",
      "duration_min": 40,
      "warmup": [
        {"n": "Rotation épaules avec bande", "reps": "15", "note": "Activation rotateurs, amplitude complète"},
        {"n": "Push-ups tempo lent", "reps": "10", "note": "Activation pecs et stabilisateurs"},
        {"n": "Face pull bande élastique", "reps": "15", "note": "Préparation coiffe des rotateurs"}
      ],
      "blocks": [
        {
          "name": "Bloc 1 — Composés Pectoraux",
          "exercises": [
            {
              "n": "Développé couché haltères",
              "m": "Pecs",
              "sets": 4,
              "reps": "8-10",
              "tempo": "3-1-2-0",
              "load_note": "80% 1RM — coudes à 45° du tronc, descente 3s contrôlée",
              "note": "Omoplates rétractées et déprimées, arc naturel maintenu"
            },
            {
              "n": "Développé incliné haltères 30°",
              "m": "Pecs haut",
              "sets": 3,
              "reps": "10-12",
              "tempo": "3-0-2-0",
              "load_note": "RPE 7-8 — dernier rep difficile mais technique intacte",
              "note": "Angle 30° max, ne pas perdre la rétraction des omoplates"
            }
          ]
        },
        {
          "name": "Bloc 2 — Isolation & Triceps",
          "exercises": [
            {
              "n": "Écarté haltères plat",
              "m": "Pecs",
              "sets": 3,
              "reps": "12-15",
              "tempo": "3-1-2-0",
              "load_note": "Poids léger — sensation d'étirement maximale en bas",
              "note": "Légère flexion des coudes fixe, descente jusqu'au niveau des épaules"
            },
            {
              "n": "Dips entre chaises ou barres",
              "m": "Triceps",
              "sets": 3,
              "reps": "10-12",
              "tempo": "2-1-2-0",
              "load_note": "Poids du corps ou lest si trop facile",
              "note": "Torse légèrement incliné en avant pour focus pecs, coudes près du corps"
            }
          ]
        }
      ],
      "finisher": {
        "n": "Drop-set pompes pieds surélevés",
        "m": "Pecs",
        "reps": "max → max → max (30s repos)",
        "note": "3 séries sans repos vrai, descendre les pieds à chaque drop"
      }
    }
  }
}

EXEMPLES sessions selon le split choisi (${splitNote}) :
${splitExample.replace(/"/g, '"')}

RÈGLES FINALES :
- Chaque session : 3 blocs minimum + finisher + warmup spécifique
- Total exercices par séance : 8-11 (warmup inclus)
- Les sets/reps PAR EXERCICE peuvent DIFFÉRER de la phase (composés = plus de charge/moins de reps)
- Toutes les sessions doivent être présentes et complètes dans "sessions"
- JSON pur UNIQUEMENT — aucun texte avant, aucun texte après, aucun bloc markdown`;
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
    for (const b of s.blocks) {
      if (!Array.isArray(b.exercises) || b.exercises.length === 0) return null;
    }
  }
  // Validate phases have required fields
  for (const p of obj.phases) {
    if (!Array.isArray(p.weeks) || !p.name || !p.sets) return null;
  }
  // Validate weekly_days keys match sessions
  const validSessionKeys = new Set(sessionKeys);
  for (const [, v] of Object.entries(obj.weekly_days)) {
    if (v !== "rest" && !validSessionKeys.has(v)) return null;
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

  // Fetch user profile + goal from Supabase (body params override DB values)
  const [profileRes, goalRes] = await Promise.allSettled([
    supabase.from("profiles").select("weight,height,age").eq("id", userId).maybeSingle(),
    supabase.from("goals").select("type,level,constraints,equipment").eq("user_id", userId).maybeSingle()
  ]);
  const profile = (profileRes.status === "fulfilled" ? profileRes.value.data : null) || {};
  const goal = (goalRes.status === "fulfilled" ? goalRes.value.data : null) || {};

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
      temperature: 0.3,
      maxOutputTokens: 7000,
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
      return sendJson(res, 200, { ok: false, error: "FORMAT_INVALID", detail: "Programme invalide retourné par l'IA. Réessaie." });
    }

    // Sanitize top-level fields
    program.title = String(program.title || "").slice(0, 120);
    program.nutrition_note = String(program.nutrition_note || "").slice(0, 200);
    program.coach_intro = String(program.coach_intro || "").slice(0, 300);
    program.weeks = weeks;
    program.sessions_per_week = daysPerWeek;
    program.generated_at = Date.now();
    program.goal = goalType;
    program.level = level;

    // Sanitize exercises within sessions
    for (const key of Object.keys(program.sessions)) {
      const s = program.sessions[key];
      s.name = String(s.name || key).slice(0, 80);
      if (s.focus) s.focus = String(s.focus).slice(0, 100);
      for (const b of (s.blocks || [])) {
        b.name = String(b.name || "").slice(0, 80);
        for (const ex of (b.exercises || [])) {
          ex.n = String(ex.n || "").slice(0, 80);
          ex.m = String(ex.m || "").slice(0, 40);
          if (ex.note) ex.note = String(ex.note).slice(0, 120);
          if (ex.tempo) ex.tempo = String(ex.tempo).slice(0, 15);
          if (ex.load_note) ex.load_note = String(ex.load_note).slice(0, 100);
        }
      }
      if (s.finisher) {
        s.finisher.n = String(s.finisher.n || "").slice(0, 80);
        if (s.finisher.note) s.finisher.note = String(s.finisher.note).slice(0, 120);
      }
    }

    sendJson(res, 200, { ok: true, program });
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("429") || msg.includes("quota")) {
      return sendJson(res, 200, { ok: false, error: "QUOTA_EXCEEDED", detail: "Gemini en surcharge. Réessaie dans 1 min." });
    }
    if (err?.code === "TIMEOUT" || msg.includes("TIMEOUT") || msg.includes("abort")) {
      return sendJson(res, 200, { ok: false, error: "TIMEOUT", detail: "Génération trop longue. Réessaie." });
    }
    console.error("[generate-full-program]", msg.slice(0, 200));
    sendJson(res, 200, { ok: false, error: "AI_UNAVAILABLE", detail: "Programme IA indisponible. Réessaie." });
  }
};
