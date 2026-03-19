"use strict";

const {
  setCors,
  parseBody,
  sanitizeInput,
  makeProfileSummary,
  historyBlock,
  detectIntent,
  getIp,
  checkRateLimit
} = require("./_coach-core");
const { callGeminiStream, normalizeGeminiError } = require("./_gemini");
const { assertEnv } = require("./_env");

// ── SSE helper ────────────────────────────────────────────────────────────────
function sseWrite(res, data) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseDone(res) {
  if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
}

module.exports = async function handler(req, res) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (assertEnv(res)) return;
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    // Rate limit (5 streaming calls / 10s per IP)
    const ip = getIp(req);
    const limit = checkRateLimit("coach-stream", ip, 5, 10_000);
    if (!limit.ok) {
      sseWrite(res, { error: `Trop de requêtes — patientez ${limit.retryAfterSec}s.` });
      return sseDone(res);
    }

    // Auth
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      sseWrite(res, { error: "Non authentifié." });
      return sseDone(res);
    }

    const body = parseBody(req);
    const rawMessage = sanitizeInput(String(body.message || ""), 800);
    if (!rawMessage) {
      sseWrite(res, { error: "Message vide." });
      return sseDone(res);
    }

    const profile  = body.profile  || {};
    const history  = Array.isArray(body.history) ? body.history : [];
    const goalCtx  = body.goalContext || {};

    const p = makeProfileSummary(profile, goalCtx);

    const prompt = `Tu es un coach fitness IA expert, bienveillant et concret. Réponds en français.

Profil utilisateur:
- Objectif: ${p.goal}
- Niveau: ${p.level}
- Équipement: ${p.equipment}
- Contraintes: ${p.constraints}
- Humeur du jour: ${p.mood || "non renseignée"}
${p.display_name ? `- Prénom: ${p.display_name}` : ""}

Historique récent:
${historyBlock(history) || "Aucun."}

Instructions:
- Réponds directement et concrètement à la question.
- Si l'humeur est "Épuisé" ou "Fatigué", adapte tes conseils en conséquence (récupération, intensité réduite).
- Si l'humeur est "En forme", propose quelque chose d'un peu plus intense.
- Longueur: 2 à 7 phrases, ou liste à puces si pertinent.
- N'écris PAS de JSON brut. N'écris PAS de programme complet sauf si demandé.

Message utilisateur:
${rawMessage}`;

    const apiKey = process.env.GEMINI_API_KEY;
    await callGeminiStream({
      apiKey,
      prompt,
      temperature: 0.65,
      maxOutputTokens: 700,
      onChunk: (text) => sseWrite(res, { text })
    });

    sseDone(res);
  } catch (err) {
    const info = normalizeGeminiError(err);
    sseWrite(res, { error: info.message || "Erreur temporaire — réessayez." });
    sseDone(res);
  }
};
