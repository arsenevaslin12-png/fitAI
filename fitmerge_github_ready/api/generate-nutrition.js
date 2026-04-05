"use strict";

function getCreateClient() {
  try {
    const mod = require("@supabase/supabase-js");
    return typeof mod.createClient === "function" ? mod.createClient : null;
  } catch {
    return null;
  }
}

const {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  extractJson,
  callGeminiText,
  normalizeGeminiError
} = require("./_gemini");

const GEMINI_TIMEOUT_MS = 15000;
const rateLimitBuckets = new Map();

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

function getIp(req) {
  const xfwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xfwd || req.socket?.remoteAddress || "unknown";
}

function checkRateLimit(bucket, key, limit = 10, windowMs = 60_000) {
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
  return { ok: true };
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

function sanitizeValue(value, fallback = "") {
  return String(value == null ? fallback : value)
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeArray(input, maxItems = 6) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => sanitizeValue(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeGoal(value) {
  const v = sanitizeValue(value, "maintenance").toLowerCase();
  if (["perte_de_poids", "cut", "seche", "sèche"].includes(v)) return "perte_de_poids";
  if (["prise_de_masse", "bulk", "masse"].includes(v)) return "prise_de_masse";
  return "maintenance";
}

function normalizeActivity(value) {
  const v = sanitizeValue(value, "moderate").toLowerCase();
  if (["low", "faible"].includes(v)) return "low";
  if (["high", "elevee", "élevée"].includes(v)) return "high";
  return "moderate";
}

function normalizeDayType(value, activityLevel = "moderate") {
  const v = sanitizeValue(value, "").toLowerCase();
  if (["rest", "repos", "off"].includes(v)) return "rest";
  if (["training", "entrainement", "entraînement", "workout"].includes(v)) return "training";
  return activityLevel === "low" ? "rest" : "training";
}

function clamp(num, min, max) {
  const value = Number(num);
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function roundToFive(value) {
  return Math.round(Number(value || 0) / 5) * 5;
}

function goalLabel(goal) {
  return {
    perte_de_poids: "perte de poids",
    maintenance: "maintien",
    prise_de_masse: "prise de masse"
  }[goal] || "maintien";
}

function dayTypeLabel(dayType) {
  return dayType === "rest" ? "jour de repos" : "jour d'entraînement";
}

function objectiveSummary(goal, dayType) {
  if (goal === "perte_de_poids") {
    return dayType === "training"
      ? "Déficit raisonnable, protéines hautes et glucides concentrés autour de la séance."
      : "Déficit maîtrisé, faim sous contrôle et volume alimentaire intelligent.";
  }
  if (goal === "prise_de_masse") {
    return dayType === "training"
      ? "Plus d'énergie autour de l'entraînement pour performer et récupérer sans lourdeur."
      : "Surplus propre, digestion fluide et protéines régulières sur la journée.";
  }
  return dayType === "training"
    ? "Équilibre performance/récupération avec des glucides utiles au bon moment."
    : "Journée stable pour maintenir le niveau sans surcharger l'appétit.";
}

function coachNote(goal, dayType) {
  if (goal === "perte_de_poids") {
    return dayType === "training"
      ? "Garde les glucides surtout avant et après la séance, puis mise sur légumes + protéines le reste du temps."
      : "Sur un jour calme, sécurise ta satiété avec légumes, protéines et portions simples à répéter.";
  }
  if (goal === "prise_de_masse") {
    return dayType === "training"
      ? "Ajoute une portion de glucides faciles avant ou après l'entraînement si l'énergie baisse."
      : "Ne saute pas la collation: elle fait souvent la différence pour tenir le surplus sans inconfort.";
  }
  return dayType === "training"
    ? "Le plus rentable: protéines régulières, fibres, et glucides placés là où ils servent vraiment."
    : "Reste simple et régulier: pas besoin de manger plus juste parce que le plan est propre.";
}

function buildMacroTargets(weight = 75, goal = "maintenance", activity = "moderate", dayType = "training") {
  const safeWeight = clamp(weight || 75, 45, 160);
  const activityFactor = activity === "high" ? 34 : activity === "low" ? 28 : 31;
  const baseCalories = Math.round(safeWeight * activityFactor);
  const trainingAdjustment = dayType === "training" ? 140 : -80;
  const goalAdjustment = goal === "perte_de_poids" ? -350 : goal === "prise_de_masse" ? 260 : 0;
  const calories = roundToFive(clamp(baseCalories + goalAdjustment + trainingAdjustment, 1400, 4200));
  const proteinPerKg = goal === "perte_de_poids" ? 2.05 : goal === "prise_de_masse" ? 1.9 : 1.8;
  const fatPerKg = goal === "prise_de_masse" ? 0.95 : 0.85;
  const protein = roundToFive(clamp(safeWeight * proteinPerKg, 90, 260));
  const fats = roundToFive(clamp(safeWeight * fatPerKg, 45, 120));
  const carbs = roundToFive(clamp((calories - (protein * 4 + fats * 9)) / 4, 110, 520));
  return {
    calories,
    protein,
    carbs,
    fats,
    notes: objectiveSummary(goal, dayType)
  };
}

function hashSeed(...parts) {
  const text = parts.map((part) => String(part || "")).join("|");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 2147483647;
  return hash || 17;
}

function pickVariant(variants, seed, offset = 0) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return null;
  return list[(seed + offset) % list.length];
}

function portion(value, pct) {
  return Math.max(110, Math.round(value * pct));
}

function proteinPortion(value, pct) {
  return Math.max(18, Math.round(value * pct));
}

function makeMeal(name, time, calories, protein, items, extra = {}) {
  return {
    name,
    time,
    calories,
    protein,
    items: sanitizeArray(items, 7),
    focus: sanitizeValue(extra.focus || ""),
    swap_options: sanitizeArray(extra.swap_options || [], 4),
    coach_tip: sanitizeValue(extra.coach_tip || "")
  };
}

function groceryCategoryFor(label) {
  const item = sanitizeValue(label).toLowerCase();
  if (!item) return null;
  if (/(poulet|dinde|boeuf|steak|saumon|thon|poisson|oeuf|tofu|tempeh|skyr|yaourt|fromage blanc|whey|shake|lait|truite)/.test(item)) return "Protéines";
  if (/(riz|pomme de terre|quinoa|pâtes|semoule|pain|avoine|granola|galettes|crackers|muesli|féculent)/.test(item)) return "Glucides utiles";
  if (/(banane|pomme|poire|kiwi|orange|fruits rouges|fruit|légumes|brocoli|salade|courgette|haricots|avocat|compote)/.test(item)) return "Fruits & légumes";
  if (/(huile|amande|amandes|noix|graines|beurre d'amande|chocolat|olive)/.test(item)) return "Extras intelligents";
  if (/(yaourt|skyr|fromage blanc|lait)/.test(item)) return "Laitages";
  return "Bases";
}

function qtyHintFor(label) {
  const item = sanitizeValue(label).toLowerCase();
  if (/(oeuf|oeufs)/.test(item)) return "6 à 12";
  if (/(poulet|dinde|boeuf|saumon|poisson|tofu|tempeh)/.test(item)) return "2 à 3 portions";
  if (/(riz|pâtes|quinoa|semoule|avoine|granola)/.test(item)) return "1 sachet / 500 g";
  if (/(pomme de terre)/.test(item)) return "1 à 2 kg";
  if (/(skyr|yaourt|fromage blanc)/.test(item)) return "2 à 4 pots";
  if (/(fruit|banane|pomme|poire|kiwi|orange|fruits rouges|avocat)/.test(item)) return "4 à 8 unités";
  if (/(légumes|brocoli|salade|courgette|haricots)/.test(item)) return "2 à 4 portions";
  if (/(huile|amandes|noix|graines|beurre d'amande)/.test(item)) return "1 paquet / 1 flacon";
  return "1 à 2 unités";
}

function buildShoppingListFromMeals(meals, substitutions = [], goal = "maintenance", dayType = "training") {
  const bucket = new Map();
  const add = (entry) => {
    const name = sanitizeValue(entry);
    if (!name) return;
    const key = name.toLowerCase();
    if (!bucket.has(key)) {
      bucket.set(key, {
        name,
        category: groceryCategoryFor(name) || "Bases",
        qty: qtyHintFor(name)
      });
    }
  };
  (Array.isArray(meals) ? meals : []).forEach((meal) => {
    sanitizeArray(meal?.items || [], 8).forEach(add);
    sanitizeArray(meal?.swap_options || [], 4).forEach((swap) => add(String(swap).split(/[↔>/]/)[0]));
  });
  sanitizeArray(substitutions || [], 6).forEach((swap) => add(String(swap).split(/[↔>/]/)[0]));
  const categories = ["Protéines", "Glucides utiles", "Fruits & légumes", "Laitages", "Extras intelligents", "Bases"]
    .map((label) => ({
      title: label,
      items: [...bucket.values()].filter((item) => item.category === label).slice(0, 8)
    }))
    .filter((group) => group.items.length);
  return {
    title: dayType === "training" ? "Liste de courses — journée entraînement" : "Liste de courses — journée repos",
    prep_tips: [
      goal === "prise_de_masse"
        ? "Pré-cuis 2 bases glucidiques pour ne pas louper le surplus les jours chargés."
        : goal === "perte_de_poids"
          ? "Commence par les protéines et les légumes: c'est ce qui rend le plan facile à tenir."
          : "Prépare 1 protéine, 1 féculent et 1 légume d'avance pour simplifier toute la journée.",
      dayType === "training"
        ? "Garde la collation et la boisson à portée pour mieux placer l'énergie autour de la séance."
        : "Sur jour calme, vise surtout une cuisine simple et répétable pour limiter les écarts."
    ],
    quick_swaps: sanitizeArray(substitutions || [], 5),
    categories
  };
}

function normalizeShoppingList(raw, fallback) {
  if (!raw || typeof raw !== "object") return fallback;
  const categories = Array.isArray(raw.categories) ? raw.categories.slice(0, 6).map((group) => ({
    title: sanitizeValue(group.title || group.name || "Courses"),
    items: (Array.isArray(group.items) ? group.items : []).slice(0, 10).map((item) => {
      if (item && typeof item === 'object') {
        return { name: sanitizeValue(item.name || item.label || ""), qty: sanitizeValue(item.qty || item.quantity || "") };
      }
      const name = sanitizeValue(item);
      return { name, qty: qtyHintFor(name) };
    }).filter((item) => item.name)
  })).filter((group) => group.title && group.items.length) : [];
  return {
    title: sanitizeValue(raw.title, fallback.title) || fallback.title,
    prep_tips: sanitizeArray(raw.prep_tips, 4).length ? sanitizeArray(raw.prep_tips, 4) : fallback.prep_tips,
    quick_swaps: sanitizeArray(raw.quick_swaps, 5).length ? sanitizeArray(raw.quick_swaps, 5) : fallback.quick_swaps,
    categories: categories.length ? categories : fallback.categories
  };
}

function buildMealVariants(nutrition, goal, dayType) {
  const isCut = goal === "perte_de_poids";
  const isBulk = goal === "prise_de_masse";
  const training = dayType === "training";
  return {
    breakfast: [
      makeMeal(
        "Petit déjeuner",
        "07:30",
        portion(nutrition.calories, isBulk ? 0.24 : 0.22),
        proteinPortion(nutrition.protein, 0.24),
        training
          ? ["Skyr ou fromage blanc", "Flocons d'avoine", "Banane ou fruits rouges", "Beurre d'amande en petite portion"]
          : ["Omelette 3 oeufs ou tofu brouillé", "Pain complet", "Fruit", "Yaourt nature"],
        {
          focus: training ? "énergie stable" : "satiété",
          swap_options: ["Avoine ↔ pain complet", "Skyr ↔ yaourt grec 0%", "Banane ↔ kiwi ou pomme"],
          coach_tip: training ? "Garde ce repas 90 à 150 min avant la séance si tu t'entraînes tôt." : "Sur jour de repos, privilégie une portion de fruit et garde les glucides simples bas."
        }
      ),
      makeMeal(
        "Petit déjeuner",
        "08:00",
        portion(nutrition.calories, isBulk ? 0.25 : 0.21),
        proteinPortion(nutrition.protein, 0.23),
        ["Porridge protéiné", "Whey ou skyr", "Poire ou banane", "Noix ou graines"],
        {
          focus: "routine simple",
          swap_options: ["Porridge ↔ muesli sans sucre", "Whey ↔ 2 oeufs + yaourt", "Poire ↔ fruits rouges"],
          coach_tip: "Prépare les ingrédients la veille pour garder une routine facile à tenir."
        }
      )
    ],
    lunch: [
      makeMeal(
        "Déjeuner",
        "12:30",
        portion(nutrition.calories, 0.33),
        proteinPortion(nutrition.protein, 0.31),
        isCut
          ? ["Poulet grillé ou tofu ferme", "Riz basmati en portion modérée", "Légumes croquants", "Huile d'olive ou avocat"]
          : ["Poulet, dinde ou boeuf 5%", "Riz ou pommes de terre", "Légumes", "Huile d'olive"],
        {
          focus: training ? "repas pivot" : "repas principal",
          swap_options: ["Poulet ↔ thon ou tempeh", "Riz ↔ pommes de terre", "Huile d'olive ↔ avocat"],
          coach_tip: training ? "Si la séance est l'après-midi, garde ici la plus grosse portion de glucides." : "Conserve une grosse assiette de légumes pour mieux contrôler la faim ensuite."
        }
      ),
      makeMeal(
        "Déjeuner",
        "13:00",
        portion(nutrition.calories, 0.34),
        proteinPortion(nutrition.protein, 0.32),
        ["Bowl saumon ou steak 5%", "Quinoa ou pâtes complètes", "Légumes rôtis", "Sauce yaourt citron"],
        {
          focus: "performance",
          swap_options: ["Saumon ↔ truite ou oeufs", "Quinoa ↔ semoule ou riz", "Sauce yaourt ↔ fromage blanc herbes"],
          coach_tip: "Garde une source de protéines facile à mesurer pour rester cohérent toute la semaine."
        }
      )
    ],
    snack: [
      makeMeal(
        "Collation",
        training ? "16:30" : "17:00",
        portion(nutrition.calories, isBulk ? 0.16 : 0.12),
        proteinPortion(nutrition.protein, 0.16),
        isBulk
          ? ["Skyr ou shake protéiné", "Fruit", "Galettes de riz ou pain de mie complet"]
          : ["Skyr ou yaourt grec", "Fruit", "Quelques amandes ou noix"],
        {
          focus: training ? "pré/post séance" : "anti-fringale",
          swap_options: ["Skyr ↔ whey + lait", "Fruit ↔ compote sans sucre", "Galettes de riz ↔ crackers complets"],
          coach_tip: training ? "Parfait juste après l'entraînement si le dîner n'arrive pas vite." : "Si tu n'as pas faim, garde seulement la base protéinée."
        }
      ),
      makeMeal(
        "Collation",
        training ? "17:00" : "16:00",
        portion(nutrition.calories, isBulk ? 0.17 : 0.13),
        proteinPortion(nutrition.protein, 0.17),
        ["Fromage blanc ou pudding protéiné", "Fruit", isBulk ? "Granola simple" : "Carrés de chocolat noir ou graines"],
        {
          focus: "régularité",
          swap_options: ["Fromage blanc ↔ yaourt grec", "Granola ↔ flocons d'avoine", "Fruit ↔ raisins ou banane"],
          coach_tip: "Choisis une collation que tu peux emmener partout: la meilleure stratégie est celle que tu tiens vraiment."
        }
      )
    ],
    dinner: [
      makeMeal(
        "Dîner",
        "20:00",
        portion(nutrition.calories, isBulk ? 0.27 : 0.31),
        proteinPortion(nutrition.protein, 0.29),
        training
          ? ["Poisson, steak 5% ou tofu", isCut ? "Pommes de terre rôties en portion modérée" : "Riz, pâtes ou pommes de terre", "Légumes cuits", "Sauce simple maison"]
          : ["Poisson ou oeufs", "Légumes cuits", isCut ? "Légumineuses ou petite portion de féculents" : "Féculents selon faim"],
        {
          focus: training ? "récupération" : "léger mais rassasiant",
          swap_options: ["Poisson ↔ omelette ou tofu", "Pommes de terre ↔ semoule ou riz", "Sauce maison ↔ huile d'olive + citron"],
          coach_tip: training ? "Si la séance était tardive, garde ici une vraie portion de glucides pour mieux récupérer." : "Sur repos, privilégie un dîner simple qui t'évite de grignoter ensuite."
        }
      ),
      makeMeal(
        "Dîner",
        "19:45",
        portion(nutrition.calories, isBulk ? 0.28 : 0.29),
        proteinPortion(nutrition.protein, 0.28),
        ["Assiette chaude protéines + légumes", training && !isCut ? "Semoule ou pâtes en portion utile" : "Féculent modéré", "Yaourt ou fruit si besoin"],
        {
          focus: "soirée maîtrisée",
          swap_options: ["Semoule ↔ riz", "Yaourt ↔ compote sans sucre", "Fruit ↔ kiwi ou orange"],
          coach_tip: "Le dîner n'a pas besoin d'être compliqué: vise 1 protéine, 1 volume de légumes, 1 glucide dosé."
        }
      )
    ]
  };
}

function buildFallbackPlan(nutrition, goal = "maintenance", activity = "moderate", dayType = "training", weight = 75) {
  const seed = hashSeed(goal, activity, dayType, weight, nutrition.calories);
  const variants = buildMealVariants(nutrition, goal, dayType);
  const planMeals = [
    pickVariant(variants.breakfast, seed, 0),
    pickVariant(variants.lunch, seed, 1),
    pickVariant(variants.snack, seed, 2),
    pickVariant(variants.dinner, seed, 3)
  ].filter(Boolean);

  const shoppingList = buildShoppingListFromMeals(planMeals, [
    "Poulet ↔ dinde, thon, tofu ferme ou tempeh.",
    "Riz ↔ pommes de terre, semoule, pâtes complètes ou quinoa.",
    "Skyr / yaourt grec ↔ fromage blanc 0% ou shake protéiné.",
    "Fruits rouges ↔ banane, pomme, kiwi selon la saison et le budget."
  ], goal, dayType);

  return {
    title: "Plan nutrition du jour",
    day_type: dayType,
    summary: objectiveSummary(goal, dayType),
    hydration_liters: Number((goal === "prise_de_masse" ? 2.9 : goal === "perte_de_poids" ? 2.5 : 2.4) + (activity === "high" ? 0.3 : 0)).toFixed(1),
    coach_note: coachNote(goal, dayType),
    training_note: dayType === "training"
      ? "Pense à placer la majorité de tes glucides autour de l'entraînement pour garder du jus et mieux récupérer."
      : "Jour plus calme: garde les protéines hautes et allège un peu les glucides si l'appétit est bas.",
    meals: planMeals,
    tips: [
      goal === "perte_de_poids"
        ? "Commence chaque repas par la protéine et les légumes pour contrôler la faim sans te sentir puni."
        : goal === "prise_de_masse"
          ? "Ajoute facilement des calories avec huile d'olive, pain, fruits secs ou une boisson lactée autour des repas."
          : "Répète 2 à 3 repas simples dans la semaine: la régularité vaut plus qu'un plan parfait mais intenable.",
      dayType === "training"
        ? "Évite d'arriver à la séance complètement à jeun si tes performances chutent."
        : "Sur jour de repos, garde une routine hydratation + marche légère pour aider la récupération.",
      "Prépare une base d'avance: protéine cuite + féculent + légumes. Tu simplifies 80 % de tes décisions."
    ],
    substitutions: [
      "Poulet ↔ dinde, thon, tofu ferme ou tempeh.",
      "Riz ↔ pommes de terre, semoule, pâtes complètes ou quinoa.",
      "Skyr / yaourt grec ↔ fromage blanc 0% ou shake protéiné.",
      "Fruits rouges ↔ banane, pomme, kiwi selon la saison et le budget."
    ],
    shopping_list: shoppingList,
    meal_prep: buildMealPrepPlan(planMeals, goal, dayType),
    notes: `${objectiveSummary(goal, dayType)} ${coachNote(goal, dayType)}`
  };
}

function validateNutrition(raw, goal, dayType) {
  const source = raw && typeof raw === "object"
    ? (raw.nutrition && typeof raw.nutrition === "object" ? raw.nutrition : raw)
    : null;
  if (!source) return null;
  return {
    calories: roundToFive(clamp(source.calories, 1200, 4500)),
    protein: roundToFive(clamp(source.protein, 70, 320)),
    carbs: roundToFive(clamp(source.carbs, 50, 550)),
    fats: roundToFive(clamp(source.fats, 30, 180)),
    notes: sanitizeValue(source.notes, objectiveSummary(goal, dayType)) || objectiveSummary(goal, dayType)
  };
}

function normalizeMeal(meal, idx, nutrition, fallbackPlan) {
  const fallback = fallbackPlan.meals[idx] || fallbackPlan.meals[0];
  if (!meal || typeof meal !== "object") return fallback;
  return {
    name: sanitizeValue(meal.name, fallback.name),
    time: sanitizeValue(meal.time, fallback.time),
    calories: Math.round(clamp(meal.calories, 120, 1600)),
    protein: Math.round(clamp(meal.protein, 10, 90)),
    items: sanitizeArray(meal.items, 7).length ? sanitizeArray(meal.items, 7) : fallback.items,
    focus: sanitizeValue(meal.focus, fallback.focus || ""),
    swap_options: sanitizeArray(meal.swap_options, 4).length ? sanitizeArray(meal.swap_options, 4) : (fallback.swap_options || []),
    coach_tip: sanitizeValue(meal.coach_tip, fallback.coach_tip || "")
  };
}

function buildMealPrepPlan(meals, goal = "maintenance", dayType = "training") {
  const proteins = [];
  const carbs = [];
  const veg = [];
  (Array.isArray(meals) ? meals : []).forEach((meal) => {
    (Array.isArray(meal.items) ? meal.items : []).forEach((item) => {
      const t = String(item || "").toLowerCase();
      if (/(poulet|dinde|boeuf|thon|saumon|oeuf|skyr|fromage blanc|tofu|tempeh|whey)/.test(t)) proteins.push(item);
      else if (/(riz|quinoa|semoule|p[âa]tes|pommes de terre|avoine|pain)/.test(t)) carbs.push(item);
      else if (/(brocoli|courgette|salade|légumes|haricots|tomate|fruit|banane|pomme|kiwi)/.test(t)) veg.push(item);
    });
  });
  const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
  return {
    title: "Meal prep express",
    batch_cook: [
      proteins.length ? `Cuire 2 à 3 portions de ${uniq(proteins).slice(0,2).join(' / ')} en avance.` : "Prépare une base protéinée simple à l'avance.",
      carbs.length ? `Préparer une base de ${uniq(carbs).slice(0,2).join(' / ')} pour 2 repas.` : "Prépare un glucide simple dosable pour la journée.",
      veg.length ? `Laver / couper ${uniq(veg).slice(0,2).join(' / ')} pour réduire la friction.` : "Prépare légumes ou fruits à portée de main."
    ],
    packing_tips: [
      dayType === 'training' ? "Garde une collation protéinée facile à emporter autour de la séance." : "Prévois un repas simple et rassasiant pour éviter le grignotage.",
      goal === 'prise_de_masse' ? "Ajoute un extra calorique simple : huile d'olive, pain, fruits secs ou laitage." : goal === 'perte_de_poids' ? "Mets d'abord la protéine et le volume (légumes/fruits) dans la box." : "Dose les portions une fois, puis évite de renégocier chaque repas."
    ],
    containers: [
      "1 box protéine + glucide pour le repas principal",
      "1 collation rapide prête à attraper",
      "1 bouteille d'eau déjà préparée"
    ]
  };
}

function validatePlan(raw, nutrition, goal, activity, dayType, weight) {

  const fallback = buildFallbackPlan(nutrition, goal, activity, dayType, weight);
  const candidate = raw && typeof raw === "object"
    ? (raw.plan && typeof raw.plan === "object" ? raw.plan : raw)
    : {};
  const rawMeals = Array.isArray(candidate.meals) ? candidate.meals.slice(0, 5) : [];
  const plan = {
    title: sanitizeValue(candidate.title, "Plan nutrition du jour") || "Plan nutrition du jour",
    day_type: normalizeDayType(candidate.day_type || dayType, activity),
    summary: sanitizeValue(candidate.summary, fallback.summary) || fallback.summary,
    hydration_liters: Number.isFinite(Number(candidate.hydration_liters))
      ? clamp(Number(candidate.hydration_liters), 1.7, 4.2)
      : Number(fallback.hydration_liters),
    coach_note: sanitizeValue(candidate.coach_note, fallback.coach_note) || fallback.coach_note,
    training_note: sanitizeValue(candidate.training_note, fallback.training_note) || fallback.training_note,
    tips: sanitizeArray(candidate.tips, 5).length ? sanitizeArray(candidate.tips, 5) : fallback.tips,
    substitutions: sanitizeArray(candidate.substitutions, 5).length ? sanitizeArray(candidate.substitutions, 5) : fallback.substitutions,
    notes: sanitizeValue(candidate.notes, nutrition.notes) || nutrition.notes,
    meals: rawMeals.map((meal, idx) => normalizeMeal(meal, idx, nutrition, fallback))
  };
  plan.shopping_list = normalizeShoppingList(candidate.shopping_list, buildShoppingListFromMeals(plan.meals, plan.substitutions, goal, plan.day_type));
  const rawPrep = candidate.meal_prep && typeof candidate.meal_prep === "object" ? candidate.meal_prep : {};
  plan.meal_prep = {
    title: sanitizeValue(rawPrep.title, (fallback.meal_prep && fallback.meal_prep.title) || "Meal prep express"),
    batch_cook: sanitizeArray(rawPrep.batch_cook, 4).length ? sanitizeArray(rawPrep.batch_cook, 4) : ((fallback.meal_prep && fallback.meal_prep.batch_cook) || []),
    packing_tips: sanitizeArray(rawPrep.packing_tips, 4).length ? sanitizeArray(rawPrep.packing_tips, 4) : ((fallback.meal_prep && fallback.meal_prep.packing_tips) || []),
    containers: sanitizeArray(rawPrep.containers, 4).length ? sanitizeArray(rawPrep.containers, 4) : ((fallback.meal_prep && fallback.meal_prep.containers) || [])
  };
  if (plan.meals.length < 3) return fallback;
  return plan;
}

function buildPrompt(profile) {
  return `Tu es un coach nutrition premium pour application fitness. Tu réponds UNIQUEMENT en JSON valide, sans markdown, sans texte autour.

OBJECTIF:
Créer un plan nutrition quotidien crédible, concret, premium et facile à suivre.

RÈGLES:
- Français uniquement.
- Différencie clairement ${goalLabel(profile.goal)} et ${dayTypeLabel(profile.day_type)}.
- Les calories, protéines, glucides et lipides doivent être cohérents.
- 4 repas, simples à faire en vraie vie, zéro aliment exotique.
- Ajoute des substitutions simples, des conseils d'adhérence et une mini stratégie de meal prep.
- Ton premium, pratique, pas robotique.
- Réponse courte mais utile.

FORMAT JSON OBLIGATOIRE:
{
  "goal": "maintenance|perte_de_poids|prise_de_masse",
  "day_type": "training|rest",
  "nutrition": {
    "calories": 2400,
    "protein": 160,
    "carbs": 280,
    "fats": 70,
    "notes": "Résumé nutrition court"
  },
  "plan": {
    "title": "Plan nutrition du jour",
    "summary": "Résumé objectif clair",
    "hydration_liters": 2.4,
    "coach_note": "Note coach courte",
    "training_note": "Note autour de la séance ou du repos",
    "tips": ["...", "...", "..."],
    "substitutions": ["...", "...", "..."],
    "shopping_list": {
      "title": "Liste de courses de la journée",
      "prep_tips": ["...", "..."],
      "quick_swaps": ["...", "..."],
      "categories": [
        {
          "title": "Protéines",
          "items": [{ "name": "Poulet", "qty": "2 à 3 portions" }]
        }
      ]
    },
    "meal_prep": {
      "title": "Meal prep express",
      "batch_cook": ["...", "..."],
      "packing_tips": ["...", "..."],
      "containers": ["...", "..."]
    },
    "meals": [
      {
        "name": "Petit déjeuner",
        "time": "08:00",
        "calories": 550,
        "protein": 35,
        "focus": "énergie stable",
        "items": ["...", "..."],
        "swap_options": ["...", "..."],
        "coach_tip": "..."
      }
    ],
    "notes": "Phrase de synthèse"
  }
}

PROFIL:
${JSON.stringify(profile)}`;
}

async function callGeminiNutrition(apiKey, profile) {
  const result = await callGeminiText({
    apiKey,
    prompt: buildPrompt(profile),
    temperature: 0.4,
    maxOutputTokens: 1100,
    timeoutMs: GEMINI_TIMEOUT_MS,
    retries: 1
  });
  const parsed = extractJson(result.text) || {};
  const nutrition = validateNutrition(parsed, profile.goal, profile.day_type)
    || buildMacroTargets(profile.weight, profile.goal, profile.activity_level, profile.day_type);
  const plan = validatePlan(parsed, nutrition, profile.goal, profile.activity_level, profile.day_type, profile.weight);
  return { goal: profile.goal, day_type: profile.day_type, nutrition, plan, model: result.model, parsed };
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
  }

  const limit = checkRateLimit("generate-nutrition", getIp(req), 8, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: "RATE_LIMITED", requestId });
  }

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", requestId });

  const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const ANON_KEY = pickAnonKey();
  if (!SUPABASE_URL || !ANON_KEY) {
    return sendJson(res, 500, {
      ok: false,
      error: "SERVER_MISCONFIG_SUPABASE",
      message: "Variables Supabase manquantes côté serveur.",
      requestId
    });
  }

  const body = parseBody(req);
  const goal = normalizeGoal(body.goal);
  const activity_level = normalizeActivity(body.activity_level);
  const day_type = normalizeDayType(body.day_type, activity_level);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();

  try {
    const createClient = getCreateClient();
    if (typeof createClient !== "function") {
      const fallbackNutrition = buildMacroTargets(75, goal, activity_level, day_type);
      const fallbackPlan = buildFallbackPlan(fallbackNutrition, goal, activity_level, day_type, 75);
      return sendJson(res, 200, {
        ok: true,
        requestId,
        goal,
        day_type,
        nutrition: fallbackNutrition,
        plan: fallbackPlan,
        hydration_liters: fallbackPlan.hydration_liters,
        fallback: true,
        error: "SUPABASE_CLIENT_UNAVAILABLE",
        error_code: "SUPABASE_CLIENT_UNAVAILABLE",
        model_default: DEFAULT_MODEL,
        model_fallback: FALLBACK_MODEL,
        saved: false
      });
    }

    const authClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    const userId = authData?.user?.id;
    if (authError || !userId) {
      return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });
    }

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false }
    });

    const { data: profileData } = await supabase
      .from("profiles")
      .select("weight")
      .eq("id", userId)
      .maybeSingle();

    const profile = {
      weight: Number(profileData?.weight || 75),
      goal,
      activity_level,
      day_type
    };

    const result = apiKey
      ? await callGeminiNutrition(apiKey, profile)
      : {
          goal,
          day_type,
          nutrition: buildMacroTargets(profile.weight, goal, activity_level, day_type),
          plan: buildFallbackPlan(buildMacroTargets(profile.weight, goal, activity_level, day_type), goal, activity_level, day_type, profile.weight),
          model: "fallback:no-key",
          fallback: true
        };

    const upsert = await supabase.from("nutrition_targets").upsert({
      user_id: userId,
      calories: result.nutrition.calories,
      protein: result.nutrition.protein,
      carbs: result.nutrition.carbs,
      fats: result.nutrition.fats,
      notes: result.nutrition.notes,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });

    if (upsert.error) {
      console.error("[generate-nutrition] upsert error:", upsert.error.message);
    }

    return sendJson(res, 200, {
      ok: true,
      requestId,
      goal,
      day_type,
      nutrition: result.nutrition,
      plan: result.plan,
      hydration_liters: result.plan?.hydration_liters || null,
      fallback: !!result.fallback,
      model: result.model,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL,
      saved: !upsert.error
    });
  } catch (error) {
    const info = normalizeGeminiError(error);
    const fallbackNutrition = buildMacroTargets(75, goal, activity_level, day_type);
    const fallbackPlan = buildFallbackPlan(fallbackNutrition, goal, activity_level, day_type, 75);
    console.error("[generate-nutrition]", info.code, info.message.slice(0, 200));
    return sendJson(res, 200, {
      ok: true,
      requestId,
      goal,
      day_type,
      nutrition: fallbackNutrition,
      plan: fallbackPlan,
      hydration_liters: fallbackPlan.hydration_liters,
      fallback: true,
      error: info.message,
      error_code: info.code,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL,
      saved: false
    });
  }
};
