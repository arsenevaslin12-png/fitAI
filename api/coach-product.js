"use strict";

const { createClient } = require("@supabase/supabase-js");
const { callGeminiText, extractJson } = require("./_gemini");
const { setCors, sendJson, parseBody } = require("./_coach-core");

// Per-user rate limit: 30 analyses per hour
const _userBuckets = new Map();
function checkUserRateLimit(userId) {
  const now = Date.now();
  const prev = _userBuckets.get(userId) || [];
  const recent = prev.filter(ts => now - ts < 3_600_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  _userBuckets.set(userId, recent);
  return true;
}

const GOAL_LABELS = {
  prise_de_masse: "prise de masse musculaire",
  seche: "sèche (perte de gras, maintien musculaire)",
  perte_de_poids: "perte de poids",
  equilibre: "équilibre alimentaire / santé",
  force: "développement de la force",
  endurance: "endurance sportive"
};

const NOVA_LABELS = { 1: "non transformé", 2: "peu transformé", 3: "transformé", 4: "ultra-transformé" };

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 503, { ok: false, error: "SERVER_MISCONFIGURED" });
  }

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let user;
  try {
    const { data: { user: u }, error } = await supabase.auth.getUser(token);
    if (error || !u) return sendJson(res, 401, { ok: false, error: "Token invalide" });
    user = u;
  } catch {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED" });
  }

  if (!checkUserRateLimit(user.id)) {
    return sendJson(res, 429, { ok: false, error: "Limite atteinte. Réessaie dans une heure." });
  }

  if (!GEMINI_API_KEY) {
    return sendJson(res, 503, { ok: false, error: "AI_UNAVAILABLE" });
  }

  const body = parseBody(req);
  const { product } = body;
  if (!product || !product.product_name) {
    return sendJson(res, 400, { ok: false, error: "product data required" });
  }

  // Fetch user context from Supabase in parallel
  const today = new Date().toISOString().slice(0, 10);
  const [profileResult, goalResult, mealsResult] = await Promise.allSettled([
    supabase.from("profiles").select("weight,height,age").eq("id", user.id).maybeSingle(),
    supabase.from("user_goals").select("type,level,target_kcal").eq("user_id", user.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("meals").select("calories,protein,name").eq("user_id", user.id).eq("date", today)
  ]);

  const profile = (profileResult.status === "fulfilled" ? profileResult.value.data : null) || {};
  const goal = (goalResult.status === "fulfilled" ? goalResult.value.data : null) || {};
  const meals = (mealsResult.status === "fulfilled" ? mealsResult.value.data : null) || [];

  const todayKcal = Math.round(meals.reduce((s, m) => s + (Number(m.calories) || 0), 0));
  const todayProtein = Math.round(meals.reduce((s, m) => s + (Number(m.protein) || 0), 0));
  const mealsSummary = meals.slice(0, 6).map(m => m.name || "repas").filter(Boolean).join(", ");

  // Compute nutrients per 100g
  const n = product.nutriments || {};
  const p100 = {
    kcal:   Math.round(n["energy-kcal_100g"] || (n["energy_100g"] || 0) / 4.184),
    prot:   parseFloat((n.proteins_100g   || 0).toFixed(1)),
    carb:   parseFloat((n.carbohydrates_100g || 0).toFixed(1)),
    sugar:  parseFloat((n.sugars_100g     || 0).toFixed(1)),
    fat:    parseFloat((n.fat_100g        || 0).toFixed(1)),
    satFat: parseFloat((n["saturated-fat_100g"] || 0).toFixed(1)),
    fiber:  parseFloat((n.fiber_100g      || 0).toFixed(1)),
    salt:   parseFloat((n.salt_100g       || 0).toFixed(2))
  };

  const hour = new Date().getHours();
  const timeContext = hour < 10 ? "matin (petit-déjeuner)"
    : hour < 13 ? "matinée"
    : hour < 15 ? "déjeuner"
    : hour < 18 ? "après-midi (collation)"
    : hour < 21 ? "soir (dîner)"
    : "soirée tardive";

  const goalLabel = GOAL_LABELS[goal.type] || goal.type || "non défini";
  const novaLabel = NOVA_LABELS[product.nova_group] || "inconnu";
  const additivesCount = (product.additives_tags || []).length;
  const remainingKcal = goal.target_kcal ? Math.max(0, goal.target_kcal - todayKcal) : null;

  // Build user protein target for context
  let proteinTarget = null;
  if (profile.weight) {
    const multiplier = (goal.type === "prise_de_masse" || goal.type === "force") ? 2.0
      : (goal.type === "seche") ? 2.2
      : 1.6;
    proteinTarget = Math.round(profile.weight * multiplier);
  }

  const prompt = `Tu es un coach nutritionnel expert, direct et bienveillant. Analyse ce produit alimentaire UNIQUEMENT pour cet utilisateur spécifique en tenant compte de tout son contexte.

PROFIL :
- Poids : ${profile.weight ? `${profile.weight} kg` : "inconnu"}
- Taille : ${profile.height ? `${profile.height} cm` : "inconnue"}
- Âge : ${profile.age ? `${profile.age} ans` : "inconnu"}
- Objectif : ${goalLabel}
- Niveau : ${goal.level || "non défini"}
${goal.target_kcal ? `- Cible calorique : ${goal.target_kcal} kcal/jour` : ""}
${proteinTarget ? `- Cible protéines estimée : ${proteinTarget}g/jour` : ""}

CONTEXTE AUJOURD'HUI (${today}, il est ${timeContext}) :
- Déjà consommé : ${todayKcal} kcal / ${todayProtein}g de protéines
${remainingKcal !== null ? `- Calories restantes pour la journée : ${remainingKcal} kcal` : ""}
${proteinTarget ? `- Protéines restantes à atteindre : ${Math.max(0, proteinTarget - todayProtein)}g` : ""}
${mealsSummary ? `- Repas du jour : ${mealsSummary}` : "- Aucun repas enregistré encore aujourd'hui"}

PRODUIT SCANNÉ :
- Nom : ${String(product.product_name || "").slice(0, 100)}
${product.brands ? `- Marque : ${String(product.brands).slice(0, 60)}` : ""}
- Nutri-Score : ${(product.nutriscore_grade || "?").toUpperCase()}
- NOVA : ${product.nova_group || "?"} (${novaLabel})
- Pour 100g : ${p100.kcal} kcal | protéines ${p100.prot}g | glucides ${p100.carb}g (sucres ${p100.sugar}g) | lipides ${p100.fat}g (sat. ${p100.satFat}g) | fibres ${p100.fiber}g | sel ${p100.salt}g
${additivesCount > 0 ? `- Additifs : ${additivesCount} détectés` : ""}

RÈGLES DE RÉPONSE :
1. Sois 100% spécifique à CET utilisateur — cite ses chiffres réels (kcal restants, protéines manquantes, son objectif)
2. Mentionne l'heure (${timeContext}) et ce que ça implique pour l'ingestion de ce produit
3. Si objectif prise de masse → parle synthèse protéique, fenêtre anabolique, besoins caloriques
4. Si sèche/perte de poids → parle déficit calorique, lipolyse, préservation musculaire
5. Sois direct et chiffré, pas de blabla générique
6. "verdict" = 1 phrase percutante, personnalisée, max 12 mots
7. "verdictType" doit refléter l'adéquation du produit à SON objectif (pas juste au score global)
8. "analysis" = 2-3 phrases avec des chiffres précis tirés du contexte
9. "action" = que faire maintenant, concrètement, pour cet utilisateur à cet instant

Réponds UNIQUEMENT en JSON valide (sans markdown, sans texte avant ou après) :
{
  "verdict": "<phrase percutante personnalisée>",
  "verdictType": "<good|neutral|warn|bad>",
  "analysis": "<2-3 phrases chiffrées et personnalisées>",
  "action": "<action concrète immédiate>"
}`;

  try {
    const raw = await callGeminiText({
      apiKey: GEMINI_API_KEY,
      prompt,
      temperature: 0.35,
      maxOutputTokens: 400,
      timeoutMs: 13000,
      retries: 0,
      mimeType: "application/json"
    });

    let result;
    const text = typeof raw?.text === "string" ? raw.text : "";
    try {
      result = JSON.parse(text);
    } catch {
      result = extractJson(text);
    }

    if (!result?.verdict || !result?.analysis || !result?.action) {
      return sendJson(res, 200, { ok: false, error: "AI_PARSE_FAILED" });
    }

    // Sanitize output
    result = {
      verdict:     String(result.verdict || "").slice(0, 200),
      verdictType: ["good", "neutral", "warn", "bad"].includes(result.verdictType) ? result.verdictType : "neutral",
      analysis:    String(result.analysis || "").slice(0, 600),
      action:      String(result.action || "").slice(0, 400)
    };

    sendJson(res, 200, { ok: true, data: result });
  } catch {
    sendJson(res, 200, { ok: false, error: "AI_UNAVAILABLE" });
  }
};
