// api/workout.js — FitAI Pro v3.4.0
"use strict";

const TIMEOUT_MS = 25000;
const MAX_PROMPT = 2000;

let _GeminiClass = null;
function getGemini() {
  if (_GeminiClass) return _GeminiClass;
  try { _GeminiClass = require("@google/generative-ai").GoogleGenerativeAI; return _GeminiClass; }
  catch { return null; }
}

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp";

function json(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
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

function normalizePlan(raw) {
  const p = (raw && typeof raw === "object") ? raw : {};
  const blocks = (Array.isArray(p.blocks) ? p.blocks : []).map(b => {
    if (!b || typeof b !== "object") return null;
    let dur = typeof b.duration_sec === "number" && b.duration_sec > 0 ? b.duration_sec
            : typeof b.duration_min === "number" && b.duration_min > 0 ? b.duration_min * 60
            : 300;
    return { title: String(b.title || "Block"), duration_sec: Math.max(10, dur), items: (Array.isArray(b.items) ? b.items : []).map(String), rpe: b.rpe || "" };
  }).filter(Boolean);

  if (!blocks.length) blocks.push(
    { title: "Échauffement", duration_sec: 480, items: ["Mobilité articulaire", "Cardio léger"], rpe: "4-5" },
    { title: "Travail principal", duration_sec: 1500, items: ["3×10 exercice principal", "3×12 accessoire"], rpe: "7-8" },
    { title: "Récupération", duration_sec: 300, items: ["Étirements", "Respiration"], rpe: "2-3" }
  );

  return {
    title: String(p.title || "Séance générée"),
    intensity: String(p.intensity || "medium"),
    notes: String(p.notes || ""),
    created_at: new Date().toISOString(),
    blocks
  };
}

async function callGemini(apiKey, prompt) {
  const G = getGemini();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "MISSING_DEP" });

  const model = new G(apiKey).getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.6, maxOutputTokens: 1000 }
  });

  let tid;
  const timeout = new Promise((_, rej) => { tid = setTimeout(() => rej(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT_MS); });
  const call = model.generateContent(prompt).then(r => {
    clearTimeout(tid);
    const t = r?.response?.text;
    return typeof t === "function" ? t() : String(t || "");
  });
  return Promise.race([call, timeout]);
}

function buildPrompt(userPrompt, goal) {
  let p = "Tu es un coach fitness expert. Réponds UNIQUEMENT avec du JSON valide, sans markdown, sans texte avant ou après.\n\n";
  if (goal) {
    p += `Contexte utilisateur:\n- Objectif: ${goal.type || ""}\n- Niveau: ${goal.level || ""}\n- Description: ${goal.text || ""}\n- Contraintes: ${goal.constraints || "aucune"}\n\n`;
  }
  p += `Demande: ${userPrompt}\n\n`;
  p += `Format JSON attendu (respecte exactement cette structure):\n`;
  p += `{"title":"Titre de la séance","intensity":"low|medium|high","notes":"conseils généraux","blocks":[{"title":"Nom du bloc","duration_sec":600,"items":["Exercice 1 — 3x10","Exercice 2 — 2 min"],"rpe":"6-7"}]}\n`;
  p += `Inclure 3 à 5 blocs. duration_sec = entier positif obligatoire.`;
  return p;
}

module.exports = async function(req, res) {
  cors(res);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", id });

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY manquant dans Vercel", id });

  const body = parseBody(req);
  const prompt = String(body.prompt || "").trim();
  const goal = body.goalContext || null;

  if (!prompt) return json(res, 400, { ok: false, error: "prompt requis", id });
  if (prompt.length > MAX_PROMPT) return json(res, 400, { ok: false, error: `prompt trop long (max ${MAX_PROMPT})`, id });

  try {
    const text = await callGemini(KEY, buildPrompt(prompt, goal));
    const plan = normalizePlan(safeJsonExtract(text));
    return json(res, 200, { ok: true, data: plan, id });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[workout]", { id, code, msg: msg.slice(0, 100) });
    if (code === "TIMEOUT") return json(res, 504, { ok: false, error: "Timeout Gemini — réessayez", id });
    if (code === "MISSING_DEP") return json(res, 500, { ok: false, error: msg, id });
    if (msg.includes("429") || msg.includes("quota")) return json(res, 429, { ok: false, error: "Quota Gemini dépassé", id });
    return json(res, 502, { ok: false, error: msg || "Erreur Gemini", id });
  }
};
