--- a/api/workout.js
+++ b/api/workout.js
@@ -201,21 +201,26 @@ async function geminiText({ apiKey, prompt }) {
   });
 
   // Promise.race timeout (AbortController non supporté par SDK)
   const startTime = Date.now();
+  let timeoutId;
+  
   const timeoutPromise = new Promise((_, reject) => {
-    setTimeout(() => {
+    timeoutId = setTimeout(() => {
       const elapsed = Date.now() - startTime;
-      console.warn("[workout] Gemini timeout triggered", { elapsedMs: elapsed });
+      console.warn("[workout] Gemini timeout triggered", { elapsedMs: elapsed, requestId: "N/A" });
       const err = new Error("Gemini timeout");
       err.code = "TIMEOUT";
       reject(err);
     }, TIMEOUT_MS);
   });
 
   const generatePromise = model.generateContent(prompt).then(result => {
-    const elapsed = Date.now() - startTime;
-    console.log("[workout] Gemini completed", { elapsedMs: elapsed });
-    
     const resp = result?.response;
     if (resp?.text && typeof resp.text === "function") return resp.text();
     if (typeof resp?.text === "string") return resp.text;
     return "";
-  });
+  }).finally(() => {
+    clearTimeout(timeoutId);
+    const elapsed = Date.now() - startTime;
+    console.log("[workout] Gemini completed", { elapsedMs: elapsed });
+  });
 
   return Promise.race([generatePromise, timeoutPromise]);
@@ -313,7 +318,7 @@ async function handler(req, res) {
 
   const validation = validateInput(prompt, goalContext);
   if (!validation.valid) {
-    console.warn("[workout] invalid input", { requestId, error: validation.error, detail: validation.detail });
+    console.warn("[workout] invalid input", { requestId, error: validation.error, promptLength: prompt.length });
     return safeSendJson(res, 400, { ok: false, error: validation.error, detail: validation.detail, requestId });
   }
 
@@ -326,7 +331,7 @@ async function handler(req, res) {
 
     const outputValidation = validateAIOutput(normalized);
     if (!outputValidation.valid) {
-      console.error("[workout] invalid AI output", { requestId, error: outputValidation.error, detail: outputValidation.detail });
+      console.error("[workout] invalid AI output", { requestId, error: outputValidation.error });
       return safeSendJson(res, 502, { ok: false, error: outputValidation.error, detail: outputValidation.detail, requestId });
     }
 
@@ -336,7 +341,7 @@ async function handler(req, res) {
     const msg = String(err?.message || "SERVER_ERROR");
     const code = err?.code || "";
 
-    console.error("[workout] error", { requestId, code, msg });
+    console.error("[workout] error", { requestId, code, errorType: err?.constructor?.name || "Error" });
 
     if (code === "MISSING_DEP") {
       return safeSendJson(res, 500, { ok: false, error: "SERVER_MISCONFIG_DEPENDENCY", detail: msg, requestId });
