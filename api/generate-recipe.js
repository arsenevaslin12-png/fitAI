"use strict";

// api/generate-recipe.js
// Endpoint standalone pour la génération de recettes IA.
// Fonctionne avec SUPABASE_ANON_KEY (pas besoin de service role key).

const { createClient } = require("@supabase/supabase-js");
const {
  extractJson,
  callGeminiText,
  normalizeGeminiError
} = require("./_gemini");
const { assertEnv, validateBody, RecipeBodySchema } = require("./_env");
const { checkRateLimit, getIp } = require("./_coach-core");

// Timeout calibré pour que 2 modèles × 1 tentative (retries: 0) reste sous les 30s maxDuration Vercel.
// 2 × 12s = 24s < 30s. Le catch retourne toujours un fallback si Gemini est trop lent.
const GEMINI_TIMEOUT_MS = 18000; // 18s × 1 model × 0 retries = 18s max, well under Vercel 30s limit

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function pickAnonKey() {
  return (
    String(process.env.SUPABASE_ANON_KEY || "").trim() ||
    String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim() ||
    String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim() ||
    String(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "").trim() ||
    ""
  );
}

const GOAL_LABELS = {
  equilibre:     "repas équilibré",
  hyperproteine: "repas hyperprotéiné (max de protéines)",
  low_carb:      "repas low carb (très peu de glucides)",
  prise_de_masse:"repas prise de masse (calorique et protéiné)",
  seche:         "repas de sèche (peu calorique, riche en protéines)"
};

const COOKING_STYLES = [
  "mariné puis poêlé", "sauté à feu vif", "mijoté doucement", "cuit vapeur",
  "rôti au four", "grillé", "en one-pan", "façon bowl", "en sauce légère"
];

function sanitizeText(value, fallback = "") {
  return String(value == null ? fallback : value).replace(/[<>]/g, "").trim();
}

function isRecipeIdeaQuery(input) {
  const text = sanitizeText(input).toLowerCase();
  if (!text) return false;
  if (/[,;]/.test(text)) return false;
  if (/et/.test(text) && text.split(/et/).length > 3) return false;
  return /(cr[eê]pes?|pancakes?|cookies?|brownie|gaufres?|wrap|burger|pizza|tacos?|bowl|salade|omelette|porridge|granola|smoothie|cake|muffins?|dessert|glace|cheesecake|lasagnes?|p[âa]tes?|risotto|sandwich)/.test(text)
    || text.split(/\s+/).length <= 5;
}

function recipeStyleProfile(goal, requestText, recipeStyle = "fast") {
  const t = sanitizeText(requestText).toLowerCase();
  const sweet = /(cr[eê]pes?|pancakes?|cookies?|brownie|gaufres?|cake|muffins?|dessert|glace|cheesecake|porridge|granola|smoothie)/.test(t);
  return {
    sweet,
    healthyAngle: goal === 'hyperproteine'
      ? 'version healthy et protéinée avec ingrédients simples, digestes et riches en protéines'
      : goal === 'seche'
        ? 'version healthy, plus légère, riche en protéines et modérée en calories'
        : goal === 'prise_de_masse'
          ? 'version healthy, généreuse, protéinée et suffisante pour soutenir la performance'
          : goal === 'low_carb'
            ? 'version healthy, riche en protéines et très modérée en glucides'
            : 'version healthy, gourmande, équilibrée et protéinée',
    styleHint: recipeStyle === 'comfort'
      ? 'texture gourmande, rassurante, très satisfaisante'
      : recipeStyle === 'mealprep'
        ? 'facile à batch-cooker et à emporter'
        : recipeStyle === 'fresh'
          ? 'fraîche, légère, digeste et clean'
          : 'rapide, simple, peu de vaisselle'
  };
}

function buildRecipeShoppingList(ingredientsList = []) {
  const groups = {
    "Protéines": [],
    "Bases & farines": [],
    "Fruits & légumes": [],
    "Extras intelligents": []
  };
  const seen = new Set();
  const classify = (item) => {
    const t = String(item || "").toLowerCase();
    if (/(oeuf|skyr|fromage blanc|yaourt grec|whey|poulet|thon|dinde|tofu|saumon|lait|laitages?)/.test(t)) return "Protéines";
    if (/(farine|avoine|riz|semoule|pain|galette|quinoa|p[âa]tes|pommes de terre)/.test(t)) return "Bases & farines";
    if (/(banane|pomme|fruits rouges|fraise|myrtille|citron|avocat|brocoli|courgette|salade|tomate|légumes?)/.test(t)) return "Fruits & légumes";
    return "Extras intelligents";
  };
  ingredientsList.slice(0, 16).forEach((raw) => {
    const name = String(raw || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    groups[classify(name)].push({ name, qty: "à prévoir" });
  });
  return {
    title: "Courses recette",
    categories: Object.entries(groups).filter(([, items]) => items.length).map(([title, items]) => ({ title, items }))
  };
}

function inferRecipeBestFor(name, goal) {
  const t = String(name || "").toLowerCase();
  if (/(cr[eê]pes?|pancakes?|porridge|granola|petit)/.test(t)) return "Petit-déjeuner ou collation";
  if (/(burger|wrap|bowl|salade|p[âa]tes|lasagnes?|risotto)/.test(t)) return "Déjeuner ou dîner";
  if (goal === 'hyperproteine') return "Post-workout ou repas rapide riche en protéines";
  if (goal === 'seche') return "Repas contrôlé ou collation rassasiante";
  return "Repas flexible selon ta journée";
}

function inferBatchPrep(name, goal) {
  if (goal === 'prise_de_masse') return "Prépare 2 portions d’un coup pour sécuriser ton apport calorique sans recuisiner.";
  if (goal === 'seche') return "Prépare la base protéinée à l’avance puis dose le topping au moment de manger.";
  if (/(cr[eê]pes?|cookies?|muffins?|cake)/i.test(String(name || ""))) return "Prépare une fournée et garde 2 portions prêtes pour la semaine.";
  return "Fais une double portion : une pour maintenant, une pour gagner du temps demain.";
}

function buildRecipePrompt(requestText, goal, targetKcal, servings = 2, recipeStyle = "fast") {

  const cleanRequest = sanitizeText(requestText);
  const goalLabel = GOAL_LABELS[goal] || "repas équilibré";
  const styleIdx = cleanRequest.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % COOKING_STYLES.length;
  const cookingStyle = COOKING_STYLES[styleIdx];
  const ideaMode = isRecipeIdeaQuery(cleanRequest);
  const style = recipeStyleProfile(goal, cleanRequest, recipeStyle);

  if (ideaMode) {
    return `Tu es un chef nutritionniste sportif premium.
L'utilisateur veut: ${cleanRequest}.
Tu dois créer une ${style.healthyAngle} inspirée de cette envie.
Objectif: ${goalLabel}. Calories visées: environ ${targetKcal} kcal.
Style suggéré: ${cookingStyle}.
Nombre de portions: ${servings}.
Direction produit: ${style.styleHint}.

RÈGLES:
- Si la demande est plaisir ou junk food (ex: crêpes, cookies, burger), transforme-la en version healthy crédible et riche en protéines.
- Utilise des ingrédients réalistes faciles à trouver.
- Donne un NOM appétissant et précis.
- Donne une vraie liste d'ingrédients avec quantités.
- Étapes détaillées, concrètes et pédagogiques.
- Interdiction de dire simplement "cuire" sans préciser comment, combien de temps ou quel repère visuel.
- Chaque étape doit être compréhensible par un débutant.
- Ajoute un champ healthy_twist qui explique pourquoi cette version est plus healthy/protéinée.
- Ajoute un champ coach_note court qui dit quand manger cette recette (petit-déj, post-workout, collation, etc.)
- Réponds UNIQUEMENT en JSON valide, sans markdown.

FORMAT EXACT:
{"name":"Nom du plat","healthy_twist":"Pourquoi cette version est healthy/protéinée","ingredients_list":["120 g ...","1 ..."],"steps":["Étape 1 détaillée","Étape 2 détaillée","Étape 3 détaillée"],"prep_time":"15 min","servings":2,"best_for":"Petit-déjeuner ou collation","batch_prep":"Comment la préparer en avance","calories":500,"protein":35,"carbs":50,"fat":15,"tips":"Conseil technique utile","coach_note":"Quand la manger"}`;
  }

  return `Tu es un chef nutritionniste sportif créatif.
Crée une recette fitness ORIGINALE avec cette base fournie par l'utilisateur: ${cleanRequest}.
Objectif: ${goalLabel}, environ ${targetKcal} kcal.
Style de cuisson suggéré (adapte si besoin): ${cookingStyle}.
Nombre de portions: ${servings}.
Direction produit: ${style.styleHint}.

RÈGLES:
- Interprète la base fournie comme ingrédients disponibles, idées de recette ou mélange des deux.
- Donne un NOM DE PLAT spécifique et appétissant.
- Donne une liste d'ingrédients structurée avec quantités.
- Étapes détaillées, concrètes, jamais vagues: cite l'ingrédient, l'action, l'ordre et si possible le temps ou le repère visuel.
- Interdiction de dire simplement "cuire les légumes" ou "cuire la protéine" sans préciser comment.
- Le champ "healthy_twist" doit résumer ce qui rend la recette plus propre / utile pour l'objectif.
- Le champ "coach_note" doit être un conseil court lié au contexte d'usage de la recette.
- Réponds UNIQUEMENT en JSON valide, sans texte autour.

FORMAT EXACT:
{"name":"Nom précis du plat","healthy_twist":"Pourquoi la recette colle à l'objectif","ingredients_list":["120 g ...","1 ..."],"steps":["Étape 1 détaillée","Étape 2 détaillée","Étape 3 détaillée"],"prep_time":"15 min","servings":2,"best_for":"Déjeuner ou dîner","batch_prep":"Comment la préparer en avance","calories":500,"protein":35,"carbs":50,"fat":15,"tips":"Conseil technique spécifique à cette recette","coach_note":"Quand la manger"}`;
}

function validateRecipe(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name && !Array.isArray(raw.steps) && !raw.calories) return null;
  return {
    name:      String(raw.name || "Recette IA"),
    healthy_twist: String(raw.healthy_twist || ""),
    ingredients_list: Array.isArray(raw.ingredients_list) ? raw.ingredients_list.map(String).filter(Boolean).slice(0, 12) : [],
    steps:     Array.isArray(raw.steps) ? raw.steps.map(String).filter(Boolean).slice(0, 10) : [],
    prep_time: String(raw.prep_time || "15 min"),
    servings: Math.max(1, Math.min(6, Math.round(Number(raw.servings) || 2))),
    best_for: String(raw.best_for || "Repas flexible"),
    batch_prep: String(raw.batch_prep || "Prépare une double portion pour gagner du temps."),
    calories:  Math.max(0, Math.round(Number(raw.calories) || 400)),
    protein:   Math.max(0, Math.round(Number(raw.protein)  || 30)),
    carbs:     Math.max(0, Math.round(Number(raw.carbs)    || 40)),
    fat:       Math.max(0, Math.round(Number(raw.fat)      || 15)),
    tips:      String(raw.tips || ""),
    coach_note:String(raw.coach_note || ""),
    shopping_list: raw.shopping_list && typeof raw.shopping_list === 'object' ? raw.shopping_list : buildRecipeShoppingList(Array.isArray(raw.ingredients_list) ? raw.ingredients_list : [])
  };
}

function fallbackRecipe(requestText, goal, targetKcal, servings = 2, recipeStyle = "fast") {
  const text = sanitizeText(requestText).toLowerCase();
  const kcal = Math.max(250, Math.min(1100, Math.round(Number(targetKcal) || 500)));
  const proteinBase = goal === 'hyperproteine' ? 35 : goal === 'prise_de_masse' ? 30 : 25;
  const s = Math.max(1, Math.min(6, Math.round(Number(servings) || 2)));

  if (/(cr[eê]pes?|pancakes?)/.test(text)) {
    return {
      name: "Crêpes protéinées healthy",
      healthy_twist: "On remplace la pâte classique par une base plus riche en protéines et plus rassasiante, sans perdre le côté gourmand.",
      ingredients_list: [
        "2 œufs",
        "120 g de fromage blanc ou skyr",
        "40 g de farine d'avoine",
        "20 à 30 g de whey vanille",
        "1/2 banane écrasée",
        "1 pincée de cannelle",
        "1 cuillère à café d'huile ou spray cuisson"
      ],
      steps: [
        "Écrase la demi-banane dans un bol, ajoute les œufs puis fouette jusqu'à obtenir une base lisse.",
        "Incorpore le fromage blanc, la whey et la farine d'avoine en fouettant pour éviter les grumeaux; laisse reposer 2 minutes pour que la pâte épaississe légèrement.",
        "Chauffe une poêle antiadhésive à feu moyen, huile très légèrement, puis verse une petite louche de pâte.",
        "Cuire 60 à 90 secondes jusqu'à voir les bords se figer et quelques bulles au centre, retourne puis cuits encore 30 à 45 secondes.",
        "Empile les crêpes et sers avec fruits rouges, un peu de skyr et éventuellement un filet de beurre de cacahuète si l'objectif le permet."
      ],
      prep_time: "12 min",
      servings: s,
      best_for: "Petit-déjeuner ou collation post-training",
      batch_prep: "Prépare la pâte la veille ou cuis 2 portions pour le lendemain.",
      calories: kcal,
      protein: proteinBase + 10,
      carbs: Math.max(20, Math.round(kcal * 0.38 / 4)),
      fat: Math.max(8, Math.round(kcal * 0.22 / 9)),
      tips: "Si la pâte épaissit trop, ajoute une cuillère à soupe de lait ou d'eau avant la deuxième crêpe.",
      coach_note: "Parfait au petit-déjeuner ou en post-training si tu veux quelque chose de gourmand mais utile.",
      shopping_list: buildRecipeShoppingList(["2 œufs", "120 g de fromage blanc ou skyr", "40 g de farine d'avoine", "20 à 30 g de whey vanille", "1/2 banane", "cannelle"])
    };
  }

  if (/(cookies?|brownie|muffins?|cake|dessert)/.test(text)) {
    return {
      name: "Cookie protéiné version clean",
      healthy_twist: "On garde le côté dessert mais avec une base plus rassasiante, plus protéinée et mieux calibrée pour l'objectif.",
      ingredients_list: [
        "1 banane mûre",
        "35 g de whey chocolat ou vanille",
        "60 g de flocons d'avoine mixés",
        "1 œuf",
        "10 g de pépites de chocolat noir",
        "1/2 cuillère à café de levure"
      ],
      steps: [
        "Préchauffe le four à 180°C et écrase la banane jusqu'à obtenir une purée lisse.",
        "Ajoute l'œuf, la whey, l'avoine mixée et la levure puis mélange jusqu'à obtenir une pâte souple mais épaisse.",
        "Incorpore les pépites de chocolat, forme 3 à 4 gros cookies sur une plaque recouverte de papier cuisson.",
        "Enfourne 8 à 10 minutes: les bords doivent être pris et le centre encore légèrement moelleux.",
        "Laisse tiédir 5 minutes pour qu'ils se raffermissent avant de servir."
      ],
      prep_time: "15 min",
      servings: 3,
      best_for: "Collation protéinée ou dessert contrôlé",
      batch_prep: "Fais une fournée de 3 à 4 cookies et conserve-les 48h dans une boîte.",
      calories: kcal,
      protein: proteinBase + 8,
      carbs: Math.max(18, Math.round(kcal * 0.35 / 4)),
      fat: Math.max(8, Math.round(kcal * 0.24 / 9)),
      tips: "Ne sur-cuis pas: c'est le repos hors du four qui donne la bonne texture.",
      coach_note: "Très bien en collation post-training ou pour calmer une envie sucrée sans saboter la journée.",
      shopping_list: buildRecipeShoppingList(["1 banane mûre", "35 g de whey", "60 g de flocons d'avoine", "1 œuf", "10 g de pépites de chocolat noir"])
    };
  }

  const goalLabel = GOAL_LABELS[goal] || "équilibré";
  const ingredientPreview = sanitizeText(requestText).slice(0, 80);
  return {
    name:      `Recette ${goalLabel}`,
    healthy_twist: "Version simple, plus riche en protéines et plus propre qu'une recette improvisée au hasard.",
    servings: 2,
    best_for: inferRecipeBestFor(ingredientPreview, goal),
    batch_prep: inferBatchPrep(ingredientPreview, goal),
    ingredients_list: [
      `Base utilisateur: ${ingredientPreview}`,
      "Une source de protéines claire",
      "Un féculent dosé si utile",
      "Légumes ou fruit selon le plat",
      "Un bon assaisonnement"
    ],
    steps: [
      `Prépare et coupe clairement les ingrédients utiles à partir de: ${ingredientPreview}.`,
      "Saisis la protéine principale 2 à 3 minutes par face ou jusqu'à coloration nette, puis baisse légèrement le feu pour finir la cuisson sans la dessécher.",
      "Ajoute ensuite les légumes les plus fermes d'abord, puis les plus tendres 2 à 3 minutes plus tard pour garder texture et couleur.",
      "Monte le plat avec la base glucidique si besoin, la protéine cuite et les légumes, puis termine par l'assaisonnement hors du feu.",
      "Goûte, ajuste les épices et sers immédiatement pour garder un bon contraste de textures."
    ],
    prep_time: "20 min",
    calories:  kcal,
    protein:   proteinBase + 5,
    carbs:     Math.max(20, Math.round(kcal * 0.4 / 4)),
    fat:       Math.max(10, Math.round(kcal * 0.24 / 9)),
    tips:      "Pèse au moins la source de protéines au début: c'est le plus simple pour garder des macros cohérentes.",
    coach_note:"Utilise cette base comme repas principal simple à tenir même quand tu n'as pas envie de cuisiner longtemps."
  };
}


module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (assertEnv(res)) return;

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
  }

  const limit = checkRateLimit("generate-recipe", getIp(req), 10, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: `Trop de requêtes. Réessayez dans ${limit.retryAfterSec}s.`, requestId });
  }

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", requestId });

  const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const ANON_KEY = pickAnonKey();
  const { GEMINI_API_KEY } = process.env;

  if (!SUPABASE_URL || !ANON_KEY) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_MISCONFIG_SUPABASE",
      message: "Variables manquantes: SUPABASE_URL + SUPABASE_ANON_KEY ou SUPABASE_PUBLISHABLE_KEY.",
      requestId
    });
  }

  // Verify JWT
  const authClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData?.user?.id) {
    return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });
  }

  let rawBody = parseBody(req);
  // Async body fallback — Vercel may not pre-populate req.body for all runtimes
  if (!rawBody.ingredients && !rawBody.message) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) rawBody = JSON.parse(raw);
    } catch { /* keep rawBody as-is */ }
  }
  // Normalize body for Zod (handle legacy field names)
  const normalizedBody = {
    ingredients: String(rawBody.ingredients || rawBody.message || "").trim(),
    goal: String(rawBody.goal || "equilibre").trim(),
    targetKcal: Math.max(100, Math.min(5000, parseInt(rawBody.targetKcal || rawBody.target_kcal || "500") || 500)),
    servings: Math.max(1, Math.min(6, parseInt(rawBody.servings || "2") || 2)),
    recipeStyle: String(rawBody.recipeStyle || rawBody.recipe_style || 'fast').trim()
  };
  const { ok: bodyOk, data: body } = validateBody(RecipeBodySchema, normalizedBody, res);
  if (!bodyOk) return;
  const { ingredients, goal, targetKcal, servings, recipeStyle } = body;

  if (!ingredients) {
    return sendJson(res, 400, {
      ok: false,
      error: "MISSING_INGREDIENTS",
      message: "Le champ 'ingredients' est requis.",
      requestId
    });
  }

  try {
    let recipe;
    let usedFallback = false;

    if (GEMINI_API_KEY) {
      const result = await callGeminiText({
        apiKey: GEMINI_API_KEY,
        prompt: buildRecipePrompt(ingredients, goal, targetKcal, servings, recipeStyle),
        temperature: 0.75,
        maxOutputTokens: 900,
        timeoutMs: GEMINI_TIMEOUT_MS,
        retries: 0,
        mimeType: "application/json"  // forces Gemini to output valid JSON, no code fences
      });

      recipe = validateRecipe(extractJson(result.text));

      if (!recipe) {
        // Gemini responded but JSON was malformed — pure fallback, no raw text exposure
        recipe = fallbackRecipe(ingredients, goal, targetKcal, servings, recipeStyle);
        usedFallback = true;
      }
    } else {
      recipe = fallbackRecipe(ingredients, goal, targetKcal, servings, recipeStyle);
      usedFallback = true;
    }

    return sendJson(res, 200, {
      ok:       true,
      requestId,
      recipe,
      type:     "recipe",
      data:     recipe,      // compatible avec le format /api/coach
      fallback: usedFallback
    });

  } catch (e) {
    const info = normalizeGeminiError(e);
    const recipe = fallbackRecipe(ingredients, goal, targetKcal, servings, recipeStyle);
    recipe.shopping_list = recipe.shopping_list || buildRecipeShoppingList(recipe.ingredients_list || []);
    return sendJson(res, 200, {
      ok:         true,
      requestId,
      recipe,
      type:       "recipe",
      data:       recipe,
      fallback:   true,
      error:      info.message,
      error_code: info.code
    });
  }
};
