diff --git a/api/bodyscan.js b/api/bodyscan.js
--- a/api/bodyscan.js
+++ b/api/bodyscan.js
@@ -1,18 +1,47 @@
 "use strict";
 
 /**
  * /api/bodyscan
  * Compatible avec TON public/app.js:
  * - Input: { user_id, image_path } + header Authorization: Bearer <token>
  * - Output: { ok:true }
  * - Met à jour body_scans.ai_feedback + ai_version + scores
  */
 
-const { GoogleGenerativeAI } = require("@google/generative-ai");
 const { createClient } = require("@supabase/supabase-js");
 
+// IMPORTANT:
+// Do NOT require "@google/generative-ai" at top-level.
+// If the dependency is missing in Production (or installed as devDependency),
+// the function will crash BEFORE responding.
+let GoogleGenerativeAI = null;
+function getGoogleGenerativeAI() {
+  if (GoogleGenerativeAI) return GoogleGenerativeAI;
+  try {
+    const mod = require("@google/generative-ai");
+    GoogleGenerativeAI = mod.GoogleGenerativeAI;
+    return GoogleGenerativeAI;
+  } catch {
+    return null;
+  }
+}
+
 const BUCKET = process.env.BUCKET || "user_uploads";
 const MODEL_PRIMARY = process.env.GEMINI_MODEL || "gemini-2.0-flash";
 const MODEL_FALLBACK = process.env.GEMINI_MODEL_FALLBACK || "gemini-1.5-flash";
 
 function sendJson(res, status, payload) {
   res.statusCode = status;
   res.setHeader("Content-Type", "application/json; charset=utf-8");
   res.setHeader("Cache-Control", "no-store");
   res.end(JSON.stringify(payload));
 }
 
 function setCors(res) {
   res.setHeader("Access-Control-Allow-Origin", "*");
   res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
   res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
 }
 
@@ -44,6 +73,16 @@
 function withTimeout(promise, ms, label) {
   let t;
   const timeout = new Promise((_, reject) => {
     t = setTimeout(() => reject(Object.assign(new Error(label || "TIMEOUT"), { code: "TIMEOUT" })), ms);
   });
   return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
 }
 
+function guessMimeFromPath(path) {
+  const p = String(path || "").toLowerCase();
+  if (p.endsWith(".png")) return "image/png";
+  if (p.endsWith(".webp")) return "image/webp";
+  if (p.endsWith(".gif")) return "image/gif";
+  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
+  return "image/jpeg";
+}
+
 function safeJsonExtract(text) {
   const s = String(text || "").trim();
   const a = s.indexOf("{");
   const b = s.lastIndexOf("}");
   if (a === -1 || b === -1 || b <= a) return null;
   const slice = s.slice(a, b + 1);
   try { return JSON.parse(slice); } catch { return null; }
 }
@@ -112,7 +151,16 @@
   ].join("\n");
 }
 
 async function geminiVisionOnce({ apiKey, modelName, prompt, b64, mime }) {
-  const genAI = new GoogleGenerativeAI(apiKey);
+  const G = getGoogleGenerativeAI();
+  if (!G) {
+    const err = new Error('Missing dependency "@google/generative-ai" in Production build.');
+    err.code = "MISSING_DEP";
+    throw err;
+  }
+
+  const genAI = new G(apiKey);
   const model = genAI.getGenerativeModel({
     model: modelName,
     generationConfig: { temperature: 0.35, topP: 0.9, maxOutputTokens: 900 },
   });
 
   const result = await model.generateContent([
     { text: prompt },
     { inlineData: { data: b64, mimeType: mime } },
   ]);
 
-  return result?.response?.text?.() || "";
+  const resp = result?.response;
+  if (resp?.text && typeof resp.text === "function") return resp.text();
+  if (typeof resp?.text === "string") return resp.text;
+  return "";
 }
 
 async function geminiVisionWithRetry({ apiKey, prompt, b64, mime }) {
   // 1) modèle principal
   try {
     return { text: await geminiVisionOnce({ apiKey, modelName: MODEL_PRIMARY, prompt, b64, mime }), model: MODEL_PRIMARY };
   } catch (e) {
+    if (e?.code === "MISSING_DEP") throw e;
     const msg = String(e?.message || "");
     // 404 / modèle introuvable => on retente fallback
     if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
       const t = await geminiVisionOnce({ apiKey, modelName: MODEL_FALLBACK, prompt, b64, mime });
       return { text: t, model: MODEL_FALLBACK };
     }
     throw e;
   }
 }
@@ -140,6 +188,9 @@
 module.exports = async function handler(req, res) {
   setCors(res);
 
   const requestId =
     String(req.headers["x-vercel-id"] || req.headers["x-request-id"] || "") ||
     `${Date.now()}-${Math.random().toString(16).slice(2)}`;
 
+  // Always return JSON even on unexpected errors
+  const fail = (status, error, detail) => sendJson(res, status, { ok: false, error, detail, requestId });
+
   if (req.method === "OPTIONS") {
     res.statusCode = 204;
     return res.end();
   }
   if (req.method !== "POST") {
-    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
+    return fail(405, "METHOD_NOT_ALLOWED");
   }
 
   const SUPABASE_URL = process.env.SUPABASE_URL;
   const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
   const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
 
   if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
-    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_SUPABASE", requestId });
+    return fail(500, "SERVER_MISCONFIG_SUPABASE", "Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.");
   }
   if (!GEMINI_API_KEY) {
-    return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_GEMINI", requestId });
+    return fail(500, "SERVER_MISCONFIG_GEMINI", "Missing GEMINI_API_KEY.");
   }
 
   const token = getBearerToken(req);
-  if (!token) return sendJson(res, 401, { ok: false, error: "MISSING_BEARER", requestId });
+  if (!token) return fail(401, "MISSING_BEARER");
 
   const body = parseBody(req) || {};
   const user_id = String(body.user_id || "").trim();
   const image_path = String(body.image_path || "").trim();
 
   if (!user_id || !image_path) {
-    return sendJson(res, 400, { ok: false, error: "MISSING_FIELDS", requestId });
+    return fail(400, "MISSING_FIELDS", "Expected { user_id, image_path }.");
   }
 
   // Client admin (pour download storage + update DB)
   const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
     auth: { persistSession: false, autoRefreshToken: false },
   });
 
   // Vérif token => on récupère l'utilisateur réel
   const u = await sbAdmin.auth.getUser(token);
+  if (u?.error) {
+    console.error("[bodyscan] auth_getUser_error", { requestId, msg: u.error.message });
+    return fail(401, "BAD_TOKEN", u.error.message);
+  }
   const authedUserId = u?.data?.user?.id || "";
-  if (!authedUserId) return sendJson(res, 401, { ok: false, error: "BAD_TOKEN", requestId });
+  if (!authedUserId) return fail(401, "BAD_TOKEN");
 
   // Interdit d'analyser un autre user
-  if (authedUserId !== user_id) return sendJson(res, 403, { ok: false, error: "FORBIDDEN", requestId });
+  if (authedUserId !== user_id) return fail(403, "FORBIDDEN");
 
   try {
     // 1) download image depuis Storage (bucket privé OK avec service role)
     const dl = await withTimeout(sbAdmin.storage.from(BUCKET).download(image_path), 12000, "FETCH_TIMEOUT");
     if (dl.error || !dl.data) {
-      return sendJson(res, 404, { ok: false, error: "IMAGE_NOT_FOUND", detail: dl.error?.message || "", requestId });
+      return fail(404, "IMAGE_NOT_FOUND", dl.error?.message || "");
     }
 
     const ab = await dl.data.arrayBuffer();
     if (ab.byteLength > 6 * 1024 * 1024) {
-      return sendJson(res, 413, { ok: false, error: "IMAGE_TOO_LARGE", requestId });
+      return fail(413, "IMAGE_TOO_LARGE", "Max 6MB.");
     }
 
-    // mime best-effort
-    const mime = dl.data.type || "image/jpeg";
+    // mime best-effort (Blob.type not reliable on server)
+    const mime = guessMimeFromPath(image_path);
     const b64 = Buffer.from(ab).toString("base64");
 
     // 2) Gemini Vision
     const prompt = buildVisionPrompt();
     const { text, model } = await withTimeout(
       geminiVisionWithRetry({ apiKey: GEMINI_API_KEY, prompt, b64, mime }),
       25000,
       "AI_TIMEOUT"
     );
 
     const parsed = safeJsonExtract(text);
     const analysis = normalizeAnalysis(parsed);
 
     if (!analysis) {
       // On stocke quand même un feedback minimal pour ne pas avoir "vide"
       const fallback = `Analyse IA invalide (format). Extrait:\n${String(text || "").slice(0, 800)}`;
       const upd = await sbAdmin
         .from("body_scans")
         .update({
           ai_feedback: fallback,
           ai_version: model,
           symmetry_score: null,
           posture_score: null,
           bodyfat_proxy: null,
         })
         .eq("user_id", user_id)
         .eq("image_path", image_path);
 
-      if (upd.error) return sendJson(res, 500, { ok: false, error: "DB_UPDATE_FAILED", detail: upd.error.message, requestId });
+      if (upd.error) return fail(500, "DB_UPDATE_FAILED", upd.error.message);
       return sendJson(res, 200, { ok: true, model, requestId, warning: "BAD_FORMAT" });
     }
 
     // 3) update DB (aligné avec app.js)
     const upd = await sbAdmin
       .from("body_scans")
       .update({
         ai_feedback: analysis.feedback,
         ai_version: model,
         symmetry_score: analysis.symmetry_score,
         posture_score: analysis.posture_score,
         bodyfat_proxy: analysis.bodyfat_proxy,
       })
       .eq("user_id", user_id)
       .eq("image_path", image_path);
 
-    if (upd.error) return sendJson(res, 500, { ok: false, error: "DB_UPDATE_FAILED", detail: upd.error.message, requestId });
+    if (upd.error) return fail(500, "DB_UPDATE_FAILED", upd.error.message);
 
     return sendJson(res, 200, { ok: true, model, requestId });
   } catch (err) {
     const msg = String(err?.message || "UPSTREAM_ERROR");
-    if (err?.code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "TIMEOUT", requestId });
+    if (err?.code === "TIMEOUT") return fail(504, "TIMEOUT");
+    if (err?.code === "MISSING_DEP") return fail(500, "SERVER_MISCONFIG_DEPENDENCY", msg);
 
     // upstream Gemini (429/403/404/etc) => 502
     const m = msg.toLowerCase();
     if (m.includes("429") || m.includes("quota") || m.includes("rate")) {
-      return sendJson(res, 502, { ok: false, error: "UPSTREAM_RATE_LIMIT", detail: msg, requestId });
+      return fail(502, "UPSTREAM_RATE_LIMIT", msg);
     }
     if (m.includes("403") || m.includes("unauthorized") || m.includes("forbidden") || m.includes("api key")) {
-      return sendJson(res, 502, { ok: false, error: "UPSTREAM_AUTH_FAILED", detail: msg, requestId });
+      return fail(502, "UPSTREAM_AUTH_FAILED", msg);
     }
     if (m.includes("404") || m.includes("not found")) {
-      return sendJson(res, 502, { ok: false, error: "UPSTREAM_NOT_FOUND", detail: msg, requestId });
+      return fail(502, "UPSTREAM_NOT_FOUND", msg);
     }
 
-    return sendJson(res, 502, { ok: false, error: "UPSTREAM_ERROR", detail: msg, requestId });
+    console.error("[bodyscan] error", { requestId, code: err?.code || "", msg });
+    return fail(502, "UPSTREAM_ERROR", msg);
   }
 };
