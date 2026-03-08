"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest"];
const GEMINI_TIMEOUT_MS = 18000;

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

function safeJsonExtract(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function validateNutrition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const nutrition = {
    calories: Number(raw.calories),
    protein: Number(raw.protein),
    carbs: Number(raw.carbs),
    fats: Number(raw.fats),
    notes: String(raw.notes || "").trim() || "Plan généré automatiquement."
  };
  const isInt = Number.isInteger;
  if (!isInt(nutrition.calories) || nutrition.calories < 1200 || nutrition.calories > 4500) return null;
  if (!isInt(nutrition.protein) || nutrition.protein < 70 || nutrition.protein > 320) return null;
  if (!isInt(nutrition.carbs) || nutrition.carbs < 80 || nutrition.carbs > 550) return null;
  if (!isInt(nutrition.fats) || nutrition.fats < 30 || nutrition.fats > 180) return null;
  return nutrition;
}

function fallbackNutrition(weight = 75, goal = "maintenance") {
  const base = Math.round(weight * 30);
  const calories = goal === "cut" ? base - 350 : goal === "bulk" ? base + 250 : base;
  const protein = Math.round(weight * (goal === "cut" ? 2.1 : 1.8));
  const fats = Math.round(weight * 0.9);
  const carbs = Math.max(100, Math.round((calories - (protein * 4 + fats * 9)) / 4));
  return { calories, protein, carbs, fats, notes: "Fallback auto (Gemini indisponible)." };
}

function buildPrompt(profile) {
  return `Génère des macros nutrition JSON strict pour ce profil: ${JSON.stringify(profile)}.
Format uniquement:
{"calories":2400,"protein":160,"carbs":280,"fats":70,"notes":"..."}
Aucun markdown.`;
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error("GEMINI_TIMEOUT"), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function callGemini(apiKey, profile) {
  const client = new GoogleGenerativeAI(apiKey);
  let lastErr;
  for (const modelName of MODELS) {
    try {
      const model = client.getGenerativeModel({
        model: process.env.GEMINI_MODEL || modelName,
        generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
      });
      const response = await withTimeout(model.generateContent(buildPrompt(profile)), GEMINI_TIMEOUT_MS);
      const text = response?.response?.text?.() || "";
      const nutrition = validateNutrition(safeJsonExtract(text));
      if (nutrition) return { nutrition, model: modelName };
      lastErr = new Error("INVALID_NUTRITION_FORMAT");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("NUTRITION_GENERATION_FAILED");
}

async function loadProfile(supabase, userId) {
  const byUser = await supabase.from("profiles").select("weight").eq("user_id", userId).maybeSingle();
  if (!byUser.error && byUser.data) return byUser.data;
  const byId = await supabase.from("profiles").select("weight").eq("id", userId).maybeSingle();
  return byId.data || {};
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED", requestId });

  const { GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE", requestId });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const auth = await supabase.auth.getUser(token);
  const userId = auth?.data?.user?.id;
  if (!userId) return sendJson(res, 401, { ok: false, error: "INVALID_TOKEN", requestId });

  const body = parseBody(req);

  try {
    const profile = await loadProfile(supabase, userId);
    let result;
    if (GEMINI_API_KEY) {
      result = await callGemini(GEMINI_API_KEY, {
        weight: Number(profile.weight || 75),
        goal: String(body.goal || "maintenance"),
        activity_level: String(body.activity_level || "moderate")
      });
    } else {
      result = { nutrition: fallbackNutrition(Number(profile.weight || 75), String(body.goal || "maintenance")), model: "fallback" };
    }

    const upsert = await supabase.from("nutrition_targets").upsert({
      user_id: userId,
      calories: result.nutrition.calories,
      protein: result.nutrition.protein,
      carbs: result.nutrition.carbs,
      fats: result.nutrition.fats,
      notes: result.nutrition.notes,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (upsert.error) throw upsert.error;

    return sendJson(res, 200, { ok: true, requestId, nutrition: result.nutrition, model: result.model });
  } catch (e) {
    const profile = await loadProfile(supabase, userId);
    const nutrition = fallbackNutrition(Number(profile.weight || 75), String(body.goal || "maintenance"));
    return sendJson(res, 200, { ok: true, requestId, nutrition, fallback: true, error: String(e.message || "generation_failed") });
  }
};
