// api/workout.js — Vercel Node Serverless (CommonJS)
//
// Env required:
// - SUPABASE_URL
// - SUPABASE_ANON_KEY
// - SUPABASE_SERVICE_ROLE_KEY
// - GEMINI_KEY
//
// Endpoint:
// - GET  /api/workout?config=1  => returns SUPABASE_URL + SUPABASE_ANON_KEY for frontend
// - POST /api/workout          => JWT required. Generates workout via Gemini + overload computation.

const { createClient } = require("@supabase/supabase-js");

const CLIENT_TOKEN = "fitai-v18";
const MODEL = "gemini-1.5-flash";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function httpError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}

function getQuery(req, key) {
  try {
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get(key);
  } catch {
    return null;
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * Moteur de surcharge (pro):
 * - RPE < 8  => +10%
 * - RPE = 10 => -5%
 * - sinon => stable
 * - Math.round() pour une cible propre
 */
function computeNextReps(prevReps, rpe) {
  const reps = Number(prevReps);
  const rp = Number(rpe);

  if (!Number.isFinite(reps) || reps <= 0) return null;
  if (!Number.isFinite(rp)) return Math.round(reps);

  if (rp < 8) return Math.round(reps * 1.10);
  if (rp === 10) return Math.round(reps * 0.95);
  return Math.round(reps);
}

function sanitizePrompt(s) {
  return String(s || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, 1600);
}

async function callGemini({ apiKey, promptText, responseSchema }) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.6,
      maxOutputTokens: 900
    }
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const err = new Error(`gemini_http_${r.status}`);
    err.detail = txt.slice(0, 400);
    throw err;
  }

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") throw new Error("gemini_no_text");

  return JSON.parse(text);
}

function isProgramShape(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.title !== "string") return false;
  if (!["light", "moderate", "hard"].includes(p.intensity)) return false;
  if (!Number.isFinite(Number(p.rest))) return false;
  if (typeof p.notes !== "string") return false;
  if (!Array.isArray(p.exercises) || p.exercises.length < 1) return false;

  for (const ex of p.exercises) {
    if (!ex || typeof ex !== "object") return false;
    if (typeof ex.name !== "string") return false;
    if (typeof ex.muscle !== "string") return false;
    if (!Number.isFinite(Number(ex.sets))) return false;
    if (typeof ex.reps !== "string") return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  // CORS permissif (à durcir si besoin)
  const origin = req.headers.origin || "";
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-FitAI-Client");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_KEY;

  const clientHeader = String(req.headers["x-fitai-client"] || "");
  if (clientHeader !== CLIENT_TOKEN) return httpError(res, 401, "client_forbidden", "Invalid client token");

  // Frontend config
  if (req.method === "GET") {
    if (getQuery(req, "config") !== "1") return httpError(res, 404, "not_found", "Not found");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return httpError(res, 500, "server_misconfig", "Missing Supabase env");
    return sendJson(res, 200, { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
  }

  if (req.method !== "POST") return httpError(res, 405, "method_not_allowed", "Method not allowed");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_KEY) {
    return httpError(res, 500, "server_misconfig", "Missing required env vars");
  }

  // JWT check (Supabase)
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return httpError(res, 401, "auth_missing", "Missing bearer token");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const userRes = await admin.auth.getUser(token);
  if (userRes.error || !userRes.data?.user?.id) return httpError(res, 401, "jwt_invalid", "Unauthorized");
  const userId = userRes.data.user.id;

  // Body
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return httpError(res, 400, "bad_json", "Invalid JSON");
  }

  const prompt = sanitizePrompt(body?.prompt);
  if (!prompt) return httpError(res, 400, "prompt_missing", "Missing prompt");

  const prevReps = body?.overload?.prevReps;
  const rpe = body?.overload?.rpe;
  const nextReps = computeNextReps(prevReps, rpe);

  // Schema Gemini (sortie JSON propre)
  const responseSchema = {
    type: "OBJECT",
    required: ["title", "rest", "intensity", "notes", "exercises"],
    properties: {
      title: { type: "STRING" },
      rest: { type: "INTEGER" },
      intensity: { type: "STRING", enum: ["light", "moderate", "hard"] },
      notes: { type: "STRING" },
      exercises: {
        type: "ARRAY",
        minItems: 3,
        maxItems: 10,
        items: {
          type: "OBJECT",
          required: ["name", "muscle", "sets", "reps"],
          properties: {
            name: { type: "STRING" },
            muscle: { type: "STRING" },
            sets: { type: "INTEGER" },
            reps: { type: "STRING" }
          }
        }
      }
    }
  };

  const overloadLine =
    (nextReps != null)
      ? `Surcharge auto: dernière perf=${Math.round(Number(prevReps))} reps à RPE=${Number(rpe)}. Prochaine cible=${nextReps} reps.`
      : `Surcharge auto: aucune perf précédente fournie, séance standard.`;

  const promptText =
`Tu es un coach sportif concis et précis.
Tu DOIS produire une réponse STRICTEMENT au format JSON (aucun texte hors JSON).

Règles:
- 3 à 8 exercices
- rest entre 30 et 180 secondes
- intensity ∈ {light, moderate, hard}
- notes: inclure 1-2 conseils + la ligne de surcharge ci-dessous

${overloadLine}

Demande utilisateur:
${prompt}`;

  let program;
  try {
    program = await callGemini({ apiKey: GEMINI_KEY, promptText, responseSchema });
  } catch (e) {
    return httpError(res, 502, "gemini_error", "Upstream AI error");
  }

  if (!isProgramShape(program)) {
    return httpError(res, 502, "invalid_ai_output", "AI returned invalid output");
  }

  // Force overload line into notes (pro/consistent)
  const safeNotes = String(program.notes || "");
  program.notes = safeNotes.includes("Surcharge auto:")
    ? safeNotes
    : (safeNotes ? (safeNotes + "\n\n" + overloadLine) : overloadLine);

  // Optional: persist in DB if you already have a workouts table
  // (kept minimal for “pro” without forcing a schema)

  return sendJson(res, 200, {
    program,
    overload: {
      userId,
      prevReps: Number.isFinite(Number(prevReps)) ? Math.round(Number(prevReps)) : null,
      rpe: Number.isFinite(Number(rpe)) ? Number(rpe) : null,
      nextReps
    }
  });
};

