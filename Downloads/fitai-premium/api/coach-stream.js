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
const { callGeminiStream, normalizeGeminiError, STREAM_TIMEOUT_MS } = require("./_gemini");

// ── SSE helper ────────────────────────────────────────────────────────────────
function streamFallbackText(res, text) {
  const msg = String(text || '').trim();
  if (!msg) return sseDone(res);
  const parts = msg.match(/.{1,120}(?:\s|$)/g) || [msg];
  parts.forEach((part) => sseWrite(res, { text: part }));
  sseDone(res);
}
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

    const prompt = `Tu es un coach fitness premium pour application SaaS. Réponds en français avec un ton humain, clair, motivant et expert.

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
- Réponds d'abord avec l'idée la plus utile.
- Ajoute une courte explication seulement si elle aide vraiment.
- Termine par une action concrète à faire aujourd'hui si pertinent.
- Si l'humeur est "Épuisé" ou "Fatigué", adapte tes conseils en conséquence (récupération, intensité réduite).
- Si l'humeur est "En forme", propose quelque chose d'un peu plus ambitieux mais réaliste.
- Longueur: 3 à 7 lignes utiles maximum.
- Tu peux utiliser ces libellés si cela aide: Réponse directe:, Pourquoi:, Action du jour:.
- N'écris PAS de JSON brut. N'écris PAS de programme complet sauf si demandé.

Message utilisateur:
${rawMessage}`;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!String(apiKey || "").trim()) {
      return streamFallbackText(res, `Réponse directe: Je passe en mode secours intelligent.
Pourquoi: Je préfère te donner une réponse utile tout de suite plutôt qu'un chargement vide.
Action du jour: pars sur 4 mouvements simples, 3 séries chacun, repos 60 à 90 secondes, puis reviens me dire ton niveau d'énergie.`);
    }
    await callGeminiStream({
      apiKey,
      prompt,
      temperature: 0.65,
      maxOutputTokens: 700,
      timeoutMs: STREAM_TIMEOUT_MS,
      onChunk: (text) => sseWrite(res, { text })
    });

    sseDone(res);
  } catch (err) {
    const info = normalizeGeminiError(err);
    return streamFallbackText(res, info.code === "TIMEOUT" ? `Réponse directe: Je te propose une version courte et fiable.
Pourquoi: Le temps de réponse a été trop long, mais ton action ne doit pas attendre.
Action du jour: pars sur une séance full body légère, 4 exercices, 3 séries, intensité modérée, puis hydrate-toi et reviens me dire comment tu te sens.` : `Réponse directe: Je passe en mode secours intelligent.
Pourquoi: L'appel IA a échoué, mais on garde un conseil utile.
Action du jour: choisis 4 mouvements simples, 3 séries chacun, repos 60 à 90 secondes, puis note ta fatigue et ta récupération.`);
  }
};
