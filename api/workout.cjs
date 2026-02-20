diff --git a/api/workout.js b/api/workout.js
--- a/api/workout.js
+++ b/api/workout.js
@@ -1,6 +1,45 @@
-const { GoogleGenerativeAI } = require("@google/generative-ai");
+// IMPORTANT: do not require "@google/generative-ai" at top-level.
+// If dependency/build/runtime fails, Vercel will crash BEFORE responding, even for ?config=1.
+let GoogleGenerativeAI = null;
+function getGoogleGenerativeAI() {
+  if (GoogleGenerativeAI) return GoogleGenerativeAI;
+  try {
+    const mod = require("@google/generative-ai");
+    GoogleGenerativeAI = mod.GoogleGenerativeAI;
+    return GoogleGenerativeAI;
+  } catch (e) {
+    return null;
+  }
+}
 
-const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
+const MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
 
 function sendJson(res, status, payload) {
   res.statusCode = status;
   res.setHeader("Content-Type", "application/json; charset=utf-8");
   res.setHeader("Cache-Control", "no-store");
   res.end(JSON.stringify(payload));
 }
 
 function setCors(res) {
   res.setHeader("Access-Control-Allow-Origin", "*");
   res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-fitai-client");
   res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
 }
 
+function getQueryParam(req, key) {
+  // Works even when req.query is undefined (common in raw Node serverless)
+  try {
+    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
+    const proto = req.headers["x-forwarded-proto"] || "https";
+    const url = new URL(req.url || "/", `${proto}://${host}`);
+    return url.searchParams.get(key);
+  } catch {
+    return null;
+  }
+}
+
 function parseBody(req) {
   const b = req.body;
   if (!b) return null;
@@ -74,8 +113,18 @@ async function geminiText({ apiKey, prompt }) {
-  const genAI = new GoogleGenerativeAI(apiKey);
+  const G = getGoogleGenerativeAI();
+  if (!G) {
+    const err = new Error('Missing dependency "@google/generative-ai" (check package.json dependencies + redeploy).');
+    err.code = "MISSING_DEP";
+    throw err;
+  }
+  const genAI = new G(apiKey);
   const model = genAI.getGenerativeModel({
     model: MODEL,
     generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens: 900 },
   });
@@ -109,21 +158,31 @@ module.exports = async function handler(req, res) {
   if (req.method === "OPTIONS") {
     res.statusCode = 204;
     return res.end();
   }
 
   // ✅ CONFIG GET for front
   if (req.method === "GET") {
-    const isConfig = String(req.query?.config || "") === "1";
+    const isConfig = String(getQueryParam(req, "config") || "") === "1";
     if (!isConfig) return sendJson(res, 404, { ok: false, error: "NOT_FOUND", requestId });
 
     const supabaseUrl = process.env.SUPABASE_URL;
     const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
 
     if (!supabaseUrl || !supabaseAnonKey) {
       console.error("[workout] misconfig supabase public", { requestId, hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey });
       return sendJson(res, 500, {
         ok: false,
         error: "SERVER_MISCONFIG_SUPABASE_PUBLIC",
         detail: "Missing SUPABASE_URL and/or SUPABASE_ANON_KEY in Vercel env vars (Production/Preview/Development) + redeploy.",
         requestId,
       });
     }
 
-    return sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
+    return sendJson(res, 200, { ok: true, supabaseUrl, supabaseAnonKey, requestId });
   }
@@ -205,6 +264,10 @@ module.exports = async function handler(req, res) {
   } catch (err) {
     const msg = String(err?.message || "SERVER_ERROR");
     const code = err?.code || "";
 
     console.error("[workout] error", { requestId, code, msg });
 
+    if (code === "MISSING_DEP") {
+      return sendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_DEPENDENCY", detail: msg, requestId });
+    }
+
     if (code === "TIMEOUT" || msg.includes("TIMEOUT")) return sendJson(res, 504, { ok: false, error: "TIMEOUT", requestId });
