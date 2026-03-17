"use strict";
// api/generate-recipe.js — FitAI Pro v8 — Generateur de recettes IA

const TIMEOUT = 25000;
const MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];

let _AI = null;
function getAI() {
  if (_AI) return _AI;
  try { _AI = require("@google/generative-ai").GoogleGenerativeAI; return _AI; } catch { return null; }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b || {};
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function buildRecipePrompt(ingredients, goal, targetCalories) {
  return `Tu es FitAI Chef, un chef cuisinier specialise en nutrition sportive.
Genere UNE recette saine et delicieuse avec les ingredients donnes.

INGREDIENTS DISPONIBLES: ${ingredients}
OBJECTIF: ${goal || "Repas equilibre"}
${targetCalories ? `CALORIES CIBLES: environ ${targetCalories} kcal` : ""}

REGLES:
1. Recette simple, realisable en 30 min max
2. Privilegier les proteines et les bons nutriments
3. Donner des quantites precises
4. Etapes claires et numerotees
5. Inclure les macros estimees

FORMAT JSON UNIQUEMENT (pas de markdown):
{
  "name": "Nom de la recette",
  "prep_time": "15 min",
  "cook_time": "20 min",
  "servings": 2,
  "calories_per_serving": 450,
  "macros": {"protein": 35, "carbs": 45, "fat": 15},
  "ingredients_list": ["200g poulet", "150g riz basmati", "100g brocoli"],
  "steps": ["Etape 1: Couper le poulet en des", "Etape 2: Faire cuire le riz", "Etape 3: ..."],
  "tips": "Conseil du chef: ajoutez du citron pour plus de saveur"
}

NE PAS inclure de blabla, juste le JSON pur.`;
}

async function callGemini(apiKey, prompt, modelIndex) {
  const G = getAI();
  if (!G) throw Object.assign(new Error("@google/generative-ai manquant"), { code: "DEP" });

  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  const model = new G(apiKey).getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
  });

  let tid;
  const tOut = new Promise((_, rej) => {
    tid = setTimeout(() => rej(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT);
  });

  const call = model.generateContent(prompt)
    .then(r => { clearTimeout(tid); const t = r?.response?.text; return typeof t === "function" ? t() : String(t || ""); })
    .catch(err => {
      clearTimeout(tid);
      const msg = String(err?.message || "");
      if ((msg.includes("404") || msg.includes("not found") || msg.includes("not supported")) && modelIndex + 1 < MODELS.length) {
        return callGemini(apiKey, prompt, modelIndex + 1);
      }
      throw err;
    });

  return Promise.race([call, tOut]);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return sendJson(res, 500, { ok: false, error: "GEMINI_API_KEY manquant" });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis" });

  const body = parseBody(req);
  const ingredients = String(body.ingredients || "").trim();
  const goal = String(body.goal || "Repas equilibre").trim();
  const targetCalories = parseInt(body.targetCalories) || 0;

  if (!ingredients) return sendJson(res, 400, { ok: false, error: "Listez au moins quelques ingredients" });
  if (ingredients.length > 500) return sendJson(res, 400, { ok: false, error: "Liste d'ingredients trop longue" });

  try {
    const text = await callGemini(GEMINI_API_KEY, buildRecipePrompt(ingredients, goal, targetCalories), 0);
    const parsed = safeJsonExtract(text);

    if (!parsed || !parsed.name || !parsed.steps) {
      return sendJson(res, 500, { ok: false, error: "Format recette invalide. Reessayez." });
    }

    return sendJson(res, 200, { ok: true, recipe: parsed });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[generate-recipe]", { code, msg: msg.slice(0, 150) });
    if (code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "Gemini timeout. Reessayez." });
    if (code === "DEP") return sendJson(res, 500, { ok: false, error: msg });
    if (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED")) {
      return sendJson(res, 429, { ok: false, error: "Quota Gemini atteint. Attendez 60 secondes.", retryAfter: 60 });
    }
    return sendJson(res, 502, { ok: false, error: msg || "Erreur serveur" });
  }
};
