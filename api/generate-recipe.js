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

const GEMINI_TIMEOUT_MS = 22000;

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

function buildRecipePrompt(ingredients, goal, targetKcal) {
  const goalLabel = GOAL_LABELS[goal] || "repas équilibré";
  return `Tu es un nutritionniste sportif expert en cuisine fitness.
Crée une recette avec ces ingrédients: ${ingredients}.
Objectif: ${goalLabel}, environ ${targetKcal} kcal.

RÈGLES ABSOLUES:
- utilise uniquement les ingrédients fournis
- donne le nom, les étapes courtes, les macros précises
- réponds UNIQUEMENT en JSON strict, sans aucun texte autour
- aucun markdown (pas de \`\`\`), aucune explication

FORMAT UNIQUE (respecte exactement cette structure):
{"name":"Nom du plat","steps":["Étape 1","Étape 2","Étape 3"],"prep_time":"15 min","calories":500,"protein":35,"carbs":50,"fat":15,"tips":"Conseil pratique court"}`;
}

function validateRecipe(raw) {
  if (!raw || typeof raw !== "object") return null;
  // Accept if we have at least name OR steps OR calories
  if (!raw.name && !Array.isArray(raw.steps) && !raw.calories) return null;
  return {
    name:      String(raw.name || "Recette IA"),
    steps:     Array.isArray(raw.steps) ? raw.steps.map(String).filter(Boolean) : [],
    prep_time: String(raw.prep_time || "15 min"),
    calories:  Math.max(0, Math.round(Number(raw.calories) || 400)),
    protein:   Math.max(0, Math.round(Number(raw.protein)  || 30)),
    carbs:     Math.max(0, Math.round(Number(raw.carbs)    || 40)),
    fat:       Math.max(0, Math.round(Number(raw.fat)      || 15)),
    tips:      String(raw.tips || "")
  };
}

function fallbackRecipe(ingredients, goal) {
  const goalLabel = GOAL_LABELS[goal] || "équilibré";
  const ingredientPreview = String(ingredients || "").slice(0, 80);
  return {
    name:      `Recette ${goalLabel}`,
    steps: [
      `Préparez vos ingrédients: ${ingredientPreview}`,
      "Faites cuire les protéines à feu moyen (10-15 min)",
      "Ajoutez les légumes et faites revenir 5 min",
      "Assaisonnez selon vos goûts et servez chaud"
    ],
    prep_time: "20 min",
    calories:  450,
    protein:   35,
    carbs:     45,
    fat:       12,
    tips:      "Pesez vos aliments pour un suivi précis des macros."
  };
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

  const body = parseBody(req);
  const ingredients = String(body.ingredients || body.message || "").trim();
  const goal       = String(body.goal || "equilibre").trim();
  const targetKcal = Math.max(150, Math.min(2000,
    parseInt(body.targetKcal || body.target_kcal || "500") || 500
  ));

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
        prompt: buildRecipePrompt(ingredients, goal, targetKcal),
        temperature: 0.65,
        maxOutputTokens: 900,
        timeoutMs: GEMINI_TIMEOUT_MS,
        retries: 1
      });

      recipe = validateRecipe(extractJson(result.text));

      if (!recipe) {
        // Gemini responded but JSON was malformed — use fallback but keep the model's text as a tip
        recipe = fallbackRecipe(ingredients, goal);
        const rawText = String(result.text || "").slice(0, 200);
        recipe.tips = rawText || "Recette générée en mode secours.";
        usedFallback = true;
      }
    } else {
      recipe = fallbackRecipe(ingredients, goal);
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
    const recipe = fallbackRecipe(ingredients, goal);
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
