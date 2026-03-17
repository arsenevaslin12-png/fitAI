"use strict";
// api/bodyscan.js — FitAI Pro v8 — Prompt enrichi + fallback structuré

const TIMEOUT_GEMINI_MS = 25000;
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

// Fallback structuré quand Gemini échoue
function buildFallbackAnalysis() {
  return {
    feedback: "Analyse automatique temporairement indisponible. Voici des conseils generaux :\n\n" +
      "POSTURE : Verifiez que vos epaules sont alignees, votre dos droit, et votre bassin neutre. " +
      "Une bonne posture reduit les risques de blessure et ameliore vos performances.\n\n" +
      "SYMETRIE : Comparez visuellement le developpement musculaire gauche/droite. " +
      "Si vous notez un desequilibre, integrez des exercices unilateraux (halteres, lunges).\n\n" +
      "COMPOSITION : Pour suivre votre evolution, prenez vos photos dans les memes conditions " +
      "(eclairage, angle, heure). Cela permet une comparaison fiable au fil du temps.\n\n" +
      "Conseil : Reessayez l'analyse dans quelques minutes pour obtenir une evaluation IA detaillee.",
    symmetry_score: null,
    posture_score: null,
    bodyfat_proxy: null,
  };
}

async function analyzeImage({ apiKey, b64, mime }) {
  const G = getGemini();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "MISSING_DEP" });

  const model = new G(apiKey).getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
  });

  const prompt = `Tu es un coach fitness expert specialise en analyse corporelle.
Analyse cette photo fitness (body scan) de maniere DETAILLEE et CONSTRUCTIVE.

Reponds UNIQUEMENT avec du JSON valide, aucun markdown.

FORMAT OBLIGATOIRE:
{
  "feedback": "Analyse complete en francais (250-400 mots). Structure ton analyse en sections : POSTURE (alignement general, epaules, bassin, colonne), SYMETRIE MUSCULAIRE (equilibre gauche/droite, groupes musculaires visibles), COMPOSITION CORPORELLE (estimation visuelle, zones de stockage, definition musculaire), POINTS FORTS (ce qui est bien developpe), AXES D'AMELIORATION (exercices recommandes, groupes musculaires a travailler), CONSEILS PRATIQUES (3 conseils concrets et motivants).",
  "symmetry_score": 78,
  "posture_score": 82,
  "bodyfat_proxy": 18
}

REGLES:
- Scores entre 0 et 100
- Utilise null si impossible a evaluer sur la photo
- Sois PRECIS et MOTIVANT, jamais decourageant
- Donne des CONSEILS CONCRETS (exercices, habitudes)
- Si la photo est de mauvaise qualite, dis-le et donne quand meme des conseils generaux`;

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
  if (ud.user.id !== user_id) return json(res, 403, { ok: false, error: "Acces refuse", id });
  if (!image_path.startsWith(`${user_id}/`)) return json(res, 403, { ok: false, error: "Chemin image invalide", id });

  try {
    const dl = await withTimeout(sb.storage.from(BUCKET).download(image_path), TIMEOUT_STORAGE_MS, "Timeout storage");
    if (dl.error || !dl.data) return json(res, 404, { ok: false, error: "Image introuvable", detail: dl.error?.message, id });

    const ab = await dl.data.arrayBuffer();
    if (ab.byteLength > 6 * 1024 * 1024) return json(res, 413, { ok: false, error: "Image trop grande (max 6MB)", id });

    let analysis;
    try {
      const text = await analyzeImage({ apiKey: GEMINI_KEY, b64: Buffer.from(ab).toString("base64"), mime: guessMime(image_path) });
      const parsed = safeJsonExtract(text);

      if (parsed && parsed.feedback && parsed.feedback.length > 30) {
        analysis = {
          feedback: String(parsed.feedback),
          symmetry_score: typeof parsed.symmetry_score === "number" ? Math.min(100, Math.max(0, parsed.symmetry_score)) : null,
          posture_score: typeof parsed.posture_score === "number" ? Math.min(100, Math.max(0, parsed.posture_score)) : null,
          bodyfat_proxy: typeof parsed.bodyfat_proxy === "number" ? Math.min(100, Math.max(0, parsed.bodyfat_proxy)) : null,
        };
      } else {
        // Gemini returned garbage — use fallback
        console.warn("[bodyscan] Gemini returned poor result, using fallback", { id });
        analysis = buildFallbackAnalysis();
      }
    } catch (geminiErr) {
      const msg = String(geminiErr?.message || "");
      console.warn("[bodyscan] Gemini failed, using fallback", { id, msg: msg.slice(0, 100) });

      if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) {
        // Still save fallback to DB so user sees something
        analysis = buildFallbackAnalysis();
        analysis.feedback = "L'IA est temporairement surchargee (limite de quota atteinte). " + analysis.feedback;
      } else {
        analysis = buildFallbackAnalysis();
      }
    }

    const { error: dbErr } = await sb.from("body_scans").update({
      ai_feedback: analysis.feedback,
      ai_version: MODEL,
      symmetry_score: analysis.symmetry_score,
      posture_score: analysis.posture_score,
      bodyfat_proxy: analysis.bodyfat_proxy
    }).eq("user_id", user_id).eq("image_path", image_path);

    if (dbErr) return json(res, 500, { ok: false, error: "Erreur DB", detail: dbErr.message, id });
    return json(res, 200, { ok: true, id, fallback: !analysis.symmetry_score });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[bodyscan]", { id, code, msg: msg.slice(0, 100) });
    if (code === "TIMEOUT") return json(res, 504, { ok: false, error: "Timeout — reessayez dans quelques secondes", id });
    if (code === "MISSING_DEP") return json(res, 500, { ok: false, error: msg, id });
    if (msg.includes("429") || msg.includes("quota")) return json(res, 429, { ok: false, error: "Quota Gemini atteint. Attendez 60 secondes.", retryAfter: 60, id });
    return json(res, 502, { ok: false, error: msg || "Erreur serveur", id });
  }
};
