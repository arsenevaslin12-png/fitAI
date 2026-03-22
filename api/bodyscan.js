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

function uniqStrings(items, max = 6) {
  const out = [];
  for (const item of items || []) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    if (out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) continue;
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function makeSeed(...parts) {
  const text = parts.map((part) => String(part || "")).join("|");
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) seed = (seed * 33 + text.charCodeAt(i)) % 2147483647;
  return seed || 17;
}

function pickSeeded(list, seed, count = 1) {
  const pool = Array.isArray(list) ? list.slice() : [];
  const out = [];
  let idx = Math.abs(seed || 1);
  while (pool.length && out.length < count) {
    const pick = idx % pool.length;
    out.push(pool.splice(pick, 1)[0]);
    idx = Math.floor(idx / 2) + 11;
  }
  return out;
}

function deriveStrengths(scores, seed) {
  const strengths = [];
  if ((scores.muscle_definition || 0) >= 72) strengths.push(...pickSeeded([
    "Définition visible du haut du corps",
    "Bonne tension musculaire générale",
    "Bras et épaules déjà lisibles sur la photo"
  ], seed + 1, 1));
  if ((scores.symmetry || 0) >= 74) strengths.push(...pickSeeded([
    "Symétrie générale plutôt propre",
    "Répartition gauche / droite assez régulière",
    "Équilibre visuel global correct"
  ], seed + 2, 1));
  if ((scores.posture || 0) >= 72) strengths.push(...pickSeeded([
    "Posture globalement stable",
    "Alignement du tronc plutôt correct",
    "Bonne tenue générale sur la prise de vue"
  ], seed + 3, 1));
  if ((scores.body_composition || 0) >= 70) strengths.push(...pickSeeded([
    "Composition corporelle déjà dans une zone cohérente pour progresser",
    "Base physique exploitable sans repartir de zéro",
    "Niveau récréatif crédible avec marge de progression réelle"
  ], seed + 4, 1));
  if (!strengths.length) strengths.push(...pickSeeded([
    "Base exploitable pour progresser vite si tu restes régulier",
    "Photo suffisamment lisible pour suivre une évolution réelle",
    "Structure générale correcte pour construire la suite"
  ], seed + 5, 2));
  return uniqStrings(strengths, 3);
}

function deriveImprovements(scores, postureAnalysis, muscleBalance, qualityIssues, bodyfatProxy, seed) {
  const improvements = [];
  const shoulder = String(postureAnalysis?.shoulder_alignment || "");
  const head = String(postureAnalysis?.head_position || "");
  const hip = String(postureAnalysis?.hip_alignment || "");
  const lr = String(muscleBalance?.left_right_symmetry || "");
  const ap = String(muscleBalance?.anterior_posterior || "");

  if ((scores.posture || 0) < 70 || shoulder === "rounded") improvements.push(...pickSeeded([
    "Ouvrir davantage la cage thoracique et renforcer l'arrière d'épaule",
    "Corriger la tendance épaules en avant avec plus de tirages horizontaux",
    "Travailler posture haute et contrôle scapulaire"
  ], seed + 10, 1));
  if ((scores.posture || 0) < 68 || head === "forward_head") improvements.push(...pickSeeded([
    "Mieux empiler tête / nuque / thorax sur les positions debout",
    "Réduire la projection de tête vers l'avant",
    "Renforcer le gainage postural du haut du tronc"
  ], seed + 11, 1));
  if ((scores.symmetry || 0) < 72 || lr === "noticeable_imbalance") improvements.push(...pickSeeded([
    "Rééquilibrer le travail unilatéral gauche / droite",
    "Corriger la légère asymétrie visible sur la chaîne supérieure",
    "Stabiliser davantage les appuis et l'alignement bilatéral"
  ], seed + 12, 1));
  if ((scores.muscle_definition || 0) < 68) improvements.push(...pickSeeded([
    "Monter le niveau de définition musculaire globale",
    "Densifier le tronc et le haut du corps avec plus de surcharge progressive",
    "Construire davantage de relief musculaire visible"
  ], seed + 13, 1));
  if ((scores.body_composition || 0) < 68 || (typeof bodyfatProxy === "number" && bodyfatProxy >= 18)) improvements.push(...pickSeeded([
    "Améliorer la composition corporelle avec plus de régularité nutrition + activité",
    "Gagner en netteté visuelle avec un meilleur contrôle du déficit ou du maintien calorique",
    "Stabiliser davantage le ratio masse maigre / masse grasse"
  ], seed + 14, 1));
  if (hip === "anterior_tilt" || hip === "posterior_tilt") improvements.push(...pickSeeded([
    "Mieux contrôler le bassin et le gainage sur les positions debout",
    "Renforcer chaîne postérieure et sangle abdominale pour stabiliser le bassin",
    "Améliorer le placement bassin / tronc sur les mouvements de base"
  ], seed + 15, 1));
  if (ap === "anterior_dominant") improvements.push(...pickSeeded([
    "Renforcer davantage la chaîne postérieure pour équilibrer le profil",
    "Donner plus de volume au dos et aux fessiers pour équilibrer la silhouette",
    "Sortir d'un profil trop dominant à l'avant du corps"
  ], seed + 16, 1));
  if (qualityIssues.length) improvements.push(...pickSeeded([
    "Refaire un scan avec un angle plus neutre et une lumière frontale propre",
    "Améliorer la qualité de prise de vue pour une lecture plus fiable",
    "Montrer le corps entier sur fond simple pour comparer les prochains scans"
  ], seed + 17, 1));
  if (!improvements.length) improvements.push(...pickSeeded([
    "Continuer à monter le niveau global sans négliger posture et régularité",
    "Chercher plus de constance sur l'entraînement et le sommeil pour débloquer la suite",
    "Passer d'une bonne base à un physique plus net avec plus de précision dans la semaine"
  ], seed + 18, 2));
  return uniqStrings(improvements, 4);
}

function deriveRecommendations(scores, improvements, bodyfatProxy, seed) {
  const weakest = [
    ["posture", scores.posture || 0],
    ["symmetry", scores.symmetry || 0],
    ["muscle_definition", scores.muscle_definition || 0],
    ["body_composition", scores.body_composition || 0]
  ].sort((a, b) => a[1] - b[1])[0][0];

  let trainingFocus = [];
  let exerciseExamples = [];
  let nutrition = [];

  if (weakest === "posture") {
    trainingFocus = pickSeeded([
      "Posture haute + chaîne postérieure",
      "Contrôle scapulaire et ouverture thoracique",
      "Gainage anti-flexion et alignement du tronc"
    ], seed + 21, 2);
    exerciseExamples = pickSeeded(["rowing poulie ou haltère", "face pull", "hip hinge léger", "dead bug", "bird dog"], seed + 22, 4);
  } else if (weakest === "symmetry") {
    trainingFocus = pickSeeded([
      "Travail unilatéral contrôlé",
      "Rééquilibrage gauche / droite",
      "Stabilité des appuis et contrôle moteur"
    ], seed + 23, 2);
    exerciseExamples = pickSeeded(["split squat", "rowing unilatéral", "développé haltères unilatéral", "fente marchée", "carry unilatéral"], seed + 24, 4);
  } else if (weakest === "body_composition") {
    trainingFocus = pickSeeded([
      "Dépense hebdo plus régulière",
      "Mouvements globaux + volume maîtrisé",
      "Progression simple mais suivie"
    ], seed + 25, 2);
    exerciseExamples = pickSeeded(["squat goblet", "pompes inclinées", "rowing haltère", "hip thrust", "marche rapide inclinée"], seed + 26, 4);
  } else {
    trainingFocus = pickSeeded([
      "Progressive overload sur les bases",
      "Volume propre sur le haut du corps et le tronc",
      "Séances full body plus denses"
    ], seed + 27, 2);
    exerciseExamples = pickSeeded(["développé incliné haltères", "tractions assistées ou tirage", "squat goblet", "élévations latérales", "gainage"], seed + 28, 4);
  }

  if (typeof bodyfatProxy === "number" && bodyfatProxy >= 18) {
    nutrition = pickSeeded([
      "Vise 80 à 90 % de repas simples et mesurables la semaine",
      "Sécurise 2 g de protéines/kg et garde les calories liquides basses",
      "Ajoute 7 à 9 k pas/jour pour faire le travail sans te cramer"
    ], seed + 29, 2);
  } else {
    nutrition = pickSeeded([
      "Garde les protéines hautes pour consolider la progression visuelle",
      "Place les glucides autour des séances pour garder du rendement",
      "Hydratation + sommeil = levier sous-estimé pour mieux récupérer"
    ], seed + 30, 2);
  }

  const frequency = weakest === "posture"
    ? "Travaille ce focus 2 à 3 fois par semaine et refais un scan dans 4 semaines avec le même angle."
    : weakest === "body_composition"
      ? "Mets 3 à 4 séances utiles + marche quotidienne pendant 4 semaines avant de rescanner."
      : "Garde ce focus 2 fois par semaine minimum et refais un scan dans 4 à 6 semaines pour comparer proprement.";

  return {
    training_focus: uniqStrings(trainingFocus, 3),
    training: uniqStrings(trainingFocus, 3),
    nutrition: uniqStrings(nutrition, 3),
    exercise_examples: uniqStrings(exerciseExamples, 4),
    frequency_suggestion: frequency,
    priority_area: weakest,
    rationale: improvements[0] || "Priorité sur le point le plus faible du scan."
  };
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
1. Sois encourageant mais franc: n'adoucis pas artificiellement les défauts visibles
2. Ne fais JAMAIS de diagnostic médical
3. Base ton analyse uniquement sur ce qui est visible
4. Si la qualité photo est insuffisante, indique-le clairement
5. Scores entre 0-100 où 100 = excellent et 50-65 = base encore moyenne

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

function normalizeAnalysisOutput(parsed, modelName = MODEL, previousAnalysis = null) {
  const p = parsed || {};
  const rawScores = {
    physical_score: clampScore(p.physical_score),
    symmetry: clampScore(p.score_breakdown?.symmetry),
    posture: clampScore(p.score_breakdown?.posture),
    muscle_definition: clampScore(p.score_breakdown?.muscle_definition),
    body_composition: clampScore(p.score_breakdown?.body_composition)
  };
  const availableScores = [rawScores.symmetry, rawScores.posture, rawScores.muscle_definition, rawScores.body_composition].filter((v) => typeof v === "number");
  const avgScore = availableScores.length ? Math.round(availableScores.reduce((acc, v) => acc + v, 0) / availableScores.length) : null;

  let bodyfatProxy = null;
  if (p.estimated_metrics?.bodyfat_range) {
    const match = String(p.estimated_metrics.bodyfat_range).match(/(\d+)/);
    if (match) bodyfatProxy = parseInt(match[1], 10);
  }

  const postureAnalysis = p.posture_analysis || null;
  const muscleBalance = p.muscle_balance || null;
  const qualityIssues = uniqStrings(toArray(p.quality_issues), 4);
  const seed = makeSeed(JSON.stringify(rawScores), bodyfatProxy, JSON.stringify(qualityIssues), previousAnalysis?.physical_score || "");

  const penalties =
    (p.analysis_quality === "poor" ? 10 : p.analysis_quality === "acceptable" ? 4 : 0)
    + ((rawScores.posture || 72) < 68 ? 6 : (rawScores.posture || 72) < 74 ? 2 : 0)
    + ((rawScores.symmetry || 72) < 68 ? 6 : (rawScores.symmetry || 72) < 74 ? 2 : 0)
    + ((rawScores.muscle_definition || 70) < 66 ? 5 : (rawScores.muscle_definition || 70) < 72 ? 2 : 0)
    + ((rawScores.body_composition || 70) < 66 ? 5 : (rawScores.body_composition || 70) < 72 ? 2 : 0)
    + (qualityIssues.length >= 2 ? 3 : 0)
    + (typeof bodyfatProxy === "number" && bodyfatProxy >= 20 ? 3 : 0);

  const derivedScores = {
    symmetry: clampScore(rawScores.symmetry ?? 62),
    posture: clampScore(rawScores.posture ?? 60),
    muscle_definition: clampScore(rawScores.muscle_definition ?? 58),
    body_composition: clampScore(rawScores.body_composition ?? (typeof bodyfatProxy === "number" ? Math.max(42, 100 - (bodyfatProxy * 2)) : 57))
  };

  const basePhysical = rawScores.physical_score ?? avgScore ?? 60;
  const calibratedPhysical = clampScore(Math.round(basePhysical - penalties * 0.55)) ?? 58;

  const strengths = uniqStrings([
    ...toArray(p.strengths),
    ...toArray(muscleBalance?.strong_points),
    ...deriveStrengths(derivedScores, seed)
  ], 3);
  const improvements = uniqStrings([
    ...toArray(p.areas_for_improvement),
    ...toArray(muscleBalance?.weak_points),
    ...deriveImprovements(derivedScores, postureAnalysis, muscleBalance, qualityIssues, bodyfatProxy, seed)
  ], 4);

  const reco = p.personalized_recommendations || {};
  const derivedReco = deriveRecommendations(derivedScores, improvements, bodyfatProxy, seed);
  const trainingFocus = uniqStrings([...toArray(reco.training_focus), ...toArray(reco.training), ...derivedReco.training_focus], 3);
  const nutritionFocus = uniqStrings([...toArray(reco.nutrition), ...derivedReco.nutrition], 3);
  const exerciseExamples = uniqStrings([...toArray(reco.exercise_examples), ...derivedReco.exercise_examples], 4);

  const feedbackParts = [];
  if (p.analysis_quality === "poor") feedbackParts.push("⚠️ Qualité photo limitée. Les constats restent prudents: refais un scan avec lumière frontale, corps entier visible et angle stable.");
  feedbackParts.push(`Score honnête: ${calibratedPhysical}/100. ${derivedReco.rationale}`);
  if (strengths.length) feedbackParts.push(`✅ Points forts visibles: ${strengths.join(", ")}.`);
  if (improvements.length) feedbackParts.push(`🎯 Priorités réelles: ${improvements.join(", ")}.`);
  if (trainingFocus.length) feedbackParts.push(`🏋️ Focus entraînement: ${trainingFocus.join(", ")}.`);
  if (nutritionFocus.length) feedbackParts.push(`🥗 Ajustements utiles: ${nutritionFocus.join(", ")}.`);
  if (exerciseExamples.length) feedbackParts.push(`📌 Exemples concrets: ${exerciseExamples.join(", ")}.`);
  feedbackParts.push(`📅 ${reco.frequency_suggestion || derivedReco.frequency_suggestion}`);

  return {
    ai_feedback: feedbackParts.join("\n\n"),
    ai_version: modelName,
    physical_score: calibratedPhysical,
    symmetry_score: derivedScores.symmetry,
    posture_score: derivedScores.posture,
    bodyfat_proxy: bodyfatProxy,
    extended_analysis: {
      analysis_quality: p.analysis_quality || "acceptable",
      quality_issues: qualityIssues,
      score_breakdown: {
        symmetry: derivedScores.symmetry,
        posture: derivedScores.posture,
        muscle_definition: derivedScores.muscle_definition,
        body_composition: derivedScores.body_composition
      },
      posture_analysis: postureAnalysis,
      muscle_balance: muscleBalance,
      strengths,
      areas_for_improvement: improvements,
      estimated_metrics: p.estimated_metrics || null,
      body_composition: p.body_composition || null,
      muscle_definition_text: p.muscle_definition_text || null,
      personalized_recommendations: {
        training_focus: trainingFocus,
        training: trainingFocus,
        nutrition: nutritionFocus,
        exercise_examples: exerciseExamples,
        frequency_suggestion: reco.frequency_suggestion || derivedReco.frequency_suggestion,
        priority_area: derivedReco.priority_area,
        rationale: derivedReco.rationale
      },
      follow_up_in_weeks: p.follow_up_in_weeks || 4
    }
  };
}

function buildDegradedAnalysis(reason, previousAnalysis = null) {
  const message = String(reason || "Analyse IA indisponible");
  const seed = makeSeed(message, previousAnalysis?.physical_score || "none");
  const strengths = uniqStrings([
    "Photo bien enregistrée pour une comparaison future",
    ...pickSeeded([
      "Base exploitable pour suivre la progression",
      "Capture suffisante pour conserver un repère visuel",
      "Scan enregistré correctement malgré l'analyse dégradée"
    ], seed + 1, 1)
  ], 2);
  const improvements = pickSeeded([
    "Refaire le scan avec une lumière frontale plus propre",
    "Se placer droit, bras légèrement ouverts et corps entier visible",
    "Utiliser un fond simple pour éviter de parasiter la lecture visuelle",
    "Reprendre le même angle à chaque scan pour comparer honnêtement"
  ], seed + 2, 3);
  const training = pickSeeded([
    "Travail full body technique",
    "Chaîne postérieure et posture",
    "Mouvements de base avec exécution propre",
    "Marche + gainage + tirages horizontaux"
  ], seed + 3, 2);
  const exercises = pickSeeded(["squat goblet", "rowing haltère", "hip thrust", "pompes inclinées", "face pull", "dead bug"], seed + 4, 4);
  const nutrition = pickSeeded([
    "Maintiens des protéines hautes sur la semaine",
    "Évite les calories liquides inutiles si tu veux mieux lire l'évolution",
    "Hydratation et sommeil restent les leviers les plus rentables"
  ], seed + 5, 2);

  return {
    ai_feedback: [
      "⚠️ L'analyse visuelle détaillée n'a pas pu être générée cette fois.",
      `Score de prudence temporaire: 52/100. ${improvements[0]}.`,
      `Focus immédiat: ${training.join(", ")}.`,
      `Nutrition utile: ${nutrition.join(", ")}.`,
      `Raison technique: ${message}.`
    ].join("\n\n"),
    ai_version: `degraded:${MODEL}`,
    physical_score: 52,
    symmetry_score: 53,
    posture_score: 51,
    bodyfat_proxy: null,
    extended_analysis: {
      degraded: true,
      analysis_quality: "poor",
      quality_issues: ["analyse IA indisponible"],
      score_breakdown: {
        symmetry: 53,
        posture: 51,
        muscle_definition: 50,
        body_composition: 52
      },
      posture_analysis: null,
      muscle_balance: null,
      strengths,
      areas_for_improvement: improvements,
      estimated_metrics: null,
      personalized_recommendations: {
        training_focus: training,
        training,
        nutrition,
        exercise_examples: exercises,
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
      normalized = normalizeAnalysisOutput(parsed, analyzed.model, previousAnalysis);
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
