"use strict";

const TIMEOUT_GEMINI_MS = 5600;
const TIMEOUT_STORAGE_MS = 7000;

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

function scoreLabel(score) {
  const s = Number(score || 0);
  if (s >= 92) return "Exceptionnel";
  if (s >= 86) return "Très athlétique";
  if (s >= 78) return "Athlétique";
  if (s >= 70) return "Bon niveau";
  if (s >= 62) return "Actif régulier";
  if (s >= 52) return "Base correcte";
  return "Début de base";
}

function confidenceLabel(qualityIssues, analysisQuality) {
  const count = Array.isArray(qualityIssues) ? qualityIssues.length : 0;
  const q = String(analysisQuality || "acceptable");
  if (q === "good" && count === 0) return "Lecture fiable";
  if (q === "poor" || count >= 2) return "Lecture prudente";
  return "Lecture correcte";
}

function buildComparison(previousScore, currentScore) {
  const prev = Number(previousScore);
  const next = Number(currentScore);
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return null;
  const delta = Math.round(next - prev);
  return {
    previous_score: prev,
    current_score: next,
    delta_score: delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    label: delta > 0 ? `+${delta}` : `${delta}`,
    summary: delta >= 3 ? 'progression visible' : delta <= -3 ? 'recul visible' : 'niveau global assez stable'
  };
}

function deriveVisualTier(scores, bodyfatProxy, qualityIssues, metrics) {
  const def = Number(scores?.muscle_definition || 0);
  const comp = Number(scores?.body_composition || 0);
  const post = Number(scores?.posture || 0);
  const sym = Number(scores?.symmetry || 0);
  const avg = Math.round((def + comp + post + sym) / 4);
  const qPenalty = Array.isArray(qualityIssues) ? qualityIssues.length : 0;
  const cat = String(metrics?.fitness_category || '').toLowerCase();

  if (qPenalty >= 2) return 'prudence';
  if (def >= 88 && comp >= 86 && post >= 72 && sym >= 76 && typeof bodyfatProxy === 'number' && bodyfatProxy <= 9) return 'elite';
  if (def >= 82 && comp >= 80 && post >= 68 && sym >= 72 && typeof bodyfatProxy === 'number' && bodyfatProxy <= 12) return 'very_athletic';
  if (def >= 74 && comp >= 72 && avg >= 72 && typeof bodyfatProxy === 'number' && bodyfatProxy <= 15) return 'athletic';
  if (def >= 66 && comp >= 66 && avg >= 66 && (bodyfatProxy == null || bodyfatProxy <= 18)) return 'good';
  if (avg >= 58 && (bodyfatProxy == null || bodyfatProxy <= 22)) return 'active';
  if (cat === 'sedentary' || (typeof bodyfatProxy === 'number' && bodyfatProxy >= 24)) return 'base';
  return 'regular';
}

function scoreFloorByTier(tier) {
  if (tier === 'elite') return 88;
  if (tier === 'very_athletic') return 80;
  if (tier === 'athletic') return 72;
  if (tier === 'good') return 64;
  if (tier === 'active') return 56;
  if (tier === 'regular') return 50;
  return 42;
}

function buildScoreReasons(scores, bodyfatProxy, qualityIssues, postureAnalysis, muscleBalance) {
  const reasons = [];
  const brakes = [];
  const def = Number(scores?.muscle_definition || 0);
  const comp = Number(scores?.body_composition || 0);
  const post = Number(scores?.posture || 0);
  const sym = Number(scores?.symmetry || 0);

  if (def >= 74) reasons.push('Relief musculaire visible sur plusieurs zones');
  else if (def >= 66) reasons.push('Tonus visible mais encore modéré');
  else brakes.push('Relief musculaire encore trop discret pour monter plus haut');

  if (comp >= 74 && typeof bodyfatProxy === 'number' && bodyfatProxy <= 15) reasons.push('Composition corporelle assez nette visuellement');
  else if (typeof bodyfatProxy === 'number' && bodyfatProxy >= 18) brakes.push('La composition corporelle limite encore la lecture athlétique');

  if (post >= 72) reasons.push('Posture globalement propre sur la prise de vue');
  else if (post <= 64) brakes.push('La posture fait baisser la lecture générale du physique');

  if (sym >= 72) reasons.push('Symétrie correcte sur la photo');
  else if (sym <= 64 || String(muscleBalance?.left_right_symmetry || '') === 'noticeable_imbalance') brakes.push('Légère asymétrie ou équilibre visuel encore irrégulier');

  if (String(postureAnalysis?.shoulder_alignment || '') === 'rounded') brakes.push('Épaules enroulées : la silhouette paraît moins ouverte');
  if (String(postureAnalysis?.head_position || '') === 'forward_head') brakes.push('Tête projetée vers l’avant sur la pose');
  if (Array.isArray(qualityIssues) && qualityIssues.length) brakes.push('La qualité de photo réduit la fiabilité et plafonne le score');

  return {
    score_drivers: uniqStrings(reasons, 4),
    score_brakes: uniqStrings(brakes, 4)
  };
}

function scoreCapByProfile({ fitnessCategory, muscleMassLevel, bodyfatProxy, analysisQuality }) {
  const category = String(fitnessCategory || "").toLowerCase();
  const muscle = String(muscleMassLevel || "").toLowerCase();
  let cap = 68;
  if (category === "sedentary") cap = 38;
  else if (category === "recreational") cap = 62;
  else if (category === "athletic") cap = 82;
  else if (category === "competitive") cap = 91;

  if (muscle === "beginner") cap = Math.min(cap, 49);
  else if (muscle === "intermediate") cap = Math.min(cap, 64);
  else if (muscle === "advanced") cap = Math.max(cap, 78);
  else if (muscle === "elite") cap = Math.max(cap, 88);

  if (typeof bodyfatProxy === "number") {
    if (bodyfatProxy >= 24) cap = Math.min(cap, 44);
    else if (bodyfatProxy >= 20) cap = Math.min(cap, 54);
    else if (bodyfatProxy >= 17) cap = Math.min(cap, 63);
    else if (bodyfatProxy >= 15) cap = Math.min(cap, 70);
    else if (bodyfatProxy <= 13) cap = Math.max(cap, 84);
    else if (bodyfatProxy <= 10) cap = Math.max(cap, 89);
    else if (bodyfatProxy <= 8) cap = Math.max(cap, 92);
  }

  const quality = String(analysisQuality || "");
  if (quality === "poor") cap = Math.min(cap, 54);
  else if (quality === "acceptable") cap = Math.max(34, cap - 3);
  return cap;
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

  return `Tu es un coach fitness spécialisé en analyse corporelle visuelle.
Analyse cette photo avec franchise absolue et des standards exigeants.
Ton analyse doit être SPÉCIFIQUE à cette photo précise — décris ce que tu vois réellement (zones, proportions, masses musculaires visibles), pas des formules génériques. Les champs "body_composition", "muscle_definition_text" et "motivational_feedback" doivent être uniques à cette personne.

CALIBRATION STRICTE — respecte impérativement ces fourchettes:
- 15-30 : personne sédentaire, peu ou pas d'activité visible sur le physique
- 31-45 : base faible, excès de masse grasse visible ou manque total de tonus
- 46-55 : niveau ordinaire, ni athlétique ni sédentaire
- 56-65 : pratiquant régulier mais sans définition marquée (la grande majorité des gens actifs)
- 66-70 : bon niveau, propre, tonus visible mais sans rendu vraiment athlétique
- 71-78 : physique athlétique réel, sec, ou présence musculaire clairement visible
- 79-88 : très athlétique à élite visuel — physique sec avec vraie densité musculaire
- 89-94 : exceptionnel, moins de 1% de la population, bodybuilder en condition ou athlète de haut niveau
- 95-100 : IMPOSSIBLE sur une photo normale — réservé au niveau pro en compétition

ERREURS À ÉVITER ABSOLUMENT:
- Ne jamais donner 62+ à quelqu'un sans définition musculaire visible
- Ne jamais donner 70+ sans sécheresse, tonus réel et cohérence globale
- Ne jamais donner 78+ sans critères athlétiques nets
- Ne jamais donner 85+ sans critères élite évidents
- Un physique "propre mais ordinaire" = 56-64, pas 70+
- La générosité fausse les données futures et détruit la crédibilité du score

AUTRES RÈGLES:
- Ne fais jamais de diagnostic médical
- Base-toi uniquement sur ce qui est visible sur la photo
- Si la qualité photo est insuffisante (flou, mauvais cadrage, vêtements masquant le corps), indique-le et pénalise le score
- Sois spécifique: nomme les zones précises observées

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
  "body_composition": "Phrase courte et franche sur le niveau de sécheresse / masse grasse visible",
  "muscle_definition_text": "Phrase courte et franche sur le relief musculaire visible",
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
    temperature: 0.6,
    maxOutputTokens: 1600,
    timeoutMs: TIMEOUT_GEMINI_MS,
    retries: 0
  });
  return { text: result.text, model: result.model };
}

function normalizeAnalysisOutput(parsed, modelName = MODEL, previousAnalysis = null, metaSeed = "") {
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
  const seed = makeSeed(JSON.stringify(rawScores), bodyfatProxy, JSON.stringify(qualityIssues), previousAnalysis?.physical_score || "", metaSeed, p.body_composition || "", p.muscle_definition_text || "", postureAnalysis?.overall || "", muscleBalance?.upper_lower_ratio || "");

  const penalties =
    (p.analysis_quality === "poor" ? 20 : p.analysis_quality === "acceptable" ? 8 : 0)
    + ((rawScores.posture || 70) < 60 ? 13 : (rawScores.posture || 70) < 66 ? 8 : (rawScores.posture || 70) < 72 ? 4 : 0)
    + ((rawScores.symmetry || 70) < 60 ? 12 : (rawScores.symmetry || 70) < 66 ? 7 : (rawScores.symmetry || 70) < 72 ? 4 : 0)
    + ((rawScores.muscle_definition || 66) < 54 ? 18 : (rawScores.muscle_definition || 66) < 62 ? 11 : (rawScores.muscle_definition || 66) < 70 ? 5 : 0)
    + ((rawScores.body_composition || 66) < 54 ? 17 : (rawScores.body_composition || 66) < 62 ? 11 : (rawScores.body_composition || 66) < 70 ? 5 : 0)
    + (qualityIssues.length >= 2 ? 7 : qualityIssues.length === 1 ? 3 : 0)
    + (typeof bodyfatProxy === "number" && bodyfatProxy >= 24 ? 16 : typeof bodyfatProxy === "number" && bodyfatProxy >= 20 ? 11 : typeof bodyfatProxy === "number" && bodyfatProxy >= 17 ? 6 : 0);

  const bonuses =
    ((rawScores.posture || 0) >= 78 ? 4 : (rawScores.posture || 0) >= 72 ? 2 : 0)
    + ((rawScores.symmetry || 0) >= 80 ? 5 : (rawScores.symmetry || 0) >= 74 ? 2 : 0)
    + ((rawScores.muscle_definition || 0) >= 82 ? 10 : (rawScores.muscle_definition || 0) >= 74 ? 4 : 0)
    + ((rawScores.body_composition || 0) >= 82 ? 9 : (rawScores.body_composition || 0) >= 74 ? 4 : 0)
    + (typeof bodyfatProxy === "number" && bodyfatProxy <= 12 ? 7 : typeof bodyfatProxy === "number" && bodyfatProxy <= 15 ? 2 : 0);

  const derivedScores = {
    symmetry: clampScore(rawScores.symmetry ?? 58),
    posture: clampScore(rawScores.posture ?? 56),
    muscle_definition: clampScore(rawScores.muscle_definition ?? 52),
    body_composition: clampScore(rawScores.body_composition ?? (typeof bodyfatProxy === "number" ? Math.max(36, 96 - (bodyfatProxy * 2.6)) : 52))
  };

  const basePhysical = rawScores.physical_score ?? avgScore ?? 56;
  const weightedBase = Math.round(((derivedScores.symmetry * 0.14) + (derivedScores.posture * 0.14) + (derivedScores.muscle_definition * 0.38) + (derivedScores.body_composition * 0.34)));
  const cap = scoreCapByProfile({
    fitnessCategory: p.estimated_metrics?.fitness_category,
    muscleMassLevel: p.estimated_metrics?.muscle_mass_level,
    bodyfatProxy,
    analysisQuality: p.analysis_quality
  });
  const qualityPenalty = qualityIssues.length ? 2 : 0;
  let calibratedPhysical = clampScore(Math.round(((basePhysical * 0.14) + (weightedBase * 0.86)) - (penalties * 0.88) - qualityPenalty + bonuses)) ?? 53;

  if ((derivedScores.muscle_definition || 0) < 60 || (derivedScores.body_composition || 0) < 60) {
    calibratedPhysical = Math.min(calibratedPhysical, 60);
  } else if ((derivedScores.muscle_definition || 0) < 68 || (derivedScores.body_composition || 0) < 68) {
    calibratedPhysical = Math.min(calibratedPhysical, 68);
  } else if ((derivedScores.muscle_definition || 0) < 74 || (derivedScores.body_composition || 0) < 72) {
    calibratedPhysical = Math.min(calibratedPhysical, 75);
  }

  if (qualityIssues.length >= 2 || p.analysis_quality === "poor") {
    calibratedPhysical = Math.min(calibratedPhysical, 61);
  }

  if (p.estimated_metrics?.fitness_category === "recreational" && typeof bodyfatProxy === "number" && bodyfatProxy >= 18) {
    calibratedPhysical = Math.min(calibratedPhysical, 63);
  }

  calibratedPhysical = Math.min(calibratedPhysical, cap);

  const visualTier = deriveVisualTier(derivedScores, bodyfatProxy, qualityIssues, p.estimated_metrics || {});
  const tierFloor = scoreFloorByTier(visualTier);
  if ((visualTier === "athletic" || visualTier === "very_athletic" || visualTier === "elite") && p.analysis_quality !== "poor") {
    calibratedPhysical = Math.max(calibratedPhysical, tierFloor);
  }
  if (visualTier === "prudence") {
    calibratedPhysical = Math.min(calibratedPhysical, 58);
  }
  calibratedPhysical = Math.min(calibratedPhysical, cap);

  const confidencePct = Math.max(42, Math.min(96,
    92
    - (p.analysis_quality === "poor" ? 24 : p.analysis_quality === "acceptable" ? 8 : 0)
    - (qualityIssues.length * 8)
  ));

  const scoreReasons = buildScoreReasons(derivedScores, bodyfatProxy, qualityIssues, postureAnalysis, muscleBalance);

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

  // ── Build ai_feedback using Gemini's actual personalized text ────────────────
  // Gemini generates specific descriptions per photo — use them as the backbone.
  const geminiComposition = String(p.body_composition || "").trim();
  const geminiDefinition  = String(p.muscle_definition_text || "").trim();
  const geminiMotivation  = String(p.motivational_feedback || "").trim();

  const feedbackParts = [];

  if (p.analysis_quality === "poor") {
    feedbackParts.push("⚠️ Qualité photo limitée — les constats sont prudents. Refais un scan avec lumière frontale, corps entier visible sur fond neutre et angle stable.");
  }

  // Score line + Gemini's composition & definition texts (specific to this photo)
  let scoreLine = `Score calibré : ${calibratedPhysical}/100.`;
  if (geminiComposition) scoreLine += `\n${geminiComposition}`;
  if (geminiDefinition)  scoreLine += `\n${geminiDefinition}`;
  if (!geminiComposition && !geminiDefinition) scoreLine += ` ${derivedReco.rationale}`;
  feedbackParts.push(scoreLine);

  if (strengths.length)        feedbackParts.push(`✅ Points forts : ${strengths.join(" · ")}.`);
  if (improvements.length)     feedbackParts.push(`🎯 Ce qui limite le score : ${improvements.join(" · ")}.`);
  if (trainingFocus.length)    feedbackParts.push(`🏋️ Focus entraînement : ${trainingFocus.join(", ")}.`);
  if (nutritionFocus.length)   feedbackParts.push(`🥗 Ajustements nutrition : ${nutritionFocus.join(", ")}.`);
  if (exerciseExamples.length) feedbackParts.push(`📌 Exercices clés : ${exerciseExamples.join(", ")}.`);

  // Gemini's motivational message — unique per photo, use it if quality is sufficient
  if (geminiMotivation && geminiMotivation.length > 15) {
    feedbackParts.push(`💪 ${geminiMotivation.replace(/^💪\s*/u, "")}`);
  }

  const comparison = buildComparison(previousAnalysis?.physical_score, calibratedPhysical);
  if (comparison) {
    feedbackParts.push(`📈 Par rapport au dernier scan: ${comparison.summary} (${comparison.label} point${Math.abs(comparison.delta_score) > 1 ? 's' : ''}).`);
  }

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
      motivational_feedback: p.motivational_feedback || null,
      personalized_recommendations: {
        training_focus: trainingFocus,
        training: trainingFocus,
        nutrition: nutritionFocus,
        exercise_examples: exerciseExamples,
        frequency_suggestion: reco.frequency_suggestion || derivedReco.frequency_suggestion,
        priority_area: derivedReco.priority_area,
        rationale: derivedReco.rationale
      },
      comparison,
      follow_up_in_weeks: p.follow_up_in_weeks || 4,
      level_label: scoreLabel(calibratedPhysical),
      confidence_label: confidenceLabel(qualityIssues, p.analysis_quality),
      confidence_pct: confidencePct,
      visual_tier: visualTier,
      score_drivers: scoreReasons.score_drivers,
      score_brakes: scoreReasons.score_brakes
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
      `Score de prudence temporaire: 48/100. ${improvements[0]}.`,
      `Focus immédiat: ${training.join(", ")}.`,
      `Nutrition utile: ${nutrition.join(", ")}.`,
      `Raison technique: ${message}.`
    ].join("\n\n"),
    ai_version: `degraded:${MODEL}`,
    physical_score: 48,
    symmetry_score: 49,
    posture_score: 47,
    bodyfat_proxy: null,
    extended_analysis: {
      degraded: true,
      analysis_quality: "poor",
      quality_issues: ["analyse IA indisponible"],
      score_breakdown: {
        symmetry: 49,
        posture: 47,
        muscle_definition: 46,
        body_composition: 48
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
      comparison: buildComparison(previousAnalysis?.physical_score, 48),
      follow_up_in_weeks: 2,
      level_label: "Lecture prudente",
      confidence_label: "Lecture prudente",
      confidence_pct: 48,
      visual_tier: "prudence",
      score_drivers: strengths,
      score_brakes: improvements,
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

const { checkRateLimit, getIp } = require("./_coach-core");

module.exports = async function(req, res) {
  cors(res);
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", id: requestId });

  const limit = checkRateLimit("bodyscan", getIp(req), 6, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return json(res, 429, { ok: false, error: `Trop de scans. Réessayez dans ${limit.retryAfterSec}s.`, id: requestId });
  }

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
      normalized = normalizeAnalysisOutput(parsed, analyzed.model, previousAnalysis, image_path);
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
