"use strict";
// api/workout.js — FitAI Pro v8 — Rate limit robuste + fallback intelligent

const TIMEOUT = 25000;
const MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];

let _AI = null;
const getAI = () => {
  if (_AI) return _AI;
  try { _AI = require("@google/generative-ai").GoogleGenerativeAI; return _AI; }
  catch { return null; }
};

function send(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
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

function extractJSON(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(s.slice(a, z + 1)); } catch { return null; }
}

function normalize(raw) {
  const p = (raw && typeof raw === "object") ? raw : {};
  let blocks = [];

  if (Array.isArray(p.blocks) && p.blocks.length > 0) {
    blocks = p.blocks.map(b => ({
      title: String(b.title || "Bloc"),
      duration_sec: (() => {
        if (typeof b.duration_sec === "number" && b.duration_sec > 0) return Math.round(b.duration_sec);
        if (typeof b.duration_min === "number" && b.duration_min > 0) return Math.round(b.duration_min * 60);
        return 300;
      })(),
      items: (Array.isArray(b.items) ? b.items : []).map(String),
      rpe: String(b.rpe || ""),
    }));
  } else if (Array.isArray(p.exercises) && p.exercises.length > 0) {
    const warmup   = p.exercises.filter(e => /chauff|warm|mobilit/i.test(e.name || ""));
    const cooldown = p.exercises.filter(e => /cool|retour|stretch|recup|repos/i.test(e.name || ""));
    const main     = p.exercises.filter(e => !warmup.includes(e) && !cooldown.includes(e));

    const exToItem = (e) => {
      let line = String(e.name || "Exercice");
      if (e.sets && e.reps) line += ` — ${e.sets}x${e.reps}`;
      else if (e.duration) line += ` — ${e.duration}s`;
      if (e.rest) line += ` (repos ${e.rest}s)`;
      if (e.instructions) line += `. ${e.instructions}`;
      return line;
    };

    if (warmup.length)   blocks.push({ title: "Echauffement",    duration_sec: warmup.length * 90,  items: warmup.map(exToItem),   rpe: "4-5" });
    if (main.length)     blocks.push({ title: "Corps principal",  duration_sec: main.length * 120,   items: main.map(exToItem),     rpe: "7-8" });
    if (cooldown.length) blocks.push({ title: "Recuperation",     duration_sec: cooldown.length * 60, items: cooldown.map(exToItem), rpe: "2-3" });
  }

  if (!blocks.length) {
    blocks = [
      { title: "Echauffement",    duration_sec: 480,  items: ["Mobilite articulaire 5min", "Cardio leger 3min"], rpe: "4-5" },
      { title: "Corps principal",  duration_sec: 1200, items: ["3x10 exercice principal", "3x12 accessoire", "2x15 gainage"], rpe: "7-8" },
      { title: "Recuperation",     duration_sec: 300,  items: ["Etirements 4min", "Respiration abdominale"], rpe: "2-3" },
    ];
  }

  const intMap = { strength:"high", cardio:"medium", hiit:"high", flexibility:"low", recovery:"low", muay_thai:"high" };
  const intensity = p.intensity || intMap[p.type] || "medium";

  return {
    title: String(p.title || "Seance personnalisee"),
    type: String(p.type || "strength"),
    level: String(p.level || "intermediate"),
    intensity: ["low","medium","high"].includes(intensity) ? intensity : "medium",
    duration: typeof p.duration === "number" ? p.duration : Math.round(blocks.reduce((a,b) => a + b.duration_sec, 0) / 60),
    calories_burned: p.calories_burned || null,
    difficulty: typeof p.difficulty === "number" ? Math.min(5, Math.max(1, p.difficulty)) : null,
    notes: p.notes || "",
    created_at: new Date().toISOString(),
    blocks,
  };
}

async function callGemini(key, prompt, modelIndex) {
  const G = getAI();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "DEP" });

  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  console.log("[workout] model:", modelName);

  const model = new G(key).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.65, maxOutputTokens: 1500 },
  });

  let tid;
  const tOut = new Promise((_, r) => {
    tid = setTimeout(() => r(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT);
  });

  const call = model.generateContent(prompt)
    .then(res => { clearTimeout(tid); const t = res?.response?.text; return typeof t === "function" ? t() : String(t || ""); })
    .catch(err => {
      clearTimeout(tid);
      const msg = String(err?.message || "");
      // Only fallback on model-not-found, NOT on 429
      if ((msg.includes("404") || msg.includes("not found") || msg.includes("not supported")) && modelIndex + 1 < MODELS.length) {
        console.warn("[workout] model unavailable, fallback:", MODELS[modelIndex + 1]);
        return callGemini(key, prompt, modelIndex + 1);
      }
      throw err;
    });

  return Promise.race([call, tOut]);
}

function buildPrompt(userPrompt, goal) {
  let p = "Tu es un coach fitness expert. Genere un entrainement JSON.\n";
  p += "Reponds UNIQUEMENT avec du JSON valide. Aucun texte avant ou apres. Aucun markdown.\n\n";

  if (goal && (goal.type || goal.text)) {
    p += "PROFIL:\n";
    if (goal.type) p += `- Objectif: ${goal.type}\n`;
    if (goal.level) p += `- Niveau: ${goal.level}\n`;
    if (goal.text) p += `- Description: ${goal.text}\n`;
    if (goal.constraints) p += `- Contraintes: ${goal.constraints}\n`;
    p += "\n";
  }

  p += `DEMANDE: ${userPrompt}\n\n`;
  p += `FORMAT (3 a 5 blocs, duration_sec = entier > 0 obligatoire):\n`;
  p += `{"title":"Titre","type":"strength|cardio|hiit|flexibility|recovery","level":"beginner|intermediate|advanced","duration":45,"difficulty":3,"calories_burned":350,"intensity":"medium","notes":"conseils","blocks":[{"title":"Echauffement","duration_sec":480,"items":["Mobilite 2min","Cardio leger 3min"],"rpe":"4-5"},{"title":"Principal","duration_sec":1800,"items":["Squat 4x10 repos 90s","Pompes 3x15 repos 60s"],"rpe":"7-8"},{"title":"Recuperation","duration_sec":300,"items":["Etirements 3min"],"rpe":"2-3"}]}`;
  return p;
}

module.exports = async function(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Methode non autorisee" });

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return send(res, 500, { ok: false, error: "GEMINI_API_KEY absent dans Vercel" });

  const b = parseBody(req);
  const prompt = String(b.prompt || "").trim();
  if (!prompt) return send(res, 400, { ok: false, error: "Le champ 'prompt' est requis" });
  if (prompt.length > 2000) return send(res, 400, { ok: false, error: "Prompt trop long (max 2000)" });

  try {
    const text = await callGemini(KEY, buildPrompt(prompt, b.goalContext || null), 0);
    const raw  = extractJSON(text);
    if (!raw) throw new Error("JSON invalide recu de Gemini. Reessayez.");
    const plan = normalize(raw);
    return send(res, 200, { ok: true, data: plan });
  } catch (e) {
    const code = e?.code || "";
    const msg  = String(e?.message || "Erreur");
    console.error("[workout]", msg.slice(0, 180));
    if (code === "TIMEOUT") return send(res, 504, { ok: false, error: "Gemini timeout. Reessayez dans quelques secondes." });
    if (code === "DEP")     return send(res, 500, { ok: false, error: msg });
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) {
      return send(res, 429, { ok: false, error: "Quota Gemini atteint (5 requetes/min en free tier). Attendez 60 secondes avant de reessayer.", retryAfter: 60 });
    }
    if (msg.includes("API key") || msg.includes("403")) return send(res, 502, { ok: false, error: "Cle Gemini invalide. Verifiez GEMINI_API_KEY." });
    if (msg.includes("404") || msg.includes("not found")) return send(res, 502, { ok: false, error: "Modeles Gemini indisponibles pour cette cle API." });
    return send(res, 502, { ok: false, error: msg });
  }
};
