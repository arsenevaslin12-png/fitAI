const { Buffer } = require("node:buffer");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const BUCKET = "user_uploads";
const MODEL = "gemini-1.5-flash";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const JSON_BODY_LIMIT = 256 * 1024; // 256KB

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

function getBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const s = String(h);
  if (!s.toLowerCase().startsWith("bearer ")) return null;
  const token = s.slice(7).trim();
  return token || null;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(label || "TIMEOUT"), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function readJsonBody(req) {
  // If a platform already parsed it
  if (req.body && typeof req.body === "object") return req.body;

  const ct = String(req.headers?.["content-type"] || "");
  const isJson = ct.includes("application/json") || ct.includes("+json");
  if (!isJson) return null;

  const chunks = [];
  let total = 0;

  await new Promise((resolve, reject) => {
    req.on("data", (c) => {
      total += c.length;
      if (total > JSON_BODY_LIMIT) {
        reject(Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferMimeType(imagePath, blobType) {
  const t = String(blobType || "").toLowerCase();
  if (t.startsWith("image/")) return t;

  const p = String(imagePath || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function isAllowedMime(mime) {
  return ALLOWED_MIME.has(String(mime || "").toLowerCase());
}

function extractFirstJsonObject(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function normalizePayload(obj) {
  if (!obj || typeof obj !== "object") return null;

  const symmetry = clampScore(obj.symmetry_score);
  const posture = clampScore(obj.posture_score);
  const bodyfat = clampScore(obj.bodyfat_proxy);

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const focus = typeof obj.improvement_focus === "string" ? obj.improvement_focus.trim() : "";

  if (symmetry == null || posture == null || bodyfat == null) return null;
  if (!summary || !focus) return null;

  return {
    symmetry_score: symmetry,
    posture_score: posture,
    bodyfat_proxy: bodyfat,
    summary,
    improvement_focus: focus,
  };
}

function buildVisionPrompt() {
  return [
    "Tu es FitAI Vision Coach (analyse body scan).",
    "Tu dois répondre UNIQUEMENT avec du JSON STRICT, sans markdown, sans texte avant/après.",
    "",
    "Analyse cette photo: symétrie, posture, proportions, masse apparente, niveau de sèche estimé (proxy).",
    "Donne des recommandations concrètes et actionnables.",
    "",
    "SCHEMA JSON EXACT à retourner :",
    "{",
    '  "symmetry_score": number,',
    '  "posture_score": number,',
    '  "bodyfat_proxy": number,',
    '  "summary": string,',
    '  "improvement_focus": string',
    "}",
    "",
    "Contraintes:",
    "- Scores = nombres entre 0 et 100 (pas de %).",
    "- summary: 2 à 4 phrases max, style sérieux.",
    "- improvement_focus: 1 à 2 priorités max, très concret.",
    "- Si la photo est mauvaise: mentionne-le mais donne quand même des scores prudents.",
  ].join("\n");
}

function buildRepairPrompt(badText) {
  return [
    "Tu es un validateur JSON strict.",
    "Convertis le contenu ci-dessous en JSON STRICT conforme EXACTEMENT au schéma :",
    '{ "symmetry_score": number, "posture_score": number, "bodyfat_proxy": number, "summary": string, "improvement_focus": string }',
    "",
    "Règles:",
    "- UNIQUEMENT le JSON, rien d'autre.",
    "- symmetry_score/posture_score/bodyfat_proxy: nombres 0-100.",
    "- summary: string 2-4 phrases.",
    "- improvement_focus: string (1-2 actions).",
    "",
    "CONTENU:",
    String(badText || ""),
  ].join("\n");
}

async function geminiGenerateJSON({ apiKey, base64, mimeType }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 650 },
  });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: buildVisionPrompt() },
          { inlineData: { data: base64, mimeType } },
        ],
      },
    ],
  });

  const text = result?.response?.text?.() || "";
  return text;
}

async function geminiRepairJSON({ apiKey, badText }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.0, maxOutputTokens: 350 },
  });

  const result = await model.generateContent(buildRepairPrompt(badText));
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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE" });
  }
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI" });
  }

  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { ok: false, error: "MISSING_BEARER" });

  let body = null;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e?.code === "BODY_TOO_LARGE") return sendJson(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
    return sendJson(res, 400, { ok: false, error: "BAD_BODY" });
  }

  const user_id = body?.user_id ? String(body.user_id) : "";
  const image_path = body?.image_path ? String(body.image_path) : "";

  if (!user_id || !image_path) {
    return sendJson(res, 400, { ok: false, error: "MISSING_FIELDS", required: ["user_id", "image_path"] });
  }

  // anti cross-user
  if (!image_path.startsWith(user_id + "/") || !image_path.includes("/bodyscans/")) {
    return sendJson(res, 400, { ok: false, error: "INVALID_IMAGE_PATH" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    // 1) verify bearer
    const authRes = await withTimeout(supabase.auth.getUser(token), 8000, "AUTH_TIMEOUT");
    if (authRes?.error || !authRes?.data?.user) {
      return sendJson(res, 401, { ok: false, error: "INVALID_BEARER" });
    }
    if (String(authRes.data.user.id) !== user_id) {
      return sendJson(res, 403, { ok: false, error: "USER_MISMATCH" });
    }

    // 2) download image
    const dlRes = await withTimeout(supabase.storage.from(BUCKET).download(image_path), 12000, "DOWNLOAD_TIMEOUT");
    if (dlRes?.error || !dlRes?.data) {
      return sendJson(res, 404, { ok: false, error: "IMAGE_NOT_FOUND", detail: dlRes?.error?.message || null });
    }

    const blob = dlRes.data;
    const size = typeof blob.size === "number" ? blob.size : null;
    if (size != null && size > MAX_IMAGE_BYTES) {
      return sendJson(res, 413, { ok: false, error: "IMAGE_TOO_LARGE", max_bytes: MAX_IMAGE_BYTES });
    }

    const mimeType = inferMimeType(image_path, blob.type);
    if (!isAllowedMime(mimeType)) {
      return sendJson(res, 415, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE", allowed: Array.from(ALLOWED_MIME) });
    }

    const ab = await withTimeout(blob.arrayBuffer(), 8000, "BLOB_READ_TIMEOUT");
    if (ab.byteLength > MAX_IMAGE_BYTES) {
      return sendJson(res, 413, { ok: false, error: "IMAGE_TOO_LARGE", max_bytes: MAX_IMAGE_BYTES });
    }

    const base64 = Buffer.from(ab).toString("base64");

    // 3) Gemini vision
    const aiText = await withTimeout(
      geminiGenerateJSON({ apiKey: GEMINI_API_KEY, base64, mimeType }),
      25000,
      "AI_TIMEOUT"
    );

    let parsed = extractFirstJsonObject(aiText);
    let normalized = normalizePayload(parsed);

    if (!normalized) {
      const repairedText = await withTimeout(
        geminiRepairJSON({ apiKey: GEMINI_API_KEY, badText: aiText }),
        12000,
        "AI_REPAIR_TIMEOUT"
      );
      parsed = extractFirstJsonObject(repairedText);
      normalized = normalizePayload(parsed);

      if (!normalized) {
        return sendJson(res, 502, { ok: false, error: "AI_INVALID_JSON" });
      }
    }

    const ai_version = `${MODEL}-vision`;
    const ai_feedback = `${normalized.summary}\n\nFocus: ${normalized.improvement_focus}`;

    const raw_ai_response = {
      provider: "gemini",
      model: MODEL,
      mimeType,
      image_path,
      output_text: aiText,
      parsed: normalized,
    };

    // 4) update DB row (inserted by front)
    const updRes = await withTimeout(
      supabase
        .from("body_scans")
        .update({
          ai_version,
          raw_ai_response,
          ai_feedback,
          symmetry_score: normalized.symmetry_score,
          posture_score: normalized.posture_score,
          bodyfat_proxy: normalized.bodyfat_proxy,
        })
        .eq("user_id", user_id)
        .eq("image_path", image_path)
        .select("id")
        .maybeSingle(),
      10000,
      "DB_TIMEOUT"
    );

    if (updRes?.error) {
      return sendJson(res, 500, { ok: false, error: "DB_UPDATE_FAILED", detail: updRes.error.message });
    }
    if (!updRes?.data?.id) {
      return sendJson(res, 404, { ok: false, error: "BODY_SCAN_ROW_NOT_FOUND" });
    }

    return sendJson(res, 200, {
      ok: true,
      body_scan_id: updRes.data.id,
      ai_version,
      ...normalized,
    });
  } catch (err) {
    const msg = String(err?.message || "SERVER_ERROR");
    const code = err?.code || "";
    if (code === "TIMEOUT" || msg.includes("TIMEOUT")) return sendJson(res, 504, { ok: false, error: "TIMEOUT" });
    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR", detail: msg });
  }
};
