/* api/workout.js
   FitAI — Coach Brain (Vercel Serverless, Node 18+)
   Uses Gemini with your server-side key.

   Env required:
   - GEMINI_API_KEY
*/

const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL = "gemini-1.5-flash";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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
    try {
      return JSON.parse(b);
    } catch {
      return null;
    }
  }
  return null;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(Object.assign(new Error(label || "TIMEOUT"), { code: "TIMEOUT" })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function clampText(s, max = 48) {
  const str = String(s || "").trim();
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function buildPrompt({ goal, level, equipment }) {
  const g = clampText(goal || "fullbody");
  const l = clampText(level || "intermediate");
  const e = clampText(equipment || "gym");

  // Prompt “anti coach teubé” : variété + règles + timers
  return [
    "Tu es FitAI Coach (cyberpunk lime/indigo, ton direct).",
    "Tu dois produire une séance VARIÉE (évite les exercices clichés répétés).",
    "",
    "PARAMÈTRES:",
    `- objectif: ${g}`,
    `- niveau: ${l}`,
    `- matériel: ${e}`,
    "",
    "RÈGLES:",
    "- 6 à 9 exercices max.",
    "- Évite de répéter les mêmes exos d'une requête à l'autre : propose des variantes (angle, prise, machine/haltères, unilatéral).",
    "- Mets au moins 1 exercice avec TIMER (ex: gainage, farmer walk, EMOM, intervalles).",
    "- Repos en secondes (rest_seconds).",
    "- Pour chaque exo: sets, reps OU timer_seconds (si timer), et une consigne coaching courte.",
    "- Pas de blabla, pas de markdown.",
    "",
    "SORTIE: JSON STRICT EXACT (rien d'autre):",
    "{",
    '  "title": string,',
    '  "intensity": "low"|"medium"|"high",',
    '  "exercises": [',
    "    {",
    '      "name": string,',
    '      "sets": number,',
    '      "reps": string,',
    '      "timer_seconds": number,',
    '      "rest_seconds": number,',
    '      "cue": string',
    "    }",
    "  ],",
    '  "finisher": { "type": string, "timer_seconds": number, "cue": string }',
    "}",
    "",
    "Contraintes:",
    '- Si un exo est au timer, mets reps="" et timer_seconds > 0.',
    "- Si exo aux reps, mets timer_seconds=0 et reps non vide (ex: \"8-12\").",
    "- sets 1..6, rest_seconds 30..180.",
  ].join("\n");
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function normalizeWorkout(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.exercises) || !obj.exercises.length) return null;

  // minimal sanitize
  const title = typeof obj.title === "string" ? obj.title.trim() : "FitAI Workout";
  const intensity =
    obj.intensity === "low" || obj.intensity === "medium" || obj.intensity === "high"
      ? obj.intensity
      : "medium";

  const exercises = obj.exercises
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const name = typeof x.name === "string" ? x.name.trim() : "";
      const sets = Number(x.sets);
      const reps = typeof x.reps === "string" ? x.reps.trim() : "";
      const timer = Number(x.timer_seconds || 0);
      const rest = Number(x.rest_seconds || 60);
      const cue = typeof x.cue === "string" ? x.cue.trim() : "";

      if (!name) return null;
      if (!Number.isFinite(sets) || sets < 1 || sets > 6) return null;
      const timerOk = Number.isFinite(timer) && timer >= 0 && timer <= 3600;
      const restOk = Number.isFinite(rest) && rest >= 20 && rest <= 600;
      if (!timerOk || !restOk) return null;

      // either reps or timer
      if (timer > 0) {
        return { name, sets, reps: "", timer_seconds: timer, rest_seconds: rest, cue };
      }
      if (!reps) return null;
      return { name, sets, reps, timer_seconds: 0, rest_seconds: rest, cue };
    })
    .filter(Boolean);

  if (!exercises.length) return null;

  const finisher =
    obj.finisher && typeof obj.finisher === "object"
      ? {
          type: typeof obj.finisher.type === "string" ? obj.finisher.type.trim() : "finisher",
          timer_seconds: Number(obj.finisher.timer_seconds || 0) || 0,
          cue: typeof obj.finisher.cue === "string" ? obj.finisher.cue.trim() : "",
        }
      : { type: "finisher", timer_seconds: 0, cue: "" };

  return { title, intensity, exercises, finisher };
}

function toPrettyText(plan) {
  const lines = [];
  lines.push(plan.title);
  lines.push(`Intensité: ${plan.intensity}`);
  lines.push("");

  plan.exercises.forEach((ex, i) => {
    const lineA = `${i + 1}) ${ex.name}`;
    const lineB =
      ex.timer_seconds > 0
        ? `   ${ex.sets} séries • ${ex.timer_seconds}s • repos ${ex.rest_seconds}s`
        : `   ${ex.sets} séries • ${ex.reps} • repos ${ex.rest_seconds}s`;
    lines.push(lineA);
    lines.push(lineB);
    if (ex.cue) lines.push(`   Coach: ${ex.cue}`);
    lines.push("");
  });

  if (plan.finisher && (plan.finisher.timer_seconds > 0 || plan.finisher.cue)) {
    lines.push(`Finisher: ${plan.finisher.type}`);
    if (plan.finisher.timer_seconds > 0) lines.push(`   ${plan.finisher.timer_seconds}s`);
    if (plan.finisher.cue) lines.push(`   Coach: ${plan.finisher.cue}`);
  }

  return lines.join("\n").trim();
}

async function geminiWorkout({ apiKey, goal, level, equipment }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens: 900 },
  });

  const prompt = buildPrompt({ goal, level, equipment });
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.() || "";
  return text;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI" });
  }

  const body = parseBody(req) || {};
  const goal = String(body.goal || "").trim();
  const level = String(body.level || "").trim();
  const equipment = String(body.equipment || "").trim();

  try {
    const text = await withTimeout(
      geminiWorkout({ apiKey: GEMINI_API_KEY, goal, level, equipment }),
      25000,
      "AI_TIMEOUT"
    );

    const parsed = safeJsonExtract(text);
    const plan = normalizeWorkout(parsed);

    if (!plan) {
      // fallback: return raw text for debugging (still useful in your textarea)
      return sendJson(res, 200, { ok: true, workout: String(text || "").trim() || "OK" });
    }

    return sendJson(res, 200, {
      ok: true,
      workout: toPrettyText(plan), // compatible with your current textarea UI
      data: plan,                  // for later: interactive workout UI
      model: MODEL,
    });
  } catch (err) {
    const msg = String(err?.message || "SERVER_ERROR");
    const code = err?.code || "";
    if (code === "TIMEOUT" || msg.includes("TIMEOUT")) {
      return sendJson(res, 504, { ok: false, error: "TIMEOUT" });
    }
    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR" });
  }
};
