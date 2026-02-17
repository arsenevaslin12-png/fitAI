const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL = "gemini-1.5-flash";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(label || "TIMEOUT"), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function normalizeWorkout(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.exercises) || !obj.exercises.length) return null;

  const note = typeof obj.note === "string" ? obj.note.trim() : "";
  const exercises = obj.exercises.map((x) => {
    if (!x || typeof x !== "object") return null;
    const name = typeof x.name === "string" ? x.name.trim() : "";
    const duration = Number(x.duration || 0) || 0;
    const rest = Number(x.rest || 0) || 0;
    const sets = Number(x.sets || 0) || 0;
    const reps = typeof x.reps === "string" ? x.reps.trim() : "";
    const rpe = Number(x.rpe || 0) || 0;

    if (!name) return null;
    if (sets < 1 || sets > 10) return null;
    if (rest < 0 || rest > 600) return null;
    if (duration < 0 || duration > 3600) return null;
    if (rpe < 0 || rpe > 10) return null;

    // either duration or reps
    if (duration > 0) return { name, duration, rest: rest || 10, sets, reps: "", rpe: rpe || 8 };
    if (!reps) return null;
    return { name, duration: 0, rest: rest || 90, sets, reps, rpe: rpe || 8 };
  }).filter(Boolean);

  if (!exercises.length) return null;
  return { type: "workout", note, exercises };
}

function toPrettyText(plan) {
  const lines = [];
  if (plan.note) lines.push(plan.note, "");
  plan.exercises.forEach((ex, i) => {
    lines.push(`${i + 1}) ${ex.name}`);
    if (ex.duration > 0) lines.push(`   ${ex.sets} séries • ${ex.duration}s • repos ${ex.rest}s`);
    else lines.push(`   ${ex.sets} séries • ${ex.reps} • repos ${ex.rest}s`);
    lines.push(`   RPE ${ex.rpe}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

async function geminiText({ apiKey, prompt }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens: 900 },
  });

  const result = await model.generateContent(String(prompt || ""));
  const text = result?.response?.text?.() || "";
  return text;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // ✅ CONFIG GET for front
  if (req.method === "GET") {
    const isConfig = String(req.query?.config || "") === "1";
    if (!isConfig) return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY; // publishable key

    if (!supabaseUrl || !supabaseAnonKey) {
      return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE_PUBLIC" });
    }
    return sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI" });

  const body = parseBody(req) || {};
  const prompt = String(body.prompt || "").trim();

  if (!prompt) {
    return sendJson(res, 400, { ok: false, error: "MISSING_PROMPT" });
  }

  try {
    const text = await withTimeout(geminiText({ apiKey: GEMINI_API_KEY, prompt }), 25000, "AI_TIMEOUT");

    const parsed = safeJsonExtract(text);
    const plan = normalizeWorkout(parsed);

    if (!plan) {
      // fallback: still useful
      return sendJson(res, 200, { ok: true, workout: String(text || "").trim() || "OK", data: null, model: MODEL });
    }

    return sendJson(res, 200, {
      ok: true,
      workout: toPrettyText(plan),
      data: plan,
      model: MODEL,
    });
  } catch (err) {
    const msg = String(err?.message || "SERVER_ERROR");
    const code = err?.code || "";
    if (code === "TIMEOUT" || msg.includes("TIMEOUT")) return sendJson(res, 504, { ok: false, error: "TIMEOUT" });
    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR" });
  }
};
