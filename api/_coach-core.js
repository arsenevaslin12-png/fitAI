"use strict";

const {
  DEFAULT_MODEL: MODEL,
  DEFAULT_TIMEOUT_MS: TIMEOUT_MS,
  extractJson,
  callGeminiText
} = require("./_gemini");

const MAX_RETRIES = 0;
const rateLimitBuckets = new Map();

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

function sanitizeInput(input, maxLength = 1000) {
  if (typeof input !== "string") return "";
  return input
    .slice(0, maxLength)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+=/gi, "")
    .trim();
}

function normalizeText(value, fallback = "") {
  return sanitizeInput(String(value || fallback), 240);
}

function normalizeRole(value) {
  const v = String(value || "user").toLowerCase();
  return v === "assistant" || v === "ai" || v === "coach" ? "assistant" : "user";
}

function extractJSON(text) {
  return extractJson(text);
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getIp(req) {
  const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xfwd || req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(bucket, key, limit = 12, windowMs = 60000) {
  const now = Date.now();
  const bucketKey = `${bucket}:${key}`;
  const prev = rateLimitBuckets.get(bucketKey) || [];
  const recent = prev.filter((ts) => now - ts < windowMs);
  if (recent.length >= limit) {
    rateLimitBuckets.set(bucketKey, recent);
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    return { ok: false, retryAfterSec };
  }
  recent.push(now);
  rateLimitBuckets.set(bucketKey, recent);
  return { ok: true, remaining: Math.max(0, limit - recent.length) };
}

function detectIntent(message, responseMode) {
  if (responseMode === "recipe_json") return "recipe_request";
  if (responseMode === "shopping_list") return "shopping_list";
  if (responseMode === "meal_plan") return "meal_plan";
  const text = String(message || "").toLowerCase();
  const has = (...keywords) => keywords.some((k) => text.includes(k));

  if (responseMode === "advice") return "advice";
  if (responseMode === "recovery") return "recovery_question";
  if (responseMode === "motivation") return "motivation_question";
  if (!text) return "general_chat";
  if (has("salut", "bonjour", "hello", "yo", "ça va", "ca va", "hey", "coucou", "cc")) return "greeting";

  // Recovery — before workout to catch "j'ai mal dormi"
  if (has("mal dormi", "pas bien dormi", "courbature", "blessure", "fatigue", "epuis",
      "recup", "repos", "mobilite", "stretch", "etirement", "j'ai mal au")) return "recovery_question";

  // Shopping list — catches social contexts like "j'ai 4 potes on fait des burgers"
  if (has("liste de course", "liste d'achat", "faire les courses", "courses pour",
      "ce qu'il faut acheter", "supermarche", "marche", "acheter pour",
      "potes", "amis", "soiree", "barbecue", "bbq")) return "shopping_list";

  // Meal plan / meal ideas
  if (has("quoi manger ce soir", "quoi manger demain", "idee repas", "repas rapide",
      "quoi manger", "que manger ce soir", "manger ce soir", "manger demain",
      "programme semaine", "menu semaine", "planning repas",
      "journee alimentaire", "repas de la journee", "semaine alimentaire")) return "meal_plan";

  // Shopping list (original keywords)
  if (has("ingredients pour", "ce qu'il faut", "liste d'achat")) return "shopping_list";

  // Meal plan (original keywords backup)
  if (has("planifier mes repas", "organisation repas", "manger toute la journee")) return "meal_plan";

  // legacy // Shopping list: detect before recipe to catch "liste d'ingrédients"
  if (has("liste de course", "liste d'achat", "faire les courses", "courses pour", "ingrédients pour", "ce qu'il faut acheter", "supermarché", "marché")) return "shopping_list";

  // Meal plan: full day or week planning
  if (has("journée alimentaire", "planning repas", "planning alimentaire", "repas de la journée", "menu journée", "semaine alimentaire", "planifier mes repas", "manger toute la journée", "organisation repas")) return "meal_plan";

  // Recipe detection
  if (has("recette", "cuisine", "prépare-moi", "prepare moi", "fais-moi un plat", "comment cuisiner", "comment préparer")) return "recipe_request";

  // Workout detection — broad
  if (has("programme", "entraînement", "entrainement", "séance", "seance", "workout", "hiit", "full body", "upper body", "lower body", "exercice", "routine", "split", "abs", "cardio", "musculation", "muscul")) return "workout_request";

  // Nutrition
  if (has("proté", "prot", "calorie", "macro", "nutrition", "aliment", "repas", "glucide", "lipide", "complément", "complement", "combien manger", "que manger", "quoi manger", "après l'entraînement", "post-workout", "pre-workout")) return "nutrition_question";

  // Recovery
  if (has("sommeil", "repos", "récup", "recup", "courbature", "fatigue", "douleur", "blessure", "mobilité", "mobilite", "stretch", "étirement")) return "recovery_question";

  // Motivation
  if (has("motivation", "discipline", "plateau", "stagne", "stagnation", "habitude", "mental", "mindset")) return "motivation_question";

  // Progress
  if (has("progression", "progresse", "stats", "niveau", "streak", "gain", "résultat", "resultat")) return "progress_question";

  // Advice / lifestyle catch-all
  if (has("conseil", "tips", "astuce", "que faire", "comment", "aide moi", "lifestyle")) return "advice";

  return "general_chat";
}

function getGoalDescription(goal) {
  const goals = {
    prise_de_masse: "prioriser hypertrophie, surcharge progressive et récupération solide",
    perte_de_poids: "prioriser déficit raisonnable, volume utile et activité régulière",
    endurance: "prioriser densité, cardio et tolérance à l'effort",
    force: "prioriser exercices de base, qualité technique et repos plus long",
    remise_en_forme: "prioriser adhérence, technique et progression simple",
    maintien: "prioriser variété et maintien du niveau"
  };
  return goals[String(goal || "").toLowerCase()] || goals.remise_en_forme;
}

function getLevelDescription(level) {
  const levels = {
    beginner: "débutant, besoin d'explications claires et volume modéré",
    debutant: "débutant, besoin d'explications claires et volume modéré",
    intermediate: "intermédiaire, bonne base technique, progression possible",
    intermediaire: "intermédiaire, bonne base technique, progression possible",
    advanced: "avancé, besoin d'une progression plus fine et d'une fatigue mieux gérée",
    avance: "avancé, besoin d'une progression plus fine et d'une fatigue mieux gérée"
  };
  return levels[String(level || "").toLowerCase()] || levels.beginner;
}

function makeProfileSummary(profile = {}, goalContext = {}) {
  const goal = normalizeText(profile.goal || goalContext.type || "remise_en_forme");
  const level = normalizeText(profile.level || goalContext.level || "beginner");
  const constraints = normalizeText(profile.injuries || goalContext.constraints || "aucune");
  const equipment = normalizeText(profile.equipment || "poids du corps");
  const sleep = Number(profile.sleep_hours || 0);
  const recovery = Number(profile.recovery_score || 0);
  const weight = Number(profile.weight || 0);
  const height = Number(profile.height || 0);
  const age = Number(profile.age || 0);

  return {
    goal,
    level,
    constraints,
    equipment,
    sleep: sleep > 0 ? sleep : null,
    recovery: recovery > 0 ? recovery : null,
    weight: weight > 0 ? weight : null,
    height: height > 0 ? height : null,
    age: age > 0 ? age : null,
    display_name: normalizeText(profile.display_name || "")
  };
}

function historyBlock(history = []) {
  const items = Array.isArray(history) ? history.slice(-6) : [];
  if (!items.length) return "";
  return items.map((item) => {
    const role = normalizeRole(item.role) === "assistant" ? "Coach" : "Utilisateur";
    return `${role}: ${sanitizeInput(String(item.content || ""), 280)}`;
  }).join("\n");
}

function buildWorkoutPrompt(message, history, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  return `Tu es un préparateur physique expert. Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil:
- Objectif: ${p.goal} (${getGoalDescription(p.goal)})
- Niveau: ${p.level} (${getLevelDescription(p.level)})
- Équipement: ${p.equipment}
- Blessures / contraintes: ${p.constraints}
- Poids: ${p.weight || "non renseigné"}
- Taille: ${p.height || "non renseignée"}
- Sommeil moyen: ${p.sleep || "non renseigné"} h
- Récupération ressentie /10: ${p.recovery || "non renseignée"}

Historique récent:
${historyBlock(history) || "Aucun historique utile."}

Demande de l'utilisateur:
${message}

RÈGLES ABSOLUES:
- Respecte les blessures et contraintes.
- Adapte l'intensité si sommeil < 6h ou récupération <= 5/10.
- Niveau débutant = exercices simples et explications claires.
- Commence toujours par l'échauffement, termine par le retour au calme.
- Réponds en français.

FORMAT JSON OBLIGATOIRE (aucun texte avant ni après, aucun markdown):
{
  "title": "Nom de la séance",
  "duration": 45,
  "calories": 350,
  "exercises": [
    {
      "name": "Nom de l'exercice",
      "sets": 3,
      "reps": "10-12",
      "duration": 0,
      "rest": 60,
      "description": "Conseil technique court et actionnable.",
      "muscle": "Groupe musculaire cible",
      "difficulty": "facile|moyen|difficile",
      "equipment": "Aucun"
    }
  ]
}

STRUCTURE exercises[] requise:
1. Échauffement — 2 à 3 exercices légers (sets:1, reps:"1×" ou "30s", rest:0, difficulty:"facile").
2. Corps principal — 4 à 7 exercices progressifs adaptés au profil.
3. Retour au calme — 2 à 3 étirements (sets:1, reps:"30-45s", rest:0, difficulty:"facile").
- "duration" = durée en secondes si exercice chronométré, sinon 0.
- "rest" = repos en secondes entre les séries (0 pour échauffement/cooldown).
- "description" = instruction pratique courte, jamais vide.`;
}

function buildConversationPrompt(intent, message, history, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  const intentGuide = {
    greeting: "réponds avec chaleur et naturel, propose 2-3 options d'aide concrète (séance, nutrition, recette, liste de courses, organisation)",
    nutrition_question: "réponds comme un coach nutrition simple et actionnable — macros, timing, aliments conseillés. Sois précis et concret.",
    recovery_question: "réponds comme un coach récupération expert — sommeil, stress, mobilité, courbatures. Donne des conseils actionnables aujourd'hui.",
    motivation_question: "réponds comme un coach mental bienveillant et direct. Parle vrai, sois humain, propose une action immédiate.",
    progress_question: "analyse la situation, interprète les signaux, propose la prochaine étape concrète.",
    general_fitness: "tu es un assistant personnel polyvalent — fitness, nutrition, lifestyle, organisation, recettes, courses. Sois utile, concret, humain. Réponds à la vraie question posée.",
    shopping_list: "aide l'utilisateur à préparer sa liste de courses adaptée à ses objectifs nutritionnels",
    meal_plan: "aide l'utilisateur à structurer ses repas pour la journée ou la semaine selon ses objectifs"
  }[intent] || "réponds comme un assistant personnel fitness et lifestyle, concret et humain";

  const lengthGuide = ["shopping_list", "meal_plan"].includes(intent)
    ? "5 à 12 lignes organisées"
    : intent === "greeting"
    ? "3 à 5 phrases max"
    : "2 à 7 phrases";

  return `Tu es un assistant coach fitness et lifestyle, expert, concret et bienveillant. Réponds en français.

Profil utilisateur:
- Objectif: ${p.goal}
- Niveau: ${p.level}
- Équipement: ${p.equipment}
- Contraintes / blessures: ${p.constraints}
- Sommeil moyen: ${p.sleep || "non renseigné"} h
- Récupération: ${p.recovery || "non renseignée"}/10
${p.display_name ? `- Prénom: ${p.display_name}` : ""}

Historique récent:
${historyBlock(history) || "Aucun."}

Instruction spécifique:
- ${intentGuide}
- Longueur idéale: ${lengthGuide}.
- Si pertinent, termine par une action simple à faire aujourd'hui.
- N'écris PAS de JSON brut.
- N'écris PAS de programme complet d'exercices sauf si explicitement demandé.
- Tu peux utiliser des listes à puces si ça aide la lisibilité.
- Sois humain : tu peux avoir de l'humour bienveillant si le contexte s'y prête.

Message utilisateur:
${message}`;
}
Message utilisateur:
${message}`;
}

function buildShoppingListPrompt(message, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  return `Tu es un coach nutrition. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil:
- Objectif: ${p.goal}
- Contraintes: ${p.constraints}

Demande:
${message}

FORMAT JSON OBLIGATOIRE (aucun texte avant ni après):
{
  "title": "Liste de courses",
  "context": "Brève description du contexte (1-2 phrases)",
  "categories": [
    {
      "name": "Protéines",
      "items": [
        { "name": "Poulet", "qty": "800g", "note": "optionnel" }
      ]
    }
  ],
  "tips": "Conseil nutrition court"
}

Catégories suggérées selon le contexte: Protéines, Légumes, Féculents/Céréales, Fruits, Produits laitiers/Oeufs, Condiments/Épices, Boissons, Divers.
Adapte les catégories et quantités au contexte exact de la demande (occasion sociale, préparation repas de masse, etc.).`;
}

function buildMealPlanPrompt(message, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  return `Tu es un coach nutrition. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil:
- Objectif: ${p.goal}
- Niveau: ${p.level}
- Contraintes: ${p.constraints}
- Poids: ${p.weight || "non renseigné"}

Demande:
${message}

FORMAT JSON OBLIGATOIRE (aucun texte avant ni après):
{
  "title": "Journée alimentaire",
  "total_calories": 2200,
  "total_protein": 150,
  "meals": [
    {
      "name": "Petit-déjeuner",
      "time": "7h30",
      "calories": 500,
      "protein": 30,
      "items": ["Flocons d'avoine 80g", "Banane", "Fromage blanc 200g"]
    }
  ],
  "notes": "Conseil court sur l'hydratation ou la répartition"
}`;
}

function fallbackShoppingList(message) {
  return {
    title: "Liste de courses équilibrée",
    context: "Liste générée en mode secours, adaptez selon vos besoins.",
    categories: [
      { name: "Protéines", items: [{ name: "Poulet", qty: "1 kg" }, { name: "Œufs", qty: "12" }, { name: "Thon en boîte", qty: "3 boîtes" }] },
      { name: "Légumes", items: [{ name: "Brocoli", qty: "500 g" }, { name: "Épinards", qty: "300 g" }, { name: "Tomates", qty: "6" }] },
      { name: "Féculents", items: [{ name: "Riz complet", qty: "1 kg" }, { name: "Patate douce", qty: "4" }] },
      { name: "Fruits", items: [{ name: "Bananes", qty: "8" }, { name: "Pommes", qty: "6" }] }
    ],
    tips: "Préparez vos repas à l'avance pour tenir votre nutrition toute la semaine."
  };
}

function fallbackMealPlan(profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  const kcal = p.goal === "prise_de_masse" ? 2800 : p.goal === "perte_de_poids" ? 1800 : 2200;
  const prot = Math.round(kcal * 0.3 / 4);
  return {
    title: "Journée alimentaire équilibrée",
    total_calories: kcal,
    total_protein: prot,
    meals: [
      { name: "Petit-déjeuner", time: "7h30", calories: Math.round(kcal * 0.22), protein: Math.round(prot * 0.2), items: ["Flocons d'avoine 80g", "Lait ou boisson végétale 200ml", "1 banane", "Fromage blanc 100g"] },
      { name: "Déjeuner", time: "12h30", calories: Math.round(kcal * 0.35), protein: Math.round(prot * 0.35), items: ["Poulet grillé 150g", "Riz complet 100g cru", "Brocoli vapeur 200g", "Huile d'olive 1 cuillère"] },
      { name: "Collation", time: "16h00", calories: Math.round(kcal * 0.13), protein: Math.round(prot * 0.15), items: ["Fromage blanc 150g", "Noix 20g", "1 pomme"] },
      { name: "Dîner", time: "19h30", calories: Math.round(kcal * 0.3), protein: Math.round(prot * 0.3), items: ["Saumon 150g ou thon", "Patate douce 200g", "Épinards sautés", "Citron et herbes"] }
    ],
    notes: "Buvez 2 à 2.5L d'eau par jour. Adaptez les portions selon votre faim réelle."
  };
}

async function generateShoppingList({ apiKey, message, profile, goalContext }) {
  const prompt = buildShoppingListPrompt(message, profile, goalContext);
  try {
    const result = await callGemini(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 900, timeoutMs: 8000, retries: 0 });
    const parsed = extractJSON(result.text);
    if (!parsed || !Array.isArray(parsed.categories)) throw new Error("INVALID_SHOPPING_JSON");
    return { ok: true, data: parsed, fallback: false };
  } catch (error) {
    return { ok: true, data: fallbackShoppingList(message), fallback: true, error: String(error?.message || "generation_failed") };
  }
}

async function generateMealPlan({ apiKey, message, profile, goalContext }) {
  const prompt = buildMealPlanPrompt(message, profile, goalContext);
  try {
    const result = await callGemini(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 900, timeoutMs: 8000, retries: 0 });
    const parsed = extractJSON(result.text);
    if (!parsed || !Array.isArray(parsed.meals)) throw new Error("INVALID_MEAL_PLAN_JSON");
    return { ok: true, data: parsed, fallback: false };
  } catch (error) {
    return { ok: true, data: fallbackMealPlan(profile, goalContext), fallback: true, error: String(error?.message || "generation_failed") };
  }
}

function buildRecipePrompt(message, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  return `Tu es un chef cuisinier et nutritionniste sportif. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil utilisateur:
- Objectif fitness: ${p.goal}
- Contraintes alimentaires: ${p.constraints}

Demande de l'utilisateur:
${message}

RÈGLES ABSOLUES:
1. Identifie tous les ingrédients mentionnés dans la demande et utilise-les TOUS dans les étapes
2. Nomme chaque ingrédient spécifiquement dans chaque étape (ex: "Coupez le poulet en dés", pas "Préparez les protéines")
3. Si les ingrédients semblent incohérents ou inhabituels ensemble, mentionne-le dans "tips" et propose quand même une recette originale qui les utilise
4. Les étapes doivent être des instructions de cuisine précises avec températures, temps et techniques (ex: "Faites revenir l'oignon 3 min à feu moyen jusqu'à transparence")
5. Minimum 5 étapes détaillées, maximum 8 étapes
6. Les macros doivent correspondre réellement aux ingrédients mentionnés

Format JSON exact (respecte exactement cette structure):
{
  "name": "Nom créatif du plat basé sur les vrais ingrédients",
  "prep_time": "X min",
  "steps": [
    "Étape 1 avec action précise + ingrédient nommé + temps/technique",
    "Étape 2 avec action précise + ingrédient nommé + temps/technique",
    "Étape 3...",
    "Étape 4...",
    "Étape 5..."
  ],
  "calories": 500,
  "protein": 35,
  "carbs": 45,
  "fat": 15,
  "tips": "Conseil spécifique aux ingrédients utilisés (ou note si combo inhabituel)"
}`;
}

function guessDurationFromMessage(message, fallback = 45) {
  const match = String(message || "").match(/(\d{2,3})\s*(min|minute)/i);
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(20, Math.min(90, value));
}

function pickExercisePool(goal, level, equipment, intensityBias) {
  const bodyweightUpper = [
    "Pompes inclinées", "Pompes tempo", "Dips entre bancs", "Pike push-ups", "Rowing inversé sous table"
  ];
  const bodyweightLower = [
    "Squats tempo", "Fentes marchées", "Split squats", "Hip thrust au sol", "Pont fessier une jambe"
  ];
  const gymUpper = [
    "Développé couché haltères", "Rowing haltère", "Développé militaire assis", "Tirage vertical", "Pompes lestées"
  ];
  const gymLower = [
    "Goblet squat", "Soulevé de terre roumain haltères", "Presse à cuisses", "Leg curl", "Hip thrust"
  ];
  const cardio = intensityBias === "low"
    ? ["Marche inclinée", "Vélo doux", "Rameur modéré"]
    : ["Bike intervals", "Circuit cardio", "Rameur fractionné"];
  const useGym = /halt[eè]re|barre|salle|machine|kettlebell|banc/i.test(equipment || "");
  return { upper: useGym ? gymUpper : bodyweightUpper, lower: useGym ? gymLower : bodyweightLower, cardio };
}

function seededIndex(seed, length, offset) {
  if (!length) return 0;
  let sum = 0;
  const source = `${seed}:${offset}`;
  for (let i = 0; i < source.length; i += 1) sum += source.charCodeAt(i) * (i + 1);
  return sum % length;
}

function fallbackWorkout(message, profile = {}, goalContext = {}) {
  const p = makeProfileSummary(profile, goalContext);
  const duration = guessDurationFromMessage(message, 45);
  const lowered = String(message || "").toLowerCase();
  const focus = lowered.includes("hiit") ? "Conditioning" : lowered.includes("jamb") ? "Lower Body" : lowered.includes("haut") ? "Upper Body" : "Full Body";
  const intensityBias = (p.sleep && p.sleep < 6) || (p.recovery && p.recovery <= 5) ? "low" : "medium";
  const pools = pickExercisePool(p.goal, p.level, p.equipment, intensityBias);
  const seed = `${message}|${p.goal}|${p.level}|${new Date().toISOString().slice(0, 10)}`;

  const upper1 = pools.upper[seededIndex(seed, pools.upper.length, 1)];
  const upper2 = pools.upper[seededIndex(seed, pools.upper.length, 2)];
  const lower1 = pools.lower[seededIndex(seed, pools.lower.length, 3)];
  const lower2 = pools.lower[seededIndex(seed, pools.lower.length, 4)];
  const cardio = pools.cardio[seededIndex(seed, pools.cardio.length, 5)];

  const sessions = focus === "Upper Body"
    ? [{
        day: "Monday",
        focus,
        duration_min: duration,
        intensity: intensityBias,
        warmup: ["3 min cardio léger", "Mobilité épaules", "Activation scapulaire"],
        exercises: [
          { name: upper1, sets: 4, reps: "8-10", rest_sec: 75, notes: "Garde 1-2 reps en réserve" },
          { name: upper2, sets: 3, reps: "10-12", rest_sec: 60, notes: "Amplitude contrôlée" },
          { name: "Gainage latéral", sets: 3, reps: "30s/side", rest_sec: 30, notes: "Tronc solide" }
        ],
        cooldown: ["Étirement pectoraux 45s", "Respiration nasale 2 min"]
      }]
    : [{
        day: "Monday",
        focus,
        duration_min: duration,
        intensity: intensityBias,
        warmup: ["5 min cardio léger", "Mobilité hanches + épaules", "1 série technique sur chaque pattern"],
        exercises: [
          { name: lower1, sets: 4, reps: "8-10", rest_sec: 75, notes: "Descente contrôlée" },
          { name: upper1, sets: 4, reps: "8-10", rest_sec: 75, notes: "Technique propre avant charge" },
          { name: lower2, sets: 3, reps: "10-12", rest_sec: 60, notes: "Amplitude complète" },
          { name: upper2, sets: 3, reps: "10-12", rest_sec: 60, notes: "Rythme régulier" },
          { name: cardio, sets: 1, reps: "8 min", rest_sec: 0, notes: intensityBias === "low" ? "Rythme confortable" : "Alterne 30s vite / 60s facile" }
        ],
        cooldown: ["Étirement hanches 45s", "Étirement dorsaux 45s", "Respiration 2 min"]
      }];

  return {
    title: `Plan ${focus} intelligent`,
    goal: p.goal,
    duration_weeks: 8,
    progression: {
      weeks_1_3: "Ajoute 1 rep par série ou 2 à 5 % de charge si tout est propre.",
      week_4_deload: "Réduis le volume d'environ 35 % et garde une intensité modérée.",
      weeks_5_8: "Repars sur le volume normal et progresse à nouveau sur la charge ou les reps."
    },
    recovery_advice: intensityBias === "low" ? "Récupération basse: garde une séance contrôlée et dors plus ce soir." : "Hydratation, 7 à 8h de sommeil et marche légère le lendemain.",
    nutrition_advice: p.goal === "prise_de_masse" ? "Ajoute un repas protéiné post-séance avec glucides digestes." : p.goal === "perte_de_poids" ? "Vise protéines hautes et garde le déficit léger pour tenir la progression." : "Mets 25 à 35 g de protéines après la séance et hydrate-toi.",
    sessions
  };
}

function fallbackConversation(intent, message, profile = {}, goalContext = {}) {
  const p = makeProfileSummary(profile, goalContext);
  const lowRecovery = (p.sleep && p.sleep < 6) || (p.recovery && p.recovery <= 5);
  if (intent === "greeting") {
    return `Salut ${p.display_name || "champion"} 👋 Dis-moi si tu veux une séance, un conseil nutrition ou un plan récup, et je te guide sans te noyer dans le blabla.`;
  }
  if (intent === "nutrition_question") {
    return p.goal === "prise_de_masse"
      ? "Pour progresser, vise surtout une portion de protéines à chaque repas et ajoute des glucides autour de l'entraînement. Le plus simple aujourd'hui: 1 source de protéines + 1 féculent + 1 fruit après ta séance."
      : "Le plus rentable est de sécuriser tes protéines, puis de garder des repas simples et réguliers. Aujourd'hui, vise un repas avec légumes + protéines + une portion de féculents adaptée à ta faim et à ton objectif.";
  }
  if (intent === "recovery_question") {
    return lowRecovery
      ? "Vu ton état, je baisserais l'intensité aujourd'hui: mobilité, marche ou séance technique courte. Si tu dors mal plusieurs jours d'affilée, n'essaie pas de compenser avec plus d'intensité, récupère d'abord."
      : "Ta récup passera surtout par le sommeil, l'hydratation et une charge bien dosée. Fais 5 à 10 minutes de mobilité ce soir et garde une séance plus lourde seulement si les courbatures baissent nettement demain.";
  }
  if (intent === "motivation_question") {
    return "Ne cherche pas la motivation parfaite: réduis le seuil d'entrée. Décide simplement de commencer 10 minutes aujourd'hui, puis laisse l'élan faire le reste; la régularité vaut plus qu'une séance héroïque isolée.";
  }
  if (intent === "progress_question") {
    return "Regarde d'abord trois marqueurs: régularité, qualité technique et charge/reps sur tes mouvements clés. Si un seul progresse chaque semaine, tu avances déjà dans la bonne direction; le plus utile aujourd'hui est de noter ton prochain mini-objectif concret.";
  }
  return `Pour ton objectif ${p.goal.replaceAll("_", " ")}, garde un plan simple: 3 à 4 séances utiles, assez de protéines et une progression mesurable. Donne-moi ton contexte exact et je te répondrai de façon beaucoup plus précise.`;
}

function fallbackRecipe(message, profile = {}, goalContext = {}) {
  const p = makeProfileSummary(profile, goalContext);
  const name = p.goal === "prise_de_masse" ? "Bol protéiné énergie" : p.goal === "perte_de_poids" ? "Assiette lean express" : "Repas fitness équilibré";
  return {
    name,
    prep_time: "15 min",
    steps: [
      "Prépare une source de protéines maigres et fais-la cuire rapidement.",
      "Ajoute une base glucidique simple si l'objectif n'est pas une coupe agressive.",
      "Complète avec légumes et une petite source de bons lipides.",
      "Assaisonne simplement et ajuste la portion selon la faim et la séance du jour."
    ],
    calories: p.goal === "prise_de_masse" ? 700 : p.goal === "perte_de_poids" ? 450 : 550,
    protein: p.goal === "prise_de_masse" ? 45 : 40,
    carbs: p.goal === "perte_de_poids" ? 30 : 55,
    fat: p.goal === "prise_de_masse" ? 22 : 16,
    tips: "Ajoute 25 à 35 g de protéines par repas pour sécuriser la récupération."
  };
}

// ─── Exercise helpers (new structured format) ────────────────────────────────

function normalizeExercise(ex) {
  return {
    name:        normalizeText(ex.name || "Exercice", "Exercice"),
    sets:        Math.max(1, Math.round(Number(ex.sets) || 3)),
    reps:        normalizeText(ex.reps || "10-12", "10-12"),
    duration:    Math.max(0, Math.round(Number(ex.duration) || 0)),
    rest:        Math.max(0, Math.round(Number(ex.rest != null ? ex.rest : ex.rest_sec) || 0)),
    description: normalizeText(ex.description || ex.notes || ""),
    muscle:      normalizeText(ex.muscle || ""),
    difficulty:  normalizeText(ex.difficulty || "moyen"),
    equipment:   normalizeText(ex.equipment || "Aucun")
  };
}

function exerciseToText(ex) {
  const suffix = ex.duration > 0
    ? `${ex.sets}×${ex.duration}s${ex.rest ? ` (repos ${ex.rest}s)` : ""}`
    : `${ex.sets}×${ex.reps}${ex.rest ? ` (repos ${ex.rest}s)` : ""}`;
  return `${ex.name} — ${suffix}${ex.description ? `. ${ex.description}` : ""}`;
}

function exercisesToBlocks(exercises, totalDurationMin) {
  const n = exercises.length;
  // Split into warmup / main / cooldown based on array position
  let warmupCount = 0;
  let cooldownCount = 0;
  if (n >= 7) { warmupCount = 2; cooldownCount = 2; }
  else if (n >= 5) { warmupCount = 2; cooldownCount = 1; }
  else if (n >= 3) { warmupCount = 1; cooldownCount = 1; }

  const warmupExs   = exercises.slice(0, warmupCount);
  const cooldownExs = n > cooldownCount ? exercises.slice(n - cooldownCount) : [];
  const mainExs     = exercises.slice(warmupCount, n - cooldownCount || n);

  const warmupSec   = warmupCount * 90;
  const cooldownSec = cooldownCount * 90;
  const mainSec     = Math.max(600, (Number(totalDurationMin || 45) * 60) - warmupSec - cooldownSec);

  const blocks = [];
  if (warmupExs.length) {
    blocks.push({ title: "Échauffement", duration_sec: warmupSec, items: warmupExs.map(exerciseToText), rpe: "3-4" });
  }
  if (mainExs.length) {
    blocks.push({ title: "Séance principale", duration_sec: mainSec, items: mainExs.map(exerciseToText), rpe: "7-8" });
  }
  if (cooldownExs.length) {
    blocks.push({ title: "Récupération", duration_sec: cooldownSec, items: cooldownExs.map(exerciseToText), rpe: "2-3" });
  }
  if (!blocks.length) {
    blocks.push({ title: "Séance complète", duration_sec: Number(totalDurationMin || 45) * 60, items: exercises.map(exerciseToText), rpe: "7-8" });
  }
  return blocks;
}

// ─── Normalisation principale ─────────────────────────────────────────────────

function normalizeWorkoutOutput(raw, profile = {}, goalContext = {}) {
  const fallback = fallbackWorkout("séance full body", profile, goalContext);
  const source = raw && typeof raw === "object" ? raw : fallback;
  const p = makeProfileSummary(profile, goalContext);

  // ── FORMAT 1 : exercises[] direct (nouveau format demandé) ──────────────────
  if (Array.isArray(source.exercises) && source.exercises.length > 0) {
    const exercises = source.exercises.map(normalizeExercise);
    const duration  = Math.max(10, Math.round(Number(source.duration) || 45));
    const blocks    = exercisesToBlocks(exercises, duration);
    const muscles   = [...new Set(exercises.map((e) => e.muscle).filter(Boolean))];
    const equip     = [...new Set(exercises.map((e) => e.equipment).filter((e) => e && e !== "Aucun"))];
    return {
      title:            String(source.title || "Séance personnalisée"),
      type:             /cardio|hiit/i.test(source.title || "") ? "hiit" : "strength",
      level:            p.level || "beginner",
      intensity:        "medium",
      duration,
      calories_estimate: source.calories ? Math.round(Number(source.calories)) : null,
      target_muscles:   muscles,
      equipment_needed: equip,
      notes:            String(source.notes || ""),
      created_at:       new Date().toISOString(),
      blocks,
      exercises
    };
  }

  // ── FORMAT 2 : blocks[] existants (compat arrière) ──────────────────────────
  if (Array.isArray(source.blocks)) {
    return {
      title:            String(source.title || "Séance personnalisée"),
      type:             String(source.type || "strength"),
      level:            String(source.level || p.level || "beginner"),
      intensity:        ["low", "medium", "high"].includes(source.intensity) ? source.intensity : "medium",
      duration:         typeof source.duration === "number" ? source.duration : 45,
      calories_estimate: source.calories_estimate || null,
      target_muscles:   Array.isArray(source.target_muscles) ? source.target_muscles : [],
      equipment_needed: Array.isArray(source.equipment_needed) ? source.equipment_needed : [],
      notes:            String(source.notes || ""),
      created_at:       new Date().toISOString(),
      blocks:           source.blocks,
      exercises:        [],
      structured_plan:  source.structured_plan || null
    };
  }

  // ── FORMAT 3 : sessions[] legacy ────────────────────────────────────────────
  const session      = Array.isArray(source.sessions) && source.sessions.length ? source.sessions[0] : fallback.sessions[0];
  const warmupItems  = Array.isArray(session.warmup)   ? session.warmup   : ["5 min cardio léger", "Mobilité dynamique"];
  const cooldownItems = Array.isArray(session.cooldown) ? session.cooldown : ["Respiration 2 min", "Étirements légers"];
  const exerciseItems = Array.isArray(session.exercises) ? session.exercises.map((ex) => {
    const name = normalizeText(ex.name || "Exercice", "Exercice");
    const sets = Number(ex.sets || 3);
    const reps = normalizeText(ex.reps || "10-12", "10-12");
    const rest = Number(ex.rest_sec || 60);
    const note = normalizeText(ex.notes || "");
    return `${name} — ${sets}×${reps}${rest ? ` (repos ${rest}s)` : ""}${note ? `. ${note}` : ""}`;
  }) : [];
  const blocks = [
    { title: "Échauffement",              duration_sec: 8 * 60,  items: warmupItems.map((x) => normalizeText(x, x)),   rpe: "3-4" },
    { title: session.focus || "Séance principale", duration_sec: Math.max(20, Number(session.duration_min || 45) - 13) * 60, items: exerciseItems, rpe: session.intensity === "high" ? "8-9" : session.intensity === "low" ? "5-6" : "7-8" },
    { title: "Récupération",              duration_sec: 5 * 60,  items: cooldownItems.map((x) => normalizeText(x, x)), rpe: "2-3" }
  ];
  const notes = [
    source.progression?.weeks_1_3,
    source.progression?.week_4_deload ? `Deload: ${source.progression.week_4_deload}` : "",
    source.recovery_advice,
    source.nutrition_advice
  ].filter(Boolean).join(" · ");

  // Extract exercises[] from legacy sessions[] for structured output
  const legacyExercises = Array.isArray(session.exercises) ? session.exercises.map((ex) => normalizeExercise({
    name: ex.name, sets: ex.sets, reps: ex.reps, duration: 0,
    rest: ex.rest_sec, description: ex.notes, muscle: "", difficulty: "moyen", equipment: "Aucun"
  })) : [];

  return {
    title:            String(source.title || "Programme intelligent"),
    type:             String(/cardio|hiit/i.test(session.focus || "") ? "hiit" : "strength"),
    level:            p.level || "beginner",
    intensity:        ["low", "medium", "high"].includes(session.intensity) ? session.intensity : "medium",
    duration:         Number(session.duration_min || 45),
    calories_estimate: null,
    target_muscles:   [String(session.focus || "Full Body")],
    equipment_needed: [],
    notes,
    created_at:       new Date().toISOString(),
    blocks,
    exercises:        legacyExercises,
    structured_plan:  source
  };
}

async function callGemini(apiKey, prompt, options = {}) {
  return callGeminiText({
    apiKey,
    prompt,
    temperature: options.temperature ?? 0.55,
    maxOutputTokens: options.maxOutputTokens ?? 1600,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    retries: options.retries ?? MAX_RETRIES
  });
}

async function generateWithRetry(apiKey, prompt, options = {}) {
  return callGemini(apiKey, prompt, options);
}

async function generateWorkoutPlan({ apiKey, message, history, profile, goalContext }) {
  const prompt = buildWorkoutPrompt(message, history, profile, goalContext);
  try {
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 1200, timeoutMs: 10000, retries: 0 });
    const parsed = extractJSON(result.text);
    // Accept new exercises[] format OR legacy sessions[] format
    const hasExercises = parsed && Array.isArray(parsed.exercises) && parsed.exercises.length > 0;
    const hasSessions  = parsed && Array.isArray(parsed.sessions)  && parsed.sessions.length  > 0;
    if (!parsed || (!hasExercises && !hasSessions)) {
      throw new Error("INVALID_WORKOUT_JSON");
    }
    return { ok: true, data: normalizeWorkoutOutput(parsed, profile, goalContext), raw: parsed, model: result.model, fallback: false };
  } catch (error) {
    const fb = fallbackWorkout(message, profile, goalContext);
    return { ok: true, data: normalizeWorkoutOutput(fb, profile, goalContext), raw: fb, fallback: true, error: String(error?.message || "generation_failed"), degraded_reason: "fallback_fast" };
  }
}

async function generateConversationReply({ apiKey, intent, message, history, profile, goalContext }) {
  const prompt = buildConversationPrompt(intent, message, history, profile, goalContext);
  try {
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.6, maxOutputTokens: 650, timeoutMs: 8000, retries: 0 });
    const text = String(result.text || "").replace(/^```[\w-]*\s*/g, "").replace(/```$/g, "").trim();
    if (!text) throw new Error("EMPTY_CONVERSATION");
    return { ok: true, message: text, model: result.model, fallback: false };
  } catch (error) {
    return { ok: true, message: fallbackConversation(intent, message, profile, goalContext), fallback: true, error: String(error?.message || "generation_failed"), degraded_reason: "fallback_fast" };
  }
}

async function generateRecipeJson({ apiKey, message, profile, goalContext }) {
  const prompt = buildRecipePrompt(message, profile, goalContext);
  try {
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.4, maxOutputTokens: 1000, timeoutMs: 8000, retries: 0 });
    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.name) throw new Error("INVALID_RECIPE_JSON");
    return { ok: true, data: parsed, model: result.model, fallback: false };
  } catch (error) {
    return { ok: true, data: fallbackRecipe(message, profile, goalContext), fallback: true, error: String(error?.message || "generation_failed"), degraded_reason: "fallback_fast" };
  }
}

module.exports = {
  MODEL,
  TIMEOUT_MS,
  sendJson,
  setCors,
  parseBody,
  sanitizeInput,
  normalizeText,
  normalizeRole,
  extractJSON,
  tryParseJson,
  getIp,
  checkRateLimit,
  detectIntent,
  makeProfileSummary,
  historyBlock,
  normalizeWorkoutOutput,
  generateWorkoutPlan,
  generateConversationReply,
  generateRecipeJson,
  generateShoppingList,
  generateMealPlan,
  fallbackWorkout,
  fallbackConversation,
  fallbackRecipe,
  fallbackShoppingList,
  fallbackMealPlan
};
