"use strict";
// api/bodyscan.js — FitAI Pro v2.0 — Enhanced Body Scan Analysis

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

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

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
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(label), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function clampScore(value) {
  if (typeof value !== "number" || isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ══════════════════════════════════════════════════════════════════════════════

function buildBodyScanPrompt(previousAnalysis = null) {
  let historyContext = "";
  if (previousAnalysis) {
    historyContext = `
HISTORIQUE (analyse précédente):
- Score physique précédent: ${previousAnalysis.physical_score || "N/A"}
- Points faibles identifiés: ${previousAnalysis.weak_points?.join(", ") || "N/A"}
- Points forts identifiés: ${previousAnalysis.strong_points?.join(", ") || "N/A"}
Compare avec ce scan et note les progrès ou régressions.
`;
  }

  return `Tu es un coach fitness et spécialiste en analyse corporelle.
Analyse cette photo avec précision, bienveillance et professionnalisme.

CONSIGNES IMPORTANTES:
1. Sois encourageant mais honnête - l'utilisateur veut progresser
2. Ne fais JAMAIS de diagnostic médical
3. Base ton analyse uniquement sur ce qui est visible
4. Si la qualité photo est insuffisante, indique-le clairement
5. Scores entre 0-100 où 100 = excellent

${historyContext}

RÉPONDS UNIQUEMENT en JSON valide, aucun texte avant ou après, aucun markdown:
{
  "analysis_quality": "good|acceptable|poor",
  "quality_issues": ["éclairage faible", "angle non optimal"],
  
  "physical_score": 72,
  "score_breakdown": {
    "symmetry": 78,
    "posture": 65,
    "muscle_definition": 70,
    "body_composition": 75
  },
  
  "posture_analysis": {
    "overall": "good|moderate|needs_work",
    "head_position": "forward_head|neutral|good",
    "shoulder_alignment": "rounded|uneven|good",
    "spine_curvature": "hyperlordosis|kyphosis|neutral|good",
    "hip_alignment": "anterior_tilt|posterior_tilt|neutral",
    "recommendations": ["Conseil 1", "Conseil 2"]
  },
  
  "muscle_balance": {
    "upper_lower_ratio": "balanced|upper_dominant|lower_dominant",
    "left_right_symmetry": "good|slight_imbalance|noticeable_imbalance",
    "anterior_posterior": "balanced|anterior_dominant|posterior_dominant",
    "weak_points": ["muscle1", "muscle2"],
    "strong_points": ["muscle1", "muscle2"]
  },
  
  "strengths": [
    "Point fort visible 1",
    "Point fort visible 2",
    "Point fort visible 3"
  ],
  
  "areas_for_improvement": [
    "Axe d'amélioration 1",
    "Axe d'amélioration 2",
    "Axe d'amélioration 3"
  ],
  
  "estimated_metrics": {
    "bodyfat_range": "15-18%",
    "muscle_mass_level": "beginner|intermediate|advanced|elite",
    "fitness_category": "sedentary|recreational|athletic|competitive"
  },
  
  "personalized_recommendations": {
    "training_focus": ["Type d'exercice 1", "Type d'exercice 2"],
    "exercise_examples": ["Exercice spécifique 1", "Exercice spécifique 2"],
    "frequency_suggestion": "Recommandation de fréquence"
  },
  
  "motivational_feedback": "Message motivant et personnalisé de 2-3 phrases maximum. Sois encourageant! 💪",
  
  "follow_up_in_weeks": 6
}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

async function analyzeImage({ apiKey, b64, mime, previousAnalysis = null }) {
  const G = getGemini();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "MISSING_DEP" });

  const model = new G(apiKey).getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
  });

  const prompt = buildBodyScanPrompt(previousAnalysis);

  let tid;
  const timeout = new Promise((_, rej) => {
    tid = setTimeout(() => rej(Object.assign(new Error("Timeout Gemini Vision"), { code: "TIMEOUT" })), TIMEOUT_GEMINI_MS);
  });

  const call = model.generateContent([
    { text: prompt },
    { inlineData: { data: b64, mimeType: mime } }
  ]).then(r => {
    clearTimeout(tid);
    const t = r?.response?.text;
    return typeof t === "function" ? t() : String(t || "");
  });

  return Promise.race([call, timeout]);
}

// ══════════════════════════════════════════════════════════════════════════════
// NORMALIZE OUTPUT
// ══════════════════════════════════════════════════════════════════════════════

function normalizeAnalysisOutput(parsed) {
  const p = parsed || {};

  // Extract and validate scores
  const physicalScore = clampScore(p.physical_score);
  const symmetryScore = clampScore(p.score_breakdown?.symmetry);
  const postureScore = clampScore(p.score_breakdown?.posture);
  const muscleDefScore = clampScore(p.score_breakdown?.muscle_definition);
  const bodyCompScore = clampScore(p.score_breakdown?.body_composition);

  // Estimate bodyfat proxy from range
  let bodyfatProxy = null;
  if (p.estimated_metrics?.bodyfat_range) {
    const match = p.estimated_metrics.bodyfat_range.match(/(\d+)/);
    if (match) bodyfatProxy = parseInt(match[1]);
  }

  // Build feedback text
  const feedbackParts = [];

  if (p.analysis_quality === "poor") {
    feedbackParts.push("⚠️ Qualité photo limitée. Pour une meilleure analyse, utilisez un bon éclairage et un angle de face ou de profil.");
  }

  if (p.motivational_feedback) {
    feedbackParts.push(p.motivational_feedback);
  }

  if (Array.isArray(p.strengths) && p.strengths.length > 0) {
    feedbackParts.push(`✅ Points forts: ${p.strengths.slice(0, 3).join(", ")}.`);
  }

  if (Array.isArray(p.areas_for_improvement) && p.areas_for_improvement.length > 0) {
    feedbackParts.push(`🎯 À travailler: ${p.areas_for_improvement.slice(0, 3).join(", ")}.`);
  }

  if (p.personalized_recommendations?.frequency_suggestion) {
    feedbackParts.push(`📅 ${p.personalized_recommendations.frequency_suggestion}`);
  }

  const feedback = feedbackParts.join("\n\n") || "Analyse terminée.";

  return {
    // Core scores for DB
    ai_feedback: feedback,
    ai_version: MODEL,
    physical_score: physicalScore,
    symmetry_score: symmetryScore,
    posture_score: postureScore,
    bodyfat_proxy: bodyfatProxy,

    // Extended data as JSONB
    extended_analysis: {
      analysis_quality: p.analysis_quality || "acceptable",
      quality_issues: p.quality_issues || [],
      score_breakdown: {
        symmetry: symmetryScore,
        posture: postureScore,
        muscle_definition: muscleDefScore,
        body_composition: bodyCompScore
      },
      posture_analysis: p.posture_analysis || null,
      muscle_balance: p.muscle_balance || null,
      strengths: p.strengths || [],
      areas_for_improvement: p.areas_for_improvement || [],
      estimated_metrics: p.estimated_metrics || null,
      personalized_recommendations: p.personalized_recommendations || null,
      follow_up_in_weeks: p.follow_up_in_weeks || 6
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════════

module.exports = async function(req, res) {
  cors(res);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", id: requestId });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!SB_URL || !SB_SRV) return json(res, 500, { ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY manquants", id: requestId });
  if (!GEMINI_KEY) return json(res, 500, { ok: false, error: "GEMINI_API_KEY manquant", id: requestId });

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { ok: false, error: "Bearer token requis", id: requestId });

  const body = parseBody(req);
  const user_id = String(body.user_id || "").trim();
  const image_path = String(body.image_path || "").trim();
  if (!user_id || !image_path) return json(res, 400, { ok: false, error: "user_id et image_path requis", id: requestId });

  const sb = createClient(SB_URL, SB_SRV, { auth: { persistSession: false } });

  // Validate token and user
  const { data: ud, error: ue } = await sb.auth.getUser(token);
  if (ue || !ud?.user?.id) return json(res, 401, { ok: false, error: "Token invalide", id: requestId });
  if (ud.user.id !== user_id) return json(res, 403, { ok: false, error: "Accès refusé", id: requestId });
  if (!image_path.startsWith(`${user_id}/`)) return json(res, 403, { ok: false, error: "Chemin image invalide", id: requestId });

  try {
    // Download image
    const dl = await withTimeout(sb.storage.from(BUCKET).download(image_path), TIMEOUT_STORAGE_MS, "Timeout storage");
    if (dl.error || !dl.data) return json(res, 404, { ok: false, error: "Image introuvable", detail: dl.error?.message, id: requestId });

    const ab = await dl.data.arrayBuffer();
    if (ab.byteLength > 6 * 1024 * 1024) return json(res, 413, { ok: false, error: "Image trop grande (max 6MB)", id: requestId });

    // Get previous analysis for comparison (optional)
    let previousAnalysis = null;
    try {
      const { data: prevScans } = await sb.from("body_scans")
        .select("physical_score, extended_analysis")
        .eq("user_id", user_id)
        .not("physical_score", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);

      if (prevScans?.length > 0) {
        const prev = prevScans[0];
        previousAnalysis = {
          physical_score: prev.physical_score,
          weak_points: prev.extended_analysis?.muscle_balance?.weak_points,
          strong_points: prev.extended_analysis?.muscle_balance?.strong_points
        };
      }
    } catch (e) {
      console.warn("[bodyscan] Could not load previous analysis:", e.message);
    }

    // Analyze image
    const text = await analyzeImage({
      apiKey: GEMINI_KEY,
      b64: Buffer.from(ab).toString("base64"),
      mime: guessMime(image_path),
      previousAnalysis
    });

    const parsed = safeJsonExtract(text) || {};
    const normalized = normalizeAnalysisOutput(parsed);

    // Update database
    const { error: dbErr } = await sb.from("body_scans").update({
      ai_feedback: normalized.ai_feedback,
      ai_version: normalized.ai_version,
      physical_score: normalized.physical_score,
      symmetry_score: normalized.symmetry_score,
      posture_score: normalized.posture_score,
      bodyfat_proxy: normalized.bodyfat_proxy,
      extended_analysis: normalized.extended_analysis
    }).eq("user_id", user_id).eq("image_path", image_path);

    if (dbErr) {
      console.error("[bodyscan] DB update failed:", dbErr);
      return json(res, 500, { ok: false, error: "Erreur sauvegarde DB", detail: dbErr.message, id: requestId });
    }

    return json(res, 200, {
      ok: true,
      id: requestId,
      analysis: {
        physical_score: normalized.physical_score,
        posture_score: normalized.posture_score,
        symmetry_score: normalized.symmetry_score,
        feedback_preview: normalized.ai_feedback.slice(0, 200)
      }
    });

  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[bodyscan]", { id: requestId, code, msg: msg.slice(0, 100) });

    if (code === "TIMEOUT") return json(res, 504, { ok: false, error: "Timeout — réessayez", id: requestId });
    if (code === "MISSING_DEP") return json(res, 500, { ok: false, error: msg, id: requestId });
    if (msg.includes("429")) return json(res, 429, { ok: false, error: "Quota Gemini dépassé", id: requestId });
    return json(res, 502, { ok: false, error: msg || "Erreur serveur", id: requestId });
  }
};
