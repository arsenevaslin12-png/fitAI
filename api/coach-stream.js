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
  const items = Array.isArray(history) ? history.slice(-6) : [];
  if (!items.length) return "";
  return items.map(item => {
    const role = (item.role === "assistant" || item.role === "ai" || item.role === "coach") ? "Coach" : "Toi";
    return `${role}: ${String(item.content || "").slice(0, 150)}`;
  }).join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (assertEnv(res)) return;
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  // SSE headers — must be set before any body parsing
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders(); // Critical for Vercel: sends headers immediately so SSE starts

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

    // Parse body: try req.body (Vercel pre-parsed) then fallback to stream reading
    let body = parseBody(req);
    if (!body.message) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) body = JSON.parse(raw);
      } catch { /* keep body as-is */ }
    }
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

    // Mood rule (compact)
    let moodRule = "";
    if (p.mood === "Épuisé")       moodRule = "⚠️ ÉPUISÉ: repos/mobilité uniquement, aucune intensité.";
    else if (p.mood === "Fatigué") moodRule = "⚠️ Fatigué: intensité -30%, séance courte.";
    else if (p.mood === "En forme") moodRule = "💪 En forme: pousse l'intensité.";

    const msgLower = rawMessage.toLowerCase();
    let extra = "";
    if (/flemme|pas envie|motivation/.test(msgLower)) extra = "\n→ Manque de motivation: UNE seule action simple tout de suite, ton humain.";
    if (/stagne|plateau|progresse plus/.test(msgLower)) extra = `\n→ Stagnation: analyse cause (volume? charge? récup? nutrition?) et propose ajustement concret.`;

    const histBlk = formatHistory(history);
    const isBodyweight = !p.equipment || !/halt[eè]re|barre|salle|machine|kettlebell|banc/i.test(p.equipment);
    const equipRule = isBodyweight
      ? "\n⚠️ ÉQUIPEMENT: POIDS DU CORPS UNIQUEMENT — n'utilise pas d'haltères, barres, machines ou kettlebell dans tes suggestions."
      : "";

    const prompt = `Tu es FitAI Coach, expert fitness et nutrition. Français, direct, humain.

PROFIL: ${p.display_name ? p.display_name + " | " : ""}${p.goal} (${goalDesc}) | ${p.level} | ${equipLabel}${p.constraints ? " | ⚠️ " + p.constraints : ""}${equipRule}
Humeur: ${p.mood || "?"} ${moodRule}${extra}
Stats: streak ${streak}j | ${totalWorkouts} séances${recentWorkouts.length ? " | " + recentWorkouts.join(", ") : ""}${lastScanScore ? " | scan " + lastScanScore + "/100" : ""}${todayKcal > 0 ? " | " + todayKcal + "kcal/" + todayProtein + "g prot" : ""}
${histBlk ? "Historique:\n" + histBlk + "\n" : ""}
MESSAGE: ${rawMessage}

**Gras** pour les points clés. Listes avec "- ". Séance = Échauffement/Corps/Retour au calme avec séries×reps×repos. Court si question simple, complet si plan.`;

    const apiKey = process.env.GEMINI_API_KEY;
    await callGeminiStream({
      apiKey,
      prompt,
      temperature: 0.7,
      maxOutputTokens: 900,
      timeoutMs: 25000,
      onChunk: (text) => sseWrite(res, { text })
    });

    sseDone(res);
  } catch (err) {
    const info = normalizeGeminiError(err);
    sseWrite(res, { error: info.message || "Erreur temporaire — réessayez." });
    sseDone(res);
  }
};
