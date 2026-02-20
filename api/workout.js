diff --git a/api/workout.js b/api/workout.js
--- a/api/workout.js
+++ b/api/workout.js
@@ -1,6 +1,34 @@
-const { GoogleGenerativeAI } = require("@google/generative-ai");
+// IMPORTANT:
+// Do NOT require "@google/generative-ai" at top-level.
+// If missing in Production (or installed as devDependency),
+// the function would crash BEFORE responding (even for ?config=1).
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
 
 const MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
 const MAX_PROMPT_LEN = 12000;
 
+function getQueryParam(req, key) {
+  // Vercel Node serverless doesn't always provide req.query depending on routing.
+  // Parse from URL to be safe.
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
 function sendJson(res, status, payload) {
   res.statusCode = status;
   res.setHeader("Content-Type", "application/json; charset=utf-8");
@@ -109,6 +137,11 @@ module.exports = async function handler(req, res) {
   setCors(res);
 
   const requestId =
     String(req.headers["x-vercel-id"] || req.headers["x-request-id"] || "") ||
     `${Date.now()}-${Math.random().toString(16).slice(2)}`;
 
   // Always return JSON even on unexpected errors
   const fail = (status, error, detail) => sendJson(res, status, { ok: false, error, detail, requestId });
 
   if (req.method === "OPTIONS") {
     res.statusCode = 204;
     return res.end();
   }
 
   // ✅ CONFIG GET for front
   if (req.method === "GET") {
     try {
-      const isConfig = String(req.query?.config || "") === "1";
+      const isConfig = String(getQueryParam(req, "config") || "") === "1";
       if (!isConfig) return fail(404, "NOT_FOUND");
 
       const supabaseUrl = process.env.SUPABASE_URL;
       const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
@@ -145,7 +178,7 @@ module.exports = async function handler(req, res) {
       return sendJson(res, 200, { ok: true, supabaseUrl, supabaseAnonKey, requestId });
     } catch (e) {
       console.error("[workout] config_get_error", { requestId, msg: e?.message, stack: e?.stack });
       return fail(500, "CONFIG_ENDPOINT_FAILED", "Unexpected failure in config handler.");
     }
   }
 
   if (req.method !== "POST") {
     return fail(405, "METHOD_NOT_ALLOWED");
   }
@@ -165,6 +198,18 @@ module.exports = async function handler(req, res) {
   if (!prompt) return fail(400, "MISSING_PROMPT");
   if (prompt.length > MAX_PROMPT_LEN) return fail(400, "PROMPT_TOO_LONG");
+
+  // Ensure dependency exists BEFORE calling Gemini
+  const G = getGoogleGenerativeAI();
+  if (!G) {
+    return fail(
+      500,
+      "SERVER_MISCONFIG_DEPENDENCY",
+      'Missing dependency "@google/generative-ai" in Production build (check package.json dependencies + redeploy).'
+    );
+  }
 
-  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
+  const genAI = new G(GEMINI_API_KEY);
   const model = genAI.getGenerativeModel({
     model: MODEL,
     generationConfig: { temperature: 0.65, topP: 0.9, maxOutputTokens: 900 },
   });
