const TIMEOUT_MS = 23000;
const MAX_PROMPT_LENGTH = 2000;
const RATE_LIMIT_MS = 3000;

let GoogleGenerativeAI = null;
function getGoogleGenerativeAI() {
  if (GoogleGenerativeAI) return GoogleGenerativeAI;
  try {
    const mod = require("@google/generative-ai");
    GoogleGenerativeAI = mod.GoogleGenerativeAI;
    return GoogleGenerativeAI;
  } catch (e) {
    return null;
  }
}

const MODEL = String(process.env.GEMINI_MODEL || "gemini-2.0-flash-exp").trim();
const rateLimitMap = new Map();

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function safeSendJson(res, status, payload) {
  if (res.writableEnded) {
    console.warn("[workout] Attempt to write after response ended");
    return;
  }
  sendJson(res, status, payload);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function getQueryParam(req, key) {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = new URL(req.url || "/", `${proto}://${host}`);
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

function parseBody(req) {
  const b = req.body;
  if (!b) return null;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return null; }
  }
  return b;
}

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

function cleanupRateLimit() {
  const now = Date.now();
  const cutoff = now - 60000;
  for (const [ip, timestamp] of rateLimitMap.entries()) {
    if (timestamp < cutoff) rateLimitMap.delete(ip);
  }
}

function buildPrompt(userPrompt, goalContext) {
  let prompt = "Tu es un coach sportif expert.\n\n";
  
  if (goalContext) {
    prompt += "CONTEXTE UTILISATEUR:\n";
    if (goalContext.type) prompt += `Type objectif: ${goalContext.type}\n`;
    if (goalContext.level) prompt += `Niveau: ${goalContext.level}\n`;
    if (goalContext.text) prompt += `Objectif: ${goalContext.text}\n`;
    if (goalContext.constraints) prompt += `Contraintes: ${goalContext.constraints}\n`;
    prompt += "\n";
  }
  
  if (userPrompt) {
    prompt += `DEMANDE: ${userPrompt}\n\n`;
  }
  
  prompt += `Génère un plan d'entraînement au format JSON strict:\n`;
  prompt += `{\n`;
  prompt += `  "title": "Titre de la séance",\n`;
  prompt += `  "intensity": "low|medium|high",\n`;
  prompt += `  "notes": "Notes générales",\n`;
  prompt += `  "blocks": [\n`;
  prompt += `    {\n`;
  prompt += `      "title": "Nom du bloc",\n`;
  prompt += `      "duration_sec": 600,\n`;
  prompt += `      "items": ["Exercice 1", "Exercice 2"],\n`;
  prompt += `      "rpe": "6-7"\n`;
  prompt += `    }\n`;
  prompt += `  ]\n`;
  prompt += `}\n`;
  prompt += `IMPORTANT: duration_sec obligatoire (nombre entier positif). Pas de duration_min.`;
  
  return prompt;
}

function validateInput(prompt, goalContext) {
  if (typeof prompt !== "string") {
    return { valid: false, error: "INVALID_INPUT", detail: "Le prompt doit être une chaîne." };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { valid: false, error: "INVALID_INPUT", detail: `Max ${MAX_PROMPT_LENGTH} caractères.` };
  }
  if (goalContext !== null && goalContext !== undefined) {
    if (typeof goalContext !== "object" || Array.isArray(goalContext)) {
      return { valid: false, error: "INVALID_INPUT", detail: "goalContext doit être un objet ou null." };
    }
  }
  return { valid: true };
}

function validateAIOutput(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "INVALID_AI_RESPONSE", detail: "Réponse IA invalide." };
  }
  if (!Array.isArray(data.blocks) || data.blocks.length === 0) {
    return { valid: false, error: "INVALID_AI_RESPONSE", detail: "Blocks absent ou vide." };
  }
  for (let i = 0; i < data.blocks.length; i++) {
    const b = data.blocks[i];
    if (typeof b.duration_sec !== "number" || isNaN(b.duration_sec) || b.duration_sec <= 0) {
      return { valid: false, error: "INVALID_AI_RESPONSE", detail: `Block ${i}: duration_sec invalide.` };
    }
  }
  return { valid: true };
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function normalizePlan(rawPlan) {
  const plan = typeof rawPlan === "object" && rawPlan !== null ? rawPlan : {};
  const normalized = {
    title: String(plan.title || "Séance générée"),
    intensity: String(plan.intensity || "medium"),
    notes: String(plan.notes || ""),
    created_at: new Date().toISOString(),
    source: plan.source || "coach",
    blocks: [],
  };
  const rawBlocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  for (const b of rawBlocks) {
    if (!b || typeof b !== "object") continue;
    let durationSec = 0;
    if (typeof b.duration_sec === "number" && b.duration_sec > 0) durationSec = b.duration_sec;
    else if (typeof b.duration_min === "number" && b.duration_min > 0) durationSec = b.duration_min * 60;
    else durationSec = 180;
    normalized.blocks.push({
      title: String(b.title || "Block"),
      duration_sec: Math.max(10, durationSec),
      items: Array.isArray(b.items) ? b.items.map(String) : [],
      rpe: b.rpe || "",
    });
  }
  if (!normalized.blocks.length) {
    normalized.blocks = [
      { title: "Warm-up", duration_sec: 480, items: ["Mobilité", "Cardio léger"], rpe: "" },
      { title: "Main", duration_sec: 1500, items: ["3x mouvement principal", "2x accessoire"], rpe: "" },
      { title: "Cooldown", duration_sec: 300, items: ["Respiration", "Stretching"], rpe: "" },
    ];
  }
  return normalized;
}

async function geminiText({ apiKey, prompt }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY manquant");
  const G = getGoogleGenerativeAI();
  if (!G) {
    const err = new Error('Missing dependency "@google/generative-ai".');
    err.code = "MISSING_DEP";
    throw err;
  }
  const genAI = new G(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens: 900 },
  });

  const startTime = Date.now();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error("Gemini timeout");
      err.code = "TIMEOUT";
      reject(err);
    }, TIMEOUT_MS);
  });

  const generatePromise = model.generateContent(prompt).then(result => {
    const resp = result?.response;
    if (resp?.text && typeof resp.text === "function") return resp.text();
    if (typeof resp?.text === "string") return resp.text;
    return "";
  }).finally(() => {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.log("[workout] Gemini completed", { elapsedMs: elapsed });
  });

  return Promise.race([generatePromise, timeoutPromise]);
}

function wrapHandler(handler) {
  return async function(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.writableEnded) {
        console.error("[workout] FATAL after response ended", { msg: err?.message });
        return;
      }
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      console.error("[workout] FATAL", { requestId, errorType: err?.constructor?.name || "Error" });
      setCors(res);
      safeSendJson(res, 500, { ok: false, error: "INTERNAL_SERVER_ERROR", detail: String(err?.message || err), requestId });
    }
  };
}

async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET") {
    let isConfig = false;
    try {
      isConfig = String(getQueryParam(req, "config") || "") === "1";
    } catch (e) {
      console.error("[workout] getQueryParam error", { requestId });
      return safeSendJson(res, 400, { ok: false, error: "INVALID_REQUEST_URL", requestId });
    }
    
    if (!isConfig) return safeSendJson(res, 404, { ok: false, error: "NOT_FOUND", requestId });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      const missing = [];
      if (!supabaseUrl) missing.push("SUPABASE_URL");
      if (!supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
      return safeSendJson(res, 500, {
        ok: false,
        error: "SERVER_MISCONFIG_SUPABASE_PUBLIC",
        detail: `Missing env vars: ${missing.join(", ")}. Configure in Vercel Dashboard.`,
        requestId,
      });
    }

    return safeSendJson(res, 200, { ok: true, supabaseUrl, supabaseAnonKey, requestId });
  }

  if (req.method !== "POST") {
    return safeSendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
  }

  const clientIP = getClientIP(req);
  const now = Date.now();
  const lastReq = rateLimitMap.get(clientIP) || 0;
  
  if (now - lastReq < RATE_LIMIT_MS) {
    return safeSendJson(res, 429, { ok: false, error: "RATE_LIMIT", detail: `Max 1 req/${RATE_LIMIT_MS / 1000}s.`, requestId });
  }
  
  rateLimitMap.set(clientIP, now);
  if (rateLimitMap.size > 500) cleanupRateLimit();

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error("[workout] misconfig gemini", { requestId });
    return safeSendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI", requestId });
  }

  const body = parseBody(req) || {};
  const prompt = String(body?.prompt || "");
  const goalContext = body?.goalContext || null;

  const validation = validateInput(prompt, goalContext);
  if (!validation.valid) {
    return safeSendJson(res, 400, { ok: false, error: validation.error, detail: validation.detail, requestId });
  }

  try {
    const fullPrompt = buildPrompt(prompt.trim(), goalContext);
    const text = await geminiText({ apiKey: GEMINI_API_KEY, prompt: fullPrompt });
    const parsed = safeJsonExtract(text);
    const normalized = normalizePlan(parsed);

    const outputValidation = validateAIOutput(normalized);
    if (!outputValidation.valid) {
      return safeSendJson(res, 502, { ok: false, error: outputValidation.error, detail: outputValidation.detail, requestId });
    }

    return safeSendJson(res, 200, { ok: true, data: normalized, requestId });
  } catch (err) {
    const msg = String(err?.message || "SERVER_ERROR");
    const code = err?.code || "";
    console.error("[workout] error", { requestId, code, errorType: err?.constructor?.name || "Error" });

    if (code === "MISSING_DEP") {
      return safeSendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_DEPENDENCY", detail: msg, requestId });
    }
    if (code === "TIMEOUT") return safeSendJson(res, 504, { ok: false, error: "TIMEOUT", requestId });

    const m = msg.toLowerCase();
    if (m.includes("429") || m.includes("quota")) {
      return safeSendJson(res, 502, { ok: false, error: "UPSTREAM_RATE_LIMIT", requestId });
    }
    if (m.includes("403") || m.includes("api key")) {
      return safeSendJson(res, 502, { ok: false, error: "UPSTREAM_AUTH_FAILED", requestId });
    }

    return safeSendJson(res, 502, { ok: false, error: "UPSTREAM_ERROR", detail: msg, requestId });
  }
}

module.exports = wrapHandler(handler);
