diff --git a/api/workout.js b/api/workout.js
index 1111111..2222222 100644
--- a/api/workout.js
+++ b/api/workout.js
@@ -1,6 +1,12 @@
 const { GoogleGenerativeAI } = require("@google/generative-ai");
 
-const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
+// PROD SAFE DEFAULT:
+// "gemini-1.5-flash" can 404 on v1beta generateContent depending on project/region/SDK routing.
+// Use a known working default and allow override via env.
+const MODEL = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();
+
+const MAX_PROMPT_LEN = 12000;
 
 function sendJson(res, status, payload) {
   res.statusCode = status;
@@ -39,6 +45,31 @@ function withTimeout(promise, ms, label) {
   return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
 }
 
+function inferGeminiStatusFromMessage(msg) {
+  const s = String(msg || "");
+  // The SDK error often embeds: "[404 Not Found] ..." or similar.
+  const m = s.match(/\[(\d{3})\s+[^\]]+\]/);
+  if (m && m[1]) return Number(m[1]);
+  if (/404\b/.test(s)) return 404;
+  if (/429\b/.test(s) || /rate limit|quota/i.test(s)) return 429;
+  if (/401\b/.test(s) || /unauthorized|forbidden|permission/i.test(s)) return 401;
+  return 0;
+}
+
+function toFrontPlanFromWorkout(workoutText) {
+  // Minimal plan compatible with public/app.js normalizePlan()
+  const t = String(workoutText || "").trim();
+  return {
+    title: "Séance générée",
+    intensity: "medium",
+    notes: t ? t.slice(0, 500) : "",
+    blocks: [
+      { title: "Main", duration_sec: 1500, items: t ? [t.slice(0, 220)] : ["Contenu généré"], rpe: "" },
+    ],
+    created_at: new Date().toISOString(),
+    source: "coach",
+  };
+}
+
 function safeJsonExtract(text) {
   const s = String(text || "").trim();
   const a = s.indexOf("{");
@@ -152,7 +183,7 @@ module.exports = async function handler(req, res) {
 
   let prompt = String(body.prompt || "").trim();
   if (!prompt) {
@@ -165,8 +196,8 @@ module.exports = async function handler(req, res) {
     if (goal || level || equipment) prompt = buildPromptFromGoal({ goal, level, equipment });
   }
 
   if (!prompt) return sendJson(res, 400, { ok: false, error: "MISSING_PROMPT", requestId });
-  if (prompt.length > 12000) return sendJson(res, 400, { ok: false, error: "PROMPT_TOO_LONG", requestId });
+  if (prompt.length > MAX_PROMPT_LEN) return sendJson(res, 400, { ok: false, error: "PROMPT_TOO_LONG", requestId });
 
   try {
     const text = await withTimeout(geminiText({ apiKey: GEMINI_API_KEY, prompt }), 25000, "AI_TIMEOUT");
@@ -176,13 +207,20 @@ module.exports = async function handler(req, res) {
     const plan = normalizeWorkout(parsed);
 
     if (!plan) {
+      // Return a front-compatible plan_json so the SPA doesn't fallback/error
+      const plan_json = toFrontPlanFromWorkout(text);
       return sendJson(res, 200, {
         ok: true,
         workout: String(text || "").trim() || "OK",
-        data: null,
+        data: null,
+        plan_json,
         model: MODEL,
         requestId,
       });
     }
@@ -199,18 +237,31 @@ module.exports = async function handler(req, res) {
   } catch (err) {
     const msg = String(err?.message || "SERVER_ERROR");
     const code = err?.code || "";
 
     console.error("[workout] error", { requestId, code, msg });
 
     if (code === "TIMEOUT" || msg.includes("TIMEOUT")) return sendJson(res, 504, { ok: false, error: "TIMEOUT", requestId });
 
-    // Gemini key invalid / blocked (best-effort detection)
+    // Gemini auth / permission (best-effort detection)
     const m = msg.toLowerCase();
     if (m.includes("api key") || m.includes("permission") || m.includes("unauthorized") || m.includes("forbidden")) {
       return sendJson(res, 502, { ok: false, error: "GEMINI_AUTH_FAILED", detail: "GEMINI_API_KEY invalid/blocked.", requestId });
     }
 
-    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR", requestId });
+    // Upstream model/quotas/etc should not be surfaced as 500 (internal).
+    const upstreamStatus = inferGeminiStatusFromMessage(msg);
+    if (upstreamStatus) {
+      // 404 model not found, 429 quota, etc.
+      return sendJson(res, 502, {
+        ok: false,
+        error: "UPSTREAM_GEMINI_ERROR",
+        upstreamStatus,
+        model: MODEL,
+        requestId,
+      });
+    }
+
+    return sendJson(res, 500, { ok: false, error: "SERVER_ERROR", requestId });
   }
 };
