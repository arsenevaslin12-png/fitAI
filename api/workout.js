diff --git a/api/workout.js b/api/workout.js
--- a/api/workout.js
+++ b/api/workout.js
@@ -1,6 +1,8 @@
 const { GoogleGenerativeAI } = require("@google/generative-ai");
 
-const MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
+const MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
+const MAX_PROMPT_LEN = 12000;
 
 function sendJson(res, status, payload) {
   res.statusCode = status;
@@ -109,6 +111,11 @@ module.exports = async function handler(req, res) {
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
@@ -116,33 +123,39 @@ module.exports = async function handler(req, res) {
   // ✅ CONFIG GET for front
   if (req.method === "GET") {
-    const isConfig = String(req.query?.config || "") === "1";
-    if (!isConfig) return sendJson(res, 404, { ok: false, error: "NOT_FOUND", requestId });
+    try {
+      const isConfig = String(req.query?.config || "") === "1";
+      if (!isConfig) return fail(404, "NOT_FOUND");
 
-    const supabaseUrl = process.env.SUPABASE_URL;
-    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
+      const supabaseUrl = process.env.SUPABASE_URL;
+      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
 
-    if (!supabaseUrl || !supabaseAnonKey) {
-      console.error("[workout] misconfig supabase public", { requestId, hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey });
-      return sendJson(res, 500, {
-        ok: false,
-        error: "SERVER_MISCONFIG_SUPABASE_PUBLIC",
-        detail: "Missing SUPABASE_URL and/or SUPABASE_ANON_KEY in Vercel env vars (Production/Preview/Development) + redeploy.",
-        requestId,
-      });
-    }
+      if (!supabaseUrl || !supabaseAnonKey) {
+        console.error("[workout] misconfig supabase public", { requestId, hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey });
+        // 500 but with a clear machine error and detail
+        return fail(
+          500,
+          "SERVER_MISCONFIG_SUPABASE_PUBLIC",
+          "Missing SUPABASE_URL and/or SUPABASE_ANON_KEY in Vercel env vars (Production/Preview/Development) + redeploy."
+        );
+      }
 
-    return sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
+      return sendJson(res, 200, { ok: true, supabaseUrl, supabaseAnonKey, requestId });
+    } catch (e) {
+      console.error("[workout] config_get_error", { requestId, msg: e?.message, stack: e?.stack });
+      return fail(500, "CONFIG_ENDPOINT_FAILED", "Unexpected failure in config handler.");
+    }
   }
 
   if (req.method !== "POST") {
-    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });
+    return fail(405, "METHOD_NOT_ALLOWED");
   }
 
   const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
   if (!GEMINI_API_KEY) {
     console.error("[workout] misconfig gemini", { requestId, hasGeminiKey: false });
-    return sendJson(res, 500, {
-      ok: false,
-      error: "SERVER_MISCONFIG_GEMINI",
-      detail: "Missing GEMINI_API_KEY in Vercel env vars (Production/Preview/Development) + redeploy.",
-      requestId,
-    });
+    return fail(500, "SERVER_MISCONFIG_GEMINI", "Missing GEMINI_API_KEY in Vercel env vars (Production/Preview/Development) + redeploy.");
   }
@@ -165,8 +178,8 @@ module.exports = async function handler(req, res) {
     if (goal || level || equipment) prompt = buildPromptFromGoal({ goal, level, equipment });
   }
 
-  if (!prompt) return sendJson(res, 400, { ok: false, error: "MISSING_PROMPT", requestId });
-  if (prompt.length > MAX_PROMPT_LEN) return sendJson(res, 400, { ok: false, error: "PROMPT_TOO_LONG", requestId });
+  if (!prompt) return fail(400, "MISSING_PROMPT");
+  if (prompt.length > MAX_PROMPT_LEN) return fail(400, "PROMPT_TOO_LONG");
