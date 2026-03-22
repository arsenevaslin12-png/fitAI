"use strict";

const DEFAULT_MODEL = "gemini-2.0-flash";
const FALLBACK_MODEL = "gemini-2.0-flash-lite";
const DEFAULT_TIMEOUT_MS = 10000;
const STREAM_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const FORBIDDEN_MODELS = new Set([
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro"
]);

let GeminiCtor = null;

function getGeminiCtor() {
  if (GeminiCtor) return GeminiCtor;
  try {
    GeminiCtor = require("@google/generative-ai").GoogleGenerativeAI;
    return GeminiCtor;
  } catch {
    return null;
  }
}

function sanitizeModelName(value) {
  const model = String(value || "").trim();
  if (!model) return "";
  return FORBIDDEN_MODELS.has(model) ? "" : model;
}

function uniqueModels() {
  const customPrimary = sanitizeModelName(process.env.GEMINI_MODEL);
  const customFallback = sanitizeModelName(process.env.GEMINI_FALLBACK_MODEL);
  const preferred = [customPrimary || DEFAULT_MODEL, customFallback || FALLBACK_MODEL];
  return [...new Set(preferred.filter(Boolean))];
}

function extractText(response) {
  const txt = response?.response?.text;
  if (typeof txt === "function") return String(txt() || "");
  return String(txt || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = "GEMINI_TIMEOUT") {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label);
      error.code = "TIMEOUT";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function extractJson(text) {
  const raw = String(text || "").trim();
  const direct = tryParseJson(raw);
  if (direct) return direct;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = tryParseJson(fenceMatch[1]);
    if (fenced) return fenced;
  }

  const firstArr = raw.indexOf("[");
  const lastArr = raw.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) {
    const arr = tryParseJson(raw.slice(firstArr, lastArr + 1));
    if (arr) return arr;
  }

  const firstObj = raw.indexOf("{");
  const lastObj = raw.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    return tryParseJson(raw.slice(firstObj, lastObj + 1));
  }
  return null;
}

function isModelIssue(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("404") || msg.includes("not found") || msg.includes("not supported") || msg.includes("unknown model") || msg.includes("model");
}

function isAuthIssue(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("api key") || msg.includes("permission") || msg.includes("unauth") || msg.includes("forbidden") || msg.includes("403");
}

function isQuotaIssue(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource exhausted");
}

function isRetryableIssue(error) {
  if (!error) return false;
  if (error.code === "TIMEOUT") return true;
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("deadline") ||
    msg.includes("tempor") ||
    msg.includes("unavailable") ||
    msg.includes("internal") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("socket") ||
    msg.includes("network")
  );
}

function normalizeGeminiError(error) {
  const msg = String(error?.message || "Gemini unavailable");
  if (isAuthIssue(error)) return { code: "AUTH", status: 502, message: "Clé Gemini invalide, absente ou refusée." };
  if (isQuotaIssue(error)) return { code: "QUOTA", status: 429, message: "Quota Gemini dépassé pour le moment." };
  if (error?.code === "TIMEOUT" || msg.includes("TIMEOUT")) return { code: "TIMEOUT", status: 504, message: "Gemini a dépassé le délai de réponse." };
  if (isModelIssue(error)) return { code: "MODEL", status: 502, message: "Modèle Gemini indisponible ou non pris en charge." };
  if (msg.includes("JSON")) return { code: "INVALID_JSON", status: 502, message: "Réponse Gemini invalide." };
  if (msg.includes("manquant")) return { code: "MISSING_DEP", status: 500, message: msg };
  return { code: "GENERIC", status: 502, message: msg };
}

async function callGeminiText({
  apiKey,
  prompt,
  contents,
  temperature = 0.5,
  maxOutputTokens = 1200,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES
}) {
  const Gemini = getGeminiCtor();
  if (!Gemini) {
    const err = new Error("@google/generative-ai manquant");
    err.code = "MISSING_DEP";
    throw err;
  }
  if (!String(apiKey || "").trim()) {
    const err = new Error("GEMINI_API_KEY manquant");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const client = new Gemini(String(apiKey).trim());
  let lastError = null;

  for (const modelName of uniqueModels()) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature, maxOutputTokens }
        });
        const input = contents || prompt || "";
        const result = await withTimeout(model.generateContent(input), timeoutMs);
        const text = extractText(result);
        if (!String(text || "").trim()) {
          const err = new Error("EMPTY_GEMINI_RESPONSE");
          err.code = "EMPTY";
          throw err;
        }
        return { model: modelName, text };
      } catch (error) {
        lastError = error;
        if (isAuthIssue(error) || isQuotaIssue(error)) break;
        if (isModelIssue(error)) break;
        if (attempt < retries && isRetryableIssue(error)) {
          await sleep((attempt + 1) * 250);
          continue;
        }
        break;
      }
    }
    if (lastError && (isAuthIssue(lastError) || isQuotaIssue(lastError))) break;
  }

  throw lastError || new Error("Gemini unavailable");
}

async function callGeminiStream({
  apiKey,
  prompt,
  contents,
  temperature = 0.6,
  maxOutputTokens = 900,
  timeoutMs = STREAM_TIMEOUT_MS,
  onChunk
}) {
  const Gemini = getGeminiCtor();
  if (!Gemini) { const err = new Error("@google/generative-ai manquant"); err.code = "MISSING_DEP"; throw err; }
  if (!String(apiKey || "").trim()) { const err = new Error("GEMINI_API_KEY manquant"); err.code = "MISSING_API_KEY"; throw err; }

  const client = new Gemini(String(apiKey).trim());
  const modelName = uniqueModels()[0];
  const model = client.getGenerativeModel({ model: modelName, generationConfig: { temperature, maxOutputTokens } });
  const input = contents || prompt || "";
  return withTimeout((async () => {
    const { stream } = await model.generateContentStream(input);
    let fullText = "";
    for await (const chunk of stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        if (typeof onChunk === "function") onChunk(text);
      }
    }
    if (!fullText.trim()) { const err = new Error("EMPTY_STREAM_RESPONSE"); err.code = "EMPTY"; throw err; }
    return { model: modelName, text: fullText };
  })(), timeoutMs, "GEMINI_STREAM_TIMEOUT");
}

module.exports = {
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  DEFAULT_TIMEOUT_MS,
  STREAM_TIMEOUT_MS,
  DEFAULT_RETRIES,
  FORBIDDEN_MODELS,
  getGeminiCtor,
  sanitizeModelName,
  uniqueModels,
  withTimeout,
  tryParseJson,
  extractJson,
  isModelIssue,
  isAuthIssue,
  isQuotaIssue,
  isRetryableIssue,
  normalizeGeminiError,
  callGeminiText,
  callGeminiStream
};
