const TIMEOUT_GEMINI_MS = 14000;
const TIMEOUT_STORAGE_MS = 12000;

let GoogleGenerativeAI = null;
function getGoogleGenerativeAI() {
  if (GoogleGenerativeAI) return GoogleGenerativeAI;
  try {
    const mod = require("@google/generative-ai");
    GoogleGenerativeAI = mod.GoogleGenerativeAI;
    return GoogleGenerativeAI;
  } catch {
    return null;
  }
}

const { createClient } = require("@supabase/supabase-js");
const BUCKET = process.env.BUCKET || "user_uploads";
const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function safeSendJson(res, status, payload) {
  if (res.writableEnded) {
    console.warn("[bodyscan] Attempt to write after response ended");
    return;
  }
  sendJson(res, status, payload);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseBody(req) {
  const b = req.body;
  if (!b) return null;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return null; }
  }
  return b;
}

function getBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(label || "TIMEOUT"), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function guessMimeFromPath(path) {
  const p = String(path || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function normalizeAnalysis(obj) {
  if (!obj || typeof obj !== "object") return null;
  return {
    feedback: String(obj.feedback || obj.analysis || "Analyse indisponible"),
    symmetry_score: typeof obj.symmetry_score === "number" ? Math.min(100, Math.max(0, obj.symmetry_score)) : null,
    posture_score: typeof obj.posture_score === "number" ? Math.min(100, Math.max(0, obj.posture_score)) : null,
    bodyfat_proxy: typeof obj.bodyfat_proxy === "number" ? Math.min(100, Math.max(0, obj.bodyfat_proxy)) : null,
  };
}

function validateAIResponse(analysis) {
  if (!analysis || typeof analysis !== "object") {
    return { valid: false, error: "INVALID_AI_RESPONSE", detail: "Réponse IA absente." };
  }
  if (!analysis.feedback || typeof analysis.feedback !== "string" || analysis.feedback.length === 0) {
    return { valid: false, error: "INVALID_AI_RESPONSE", detail: "Analyse textuelle absente." };
  }
  const scores = [analysis.symmetry_score, analysis.posture_score, analysis.bodyfat_proxy];
  for (const s of scores) {
    if (s !== null && s !== undefined) {
      if (typeof s !== "number" || isNaN(s) || s < 0 || s > 100) {
        return { valid: false, error: "INVALID_AI_RESPONSE", detail: `Score invalide: ${s}.` };
      }
    }
  }
  return { valid: true };
}

function buildVisionPrompt() {
  return [
    "Analyse cette photo de body scan fitness.",
    "Retourne UNIQUEMENT un JSON strict (pas de markdown):",
    "{",
    '  "feedback": "Analyse complète en français (150 mots max)",',
    '  "symmetry_score": 85,',
    '  "posture_score": 78,',
    '  "bodyfat_proxy": 15',
    "}",
    "Scores: 0-100. Si impossible à évaluer, mettre null.",
  ].join("\n");
}

async function geminiVisionOnce({ apiKey, modelName, prompt, b64, mime }) {
  const G = getGoogleGenerativeAI();
  if (!G) {
    const err = new Error('Missing dependency "@google/generative-ai".');
    err.code = "MISSING_DEP";
    throw err;
  }
  const genAI = new G(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.35, topP: 0.9, maxOutputTokens: 900 },
  });

  const startTime = Date.now();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error("Gemini Vision timeout");
      err.code = "TIMEOUT";
      reject(err);
    }, TIMEOUT_GEMINI_MS);
  });

  const generatePromise = model.generateContent([
      { text: prompt },
      { inlineData: { data: b64, mimeType: mime } },
    ]).then(result => {
    const resp = result?.response;
    if (resp?.text && typeof resp.text === "function") return resp.text();
    if (typeof resp?.text === "string") return resp.text;
    return "";
  }).finally(() => {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.log("[bodyscan] Gemini Vision completed", { elapsedMs: elapsed, model: modelName });
  });

  return Promise.race([generatePromise, timeoutPromise]);
}

async function geminiVisionWithRetry({ apiKey, prompt, b64, mime }) {
  try {
    return { text: await geminiVisionOnce({ apiKey, modelName: MODEL_PRIMARY, prompt, b64, mime }), model: MODEL_PRIMARY };
  } catch (e) {
    if (e?.code === "MISSING_DEP") throw e;
    throw e;
  }
}

function wrapHandler(handler) {
  return async function(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.writableEnded) {
        console.error("[bodyscan] FATAL after response ended");
        return;
      }
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      console.error("[bodyscan] FATAL", { requestId, errorType: err?.constructor?.name || "Error" });
      setCors(res);
      safeSendJson(res, 500, { ok: false, error: "INTERNAL_SERVER_ERROR", detail: String(err?.message || err), requestId });
    }
  };
}

async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fail = (status, error, detail) => safeSendJson(res, status, { ok: false, error, detail, requestId });

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return fail(405, "METHOD_NOT_ALLOWED");
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return fail(500, "SERVER_MISCONFIG_SUPABASE", "Missing SUPABASE_URL/SERVICE_ROLE_KEY.");
  }
  if (!GEMINI_API_KEY) {
    return fail(500, "SERVER_MISCONFIG_GEMINI", "Missing GEMINI_API_KEY.");
  }

  const token = getBearerToken(req);
  if (!token) return fail(401, "MISSING_BEARER");

  const body = parseBody(req) || {};
  const user_id = String(body.user_id || "").trim();
  const image_path = String(body.image_path || "").trim();

  if (!user_id || !image_path) {
    return fail(400, "MISSING_FIELDS", "Expected { user_id, image_path }.");
  }

  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const u = await sbAdmin.auth.getUser(token);
  if (u?.error) {
    return fail(401, "BAD_TOKEN", u.error.message);
  }
  const authedUserId = u?.data?.user?.id || "";
  if (!authedUserId) return fail(401, "BAD_TOKEN");
  if (authedUserId !== user_id) return fail(403, "FORBIDDEN");

  const expectedPrefix = `${user_id}/`;
  if (!image_path.startsWith(expectedPrefix)) {
    return fail(403, "FORBIDDEN_IMAGE_PATH", `Image must be in ${expectedPrefix}*`);
  }

  try {
    const dl = await withTimeout(sbAdmin.storage.from(BUCKET).download(image_path), TIMEOUT_STORAGE_MS, "FETCH_TIMEOUT");
    if (dl.error || !dl.data) {
      return fail(404, "IMAGE_NOT_FOUND", dl.error?.message || "");
    }

    const ab = await dl.data.arrayBuffer();
    if (ab.byteLength > 6 * 1024 * 1024) {
      return fail(413, "IMAGE_TOO_LARGE", "Max 6MB.");
    }

    const mime = guessMimeFromPath(image_path);
    const b64 = Buffer.from(ab).toString("base64");

    const prompt = buildVisionPrompt();
    const { text, model } = await geminiVisionWithRetry({ apiKey: GEMINI_API_KEY, prompt, b64, mime });

    const parsed = safeJsonExtract(text);
    const analysis = normalizeAnalysis(parsed);

    const validation = validateAIResponse(analysis);
    if (!validation.valid) {
      const fallback = `❌ Analyse IA invalide: ${validation.detail}\n\nExtrait brut:\n${String(text || "").slice(0, 500)}`;
      
      const upd = await sbAdmin
        .from("body_scans")
        .update({
          ai_feedback: fallback,
          ai_version: model,
          symmetry_score: null,
          posture_score: null,
          bodyfat_proxy: null,
        })
        .eq("user_id", user_id)
        .eq("image_path", image_path);

      if (upd.error) return fail(500, "DB_UPDATE_FAILED", upd.error.message);
      return safeSendJson(res, 200, { ok: true, model, requestId, warning: validation.error });
    }

    const upd = await sbAdmin
      .from("body_scans")
      .update({
        ai_feedback: analysis.feedback,
        ai_version: model,
        symmetry_score: analysis.symmetry_score,
        posture_score: analysis.posture_score,
        bodyfat_proxy: analysis.bodyfat_proxy,
      })
      .eq("user_id", user_id)
      .eq("image_path", image_path);

    if (upd.error) return fail(500, "DB_UPDATE_FAILED", upd.error.message);

    return safeSendJson(res, 200, { ok: true, model, requestId });
  } catch (err) {
    const msg = String(err?.message || "UPSTREAM_ERROR");
    if (err?.code === "TIMEOUT") return fail(504, "TIMEOUT");
    if (err?.code === "MISSING_DEP") return fail(500, "SERVER_MISCONFIG_DEPENDENCY", msg);

    const m = msg.toLowerCase();
    if (m.includes("429") || m.includes("quota")) {
      return fail(502, "UPSTREAM_RATE_LIMIT", msg);
    }
    if (m.includes("403") || m.includes("api key")) {
      return fail(502, "UPSTREAM_AUTH_FAILED", msg);
    }

    console.error("[bodyscan] error", { requestId, code: err?.code || "", errorType: err?.constructor?.name || "Error" });
    return fail(502, "UPSTREAM_ERROR", msg);
  }
}

module.exports = wrapHandler(handler);
