// api/bodyscan.js — FitAI Pro v3.4.0
"use strict";

const TIMEOUT_GEMINI_MS = 20000;
const TIMEOUT_STORAGE_MS = 12000;

let _GeminiClass = null;
function getGemini() {
  if (_GeminiClass) return _GeminiClass;
  try { _GeminiClass = require("@google/generative-ai").GoogleGenerativeAI; return _GeminiClass; }
  catch { return null; }
}

const { createClient } = require("@supabase/supabase-js");
const BUCKET = process.env.BUCKET || "user_uploads";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

function getBearerToken(req) {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function guessMime(path) {
  const p = String(path).toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(label), { code: "TIMEOUT" })), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function analyzeImage({ apiKey, b64, mime }) {
  const G = getGemini();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "MISSING_DEP" });

  const model = new G(apiKey).getGenerativeModel({ model: MODEL, generationConfig: { temperature: 0.3, maxOutputTokens: 800 } });
  const prompt = `Analyse cette photo fitness (body scan). Réponds UNIQUEMENT avec du JSON valide, aucun markdown:\n{"feedback":"analyse détaillée en français (max 120 mots)","symmetry_score":85,"posture_score":78,"bodyfat_proxy":18}\nScores entre 0 et 100. Utilise null si impossible à évaluer.`;

  let tid;
  const timeout = new Promise((_, rej) => { tid = setTimeout(() => rej(Object.assign(new Error("Timeout Gemini Vision"), { code: "TIMEOUT" })), TIMEOUT_GEMINI_MS); });
  const call = model.generateContent([{ text: prompt }, { inlineData: { data: b64, mimeType: mime } }]).then(r => {
    clearTimeout(tid);
    const t = r?.response?.text;
    return typeof t === "function" ? t() : String(t || "");
  });
  return Promise.race([call, timeout]);
}

module.exports = async function(req, res) {
  cors(res);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", id });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!SB_URL || !SB_SRV) return json(res, 500, { ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY manquants", id });
  if (!GEMINI_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY manquant", id });

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { ok: false, error: "Bearer token requis", id });

  const body = parseBody(req);
  const user_id = String(body.user_id || "").trim();
  const image_path = String(body.image_path || "").trim();
  if (!user_id || !image_path) return json(res, 400, { ok: false, error: "user_id et image_path requis", id });

  const sb = createClient(SB_URL, SB_SRV, { auth: { persistSession: false } });

  const { data: ud, error: ue } = await sb.auth.getUser(token);
  if (ue || !ud?.user?.id) return json(res, 401, { ok: false, error: "Token invalide", id });
  if (ud.user.id !== user_id) return json(res, 403, { ok: false, error: "Accès refusé", id });
  if (!image_path.startsWith(`${user_id}/`)) return json(res, 403, { ok: false, error: "Chemin image invalide", id });

  try {
    const dl = await withTimeout(sb.storage.from(BUCKET).download(image_path), TIMEOUT_STORAGE_MS, "Timeout storage");
    if (dl.error || !dl.data) return json(res, 404, { ok: false, error: "Image introuvable", detail: dl.error?.message, id });

    const ab = await dl.data.arrayBuffer();
    if (ab.byteLength > 6 * 1024 * 1024) return json(res, 413, { ok: false, error: "Image trop grande (max 6MB)", id });

    const text = await analyzeImage({ apiKey: GEMINI_KEY, b64: Buffer.from(ab).toString("base64"), mime: guessMime(image_path) });
    const parsed = safeJsonExtract(text) || {};

    const feedback = String(parsed.feedback || "Analyse indisponible");
    const sym = typeof parsed.symmetry_score === "number" ? Math.min(100, Math.max(0, parsed.symmetry_score)) : null;
    const pos = typeof parsed.posture_score === "number" ? Math.min(100, Math.max(0, parsed.posture_score)) : null;
    const bf = typeof parsed.bodyfat_proxy === "number" ? Math.min(100, Math.max(0, parsed.bodyfat_proxy)) : null;

    const { error: dbErr } = await sb.from("body_scans").update({
      ai_feedback: feedback, ai_version: MODEL, symmetry_score: sym, posture_score: pos, bodyfat_proxy: bf
    }).eq("user_id", user_id).eq("image_path", image_path);

    if (dbErr) return json(res, 500, { ok: false, error: "Erreur DB", detail: dbErr.message, id });
    return json(res, 200, { ok: true, id });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[bodyscan]", { id, code, msg: msg.slice(0, 100) });
    if (code === "TIMEOUT") return json(res, 504, { ok: false, error: "Timeout — réessayez", id });
    if (code === "MISSING_DEP") return json(res, 500, { ok: false, error: msg, id });
    if (msg.includes("429")) return json(res, 429, { ok: false, error: "Quota Gemini dépassé", id });
    return json(res, 502, { ok: false, error: msg || "Erreur serveur", id });
  }
};
