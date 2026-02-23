--- a/api/bodyscan.js
+++ b/api/bodyscan.js
@@ -207,21 +207,26 @@ async function geminiVisionOnce({ apiKey, modelName, prompt, b64, mime }) {
   });
 
   // Promise.race timeout (AbortController non supporté par SDK)
   const startTime = Date.now();
+  let timeoutId;
+  
   const timeoutPromise = new Promise((_, reject) => {
-    setTimeout(() => {
+    timeoutId = setTimeout(() => {
       const elapsed = Date.now() - startTime;
-      console.warn("[bodyscan] Gemini Vision timeout triggered", { elapsedMs: elapsed, model: modelName });
+      console.warn("[bodyscan] Gemini Vision timeout triggered", { elapsedMs: elapsed, model: modelName, requestId: "N/A" });
       const err = new Error("Gemini Vision timeout");
       err.code = "TIMEOUT";
       reject(err);
     }, TIMEOUT_GEMINI_MS);
   });
 
   const generatePromise = model.generateContent([
       { text: prompt },
       { inlineData: { data: b64, mimeType: mime } },
     ]).then(result => {
-    const elapsed = Date.now() - startTime;
-    console.log("[bodyscan] Gemini Vision completed", { elapsedMs: elapsed, model: modelName });
-
     const resp = result?.response;
     if (resp?.text && typeof resp.text === "function") return resp.text();
     if (typeof resp?.text === "string") return resp.text;
     return "";
-  });
+  }).finally(() => {
+    clearTimeout(timeoutId);
+    const elapsed = Date.now() - startTime;
+    console.log("[bodyscan] Gemini Vision completed", { elapsedMs: elapsed, model: modelName });
+  });
 
   return Promise.race([generatePromise, timeoutPromise]);
@@ -266,7 +271,7 @@ async function handler(req, res) {
   // CRITICAL: Vérifier que image_path commence par user_id/
   const expectedPrefix = `${user_id}/`;
   if (!image_path.startsWith(expectedPrefix)) {
-    console.warn("[bodyscan] forbidden image_path", { requestId, user_id, image_path });
+    console.warn("[bodyscan] forbidden image_path", { requestId, expectedPrefix });
     return fail(403, "FORBIDDEN_IMAGE_PATH", `L'image doit être dans le dossier utilisateur (${expectedPrefix}*).`);
   }
 
@@ -332,7 +337,7 @@ async function handler(req, res) {
 
     const validation = validateAIResponse(analysis);
     if (!validation.valid) {
-      console.error("[bodyscan] invalid AI response", { requestId, error: validation.error, detail: validation.detail });
+      console.error("[bodyscan] invalid AI response", { requestId, error: validation.error });
       // On stocke quand même un feedback minimal
       const fallback = `❌ Analyse IA invalide: ${validation.detail}\n\nExtrait brut:\n${String(text || "").slice(0, 500)}`;
       
@@ -366,7 +371,7 @@ async function handler(req, res) {
     if (err?.code === "TIMEOUT") return fail(504, "TIMEOUT");
     if (err?.code === "MISSING_DEP") return fail(500, "SERVER_MISCONFIG_DEPENDENCY", msg);
 
-    // upstream Gemini (429/403/404/etc) => 502
+    // upstream Gemini errors
     const m = msg.toLowerCase();
     if (m.includes("429") || m.includes("quota") || m.includes("rate")) {
       return fail(502, "UPSTREAM_RATE_LIMIT", msg);
@@ -378,7 +383,7 @@ async function handler(req, res) {
       return fail(502, "UPSTREAM_NOT_FOUND", msg);
     }
 
-    console.error("[bodyscan] error", { requestId, code: err?.code || "", msg });
+    console.error("[bodyscan] error", { requestId, code: err?.code || "", errorType: err?.constructor?.name || "Error" });
     return fail(502, "UPSTREAM_ERROR", msg);
   }
 }
