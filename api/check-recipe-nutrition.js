"use strict";

// api/check-recipe-nutrition.js
// Vérifie la valeur nutritionnelle d'une recette partagée dans la communauté.
// Retourne un score 0-100 + analyse Gemini + macros estimés.

const { callGeminiText, normalizeGeminiError } = require("./_gemini");
const { assertEnv } = require("./_env");

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

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { sendJson(res, 405, { error: "method_not_allowed" }); return; }

  // Auth check
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "unauthorized" }); return;
  }

  const GEMINI_API_KEY = assertEnv("GEMINI_API_KEY");
  const body = parseBody(req);
  const { name, ingredients, servings = 1 } = body;

  if (!name || !ingredients) {
    sendJson(res, 400, { error: "name and ingredients required" }); return;
  }

  const prompt = `Tu es un nutritionniste expert. Analyse cette recette et retourne UNIQUEMENT un JSON valide, sans texte avant ou après.

Recette: "${String(name).slice(0, 100)}"
Ingrédients (${Number(servings) || 1} portions): ${String(ingredients).slice(0, 600)}

JSON requis (tous les champs sont obligatoires):
{
  "score": <entier 0-100, score nutritionnel global>,
  "label": "<Pauvre|Moyen|Bon|Excellent>",
  "kcal": <calories par portion, entier>,
  "protein": <protéines en grammes par portion, entier>,
  "carbs": <glucides en grammes par portion, entier>,
  "fat": <lipides en grammes par portion, entier>,
  "fiber": <fibres en grammes par portion, entier>,
  "analysis": "<2 phrases concises sur l'intérêt nutritionnel>",
  "strengths": ["<point fort 1>", "<point fort 2>"],
  "improvements": ["<1 amélioration concrète>"]
}

Critères du score: densité nutritionnelle, équilibre protéines/glucides/lipides, teneur en fibres, présence de légumes/fruits, absence d'aliments ultra-transformés.`;

  try {
    const raw = await callGeminiText({
      apiKey: GEMINI_API_KEY,
      prompt,
      temperature: 0.2,
      maxOutputTokens: 400,
      timeoutMs: 14000,
      retries: 0,
      mimeType: "application/json"
    });

    let result;
    try {
      result = typeof raw === "string" ? JSON.parse(raw) : raw;
      // Validate required fields
      if (!result || typeof result.score !== "number") throw new Error("invalid");
    } catch {
      result = {
        score: 60, label: "Moyen",
        kcal: 400, protein: 25, carbs: 45, fat: 15, fiber: 4,
        analysis: "Recette partagée. Analyse indisponible temporairement.",
        strengths: ["Recette maison"],
        improvements: ["Ajouter des légumes pour enrichir la valeur nutritive"]
      };
    }

    sendJson(res, 200, { ok: true, data: result });
  } catch (err) {
    const detail = normalizeGeminiError(err);
    // Return a graceful fallback instead of an error
    sendJson(res, 200, {
      ok: true,
      data: {
        score: 60, label: "Moyen",
        kcal: 400, protein: 25, carbs: 45, fat: 15, fiber: 4,
        analysis: "Analyse nutritionnelle indisponible momentanément.",
        strengths: ["Recette faite maison"],
        improvements: ["Ajouter plus de légumes verts"],
        _fallback: true
      }
    });
  }
};
