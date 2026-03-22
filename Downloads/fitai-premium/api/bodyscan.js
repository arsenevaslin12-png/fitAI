"use strict";

const TIMEOUT_GEMINI_MS = 3000;
const TIMEOUT_STORAGE_MS = 2500;

const {
  DEFAULT_MODEL: MODEL,
  FALLBACK_MODEL,
  callGeminiText,
  extractJson,
  normalizeGeminiError
} = require("./_gemini");
const { validateBody, BodyscanBodySchema } = require("./_env");

const BUCKET = process.env.BUCKET || "user_uploads";

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
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return {}; }
  }
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
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function toArray(input, fallback = []) {
  return Array.isArray(input) ? input.filter(Boolean).map((x) => String(x).trim()).filter(Boolean) : fallback;
}

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
  "strengths": ["Point fort visible 1", "Point fort visible 2", "Point fort visible 3"],
  "areas_for_improvement": ["Axe d'amélioration 1", "Axe d'amélioration 2", "Axe d'amélioration 3"],
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

function normalizeAnalysisOutput(parsed, modelName = MODEL) {
  const p = parsed || {};

  const physicalScore = clampScore(p.physical_score);
  const symmetryScore = clampScore(p.score_breakdown?.symmetry);
  const postureScore = clampScore(p.score_breakdown?.posture);
  const muscleDefScore = clampScore(p.score_breakdown?.muscle_definition);
  const bodyCompScore = clampScore(p.score_breakdown?.body_composition);
  const hasUsefulScores = [physicalScore, symmetryScore, postureScore, muscleDefScore, bodyCompScore].some((v) => typeof v === "number");

  let bodyfatProxy = null;
  if (p.estimated_metrics?.bodyfat_range) {
    const match = String(p.estimated_metrics.bodyfat_range).match(/(\d+)/);
    if (match) bodyfatProxy = parseInt(match[1], 10);
  }

  const strengths = toArray(p.strengths, toArray(p.muscle_balance?.strong_points));
  const improvements = toArray(p.areas_for_improvement, toArray(p.muscle_balance?.weak_points));
  const reco = p.personalized_recommendations || {};
  const trainingFocus = toArray(reco.training_focus);
  const exerciseExamples = toArray(reco.exercise_examples);
  const qualityIssues = toArray(p.quality_issues);

  const feedbackParts = [];
  if (p.analysis_quality === "poor") {
    feedbackParts.push("⚠️ Qualité photo limitée. Pour une meilleure analyse, utilisez un bon éclairage, le corps entier visible et un angle stable.");
  }
  if (p.motivational_feedback) feedbackParts.push(String(p.motivational_feedback).trim());
  if (strengths.length) feedbackParts.push(`✅ Points forts: ${strengths.slice(0, 3).join(", ")}.`);
  if (improvements.length) feedbackParts.push(`🎯 À travailler: ${improvements.slice(0, 3).join(", ")}.`);
  if (trainingFocus.length) feedbackParts.push(`🏋️ Focus entraînement: ${trainingFocus.slice(0, 2).join(", ")}.`);
  if (exerciseExamples.length) feedbackParts.push(`📌 Exercices utiles: ${exerciseExamples.slice(0, 3).join(", ")}.`);
  if (reco.frequency_suggestion) feedbackParts.push(`📅 ${String(reco.frequency_suggestion).trim()}`);
  if (!feedbackParts.length && qualityIssues.length) feedbackParts.push(`⚠️ Points à corriger sur la photo: ${qualityIssues.join(", ")}.`);
  if (!feedbackParts.length) feedbackParts.push("Analyse effectuée. Continuez avec un entraînement régulier, une bonne posture et un nouveau scan dans quelques semaines pour comparer vos progrès.");

  return {
    ai_feedback: feedbackParts.join("\n\n"),
    ai_version: modelName,
    physical_score: hasUsefulScores ? (physicalScore ?? 58) : 58,
    symmetry_score: hasUsefulScores ? (symmetryScore ?? 56) : 56,
    posture_score: hasUsefulScores ? (postureScore ?? 57) : 57,
    bodyfat_proxy: bodyfatProxy,
    extended_analysis: {
      analysis_quality: p.analysis_quality || "acceptable",
      quality_issues: qualityIssues,
      score_breakdown: {
        symmetry: hasUsefulScores ? (symmetryScore ?? 56) : 56,
        posture: hasUsefulScores ? (postureScore ?? 57) : 57,
        muscle_definition: muscleDefScore ?? 55,
        body_composition: bodyCompScore ?? 55
      },
      posture_analysis: p.posture_analysis || null,
      muscle_balance: p.muscle_balance || null,
      strengths,
      areas_for_improvement: improvements,
      estimated_metrics: p.estimated_metrics || null,
      personalized_recommendations: {
        training_focus: trainingFocus,
        exercise_examples: exerciseExamples,
        frequency_suggestion: reco.frequency_suggestion || "Refaites un scan dans 4 à 6 semaines pour mesurer la progression."
      },
      follow_up_in_weeks: p.follow_up_in_weeks || 6
    }
  };
}

function buildDegradedAnalysis(reason, previousAnalysis = null) {
  const message = String(reason || "Analyse IA indisponible");
  return {
    ai_feedback: [
      "⚠️ L'analyse visuelle détaillée n'a pas pu être générée cette fois.",
      "Ce scan a tout de même été enregistré correctement.",
      "Conseil utile: reprenez une photo de face, corps entier visible, lumière frontale et fond simple.",
      `Raison technique: ${message}.`,
      "Réessayez plus tard pour obtenir un feedback plus précis."
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
      strengths: ["Photo bien enregistrée pour un futur comparatif"],
      areas_for_improvement: ["Refaire le scan avec un angle plus propre", "Améliorer l'éclairage"],
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

async function resolvePreviousAnalysis(sb, userId) {
  try {
    const { data: prevScans } = await sb.from("body_scans")
      .select("physical_score, extended_analysis")
      .eq("user_id", userId)
      .not("physical_score", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (!prevScans?.length) return null;
    const prev = prevScans[0];
    return {
      physical_score: prev.physical_score,
      weak_points: prev.extended_analysis?.areas_for_improvement || prev.extended_analysis?.muscle_balance?.weak_points,
      strong_points: prev.extended_analysis?.strengths || prev.extended_analysis?.muscle_balance?.strong_points
    };
  } catch (e) {
    console.warn("[bodyscan] previous analysis unavailable:", e.message);
    return null;
  }
}

async function saveBodyScanResult(sb, { user_id, image_path, normalized }) {
  const payload = {
    user_id,
    image_path,
    ai_feedback: normalized.ai_feedback,
    ai_version: normalized.ai_version,
    physical_score: normalized.physical_score,
    symmetry_score: normalized.symmetry_score,
    posture_score: normalized.posture_score,
    bodyfat_proxy: normalized.bodyfat_proxy,
    extended_analysis: normalized.extended_analysis
  };

  const findByImagePath = await sb.from("body_scans").select("id").eq("user_id", user_id).eq("image_path", image_path).limit(1);
  if (!findByImagePath.error && findByImagePath.data?.[0]?.id) {
    const { error } = await sb.from("body_scans").update(payload).eq("id", findByImagePath.data[0].id);
    if (!error) return { ok: true, mode: "update:image_path" };
  }

  const findByAll = await sb.from("body_scans").select("id").eq("user_id", user_id).order("created_at", { ascending: false }).limit(5);
  if (!findByAll.error && Array.isArray(findByAll.data)) {
    const row = findByAll.data.find((x) => x.id);
    if (row) {
      const { error } = await sb.from("body_scans").update(payload).eq("id", row.id);
      if (!error) return { ok: true, mode: "update:last-row" };
    }
  }

  const { error: insertError } = await sb.from("body_scans").insert(payload);
  if (insertError) return { ok: false, error: insertError };
  return { ok: true, mode: "insert" };
}

module.exports = async function(req, res) {
  cors(res);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", id: requestId });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_SRV = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!SB_URL || !SB_SRV) {
    return json(res, 500, { ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY manquants", id: requestId });
  }

  const token = getBearerToken(req);
  if (!token) return json(res, 401, { ok: false, error: "Bearer token requis", id: requestId });

  let createClient;
  try {
    ({ createClient } = require("@supabase/supabase-js"));
  } catch {
    return json(res, 500, { ok: false, error: "SUPABASE_CLIENT_MISSING", id: requestId });
  }

  const rawBody = parseBody(req);
  const { ok: bodyOk, data: body } = validateBody(BodyscanBodySchema, rawBody, res);
  if (!bodyOk) return;
  const { user_id, image_path } = body;

  const sb = createClient(SB_URL, SB_SRV, { auth: { persistSession: false } });
  const { data: ud, error: ue } = await sb.auth.getUser(token);
  if (ue || !ud?.user?.id) return json(res, 401, { ok: false, error: "Token invalide", id: requestId });
  if (ud.user.id !== user_id) return json(res, 403, { ok: false, error: "Accès refusé", id: requestId });
  if (!image_path.startsWith(`${user_id}/`)) return json(res, 403, { ok: false, error: "Chemin image invalide", id: requestId });

  try {
    const dl = await withTimeout(sb.storage.from(BUCKET).download(image_path), TIMEOUT_STORAGE_MS, "Timeout storage");
    if (dl.error || !dl.data) return json(res, 404, { ok: false, error: "Image introuvable", detail: dl.error?.message, id: requestId });

    const ab = await dl.data.arrayBuffer();
    if (ab.byteLength > 6 * 1024 * 1024) return json(res, 413, { ok: false, error: "Image trop grande (max 6MB)", id: requestId });

    const previousAnalysis = await resolvePreviousAnalysis(sb, user_id);

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
      normalized = buildDegradedAnalysis(info.message, previousAnalysis);
      console.warn("[bodyscan] degraded mode:", info.code, info.message);
    }

    const saved = await saveBodyScanResult(sb, { user_id, image_path, normalized });
    if (!saved.ok) {
      console.error("[bodyscan] DB save failed:", saved.error);
      return json(res, 200, {
        ok: true,
        id: requestId,
        fallback: true,
        fallback_reason: saved.error?.message || "db_save_failed",
        model_default: MODEL,
        model_fallback: FALLBACK_MODEL,
        db_saved: false,
        analysis: {
          physical_score: normalized.physical_score,
          posture_score: normalized.posture_score,
          symmetry_score: normalized.symmetry_score,
          feedback_preview: normalized.ai_feedback.slice(0, 200),
          degraded_reason: fallback ? fallbackReason : null
        }
      });
    }

    return json(res, 200, {
      ok: true,
      id: requestId,
      fallback,
      model_default: MODEL,
      model_fallback: FALLBACK_MODEL,
      db_saved: true,
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
