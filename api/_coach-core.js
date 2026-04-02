"use strict";

const {
  DEFAULT_MODEL: MODEL,
  DEFAULT_TIMEOUT_MS: TIMEOUT_MS,
  extractJson,
  callGeminiText
} = require("./_gemini");

const MAX_RETRIES = 1;
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
  if (responseMode === "workout_json") return "workout_request";
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

  // Recipe detection — explicit keywords + common food names
  if (has("recette", "cuisine", "prépare-moi", "prepare moi", "fais-moi un plat", "comment cuisiner", "comment préparer",
      "fais-moi", "fais moi", "je veux faire", "je veux cuisiner", "je veux manger")) return "recipe_request";
  if (has("pizza", "pâtes", "pasta", "risotto", "burger", "wrap", "bowl", "salade composée",
      "omelette", "quiche", "pancake", "crêpe", "crepe", "smoothie", "porridge", "tartine",
      "galette", "wok", "curry", "poulet", "saumon", "steak", "riz sauté", "soupe",
      "boulette", "gratin", "lasagne", "tarte", "cake salé")) return "recipe_request";

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
  const mood = normalizeText(profile.mood_today || "");

  return {
    goal,
    level,
    constraints,
    equipment,
    mood: mood || null,
    sleep: sleep > 0 ? sleep : null,
    recovery: recovery > 0 ? recovery : null,
    weight: weight > 0 ? weight : null,
    height: height > 0 ? height : null,
    age: age > 0 ? age : null,
    display_name: normalizeText(profile.display_name || ""),
    current_streak: Number(profile.current_streak || 0) || null,
    total_workouts: Number(profile.total_workouts || 0) || null,
    recent_sessions_7d: Number(profile.recent_sessions_7d || 0) || null,
    best_scan_score: Number(profile.best_scan_score || 0) || null,
    last_scan_summary: normalizeText(profile.last_scan_summary || ""),
    nutrition_summary: normalizeText(profile.nutrition_summary || ""),
    recent_meal_pattern: normalizeText(profile.recent_meal_pattern || ""),
    recent_workouts: Array.isArray(profile.recent_workouts) ? profile.recent_workouts.map((x) => normalizeText(x)).filter(Boolean).slice(0, 4) : [],
    today_kcal: Number(profile.today_kcal || 0) || null,
    today_protein: Number(profile.today_protein || 0) || null,
    coach_tone: normalizeText(profile.coach_tone || 'balanced') || 'balanced'
  };
}

function buildContextSnapshot(p) {
  const lines = [];
  if (p.current_streak != null) lines.push(`- Streak actif: ${p.current_streak} jour(s)`);
  if (p.recent_sessions_7d != null) lines.push(`- Séances sur 7 jours: ${p.recent_sessions_7d}`);
  if (p.best_scan_score != null) lines.push(`- Meilleur score de scan récent: ${p.best_scan_score}/100`);
  if (p.last_scan_summary) lines.push(`- Dernier scan: ${p.last_scan_summary}`);
  if (p.nutrition_summary) lines.push(`- Nutrition cible: ${p.nutrition_summary}`);
  if (p.recent_meal_pattern) lines.push(`- Repas récents: ${p.recent_meal_pattern}`);
  if (p.coach_tone) lines.push(`- Ton attendu du coach: ${p.coach_tone}`);
  return lines.length ? lines.join("\n") : "- Contexte avancé indisponible";
}


function coachToneGuide(tone) {
  const t = String(tone || 'balanced').toLowerCase();
  if (t === 'supportive') return "Ton attendu: chaleureux, rassurant, motivant, sans mollesse. Tu aides l'utilisateur à repartir sans culpabiliser.";
  if (t === 'direct') return "Ton attendu: franc, net, sans détour. Tu vas droit au point utile sans être froid.";
  if (t === 'strict') return "Ton attendu: exigeant, cadrant, discipliné. Tu recadres vite mais toujours de façon utile et respectueuse.";
  return "Ton attendu: équilibré, premium, humain, clair et pragmatique.";
}

function historyBlock(history = []) {
  const items = Array.isArray(history) ? history.slice(-12) : [];
  if (!items.length) return "";
  return items.map((item) => {
    const role = normalizeRole(item.role) === "assistant" ? "Coach" : "Utilisateur";
    return `${role}: ${sanitizeInput(String(item.content || ""), 350)}`;
  }).join("\n");
}

function buildWorkoutPrompt(message, history, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  return `Tu es un préparateur physique expert, orienté coaching premium. Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil utilisateur:
- Objectif: ${p.goal} (${getGoalDescription(p.goal)})
- Niveau: ${p.level} (${getLevelDescription(p.level)})
- Équipement: ${p.equipment}
- Blessures / contraintes: ${p.constraints}
- Poids: ${p.weight || "non renseigné"}
- Taille: ${p.height || "non renseignée"}
- Humeur du jour: ${p.mood || "non renseignée"}
- Sommeil moyen: ${p.sleep || "non renseigné"} h
- Récupération ressentie /10: ${p.recovery || "non renseignée"}

Contexte avancé à utiliser VRAIMENT:
${buildContextSnapshot(p)}

Historique récent:
${historyBlock(history) || "Aucun historique utile."}

Demande de l'utilisateur:
${message}

RÈGLES ABSOLUES:
- La séance doit être PERSONNALISÉE au profil, pas une routine générique.
- Utilise le contexte avancé: streak, séances récentes, scan, nutrition, récupération.
- Si la récup est basse, baisse l'intensité ou bascule sur une séance plus technique / plus courte.
- Si le niveau est débutant, simplifie les patterns et rends les consignes très claires.
- Si l'utilisateur a déjà beaucoup travaillé un pattern récemment, varie intelligemment les exercices.
- Respecte strictement les contraintes et l'équipement.
- ÉQUIPEMENT STRICT: ${/halt[eè]re|barre|salle|machine|kettlebell|banc/i.test(p.equipment || "") ? `Utilise UNIQUEMENT: ${p.equipment}. N'ajoute pas d'équipement non mentionné.` : "POIDS DU CORPS UNIQUEMENT — INTERDIT: haltères, barres, kettlebell, machines, câbles, poulies. Chaque exercice doit être réalisable sans aucun matériel."}
- Adapte l'intensité si sommeil < 6h ou récupération <= 5/10 ou humeur basse.
- Commence toujours par l'échauffement, termine par le retour au calme.
- Réponds en français.
- Les exercices doivent pouvoir être joués en séance guidée avec timer.

FORMAT JSON OBLIGATOIRE:
{
  "title": "Nom de la séance",
  "duration": 45,
  "calories": 350,
  "daily_focus": "priorité du jour en une phrase",
  "intensity_reason": "pourquoi cette intensité est adaptée aujourd'hui",
  "coach_note": "note coach courte et personnelle",
  "session_style": "guidée, dense, fluide, recovery...",
  "personalization": ["fait relié au contexte 1", "fait relié au contexte 2"],
  "exercises": [
    {
      "name": "Nom de l'exercice",
      "sets": 3,
      "reps": "10-12",
      "duration": 40,
      "rest": 20,
      "description": "Consigne technique courte et actionnable.",
      "muscle": "Groupe musculaire cible",
      "difficulty": "facile|moyen|difficile",
      "equipment": "Aucun",
      "personalWhy": "Pourquoi cet exercice est pertinent pour cet utilisateur aujourd'hui",
      "targetGoal": "prise_de_masse|perte_de_poids|remise_en_forme|endurance|force"
    }
  ]
}

STRUCTURE exercises[] requise:
1. Échauffement — 2 à 3 exercices légers, 25 à 35 secondes chacun, repos 0 à 15 secondes.
2. Corps principal — 4 à 7 exercices progressifs adaptés au profil.
3. Retour au calme — 2 à 3 étirements ou mobilités, 25 à 40 secondes.
- Préfère des exercices chronométrés et guidables plutôt qu'une simple logique 4x18.
- "duration" = durée en secondes du bloc d'effort quand pertinent.
- "rest" = repos en secondes entre les blocs.
- "description" ne doit jamais être vide.
- "personalWhy" doit expliquer brièvement pourquoi l'exercice a été choisi pour CE profil.
- "daily_focus", "intensity_reason" et "coach_note" doivent être présents et cohérents avec le contexte du jour.`;
}

function buildConversationPrompt(intent, message, history, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  const intentGuide = {
    greeting: "accueille avec chaleur puis propose 2 ou 3 aides concrètes maximum",
    nutrition_question: "réponds comme un coach nutrition premium: concret, crédible, simple à appliquer dès aujourd'hui",
    recovery_question: "réponds comme un coach récupération: sommeil, stress, fatigue, intensité du jour et prochain meilleur choix",
    motivation_question: "réponds comme un coach mental direct mais bienveillant: pas de banalités, une vraie relance utile",
    progress_question: "interprète la situation puis propose l'ajustement le plus rentable à faire maintenant",
    advice: "réponds comme un mentor fitness/lifestyle: clair, concret, utile dans la vraie vie",
    general_chat: "réponds comme un coach humain, premium et pragmatique",
    shopping_list: "aide l'utilisateur à préparer une liste de courses réaliste et alignée avec ses objectifs",
    meal_plan: "aide l'utilisateur à structurer ses repas de façon simple, efficace et tenable"
  }[intent] || "réponds comme un coach humain, premium et pragmatique";

  const lengthGuide = intent === "greeting"
    ? "3 à 5 lignes maximum"
    : ["shopping_list", "meal_plan"].includes(intent)
      ? "6 à 10 lignes organisées"
      : "3 à 7 lignes utiles";

  // Detect low-motivation / stagnation keywords for extra context injection
  const msgLow = message.toLowerCase();
  const isLowMotivation = /flemme|pas envie|j.ai pas|j.ai la|motivation|paresseux|peux pas me motiv/.test(msgLow);
  const isStagnating    = /stagne|plateau|progresse plus|j.avance pas|bloqué|plus de résultat|résultats nuls|progres/.test(msgLow);
  const isFatigue       = /fatigue|épuisé|epuise|crevé|creve|nul ce soir|claqué|claque/.test(msgLow);

  let extraCtx = "";
  if (isLowMotivation) extraCtx += "\nCONTEXTE FLEMME/DÉMOTIVATION: Ne pas donner une liste de conseils génériques. Reconnaître honnêtement l'état, identifier une cause probable (routine, fatigue, manque de résultats), et proposer UNE seule action concrète faisable dans les 5 prochaines minutes. Ton direct, humain, pas de blabla.";
  if (isFatigue)       extraCtx += "\nCONTEXTE FATIGUE: Si humeur Épuisé ou mention fatigue sévère: ne proposer que repos actif, mobilité légère ou rien. Si fatigue modérée: séance courte, intensité -30%, pas de HIIT. Protège la récupération.";
  if (isStagnating)    extraCtx += `\nCONTEXTE STAGNATION: Analyser la cause probable parmi: volume insuffisant, pas de surcharge progressive, récupération insuffisante, nutrition inadaptée. Streak actuel: ${p.current_streak || 0}j, séances récentes: ${p.recent_sessions_7d || 0}/7j. Proposer un ajustement précis et immédiat.`;
  if (p.current_streak && p.current_streak >= 3 && !isLowMotivation) extraCtx += `\nCONTEXTE STREAK: L'utilisateur a un streak de ${p.current_streak} jours — valorise cet élan et aide à le maintenir plutôt que de tout remettre en question.`;

  return `Tu es un coach fitness premium. Tu parles en français, directement, comme un coach qui suit cette personne depuis plusieurs semaines.

PROFIL:
- Objectif: ${p.goal} (${getGoalDescription(p.goal)})
- Niveau: ${p.level} (${getLevelDescription(p.level)})
- Équipement: ${p.equipment}
- Contraintes / blessures: ${p.constraints}
- Humeur du jour: ${p.mood || "non renseignée"}
- Sommeil: ${p.sleep ? `${p.sleep}h` : "non renseigné"} | Récupération: ${p.recovery ? `${p.recovery}/10` : "non renseignée"}
${p.display_name ? `- Prénom: ${p.display_name}` : ""}
- Préférence de ton: ${coachToneGuide(p.coach_tone)}

CONTEXTE SUIVI:
${buildContextSnapshot(p)}
${extraCtx}

HISTORIQUE CONVERSATION:
${historyBlock(history) || "— Début de conversation —"}

RÈGLES:
- ${intentGuide}.
- Longueur: ${lengthGuide}.
- Jamais vague ni générique: utilise le profil, le contexte, l'historique.
- Donne d'abord la réponse utile. Ensuite l'analyse si nécessaire. Ensuite l'action.
- Questions simples → réponse courte mais percutante (2-4 phrases max).
- Questions complexes → structure explicite: Réponse directe / Pourquoi / Action du jour.
- Quand l'utilisateur parle de flemme, fatigue ou manque d'envie: reconnais l'état, protège son élan, puis réduis la friction avec une micro-action immédiate.
- Utilise si pertinent le streak, les dernières séances, le dernier scan et la nutrition pour rendre la réponse personnelle.
- Si l'utilisateur semble dispersé, recentre-le sur UNE seule priorité concrète.
- Évite les slogans de motivation creux. Préfère une relance précise, réaliste et tenable aujourd'hui.
- Puces (2-4 max) uniquement si ça aide vraiment la lisibilité.
- Pas de JSON. Pas de programme complet sauf si explicitement demandé.
- Ne jamais parler de serveur, timeout, fallback ou de technique.
- Ne jamais dire "Je suis une IA" ou se décrire comme un assistant.
- Respecte la préférence de ton sans tomber dans la caricature.
- Si l'utilisateur veut une séance, commence par un cadrage court puis donne un plan exploitable, sans transformer la réponse en pavé confus.

MESSAGE:
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
  return `Tu es un coach nutrition premium. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

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
  "coach_note": "Phrase coach courte",
  "tips": ["...", "..."],
  "substitutions": ["...", "..."],
  "meals": [
    {
      "name": "Petit-déjeuner",
      "time": "7h30",
      "calories": 500,
      "protein": 30,
      "items": ["Flocons d'avoine 80g", "Banane", "Fromage blanc 200g"],
      "swap_options": ["Avoine ↔ pain complet"],
      "coach_tip": "Conseil court et utile"
    }
  ],
  "notes": "Conseil court sur l'hydratation ou la répartition"
}`;
}

function fallbackShoppingList(message) {
  const text = String(message || "").toLowerCase();
  const burgerMode = /burger|soirée|soiree|potes|amis|bbq|barbecue/.test(text);
  const bulkMode = /prise de masse|masse|bulk/.test(text);
  return {
    title: burgerMode ? "Courses pour soirée burgers" : bulkMode ? "Courses prise de masse sur 4 jours" : "Courses simples pour la semaine",
    context: burgerMode
      ? "Liste courte, conviviale et facile à préparer sans exploser les calories."
      : bulkMode
        ? "Base pratique pour tenir plusieurs jours avec plus d'énergie et des protéines hautes."
        : "Base réaliste pour cuisiner simple, riche en protéines et facile à répéter.",
    categories: burgerMode ? [
      { name: "Protéines", items: [{ name: "Steaks hachés 5%", qty: "6 à 8" }, { name: "Poulet mariné", qty: "600 g", note: "option plus légère" }, { name: "Tranches de cheddar", qty: "1 paquet" }] },
      { name: "Pains / féculents", items: [{ name: "Pains burger", qty: "8" }, { name: "Pommes de terre", qty: "2 kg" }] },
      { name: "Garnitures", items: [{ name: "Tomates", qty: "4" }, { name: "Salade", qty: "1" }, { name: "Oignons", qty: "2" }, { name: "Cornichons", qty: "1 bocal" }] },
      { name: "Sauces / extras", items: [{ name: "Sauce burger", qty: "1 flacon" }, { name: "Moutarde", qty: "1" }, { name: "Eau gazeuse / soft zéro", qty: "1 pack" }] }
    ] : [
      { name: "Protéines", items: bulkMode ? [{ name: "Poulet", qty: "1,5 kg" }, { name: "Boeuf 5%", qty: "700 g" }, { name: "Œufs", qty: "18" }, { name: "Skyr / yaourt grec", qty: "8 pots" }] : [{ name: "Poulet", qty: "1,2 kg" }, { name: "Œufs", qty: "12" }, { name: "Thon / saumon", qty: "3 portions" }, { name: "Skyr / fromage blanc", qty: "6 pots" }] },
      { name: "Féculents", items: bulkMode ? [{ name: "Riz basmati", qty: "1,5 kg" }, { name: "Pâtes", qty: "1 kg" }, { name: "Flocons d'avoine", qty: "750 g" }] : [{ name: "Riz basmati", qty: "1 kg" }, { name: "Pommes de terre", qty: "2 kg" }, { name: "Flocons d'avoine", qty: "500 g" }] },
      { name: "Légumes / fruits", items: [{ name: "Brocoli / haricots verts", qty: "4 sachets" }, { name: "Tomates", qty: "6" }, { name: "Bananes", qty: "7" }, { name: "Pommes / fruits rouges", qty: "1 à 2 barquettes" }] },
      { name: "Extras utiles", items: [{ name: "Huile d'olive", qty: "1 bouteille" }, { name: "Amandes / noix", qty: "1 sachet" }, { name: "Épices", qty: "paprika, ail, herbes" }] }
    ],
    tips: burgerMode ? "Prévois une plaque de pommes de terre au four et une salade pour garder la soirée plus légère sans perdre le côté plaisir." : "Cuis deux protéines et un gros féculent en batch pour sécuriser la semaine sans passer ta vie en cuisine."
  };
}

function fallbackMealPlan(profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  const kcal = p.goal === "prise_de_masse" ? 2800 : p.goal === "perte_de_poids" ? 1850 : 2250;
  const prot = Math.round(kcal * 0.29 / 4);
  return {
    title: "Journée alimentaire premium",
    total_calories: kcal,
    total_protein: prot,
    coach_note: p.goal === "prise_de_masse"
      ? "Priorité à la régularité: 4 prises simples et un vrai apport glucidique autour de la séance."
      : p.goal === "perte_de_poids"
        ? "Reste haut en protéines et garde le plus gros volume sur légumes + sources maigres."
        : "Mange simple, stable et répétable: c'est la meilleure base pour progresser sans te lasser.",
    tips: [
      "Prépare une base protéine + féculent + légumes pour 2 repas d'avance.",
      "Si la faim grimpe, augmente d'abord les légumes et l'hydratation avant de changer tout le plan.",
      "Garde une collation transportable pour éviter les écarts improvisés."
    ],
    substitutions: [
      "Poulet ↔ dinde, thon, tofu ferme.",
      "Riz ↔ pommes de terre, semoule, pâtes complètes.",
      "Skyr ↔ yaourt grec, fromage blanc ou whey + lait."
    ],
    meals: [
      { name: "Petit-déjeuner", time: "7h30", calories: Math.round(kcal * 0.22), protein: Math.round(prot * 0.2), items: ["Flocons d'avoine 80g", "Skyr ou fromage blanc", "1 fruit", "Quelques oléagineux"], swap_options: ["Avoine ↔ pain complet", "Skyr ↔ yaourt grec"], coach_tip: "Petit-déjeuner simple et stable: il doit te donner de l'énergie sans te ralentir." },
      { name: "Déjeuner", time: "12h30", calories: Math.round(kcal * 0.35), protein: Math.round(prot * 0.35), items: ["Poulet grillé 150g", "Riz ou pommes de terre", "Brocoli ou haricots verts", "Huile d'olive 1 cuillère"], swap_options: ["Poulet ↔ steak 5% ou tofu", "Riz ↔ pommes de terre"], coach_tip: "Si tu t'entraînes l'après-midi, place ici la plus grosse portion de glucides." },
      { name: "Collation", time: "16h00", calories: Math.round(kcal * 0.13), protein: Math.round(prot * 0.15), items: ["Fromage blanc 150g", "Noix 20g", "1 pomme ou banane"], swap_options: ["Fromage blanc ↔ shake protéiné", "Noix ↔ beurre de cacahuète"], coach_tip: "Choisis une collation que tu peux prendre même en déplacement." },
      { name: "Dîner", time: "19h30", calories: Math.round(kcal * 0.3), protein: Math.round(prot * 0.3), items: ["Saumon 150g ou oeufs", "Patate douce ou semoule", "Légumes cuits", "Citron et herbes"], swap_options: ["Saumon ↔ thon ou tofu", "Patate douce ↔ riz"], coach_tip: "Le soir, vise surtout récupération et digestion facile: inutile de compliquer." }
    ],
    notes: "Buvez 2 à 2.5L d'eau par jour. Ajustez les portions selon la faim, la séance et la récupération."
  };
}

async function generateShoppingList({ apiKey, message, profile, goalContext }) {
  const prompt = buildShoppingListPrompt(message, profile, goalContext);
  try {
    const result = await callGemini(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 900, timeoutMs: 8000, retries: 1 });
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
    const result = await callGemini(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 900, timeoutMs: 8000, retries: 1 });
    const parsed = extractJSON(result.text);
    if (!parsed || !Array.isArray(parsed.meals)) throw new Error("INVALID_MEAL_PLAN_JSON");
    return { ok: true, data: parsed, fallback: false };
  } catch (error) {
    return { ok: true, data: fallbackMealPlan(profile, goalContext), fallback: true, error: String(error?.message || "generation_failed") };
  }
}

function extractServings(message) {
  const t = String(message || "").toLowerCase();
  const m = t.match(/pour\s+(\d+)\s*(?:personnes?|couverts?|parts?)?/) ||
            t.match(/\b(\d+)\s*(?:personnes?|couverts?|parts?)\b/);
  if (m) return Math.min(12, Math.max(1, Number(m[1])));
  return 2;
}

function buildRecipePrompt(message, profile, goalContext) {
  const p = makeProfileSummary(profile, goalContext);
  const servings = extractServings(message);
  return `Tu es un chef cuisinier et nutritionniste sportif. Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ni après.

Profil utilisateur:
- Objectif fitness: ${p.goal}
- Contraintes alimentaires: ${p.constraints}

Demande de l'utilisateur: ${message}
Nombre de couverts: ${servings}

RÈGLES ABSOLUES:
1. La recette est pour EXACTEMENT ${servings} personne${servings > 1 ? "s" : ""} — toutes les quantités doivent être adaptées
2. Identifie tous les ingrédients mentionnés et utilise-les TOUS dans les étapes
3. Nomme chaque ingrédient spécifiquement dans chaque étape avec la quantité (ex: "Étale 150 g de sauce tomate", pas "Ajoute la sauce")
4. Les étapes doivent être des instructions précises avec températures, temps et techniques
5. Minimum 5 étapes détaillées, maximum 8 étapes
6. Les macros doivent correspondre aux ingrédients ET au nombre de couverts (calories par personne)
7. ingredients_list: liste chaque ingrédient avec la quantité exacte pour ${servings} personne${servings > 1 ? "s" : ""}

Format JSON exact:
{
  "name": "Nom créatif du plat",
  "servings": ${servings},
  "prep_time": "X min",
  "ingredients_list": [
    "Quantité précise Ingrédient 1 (pour ${servings} pers.)",
    "Quantité précise Ingrédient 2",
    "..."
  ],
  "steps": [
    "Étape 1 avec ingrédient nommé + quantité + temps/technique",
    "Étape 2...",
    "..."
  ],
  "calories": 500,
  "protein": 35,
  "carbs": 45,
  "fat": 15,
  "tips": "Conseil spécifique",
  "shopping_list": {
    "title": "Courses pour la recette",
    "categories": [
      { "title": "Catégorie", "items": [{ "name": "Ingrédient", "qty": "quantité pour ${servings} pers." }] }
    ]
  }
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
  const lowered = String(message || '').toLowerCase();
  const focus = lowered.includes('hiit') ? 'Conditioning' : lowered.includes('jamb') ? 'Lower Body' : lowered.includes('haut') ? 'Upper Body' : 'Full Body';
  const lowRecovery = (p.sleep && p.sleep < 6) || (p.recovery && p.recovery <= 5) || /fatigu|epuis|mal dormi/.test(String(p.mood || '').toLowerCase());
  const intensityBias = lowRecovery ? 'low' : p.goal === 'prise_de_masse' ? 'medium' : p.goal === 'perte_de_poids' ? 'medium' : 'medium';
  const pools = pickExercisePool(p.goal, p.level, p.equipment, intensityBias);
  const seed = `${message}|${p.goal}|${p.level}|${new Date().toISOString().slice(0, 10)}|${(p.recent_workouts || []).join('|')}`;

  const upper1 = pools.upper[seededIndex(seed, pools.upper.length, 1)];
  const upper2 = pools.upper[seededIndex(seed, pools.upper.length, 2)];
  const lower1 = pools.lower[seededIndex(seed, pools.lower.length, 3)];
  const lower2 = pools.lower[seededIndex(seed, pools.lower.length, 4)];
  const cardio = pools.cardio[seededIndex(seed, pools.cardio.length, 5)];
  const avoidRecent = (name) => !(p.recent_workouts || []).some((x) => String(x || '').toLowerCase().includes(String(name || '').toLowerCase().slice(0, 5)));

  const workSecMain = lowRecovery ? 30 : p.goal === 'endurance' ? 45 : p.goal === 'perte_de_poids' ? 40 : 42;
  const restMain = lowRecovery ? 25 : p.goal === 'prise_de_masse' ? 25 : 20;
  const title = lowRecovery ? `Séance ${focus} allégée et guidée` : `Séance ${focus} personnalisée et guidée`;

  const warmup = [
    { name: 'Respiration + ouverture thoracique', sets: 1, reps: '1 bloc', duration: 30, rest: 10, description: 'Détends les épaules et cale ta respiration avant d’accélérer.', muscle: 'Mobilité', difficulty: 'facile', equipment: 'Aucun', personalWhy: 'On prépare ton corps sans te fatiguer inutilement.', targetGoal: p.goal },
    { name: 'Mobilité hanches et chevilles', sets: 1, reps: '1 bloc', duration: 30, rest: 10, description: 'Cherche de l’amplitude propre, pas de vitesse.', muscle: 'Mobilité', difficulty: 'facile', equipment: 'Aucun', personalWhy: 'Ça améliore ta qualité de mouvement sur toute la séance.', targetGoal: p.goal }
  ];

  const main = [];
  if (focus !== 'Upper Body') main.push({ name: avoidRecent(lower1) ? lower1 : 'Split squats contrôlés', sets: 1, reps: 'bloc guidé', duration: workSecMain, rest: restMain, description: 'Rythme propre, genoux alignés, amplitude régulière.', muscle: 'Jambes / fessiers', difficulty: p.level === 'beginner' ? 'facile' : 'moyen', equipment: /halt|salle|machine|barre|kettlebell|banc/i.test(p.equipment || '') ? p.equipment : 'Aucun', personalWhy: lowRecovery ? 'On stimule le bas du corps sans te cramer nerveusement.' : 'Bloc clé pour construire une base solide selon ton objectif.', targetGoal: p.goal });
  if (focus !== 'Lower Body') main.push({ name: avoidRecent(upper1) ? upper1 : 'Pompes tempo', sets: 1, reps: 'bloc guidé', duration: workSecMain, rest: restMain, description: 'Cherche une poussée propre, poitrine ouverte et tronc gainé.', muscle: 'Pectoraux / épaules', difficulty: p.level === 'beginner' ? 'facile' : 'moyen', equipment: /halt|salle|machine|barre|kettlebell|banc/i.test(p.equipment || '') ? p.equipment : 'Aucun', personalWhy: 'On garde un mouvement de poussée rentable et lisible pour progresser sans confusion.', targetGoal: p.goal });
  main.push({ name: avoidRecent(lower2) ? lower2 : 'Hip hinge contrôlé', sets: 1, reps: 'bloc guidé', duration: workSecMain, rest: restMain, description: 'Hanches en arrière, dos long, contrôle total.', muscle: 'Chaîne postérieure', difficulty: p.level === 'beginner' ? 'facile' : 'moyen', equipment: /halt|salle|machine|barre|kettlebell|banc/i.test(p.equipment || '') ? p.equipment : 'Aucun', personalWhy: 'Ce pattern améliore puissance, posture et transfert sur beaucoup de mouvements.', targetGoal: p.goal });
  main.push({ name: avoidRecent(upper2) ? upper2 : 'Rowing contrôlé', sets: 1, reps: 'bloc guidé', duration: workSecMain, rest: restMain, description: 'Tire sans hausser les épaules, poitrine sortie.', muscle: 'Dos / bras', difficulty: p.level === 'beginner' ? 'facile' : 'moyen', equipment: /halt|salle|machine|barre|kettlebell|banc/i.test(p.equipment || '') ? p.equipment : 'Aucun', personalWhy: 'On équilibre la posture et le haut du corps pour une séance plus complète.', targetGoal: p.goal });
  if (p.goal === 'perte_de_poids' || p.goal === 'endurance') main.push({ name: cardio, sets: 1, reps: 'bloc guidé', duration: lowRecovery ? 35 : 45, rest: 20, description: lowRecovery ? 'Rythme régulier et respirable.' : 'Monte le cardio sans te désunir techniquement.', muscle: 'Cardio', difficulty: lowRecovery ? 'facile' : 'moyen', equipment: /halt|salle|machine|barre|kettlebell|banc/i.test(p.equipment || '') ? p.equipment : 'Aucun', personalWhy: 'Tu as besoin d’un bloc de densité pour coller à ton objectif actuel.', targetGoal: p.goal });
  else main.push({ name: 'Gainage actif', sets: 1, reps: 'bloc guidé', duration: 35, rest: 18, description: 'Reste compact, zéro relâchement du tronc.', muscle: 'Core', difficulty: 'facile', equipment: 'Aucun', personalWhy: 'On finit par un bloc qui stabilise tout le reste sans te détruire.', targetGoal: p.goal });

  const cooldown = [
    { name: 'Respiration guidée', sets: 1, reps: '1 bloc', duration: 30, rest: 0, description: 'Ralentis la respiration et fais redescendre le rythme.', muscle: 'Récupération', difficulty: 'facile', equipment: 'Aucun', personalWhy: 'Ta récupération fait partie de la progression.', targetGoal: p.goal },
    { name: 'Étirements ciblés', sets: 1, reps: '1 bloc', duration: 30, rest: 0, description: 'Ouvre les zones qui ont le plus travaillé sans forcer.', muscle: focus === 'Upper Body' ? 'Haut du corps' : focus === 'Lower Body' ? 'Bas du corps' : 'Full Body', difficulty: 'facile', equipment: 'Aucun', personalWhy: 'On clôt la séance proprement pour que tu repartes plus mobile et plus frais.', targetGoal: p.goal }
  ];

  return {
    title,
    duration,
    calories: Math.round(duration * (lowRecovery ? 5.2 : p.goal === 'perte_de_poids' ? 7.5 : 6.6)),
    exercises: [...warmup, ...main, ...cooldown]
  };
}


function fallbackConversation(intent, message, profile = {}, goalContext = {}) {
  const p = makeProfileSummary(profile, goalContext);
  const lowRecovery = (p.sleep && p.sleep < 6) || (p.recovery && p.recovery <= 5);
  const tone = String(p.coach_tone || 'balanced').toLowerCase();
  const intro = tone === 'strict' ? 'On coupe le bruit et on agit.' : tone === 'direct' ? 'On va droit au plus rentable.' : tone === 'supportive' ? 'On garde l\'élan sans se juger.' : 'On reste simple et utile.';
  if (intent === "greeting") {
    return `Réponse directe: Salut ${p.display_name || "champion"} 👋 ${intro}
Pourquoi: Je peux te guider vite sur une séance, une journée alimentaire, une recette ou une stratégie récupération sans te noyer dans le blabla.
Action du jour: Donne-moi ton besoin exact en une phrase, par exemple « séance full body 40 min », « idée repas sèche » ou « j'ai mal dormi, j'adapte comment ? ». `;
  }
  if (intent === "nutrition_question") {
    return p.goal === "prise_de_masse"
      ? `Réponse directe: Pour progresser en prise de masse, assure surtout une vraie portion de protéines à chaque repas et place davantage de glucides autour de l'entraînement.
Pourquoi: C'est ce qui t'aide à performer sans te sentir lourd toute la journée.
Action du jour: Fais simple aujourd'hui: protéine + féculent + fruit après ta séance, puis une collation protéinée dans l'après-midi.`
      : `Réponse directe: Le plus rentable pour ton objectif, c'est de sécuriser les protéines puis de garder des repas simples et réguliers.
Pourquoi: Quand la structure est claire, tu tiens plus facilement sur plusieurs semaines.
Action du jour: Sur ton prochain repas, vise légumes + protéines + une portion de féculents adaptée à ta faim et à ta dépense.`;
  }
  if (intent === "recovery_question") {
    return lowRecovery
      ? `Réponse directe: ${tone === 'strict' ? "Aujourd'hui on n'ego pas : on baisse l'intensité." : "Aujourd'hui, je baisserais l'intensité."}
Pourquoi: Avec peu de sommeil ou une récupération basse, forcer plus fort te coûte souvent plus qu'il ne te rapporte.
Action du jour: Fais 10 à 20 min de mobilité, une marche active ou une séance technique très propre, puis couche-toi plus tôt ce soir.`
      : `Réponse directe: ${intro} Ta récup passera surtout par sommeil, hydratation et charge bien dosée.
Pourquoi: C'est le trio qui protège ta progression sans casser le rythme.
Action du jour: Fais 5 à 10 minutes de mobilité ce soir et garde la séance lourde seulement si les courbatures baissent nettement demain.`;
  }
  if (intent === "motivation_question") {
    const streakNote = p.current_streak ? `Tu as déjà ${p.current_streak} jour(s) de régularité en jeu.` : "Tu n'as pas besoin d'une énorme séance pour rester dans le rythme.";
    const scanNote = p.last_scan_summary ? `Ton dernier scan rappelle déjà l'axe prioritaire: ${p.last_scan_summary}.` : "";
    const sessionNote = p.recent_sessions_7d ? `Tu as déjà bougé ${p.recent_sessions_7d} fois cette semaine.` : "";
    return `Réponse directe: ${intro} Avoir la flemme est normal — on ne cherche pas l'héroïsme, on protège l'élan.
Pourquoi: ${[streakNote, sessionNote, scanNote].filter(Boolean).join(' ')}`.trim() + `
Action du jour: Mets ta tenue maintenant. Fais 6 minutes de marche active ou 2 mouvements faciles. Si l'énergie remonte, tu prolonges 10 minutes. Si non, tu as quand même gagné ta journée de discipline.`;
  }
  if (intent === "progress_question") {
    return `Réponse directe: Regarde d'abord régularité, qualité technique et charge ou reps sur tes mouvements clés.
Pourquoi: Si un seul de ces marqueurs monte proprement, tu avances déjà.
Action du jour: Choisis un mini-objectif mesurable pour la prochaine séance: +1 rep, meilleure exécution ou tempo plus propre.`;
  }
  return `Réponse directe: ${intro} Pour ton objectif ${p.goal.replaceAll("_", " ")}, on va chercher l'action la plus rentable aujourd'hui, pas la réponse la plus théorique.
Pourquoi: Tu progresses surtout quand tes choix collent à ton niveau réel, à ton énergie et à ce que tu tiens dans la durée.${p.best_scan_score ? ` Ton meilleur repère récent est ${p.best_scan_score}/100, donc on ajuste sans perdre le fil.` : ""}
Action du jour: Donne-moi ton contexte exact — temps dispo, matériel, fatigue du jour — et je te répondrai avec une action courte, précise et applicable maintenant.`;
}

function fallbackRecipe(message, profile = {}, goalContext = {}) {
  const p = makeProfileSummary(profile, goalContext);
  const s = extractServings(message);
  const isMasse = p.goal === "prise_de_masse";
  const isSeche = p.goal === "perte_de_poids";
  const name = isMasse ? "Bol protéiné énergie" : isSeche ? "Assiette lean express" : "Repas fitness équilibré";
  const protQty = `${150 * s} g`;
  const glucQty = `${80 * s} g`;
  const ingredients_list = [
    `${protQty} de blanc de poulet ou filet de saumon`,
    `${glucQty} de riz complet ou quinoa (poids sec)`,
    `${s} poignée${s > 1 ? "s" : ""} de légumes (brocoli, courgette, poivron)`,
    `${s} cuillère${s > 1 ? "s" : ""} à soupe d'huile d'olive`,
    `Sel, poivre, herbes de Provence`
  ];
  const shopping_list = {
    title: `Courses pour ${s} personne${s > 1 ? "s" : ""}`,
    categories: [{
      title: 'Protéines', items: [{ name: 'Blanc de poulet ou saumon', qty: `${150 * s} g` }]
    }, {
      title: 'Glucides', items: [{ name: 'Riz complet ou quinoa', qty: `${80 * s} g` }]
    }, {
      title: 'Légumes', items: [
        { name: 'Brocoli', qty: `${100 * s} g` },
        { name: 'Courgette ou poivron', qty: `${s} unité${s > 1 ? "s" : ""}` }
      ]
    }, {
      title: 'Épicerie', items: [{ name: 'Huile d\'olive', qty: `${s} c. à soupe` }]
    }]
  };
  return {
    name,
    servings: s,
    prep_time: "15 min",
    ingredients_list,
    steps: [
      `Assaisonne ${protQty} de protéines avec sel, poivre et herbes, puis fais-les cuire 6 à 8 min à feu moyen dans une poêle avec un filet d'huile.`,
      `Lance ${glucQty} de riz complet dans de l'eau bouillante salée (ratio 1:2) et fais cuire 12 min.`,
      `Coupe les légumes en morceaux réguliers et fais-les sauter 4 à 5 min à feu vif jusqu'à coloration.`,
      `Incorpore une cuillère d'huile d'olive sur les légumes, assaisonne et mélange bien.`,
      `Dresse dans ${s > 1 ? "les assiettes" : "l'assiette"} : base de riz, légumes, protéine par-dessus. Sers immédiatement.`
    ],
    calories: isMasse ? 700 : isSeche ? 450 : 550,
    protein: isMasse ? 45 : 40,
    carbs: isSeche ? 30 : 55,
    fat: isMasse ? 22 : 16,
    tips: `Adapte les quantités : pour ${s} personne${s > 1 ? "s" : ""}, compte environ 150 g de protéines et 80 g de glucides secs par personne.`,
    shopping_list
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
      calories: source.calories ? Math.round(Number(source.calories)) : null,
      calories_estimate: source.calories ? Math.round(Number(source.calories)) : null,
      target_muscles:   muscles,
      equipment_needed: equip,
      notes:            String(source.notes || ""),
      daily_focus:      normalizeText(source.daily_focus || ""),
      intensity_reason: normalizeText(source.intensity_reason || ""),
      coach_note:       normalizeText(source.coach_note || ""),
      session_style:    normalizeText(source.session_style || ""),
      personalization:  Array.isArray(source.personalization) ? source.personalization.map((x) => normalizeText(x)).filter(Boolean).slice(0, 4) : [],
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
      calories:         source.calories || source.calories_estimate || null,
      calories_estimate: source.calories_estimate || null,
      target_muscles:   Array.isArray(source.target_muscles) ? source.target_muscles : [],
      equipment_needed: Array.isArray(source.equipment_needed) ? source.equipment_needed : [],
      notes:            String(source.notes || ""),
      daily_focus:      normalizeText(source.daily_focus || ""),
      intensity_reason: normalizeText(source.intensity_reason || ""),
      coach_note:       normalizeText(source.coach_note || ""),
      session_style:    normalizeText(source.session_style || ""),
      personalization:  Array.isArray(source.personalization) ? source.personalization.map((x) => normalizeText(x)).filter(Boolean).slice(0, 4) : [],
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
    calories:         null,
    calories_estimate: null,
    target_muscles:   [String(session.focus || "Full Body")],
    equipment_needed: [],
    notes,
    daily_focus:      "remettre du mouvement propre dans la semaine",
    intensity_reason: p.recovery && p.recovery <= 5 ? "intensité allégée pour respecter la récupération" : "intensité standard pour relancer la progression",
    coach_note:       "Reste propre sur les mouvements clés avant de chercher plus d'intensité.",
    session_style:    "guidée progressive",
    personalization:  [],
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
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.3, maxOutputTokens: 1200, timeoutMs: 8000, retries: 1 });
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
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.55, maxOutputTokens: 2000, timeoutMs: 12000, retries: 1 });
    const text = String(result.text || "").replace(/^```[\w-]*\s*/g, "").replace(/```$/g, "").trim();
    if (!text) throw new Error("EMPTY_CONVERSATION");
    return { ok: true, message: text, model: result.model, fallback: false };
  } catch (error) {
    return { ok: true, message: fallbackConversation(intent, message, profile, goalContext), fallback: true, error: String(error?.message || "generation_failed"), degraded_reason: "fallback_fast" };
  }
}

async function generateRecipeJson({ apiKey, message, profile, goalContext }) {
  const prompt = buildRecipePrompt(message, profile, goalContext);
  const servings = extractServings(message);
  try {
    const result = await generateWithRetry(apiKey, prompt, { temperature: 0.35, maxOutputTokens: 2200, timeoutMs: 12000, retries: 1 });
    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.name) throw new Error("INVALID_RECIPE_JSON");
    if (!parsed.servings) parsed.servings = servings;
    // Build shopping_list from ingredients_list if AI didn't provide it
    if (!parsed.shopping_list && Array.isArray(parsed.ingredients_list)) {
      parsed.shopping_list = { title: 'Courses recette', categories: [{ title: 'Ingrédients', items: parsed.ingredients_list.map(n => ({ name: n, qty: '' })) }] };
    }
    return { ok: true, data: parsed, model: result.model, fallback: false };
  } catch (error) {
    return { ok: true, data: fallbackRecipe(message, profile, goalContext), fallback: true, error: String(error?.message || "generation_failed"), degraded_reason: "fallback_fast" };
  }
}

function strictWorkoutPayloadFromPlan(plan) {
  const normalized = normalizeWorkoutOutput(plan);
  const fromExercises = Array.isArray(normalized.exercises) ? normalized.exercises : [];
  const derived = [];
  if (!fromExercises.length && Array.isArray(normalized.blocks)) {
    normalized.blocks.forEach((block) => {
      (Array.isArray(block.items) ? block.items : []).forEach((item) => {
        const text = String(item || "").trim();
        if (!text) return;
        derived.push({
          name: text.split(/\s+[—-]\s+/)[0] || "Exercice",
          sets: 3,
          reps: /\b(\d+\s*(?:-\s*\d+)?)\b/.test(text) ? RegExp.$1.replace(/\s+/g, "") : "10-12",
          rest: 60,
          duration: /\b(\d+)s\b/i.test(text) ? Number(RegExp.$1) : 0,
          description: text
        });
      });
    });
  }
  const exercises = (fromExercises.length ? fromExercises : derived).slice(0, 10).map((ex) => ({
    name: normalizeText(ex.name || "Exercice", "Exercice"),
    sets: Math.max(1, Math.round(Number(ex.sets) || 3)),
    reps: normalizeText(ex.reps || (ex.duration ? `${Math.max(15, Number(ex.duration) || 30)}s` : "10-12"), "10-12"),
    rest: Math.max(0, Math.round(Number(ex.rest) || 0)),
    duration: Math.max(0, Math.round(Number(ex.duration) || 0)),
    description: normalizeText(ex.description || "", "")
  }));
  const safeExercises = exercises.length ? exercises : strictWorkoutPayloadFromPlan(fallbackWorkout("séance full body")).exercises;
  const duration = Math.max(10, Math.round(Number(normalized.duration) || 45));
  const calories = Math.max(120, Math.round(Number(normalized.calories || normalized.calories_estimate) || safeExercises.length * 35 + duration * 4));
  return {
    title: normalizeText(normalized.title || "Workout du jour", "Workout du jour"),
    duration,
    calories,
    exercises: safeExercises
  };
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
  strictWorkoutPayloadFromPlan,
  generateWorkoutPlan,
  generateConversationReply,
  generateRecipeJson,
  generateShoppingList,
  generateMealPlan,
  fallbackWorkout,
  fallbackConversation,
  fallbackRecipe,
  fallbackShoppingList,
  fallbackMealPlan,
  getGoalDescription,
  getLevelDescription
};
