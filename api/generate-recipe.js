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

  const recipeTemplate = `{"name":"Nom du plat","healthy_twist":"Pourquoi healthy/protéiné","ingredients_list":["120 g ...","1 ..."],"steps":["Étape 1 détaillée","Étape 2 détaillée","Étape 3"],"prep_time":"15 min","servings":${servings},"best_for":"Contexte d'usage","batch_prep":"Conseil batch","calories":${targetKcal},"protein":35,"carbs":50,"fat":15,"tips":"Conseil technique","coach_note":"Quand la manger"}`;

  const r5 = Array(5).fill(recipeTemplate).join(",");

  if (ideaMode) {
    return `Tu es un chef nutritionniste sportif premium.
L'utilisateur veut: ${cleanRequest}.
Crée 5 versions DIFFÉRENTES de cette idée, toutes healthy et protéinées. Varie : légère, rapide, gourmande, meal-prep, originale.
Objectif: ${goalLabel}. Calories visées: environ ${targetKcal} kcal par portion.
Nombre de portions: ${servings}. Direction produit: ${style.styleHint}.

RÈGLES:
- Les 5 recettes doivent être distinctes (ingrédients, style de cuisson, texture différents).
- Si la demande est plaisir/junk food, transforme chaque version en variante healthy crédible.
- Ingrédients réalistes, faciles à trouver.
- Étapes détaillées et pédagogiques — jamais "cuire" sans préciser comment ni combien de temps.
- Réponds UNIQUEMENT en JSON valide, sans markdown.

FORMAT EXACT:
{"recipes":[${r5}]}`;
  }

  return `Tu es un chef nutritionniste sportif créatif.
Base fournie par l'utilisateur: ${cleanRequest}.
Crée 5 recettes FITNESS ORIGINALES et variées à partir de cette base. Varie les styles : sauté, cuit au four, cru/salade, soupe, wok, grillé.
Objectif: ${goalLabel}, environ ${targetKcal} kcal par portion. Portions: ${servings}.
Direction produit: ${style.styleHint}.

RÈGLES:
- Les 5 recettes doivent être vraiment différentes entre elles (mode de cuisson, profil gustatif).
- Ingrédients disponibles = base principale, complète avec d'autres ingrédients courants.
- Noms de plats spécifiques et appétissants.
- Étapes concrètes: cite l'ingrédient, l'action, l'ordre, le temps ou le repère visuel.
- Réponds UNIQUEMENT en JSON valide, sans texte autour.

FORMAT EXACT:
{"recipes":[${r5}]}`;
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

  if (/pizza/.test(text)) {
    return {
      name: "Pizza maison healthy base légère",
      healthy_twist: "Base fine et croustillante, sauce tomate maison sans sucre ajouté, garnie de légumes et d'une source de protéines maigres.",
      ingredients_list: [
        "1 pâte à pizza fine (ou wrap tortilla grande)",
        "3 cuillères à soupe de sauce tomate nature",
        "1 boule de mozzarella légère (125 g) ou 60 g de mozzarella light",
        "100 g de poulet grillé en lanières (ou thon au naturel)",
        "1/2 poivron rouge en lamelles",
        "1/4 courgette en rondelles fines",
        "1 poignée de roquette (ajoutée après cuisson)",
        "Origan, basilic, poivre noir, filet d'huile d'olive"
      ],
      steps: [
        "Préchauffe le four à 220°C chaleur tournante (ou 240°C conventionnel). Pose la base sur une grille ou plaque huilée.",
        "Étale la sauce tomate sur la base en laissant 2 cm de bord libre. Assaisonne avec origan, poivre et une pincée de sel.",
        "Répartis la mozzarella émiettée en petits morceaux uniformément sur la sauce.",
        "Dispose les lamelles de poulet (ou thon égoutté), les rondelles de courgette et les lamelles de poivron.",
        "Enfourne 10 à 13 minutes: la pâte doit être dorée et croustillante, la mozzarella fondue et légèrement colorée.",
        "Sors du four, ajoute la roquette fraîche, un filet d'huile d'olive et sers immédiatement."
      ],
      prep_time: "20 min",
      servings: s,
      best_for: "Déjeuner ou dîner",
      batch_prep: "Prépare 2 pizzas en même temps et emballe la deuxième pour le lendemain.",
      calories: kcal,
      protein: proteinBase + 8,
      carbs: Math.max(30, Math.round(kcal * 0.42 / 4)),
      fat: Math.max(10, Math.round(kcal * 0.25 / 9)),
      tips: "Pour une base encore plus légère, remplace la pâte par un grand wrap tortilla : croustillant garantit en 8 min au four.",
      coach_note: "Cette pizza couvre bien les macros d'un repas principal tout en restant bien en dessous d'une pizza classique.",
      shopping_list: buildRecipeShoppingList(["1 pâte à pizza fine", "sauce tomate", "mozzarella légère", "100 g de poulet grillé", "poivron", "courgette", "roquette", "huile d'olive"])
    };
  }

  if (/(bowl|buddha|poke)/.test(text)) {
    return {
      name: "Bowl protéiné équilibré",
      healthy_twist: "Un seul bol pour couvrir protéines, glucides complexes et graisses saines en bonne proportion.",
      ingredients_list: [
        "150 g de riz complet ou quinoa cuit",
        "120 g de poulet grillé ou tofu ferme",
        "1/2 avocat en tranches",
        "1 poignée d'épinards ou de roquette",
        "1/4 de concombre en rondelles",
        "1 cuillère à soupe de sauce soja légère",
        "1 cuillère à café de sésame grillé",
        "Jus de citron, gingembre râpé"
      ],
      steps: [
        "Cuis le riz complet ou le quinoa selon le paquet (environ 15-18 min). Assaisonne avec une pointe de sel.",
        "Coupe le poulet en lamelles et fais-le griller 3-4 min par face à feu moyen-vif avec un peu d'huile.",
        "Prépare les légumes : tranche le concombre, coupe l'avocat et rince les feuilles vertes.",
        "Dispose le riz au fond du bol, puis range les ingrédients en zones distinctes par-dessus.",
        "Arrose avec la sauce soja, un trait de jus de citron et saupoudre de sésame grillé."
      ],
      prep_time: "20 min",
      servings: s,
      best_for: "Déjeuner ou repas post-training",
      batch_prep: "Cuis le riz en grande quantité et conserve-le 3 jours au frigo.",
      calories: kcal,
      protein: proteinBase + 5,
      carbs: Math.max(30, Math.round(kcal * 0.45 / 4)),
      fat: Math.max(12, Math.round(kcal * 0.28 / 9)),
      tips: "Ajoute 1 œuf mollet pour encore plus de protéines et de textures.",
      coach_note: "Idéal après l'entraînement pour recharger glycogène et protéines en une fois.",
      shopping_list: buildRecipeShoppingList(["150 g de riz complet", "120 g de poulet", "1/2 avocat", "épinards", "concombre", "sauce soja", "sésame"])
    };
  }

  if (/(burger|sandwich|bagel)/.test(text)) {
    return {
      name: "Burger maison healthy",
      healthy_twist: "Pain complet, steak maison ou galette de légumineuses, légumes frais croquants — le tout sans sauce industrielle.",
      ingredients_list: [
        "2 pains complets ou briochés légers",
        "200 g de bœuf haché 5% ou de dinde hachée",
        "1 tranche de fromage frais ou cheddar light",
        "Laitue, tomate, oignon rouge",
        "1 cuillère à soupe de moutarde",
        "1 cuillère à soupe de fromage blanc (sauce burger maison)",
        "Sel, poivre, ail en poudre"
      ],
      steps: [
        "Mélange la viande hachée avec sel, poivre et ail en poudre. Façonne 2 steaks de même épaisseur (environ 2 cm).",
        "Chauffe une poêle à feu vif sans matière grasse. Saisis les steaks 2-3 min par face pour du rosé, 4 min pour bien cuit.",
        "Prépare la sauce : mélange fromage blanc, moutarde, une pincée de sel et un trait de citron.",
        "Toaste légèrement les pains coupés en deux dans la même poêle 30 secondes côté mie.",
        "Monte le burger : sauce sur la base, laitue, steak, fromage, tomate, oignon, sauce sur le chapeau."
      ],
      prep_time: "15 min",
      servings: s,
      best_for: "Repas principal ou post-training",
      batch_prep: "Prépare les steaks à l'avance et congèle-les crus entre des feuilles de papier sulfurisé.",
      calories: kcal,
      protein: proteinBase + 12,
      carbs: Math.max(25, Math.round(kcal * 0.35 / 4)),
      fat: Math.max(12, Math.round(kcal * 0.28 / 9)),
      tips: "Ne presse pas le steak avec la spatule pendant la cuisson : tu perds le jus et la jutosité.",
      coach_note: "Bien calibré en protéines pour soutenir la récupération musculaire.",
      shopping_list: buildRecipeShoppingList(["200 g de bœuf haché", "2 pains complets", "cheddar light", "laitue", "tomate", "oignon", "fromage blanc"])
    };
  }

  if (/(p[âa]tes?|pasta|spaghetti|rigatoni|tagliatelle|linguine)/.test(text)) {
    return {
      name: "Pâtes protéinées sauce maison",
      healthy_twist: "Pâtes complètes ou lentilles, sauce tomate maison sans sucre, source de protéines maigres bien dosée.",
      ingredients_list: [
        "100 g de pâtes complètes ou de lentilles corail (sec)",
        "120 g de poulet émincé ou thon au naturel",
        "200 g de coulis de tomates nature",
        "1/2 oignon, 1 gousse d'ail",
        "1 poignée d'épinards ou de basilic frais",
        "1 cuillère à café d'huile d'olive",
        "Sel, poivre, origan, flocons de piment"
      ],
      steps: [
        "Cuis les pâtes al dente dans une grande casserole d'eau bouillante salée selon le temps indiqué. Réserve 2 cuillères d'eau de cuisson.",
        "Pendant ce temps, fais revenir l'oignon émincé 3 min à feu moyen dans l'huile d'olive, puis ajoute l'ail 30 secondes.",
        "Ajoute le poulet émincé et cuis-le 5-6 min en remuant jusqu'à coloration.",
        "Verse le coulis, assaisonne avec origan, poivre et piment. Laisse mijoter 5 min à feu doux.",
        "Égoutte les pâtes, ajoute-les à la sauce avec l'eau de cuisson réservée et les épinards. Mélange 1 min hors du feu."
      ],
      prep_time: "22 min",
      servings: s,
      best_for: "Déjeuner ou dîner post-training",
      batch_prep: "Prépare la sauce en double et congèle-la par portions.",
      calories: kcal,
      protein: proteinBase + 6,
      carbs: Math.max(35, Math.round(kcal * 0.48 / 4)),
      fat: Math.max(8, Math.round(kcal * 0.2 / 9)),
      tips: "L'eau de cuisson (amidon) lie la sauce aux pâtes et évite qu'elle sèche.",
      coach_note: "Parfait avant un entraînement le soir : charge en glucides complexes et protéines.",
      shopping_list: buildRecipeShoppingList(["100 g de pâtes complètes", "120 g de poulet émincé", "200 g de coulis de tomates", "oignon", "ail", "épinards", "huile d'olive"])
    };
  }

  if (/(salade|salad)/.test(text)) {
    return {
      name: "Salade repas complète et rassasiante",
      healthy_twist: "Une vraie salade-repas avec protéines, bons glucides et graisses saines — pas juste de la laitue.",
      ingredients_list: [
        "100 g de quinoa cuit ou pois chiches",
        "120 g de poulet grillé ou œufs durs",
        "Laitue romaine ou épinards frais",
        "1/4 de concombre, 10 tomates cerises",
        "1/4 d'avocat",
        "30 g de feta légère émiettée",
        "1 cuillère à soupe d'huile d'olive + citron (vinaigrette)",
        "Herbes fraîches : persil, ciboulette"
      ],
      steps: [
        "Cuis le quinoa (15 min eau bouillante) ou rince des pois chiches en boîte. Laisse refroidir.",
        "Grille le poulet avec sel, poivre et herbes, 3-4 min par face. Laisse reposer 2 min avant de trancher.",
        "Lave et essore les feuilles, coupe concombre et tomates, tranche l'avocat.",
        "Prépare la vinaigrette : mélange huile d'olive, jus de citron, sel, poivre et une pincée d'origan.",
        "Assemble dans un grand bol : feuilles, quinoa, poulet, légumes, avocat, feta. Arrose de vinaigrette juste avant de servir."
      ],
      prep_time: "18 min",
      servings: s,
      best_for: "Déjeuner ou repas léger du soir",
      batch_prep: "Prépare les composants séparément et assemble au moment de manger.",
      calories: kcal,
      protein: proteinBase + 4,
      carbs: Math.max(20, Math.round(kcal * 0.35 / 4)),
      fat: Math.max(12, Math.round(kcal * 0.3 / 9)),
      tips: "Ne mets la vinaigrette qu'au moment de manger pour éviter que les feuilles ramollissent.",
      coach_note: "Idéale en déjeuner pour rester alerte l'après-midi sans coup de fatigue.",
      shopping_list: buildRecipeShoppingList(["100 g de quinoa", "120 g de poulet grillé", "laitue romaine", "concombre", "tomates cerises", "avocat", "feta", "huile d'olive"])
    };
  }

  if (/(omelette|frittata|oeuf|œuf)/.test(text)) {
    return {
      name: "Omelette protéinée aux légumes",
      healthy_twist: "Riche en protéines, sans glucides superflus et cuisson sèche pour limiter les graisses ajoutées.",
      ingredients_list: [
        "3 œufs entiers + 2 blancs d'œufs",
        "1/2 poivron, 1/4 d'oignon, 1 poignée d'épinards",
        "30 g de fromage de chèvre ou feta émiettée",
        "Sel, poivre, paprika, herbes de Provence",
        "Spray cuisson ou 1/2 cuillère à café d'huile"
      ],
      steps: [
        "Fouette les œufs et les blancs avec sel, poivre et une pincée de paprika. Réserve.",
        "Fais revenir l'oignon et le poivron en brunoise 3 min à feu moyen dans une poêle légèrement huilée.",
        "Ajoute les épinards frais et remue 1 min jusqu'à ce qu'ils tombent. Retire les légumes de la poêle.",
        "Verse les œufs dans la poêle chaude à feu moyen-doux. Laisse prendre 2 min sans remuer, puis soulève les bords pour laisser couler l'œuf cru dessous.",
        "Ajoute les légumes et le fromage sur une moitié, plie l'omelette et laisse encore 30 secondes. Sers immédiatement."
      ],
      prep_time: "10 min",
      servings: s,
      best_for: "Petit-déjeuner, déjeuner express ou dîner léger",
      batch_prep: "Prépare les légumes en avance et cuis les œufs au moment.",
      calories: kcal,
      protein: proteinBase + 14,
      carbs: Math.max(5, Math.round(kcal * 0.1 / 4)),
      fat: Math.max(10, Math.round(kcal * 0.35 / 9)),
      tips: "Feu moyen-doux uniquement : une omelette sur feu vif devient caoutchouteuse.",
      coach_note: "Un des repas les plus rapides et les plus efficaces en protéines.",
      shopping_list: buildRecipeShoppingList(["3 œufs entiers", "2 blancs d'œufs", "poivron", "oignon", "épinards", "fromage de chèvre"])
    };
  }

  if (/(wrap|tacos?|burrito|quesadilla)/.test(text)) {
    return {
      name: "Wrap protéiné maison",
      healthy_twist: "Tortilla complète, garniture fraîche et sauce légère maison — sans sauce industrielle grasse.",
      ingredients_list: [
        "2 tortillas complètes (blé complet ou maïs)",
        "120 g de poulet grillé émincé",
        "1/4 d'avocat",
        "2 cuillères à soupe de fromage blanc + épices (sauce)",
        "Laitue iceberg, tomate, oignon rouge",
        "Jus de citron vert, cumin, paprika fumé"
      ],
      steps: [
        "Assaisonne le poulet avec cumin, paprika, sel et poivre. Fais-le griller 3-4 min par face.",
        "Prépare la sauce : mélange fromage blanc, jus de citron vert, une pincée de cumin et paprika.",
        "Écrase légèrement l'avocat avec sel, jus de citron et poivre.",
        "Réchauffe les tortillas 30 secondes côté par côté dans une poêle sèche.",
        "Étale la sauce sur chaque tortilla, ajoute laitue, poulet émincé, avocat, tomate et oignon. Roule fermement."
      ],
      prep_time: "15 min",
      servings: s,
      best_for: "Déjeuner ou repas rapide",
      batch_prep: "Prépare le poulet en avance pour assembler le wrap en 5 min.",
      calories: kcal,
      protein: proteinBase + 8,
      carbs: Math.max(25, Math.round(kcal * 0.4 / 4)),
      fat: Math.max(12, Math.round(kcal * 0.27 / 9)),
      tips: "Enroule dans du papier alu pour manger facilement sans tout faire tomber.",
      coach_note: "Pratique à emporter au travail ou en compétition.",
      shopping_list: buildRecipeShoppingList(["2 tortillas complètes", "120 g de poulet grillé", "avocat", "fromage blanc", "laitue", "tomate", "oignon rouge"])
    };
  }

  if (/(risotto)/.test(text)) {
    return {
      name: "Risotto léger poulet et légumes",
      healthy_twist: "Riz arborio en quantité maîtrisée, bouillon maison à la place de la crème, parmesan dosé.",
      ingredients_list: [
        "100 g de riz arborio",
        "120 g de poulet en dés",
        "400 ml de bouillon de légumes chaud",
        "1/2 oignon, 1 gousse d'ail",
        "1 poignée de petits pois ou épinards",
        "20 g de parmesan râpé",
        "1 cuillère à café d'huile d'olive, sel, poivre"
      ],
      steps: [
        "Fais revenir l'oignon et l'ail dans l'huile à feu moyen 2 min. Ajoute le poulet et dore-le 3 min.",
        "Ajoute le riz et nacre-le 1 min en remuant jusqu'à ce qu'il soit légèrement translucide.",
        "Ajoute le bouillon chaud louche par louche en remuant constamment — attends que chaque louche soit absorbée avant d'ajouter la suivante.",
        "Après 16-18 min, le riz doit être al dente et crémeux. Ajoute petits pois ou épinards 2 min avant la fin.",
        "Hors du feu, incorpore le parmesan, goûte et ajuste l'assaisonnement. Sers immédiatement."
      ],
      prep_time: "25 min",
      servings: s,
      best_for: "Dîner ou déjeuner",
      batch_prep: "Le risotto se réchauffe avec un peu de bouillon ajouté.",
      calories: kcal,
      protein: proteinBase + 4,
      carbs: Math.max(35, Math.round(kcal * 0.48 / 4)),
      fat: Math.max(8, Math.round(kcal * 0.2 / 9)),
      tips: "Le secret c'est le bouillon chaud et le remuage continu : ne jamais verser du bouillon froid.",
      coach_note: "Riche en glucides complexes, idéal la veille d'une grosse séance.",
      shopping_list: buildRecipeShoppingList(["100 g de riz arborio", "120 g de poulet", "bouillon de légumes", "oignon", "petits pois", "parmesan"])
    };
  }

  if (/(soupe|veloute|bouillon|potage)/.test(text)) {
    return {
      name: "Soupe veloutée légume-protéine",
      healthy_twist: "Soupe maison sans crème ni beurre — juste légumes, bouillon et une source de protéines pour rassasier.",
      ingredients_list: [
        "3 carottes ou 1 patate douce",
        "1 oignon, 1 gousse d'ail",
        "500 ml de bouillon de légumes",
        "100 g de lentilles corail ou 100 g de poulet cuit",
        "1 cuillère à café de cumin, curcuma",
        "Sel, poivre, persil frais"
      ],
      steps: [
        "Épluche et coupe les légumes en dés. Fais revenir l'oignon et l'ail 3 min dans une casserole avec un peu d'huile.",
        "Ajoute les légumes et les épices, remue 2 min pour bien enrober.",
        "Verse le bouillon chaud, ajoute les lentilles corail. Porte à ébullition puis laisse mijoter 18-20 min.",
        "Mixe la soupe à l'aide d'un mixeur plongeant jusqu'à obtenir un velouté lisse.",
        "Ajuste la consistance avec un peu d'eau si trop épaisse, assaisonne et sers avec persil frais."
      ],
      prep_time: "25 min",
      servings: s,
      best_for: "Entrée ou dîner léger",
      batch_prep: "Se conserve 4 jours au frigo et se congèle très bien.",
      calories: kcal,
      protein: proteinBase,
      carbs: Math.max(20, Math.round(kcal * 0.42 / 4)),
      fat: Math.max(5, Math.round(kcal * 0.15 / 9)),
      tips: "Ajoute une cuillère de skyr ou fromage blanc au moment de servir pour un velouté plus riche sans matières grasses.",
      coach_note: "Parfait en dîner léger les jours de repos.",
      shopping_list: buildRecipeShoppingList(["3 carottes", "1 oignon", "bouillon de légumes", "lentilles corail", "cumin", "curcuma"])
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

    let recipes = null;

    if (GEMINI_API_KEY) {
      const result = await callGeminiText({
        apiKey: GEMINI_API_KEY,
        prompt: buildRecipePrompt(ingredients, goal, targetKcal, servings, recipeStyle),
        temperature: 0.75,
        maxOutputTokens: 4000,
        timeoutMs: GEMINI_TIMEOUT_MS,
        retries: 0,
        mimeType: "application/json"
      });

      const parsed = extractJson(result.text);
      if (parsed && Array.isArray(parsed.recipes) && parsed.recipes.length) {
        recipes = parsed.recipes.map(validateRecipe).filter(Boolean).slice(0, 5);
      } else if (parsed) {
        const single = validateRecipe(parsed);
        if (single) recipes = [single];
      }
    }

    if (!recipes || !recipes.length) {
      recipes = [fallbackRecipe(ingredients, goal, targetKcal, servings, recipeStyle)];
      usedFallback = true;
    }

    recipe = recipes[0];

    return sendJson(res, 200, {
      ok:       true,
      requestId,
      recipes,               // array of up to 3 recipes
      recipe,                // backward compat: first recipe
      type:     "recipe",
      data:     recipe,      // backward compat
      fallback: usedFallback
    });

  } catch (e) {
    const info = normalizeGeminiError(e);
    const recipe = fallbackRecipe(ingredients, goal, targetKcal, servings, recipeStyle);
    recipe.shopping_list = recipe.shopping_list || buildRecipeShoppingList(recipe.ingredients_list || []);
    return sendJson(res, 200, {
      ok:         true,
      requestId,
      recipes:    [recipe],
      recipe,
      type:       "recipe",
      data:       recipe,
      fallback:   true,
      error:      info.message,
      error_code: info.code
    });
  }
};
