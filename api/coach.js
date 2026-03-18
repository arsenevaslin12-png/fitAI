"use strict";

const {
  sendJson,
  setCors,
  parseBody,
  sanitizeInput,
  getIp,
  checkRateLimit,
  detectIntent,
  generateWorkoutPlan,
  generateConversationReply,
  generateRecipeJson,
  generateShoppingList,
  generateMealPlan
} = require("./_coach-core");
const {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  normalizeGeminiError
} = require("./_gemini");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Méthode non autorisée" });

  const limit = checkRateLimit("coach", getIp(req), 10, 60_000);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: `Trop de demandes. Réessayez dans ${limit.retryAfterSec}s.` });
  }

  const body = parseBody(req);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  const responseMode = sanitizeInput(body.responseMode || "", 40);
  const message = sanitizeInput(body.message || "", 1400);
  if (!message) return sendJson(res, 400, { ok: false, error: "Le champ 'message' est requis" });

  const history = Array.isArray(body.history)
    ? body.history.slice(-6).map((item) => ({
        role: sanitizeInput(String(item.role || "user"), 20),
        content: sanitizeInput(String(item.content || ""), 500)
      }))
    : [];

  const profile = body.profile && typeof body.profile === "object" ? {
    goal: sanitizeInput(body.profile.goal || "", 60),
    level: sanitizeInput(body.profile.level || "", 30),
    equipment: sanitizeInput(body.profile.equipment || "", 200),
    injuries: sanitizeInput(body.profile.injuries || "", 300),
    display_name: sanitizeInput(body.profile.display_name || "", 80),
    weight: Number(body.profile.weight || 0) || null,
    height: Number(body.profile.height || 0) || null,
    sleep_hours: Number(body.profile.sleep_hours || 0) || null,
    recovery_score: Number(body.profile.recovery_score || 0) || null
  } : {};

  const goalContext = body.goalContext && typeof body.goalContext === "object" ? {
    type: sanitizeInput(body.goalContext.type || "", 60),
    level: sanitizeInput(body.goalContext.level || "", 30),
    constraints: sanitizeInput(body.goalContext.constraints || "", 300)
  } : {};

  try {
    const intent = detectIntent(message, responseMode);

    if (responseMode === "recipe_json" || intent === "recipe_request") {
      const recipe = await generateRecipeJson({ apiKey, message, profile, goalContext });
      return sendJson(res, 200, {
        ok: true,
        type: "recipe",
        data: recipe.data,
        message: null,
        fallback: !!recipe.fallback,
        meta: recipe.error ? { note: recipe.error } : undefined,
        model_default: DEFAULT_MODEL,
        model_fallback: FALLBACK_MODEL
      });
    }

    if (intent === "workout_request") {
      const plan = await generateWorkoutPlan({ apiKey, message, history, profile, goalContext });
      return sendJson(res, 200, {
        ok: true,
        type: "workout",
        data: plan.data,
        message: null,
        fallback: !!plan.fallback,
        meta: plan.error ? { note: plan.error } : undefined,
        model_default: DEFAULT_MODEL,
        model_fallback: FALLBACK_MODEL
      });
    }

    if (intent === "shopping_list") {
      const result = await generateShoppingList({ apiKey, message, profile, goalContext });
      return sendJson(res, 200, {
        ok: true,
        type: "shopping_list",
        data: result.data,
        message: null,
        fallback: !!result.fallback,
        meta: result.error ? { note: result.error } : undefined,
        model_default: DEFAULT_MODEL,
        model_fallback: FALLBACK_MODEL
      });
    }

    if (intent === "meal_plan") {
      const result = await generateMealPlan({ apiKey, message, profile, goalContext });
      return sendJson(res, 200, {
        ok: true,
        type: "meal_plan",
        data: result.data,
        message: null,
        fallback: !!result.fallback,
        meta: result.error ? { note: result.error } : undefined,
        model_default: DEFAULT_MODEL,
        model_fallback: FALLBACK_MODEL
      });
    }

    const reply = await generateConversationReply({ apiKey, intent, message, history, profile, goalContext });
    return sendJson(res, 200, {
      ok: true,
      type: "conversation",
      message: reply.message,
      data: null,
      fallback: !!reply.fallback,
      meta: reply.error ? { note: reply.error } : undefined,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL
    });
  } catch (error) {
    const info = normalizeGeminiError(error);
    console.error("[coach]", info.code, info.message.slice(0, 200));
    return sendJson(res, info.status, {
      ok: false,
      error: info.message,
      error_code: info.code,
      model_default: DEFAULT_MODEL,
      model_fallback: FALLBACK_MODEL
    });
  }
};
