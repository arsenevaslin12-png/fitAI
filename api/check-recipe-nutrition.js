"use strict";

const { callGeminiText } = require("./_gemini");
const { assertEnv } = require("./_env");
const { setCors, sendJson, parseBody, checkRateLimit, getIp } = require("./_coach-core");

const FALLBACK = {
  score: 60, label: "Moyen",
  kcal: 400, protein: 25, carbs: 45, fat: 15, fiber: 4,
  analysis: "Analyse nutritionnelle indisponible momentanément.",
  strengths: ["Recette faite maison"],
  improvements: ["Ajouter plus de légumes verts"],
  _fallback: true
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { sendJson(res, 405, { error: "method_not_allowed" }); return; }

  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "unauthorized" }); return;
  }

  const limit = checkRateLimit("check-recipe", getIp(req), 15, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    sendJson(res, 429, { error: `Trop de requêtes. Réessayez dans ${limit.retryAfterSec}s.` }); return;
  }

  if (assertEnv(res)) return;
  const { GEMINI_API_KEY } = process.env;

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
      if (!result || typeof result.score !== "number") throw new Error("invalid");
    } catch {
      result = { ...FALLBACK, analysis: "Recette partagée. Analyse indisponible temporairement.", strengths: ["Recette maison"] };
    }

    sendJson(res, 200, { ok: true, data: result });
  } catch {
    sendJson(res, 200, { ok: true, data: FALLBACK });
  }
};
