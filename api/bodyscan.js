"use strict";
// api/bodyscan.js — FitAI Pro v2.0 — Enhanced Body Scan Analysis

const TIMEOUT_GEMINI_MS = 6500;
const TIMEOUT_STORAGE_MS = 12000;

const { createClient } = require("@supabase/supabase-js");
const {
  DEFAULT_MODEL: MODEL,
  FALLBACK_MODEL,
  callGeminiText,
  extractJson,
  normalizeGeminiError
} = require("./_gemini");
const { validateBody, BodyscanBodySchema } = require("./_env");

const BUCKET = process.env.BUCKET || "user_uploads";

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

  return `Tu es un coach fitness expert en analyse corporelle visuelle. Tu analyses les photos avec précision et professionnalisme.

RÈGLES D'ANALYSE STRICTES:
1. Sois honnête et précis — pas de flatterie, pas de sévérité excessive
2. Ne fais JAMAIS de diagnostic médical
3. Base-toi UNIQUEMENT sur ce qui est visible dans la photo
4. Si la qualité photo est insuffisante, dis-le dans quality_issues

CALIBRATION OBLIGATOIRE DES SCORES (physical_score):
- 15-30: Personne sédentaire, surpoids important, peu de masse musculaire visible
- 30-45: Débutant, peu d'activité physique, posture à améliorer significativement
- 45-55: Personne active occasionnellement, silhouette normale, peu de définition musculaire
- 55-65: Pratiquant régulier, bonne condition générale, légère définition visible
- 65-72: Bon niveau fitness, masse musculaire visible, composition corporelle correcte
- 72-80: Athlète confirmé, bonne définition musculaire, posture solide (niveau Ryan Reynolds, Jason Statham moyen)
- 80-87: Athlète avancé, définition marquée, symétrie bonne (niveau Brad Pitt Fight Club = ~82)
- 87-92: Elite physique, très faible bodyfat avec masse musculaire, proportions excellentes
- 92-97: Bodybuilder compétition, culturiste physique exceptionnel
- 97-100: IMPOSSIBLE en photo normale — réservé uniquement pour physique de compétition olympique

ERREURS À ÉVITER ABSOLUMENT:
- Ne donne JAMAIS 62+ à quelqu'un qui n'est visiblement pas un pratiquant régulier et défini
- Ne donne JAMAIS 85+ à quelqu'un qui n'a pas une définition musculaire clairement visible
- Un corps "normal" actif est entre 48-60, pas 70+
- La moyenne réelle d'un utilisateur fitness est 52-65
- Sois cohérent: si tu donnes 72 au physique global, les sous-scores doivent être proches de 72 (±15 max)

${historyContext}

RÉPONDS UNIQUEMENT en JSON valide, aucun texte avant ou après, aucun markdown:
{
  "analysis_quality": "good|acceptable|poor",
  "quality_issues": [],

  "physical_score": 58,
  "score_breakdown": {
    "symmetry": 62,
    "posture": 55,
    "muscle_definition": 52,
    "body_composition": 60
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
  const prompt = buildBodyScanPrompt(previousAnalysis);
  const result = await callGeminiText({
    apiKey,
    contents: [
      { text: prompt },
      { inlineData: { data: b64, mimeType: mime } }
    ],
    temperature: 0.3,
    maxOutputTokens: 1500,
    timeoutMs: TIMEOUT_GEMINI_MS,
    retries: 0
  });
  return { text: result.text, model: result.model };
}

// ══════════════════════════════════════════════════════════════════════════════
// NORMALIZE OUTPUT
// ══════════════════════════════════════════════════════════════════════════════

function normalizeAnalysisOutput(parsed, modelName = MODEL) {
  const p = parsed || {};

  // Extract and validate scores
  const physicalScore = clampScore(p.physical_score);
  const symmetryScore = clampScore(p.score_breakdown?.symmetry);
  const postureScore = clampScore(p.score_breakdown?.posture);
  const muscleDefScore = clampScore(p.score_breakdown?.muscle_definition);
  const bodyCompScore = clampScore(p.score_breakdown?.body_composition);
  const hasUsefulScores = [physicalScore, symmetryScore, postureScore].some((v) => typeof v === "number");

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
    ai_version: modelName,
    physical_score: hasUsefulScores ? physicalScore : 58,
    symmetry_score: hasUsefulScores ? symmetryScore : 56,
    posture_score: hasUsefulScores ? postureScore : 57,
    bodyfat_proxy: bodyfatProxy,

    // Extended data as JSONB
    extended_analysis: {
      analysis_quality: p.analysis_quality || "acceptable",
      quality_issues: p.quality_issues || [],
      score_breakdown: {
        symmetry: hasUsefulScores ? symmetryScore : 56,
        posture: hasUsefulScores ? postureScore : 57,
        muscle_definition: muscleDefScore ?? 55,
        body_composition: bodyCompScore ?? 55
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


function buildDegradedAnalysis(reason) {
  const message = String(reason || "Analyse IA indisponible");
  return {
    ai_feedback: [
      "⚠️ Analyse visuelle détaillée indisponible pour le moment.",
      "Aucune donnée biométrique fiable n'a été produite automatiquement.",
      `Raison: ${message}.`,
      "Vous pouvez réessayer plus tard avec une photo bien éclairée et un angle stable."
    ].join("\n\n"),
    ai_version: `degraded:${MODEL}`,
    physical_score: 55,
    symmetry_score: 55,
    posture_score: 55,
    bodyfat_proxy: null,
    extended_analysis: {
      degraded: true,
      analysis_quality: "poor",
      quality_issues: ["analyse IA indisponible"],
      score_breakdown: {
        symmetry: 55,
        posture: 55,
        muscle_definition: 55,
        body_composition: 55
      },
      posture_analysis: null,
      muscle_balance: null,
      strengths: [],
      areas_for_improvement: [],
      estimated_metrics: null,
      personalized_recommendations: {
        training_focus: ["Travail full body technique", "Sommeil et récupération", "Progression sur mouvements de base"],
        exercise_examples: ["Squat goblet", "Pompes inclinées", "Rowing haltère", "Hip thrust"],
        frequency_suggestion: "Refaites un scan sous 1 à 2 semaines avec une photo plus propre pour obtenir une analyse plus précise."
      },
      follow_up_in_weeks: 2,
      error: message
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

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { ok: false, error: "Bearer token requis", id: requestId });

  const rawBody = parseBody(req);
  const { ok: bodyOk, data: body } = validateBody(BodyscanBodySchema, rawBody, res);
  if (!bodyOk) return;
  const { user_id, image_path } = body;

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

    let normalized;
    let fallback = false;
    let fallbackReason = "";

    try {
      const analyzed = await analyzeImage({
        apiKey: GEMINI_KEY,
        b64: Buffer.from(ab).toString("base64"),
        mime: guessMime(image_path),
        previousAnalysis
      });
      const parsed = safeJsonExtract(analyzed.text) || extractJson(analyzed.text) || {};
      normalized = normalizeAnalysisOutput(parsed, analyzed.model);
    } catch (analysisError) {
      const info = normalizeGeminiError(analysisError);
      fallback = true;
      fallbackReason = info.message;
      normalized = buildDegradedAnalysis(info.message);
      console.warn("[bodyscan] degraded mode:", info.code, info.message);
    }

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
      fallback,
      model_default: MODEL,
      model_fallback: FALLBACK_MODEL,
      analysis: {
        physical_score: normalized.physical_score,
        posture_score: normalized.posture_score,
        symmetry_score: normalized.symmetry_score,
        feedback_preview: normalized.ai_feedback.slice(0, 200),
        degraded_reason: fallback ? fallbackReason : null
      }
    });

  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[bodyscan]", { id: requestId, code, msg: msg.slice(0, 100) });

    if (code === "TIMEOUT") return json(res, 504, { ok: false, error: "Timeout storage ou traitement — réessayez", id: requestId });
    if (code === "MISSING_DEP") return json(res, 500, { ok: false, error: msg, id: requestId });
    return json(res, 502, { ok: false, error: msg || "Erreur serveur", id: requestId });
  }
};
