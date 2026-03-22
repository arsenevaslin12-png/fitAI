"use strict";

const {
  setCors,
  parseBody,
  sanitizeInput,
  makeProfileSummary,
  getGoalDescription,
  getLevelDescription,
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

function formatHistory(history = []) {
  const items = Array.isArray(history) ? history.slice(-14) : [];
  if (!items.length) return "— Début de la conversation —";
  return items.map(item => {
    const role = String(item.role || "user").toLowerCase();
    const label = (role === "assistant" || role === "ai" || role === "coach") ? "Coach" : "Utilisateur";
    const content = String(item.content || "").slice(0, 400).trim();
    return `${label}: ${content}`;
  }).join("\n");
}

module.exports = async function handler(req, res) {
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
    const ip = getIp(req);
    const limit = checkRateLimit("coach-stream", ip, 8, 15_000);
    if (!limit.ok) {
      sseWrite(res, { error: `Trop de requêtes — patientez ${limit.retryAfterSec}s.` });
      return sseDone(res);
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      sseWrite(res, { error: "Non authentifié." });
      return sseDone(res);
    }

    const body = parseBody(req);
    const rawMessage = sanitizeInput(String(body.message || ""), 1000);
    if (!rawMessage) {
      sseWrite(res, { error: "Message vide." });
      return sseDone(res);
    }

    const profile = body.profile || {};
    const history = Array.isArray(body.history) ? body.history : [];
    const goalCtx = body.goalContext || {};

    const p = makeProfileSummary(profile, goalCtx);
    const goalDesc = getGoalDescription(p.goal);
    const levelDesc = getLevelDescription(p.level);

    const equipMap = { halteres:"haltères", barre:"barre + disques", salle:"salle de sport complète", kettlebell:"kettlebell", elastiques:"élastiques" };
    const equipLabel = equipMap[p.equipment] || p.equipment || "poids du corps uniquement";

    // Contextual data from profile
    const streak         = Number(profile.streak) || 0;
    const totalWorkouts  = Number(profile.total_workouts) || 0;
    const recentWorkouts = Array.isArray(profile.recent_workouts) ? profile.recent_workouts : [];
    const lastScanScore  = profile.last_scan_score ? Number(profile.last_scan_score) : null;
    const todayKcal      = profile.today_kcal ? Number(profile.today_kcal) : 0;
    const todayProtein   = profile.today_protein ? Number(profile.today_protein) : 0;

    // Mood rule
    let moodRule = "";
    if (p.mood === "Épuisé")    moodRule = "CRITIQUE: Utilisateur épuisé — récupération active, mobilité ou repos seulement. Aucun entraînement intense.";
    else if (p.mood === "Fatigué") moodRule = "IMPORTANT: Utilisateur fatigué — intensité -30%, séance courte, pas de HIIT.";
    else if (p.mood === "En forme") moodRule = "Utilisateur en grande forme — tu peux pousser l'intensité.";

    // State of mind detection for "flemme/fatigué/j'ai pas envie/je stagne"
    const msgLower = rawMessage.toLowerCase();
    const isLowMotivation = /flemme|pas envie|j.ai pas|motivation|paresseux|la flemme|peux pas me motiver/.test(msgLower);
    const isStagnating    = /stagne|plateau|progresse plus|j.avance pas|bloqué|résultat|résultats|progres/.test(msgLower);

    let motivationContext = "";
    if (isLowMotivation) {
      motivationContext = `\nCONTEXTE MOTIVATION: L'utilisateur manque de motivation. Ne donne PAS une liste de conseils génériques. Reconnais honnêtement sa situation, identifie un déclencheur probable (fatigue, routine, manque de résultats), et propose UNE seule action très simple à faire dans les 5 prochaines minutes. Ton direct, humain, pas de blabla.`;
    }
    if (isStagnating) {
      motivationContext += `\nCONTEXTE STAGNATION: L'utilisateur stagne. Analyse son profil (${totalWorkouts} séances total, streak ${streak}j) et identifie la cause probable (volume insuffisant? manque de progression de charge? récupération? nutrition?). Propose un ajustement concret.`;
    }

    const prompt = `Tu es un coach fitness et nutrition IA expert. Tu parles en français, directement, comme un vrai coach qui connaît bien son client depuis des semaines.

━━ PROFIL COMPLET ━━
- Prénom: ${p.display_name || "non renseigné"}
- Objectif: ${p.goal} (${goalDesc})
- Niveau: ${p.level} (${levelDesc})
- Équipement: ${equipLabel}
- Contraintes: ${p.constraints || "aucune"}
- Humeur aujourd'hui: ${p.mood || "non renseignée"}${moodRule ? `\n→ ${moodRule}` : ""}

━━ CONTEXTE RÉEL ━━
- Streak actuel: ${streak > 0 ? `${streak} jours consécutifs` : "pas encore de streak"}
- Total séances: ${totalWorkouts > 0 ? `${totalWorkouts} séances` : "débutant"}
- Séances récentes: ${recentWorkouts.length ? recentWorkouts.join(", ") : "aucune encore"}
- Dernier score physique IA: ${lastScanScore ? `${lastScanScore}/100` : "pas encore de scan"}
- Nutrition aujourd'hui: ${todayKcal > 0 ? `${todayKcal} kcal / ${todayProtein}g protéines` : "rien de loggé aujourd'hui"}
${motivationContext}

━━ HISTORIQUE CONVERSATION ━━
${formatHistory(history)}

━━ RÈGLES ━━
1. Tu utilises le CONTEXTE RÉEL pour personnaliser ta réponse. Référence le streak, les séances récentes, le score scan si pertinent.
2. Tu te souviens de tout l'historique. "rend-la plus intense" → tu sais de quelle séance il parle.
3. Tu ne répètes JAMAIS la question. Tu ne dis jamais "Je suis une IA".
4. **Gras** pour les éléments clés. "- " pour les listes. Pas d'emoji.
5. Longueur adaptée: 2-3 phrases pour le simple, 15-20 lignes pour un plan structuré.
6. Pour une séance: structure **Échauffement / Corps / Retour au calme** avec séries/reps/temps.
7. Pour la nutrition: grammes réels, exemples de repas concrets.
8. Si flemme/pas envie: 1 seule action simple, maintenant, ton humain et direct.
9. Si stagnation: analyse cause + ajustement précis.

━━ MESSAGE ━━
${rawMessage}`;

    const apiKey = process.env.GEMINI_API_KEY;
    await callGeminiStream({
      apiKey,
      prompt,
      temperature: 0.7,
      maxOutputTokens: 1400,
      onChunk: (text) => sseWrite(res, { text })
    });

    sseDone(res);
  } catch (err) {
    const info = normalizeGeminiError(err);
    sseWrite(res, { error: info.message || "Erreur temporaire — réessayez." });
    sseDone(res);
  }
};
