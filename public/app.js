(() => {
  "use strict";

  const APP = {
    sb: null,
    cfg: null,
    session: null,
    user: null,
    busy: new Set(),
    _booted: false,
    _createClient: null,
    _supabaseImportPromise: null,
    kpis: { recovery: 75, weight: 75, sleep: 7 },
    goal: null,
  };

  const $id = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  const safeText = (el, t) => { if (el) el.textContent = String(t ?? ""); };
  const show = (el, yes) => { if (el) el.style.display = yes ? "" : "none"; };
  const disable = (el, yes) => { if (el) { el.disabled = !!yes; el.setAttribute("aria-disabled", yes ? "true" : "false"); } };

  const isBusy = (k) => APP.busy.has(k);
  const setBusy = (k, yes) => { if (yes) APP.busy.add(k); else APP.busy.delete(k); };

  function toast(msg, kind = "info") {
    if (kind === "error") console.error("[toast]", msg);
    else console.log("[toast]", msg);
    const hint = $id("profileHint");
    if (hint) {
      hint.textContent = String(msg);
      hint.style.color = kind === "error" ? "rgba(255,59,48,.95)" : "rgba(183,255,42,.95)";
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { hint.textContent = ""; hint.style.color = ""; }, 4000);
    }
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  let _loaderCount = 0;
  function showLoader(yes) {
    if (yes) {
      _loaderCount++;
      if (_loaderCount === 1) {
        const loader = $id("globalLoader");
        if (loader) loader.style.display = "flex";
      }
    } else {
      _loaderCount = Math.max(0, _loaderCount - 1);
      if (_loaderCount === 0) {
        const loader = $id("globalLoader");
        if (loader) loader.style.display = "none";
      }
    }
  }

  const TAB_MAP = [
    { btn: "tabBtnDash", section: "tab-dash" },
    { btn: "tabBtnGoal", section: "tab-goal" },
    { btn: "tabBtnCoach", section: "tab-coach" },
    { btn: "tabBtnNutrition", section: "tab-nutrition" },
    { btn: "tabBtnCommunity", section: "tab-community" },
    { btn: "tabBtnProfile", section: "tab-profile" },
    { btn: "tabBtnBodyScan", section: "tab-bodyscan" },
  ];

  function setActiveTab(btnId) {
    for (const t of TAB_MAP) {
      const b = $id(t.btn);
      const s = $id(t.section);
      const active = t.btn === btnId;
      if (b) {
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      }
      if (s) s.style.display = active ? "" : "none";
    }
  }

  function bindTabs() {
    for (const t of TAB_MAP) {
      const b = $id(t.btn);
      if (!b || b._fitaiBound) continue;
      b.addEventListener("click", () => {
        console.log("[tabs] Switching to", t.btn);
        setActiveTab(t.btn);
      });
      b._fitaiBound = true;
    }
  }

  function loadKPIs() {
    try {
      const s = localStorage.getItem("fitai_kpis");
      if (s) {
        const parsed = JSON.parse(s);
        APP.kpis = { recovery: parsed.recovery || 75, weight: parsed.weight || 75, sleep: parsed.sleep || 7 };
      }
    } catch {}
    return APP.kpis;
  }

  function saveKPIs() {
    try {
      localStorage.setItem("fitai_kpis", JSON.stringify(APP.kpis));
    } catch {}
  }

  function renderKPIs() {
    safeText($id("valRecovery"), APP.kpis.recovery);
    safeText($id("valWeight"), APP.kpis.weight);
    safeText($id("valSleep"), APP.kpis.sleep);
    renderBrief();
  }

  function renderBrief() {
    const el = $id("morningBrief");
    if (!el) return;
    const { recovery, weight, sleep } = APP.kpis;
    let brief = "☀️ ";
    if (recovery < 60) brief += "Recovery faible. Journée récup recommandée.";
    else if (recovery >= 80 && sleep >= 7) brief += "Conditions optimales. Go push hard!";
    else brief += `Recovery: ${recovery}%, Poids: ${weight}kg, Sommeil: ${sleep}h.`;
    el.textContent = brief;
  }

  function loadGoal() {
    try {
      const s = localStorage.getItem("fitai_goal_v1");
      if (s) {
        APP.goal = JSON.parse(s);
      }
    } catch {}
    return APP.goal;
  }

  function saveGoal(goal) {
    try {
      localStorage.setItem("fitai_goal_v1", JSON.stringify(goal));
      APP.goal = goal;
    } catch {}
  }

  function renderGoalSummary() {
    const el = $id("goalSummary");
    if (!el) return;
    if (!APP.goal || !APP.goal.text) {
      el.innerHTML = `<div class="empty">Aucun objectif défini.</div>`;
      return;
    }
    const { text, type, level } = APP.goal;
    el.innerHTML = `
      <div class="chip lime" style="margin-bottom:10px">${esc(type || "")}</div>
      <div class="chip orange" style="margin-bottom:10px">${esc(level || "")}</div>
      <div style="margin-top:12px">${esc(text)}</div>
    `;
  }

  async function getCreateClient() {
    if (APP._createClient) return APP._createClient;
    if (!APP._supabaseImportPromise) {
      APP._supabaseImportPromise = import("https://esm.sh/@supabase/supabase-js@2");
    }
    const mod = await APP._supabaseImportPromise;
    if (!mod || typeof mod.createClient !== "function") throw new Error("Supabase module introuvable");
    APP._createClient = mod.createClient;
    return APP._createClient;
  }

  async function loadConfigAndInitSupabase() {
    let r;
    try {
      r = await fetch("/api/workout?config=1", { cache: "no-store" });
    } catch (e) {
      throw new Error(`Impossible de contacter /api/workout (réseau): ${e.message}`);
    }

    const contentType = r.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    console.log("[config] status:", r.status, "content-type:", contentType);

    if (!r.ok) {
      if (!isJson) {
        const txt = await r.text().catch(() => "");
        console.error("[config] HTML response:", txt.slice(0, 200));
        throw new Error(`Config endpoint retourne HTML au lieu de JSON (${r.status}). Probable 404/500.`);
      }
      const err = await safeJson(r);
      if (err?.ok === false) {
        console.error("[config] error response:", err);
        const detail = err.detail || "";
        const requestId = err.requestId || "";
        if (err.error === "SERVER_MISCONFIG_SUPABASE_PUBLIC") {
          throw new Error(`❌ CONFIG SUPABASE MANQUANTE\n\n${detail}\n\nRequest ID: ${requestId}`);
        }
        throw new Error(`Config endpoint erreur: ${err.error}\n${detail}\nRequest ID: ${requestId}`);
      }
      const txt = await r.text().catch(() => "");
      throw new Error(`Config endpoint HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }

    if (!isJson) {
      const txt = await r.text().catch(() => "");
      console.error("[config] Non-JSON 200 response:", txt.slice(0, 200));
      throw new Error(`Config endpoint retourne du non-JSON malgré status 200.`);
    }

    const cfg = await safeJson(r);
    if (!cfg) throw new Error("Config endpoint: JSON parse échoué.");

    console.log("[config] parsed:", { ok: cfg.ok, hasUrl: !!cfg.supabaseUrl, hasAnon: !!cfg.supabaseAnonKey });

    if (cfg.ok === false) {
      throw new Error(`Config endpoint retourne {ok:false}: ${cfg.error || "UNKNOWN"}\n${cfg.detail || ""}`);
    }

    const missing = [];
    if (!cfg.supabaseUrl) missing.push("supabaseUrl");
    if (!cfg.supabaseAnonKey) missing.push("supabaseAnonKey");
    if (missing.length > 0) {
      throw new Error(`Config endpoint JSON incomplet. Clés manquantes: ${missing.join(", ")}`);
    }

    const createClient = await getCreateClient();
    APP.cfg = cfg;
    APP.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { "x-client-info": "fitai-v3.2-prod" } },
    });

    if (!APP.sb) throw new Error("createClient retourne null/undefined");

    APP.sb.auth.onAuthStateChange((_evt, session) => {
      APP.session = session;
      APP.user = session?.user ?? null;
      renderAuth();
    });
  }

  async function bootstrapSession() {
    if (!APP.sb) return;
    const { data, error } = await APP.sb.auth.getSession();
    if (error) throw error;
    APP.session = data?.session ?? null;
    APP.user = data?.session?.user ?? null;
  }

  function renderAuth() {
    const authStatus = $id("authStatus");
    const btnLogout = $id("btnLogout");
    if (!APP.user) {
      safeText(authStatus, "Non connecté");
      show(btnLogout, false);
      return;
    }
    safeText(authStatus, "Connecté");
    show(btnLogout, true);
  }

  async function actionMagicLink() {
    if (!APP.sb) return toast("Supabase non initialisé.", "error");
    const email = ($id("email")?.value ?? "").trim();
    if (!email) return toast("Email manquant.", "error");
    if (isBusy("magic")) return;
    setBusy("magic", true);
    const btn = $id("btnMagicLink");
    disable(btn, true);
    try {
      const { error } = await APP.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
      if (error) throw error;
      toast("Magic link envoyé ✅", "info");
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("magic", false);
    }
  }

  async function actionLogout() {
    if (!APP.sb) return toast("Supabase non initialisé.", "error");
    if (isBusy("logout")) return;
    setBusy("logout", true);
    const btn = $id("btnLogout");
    disable(btn, true);
    try {
      const { error } = await APP.sb.auth.signOut();
      if (error) throw error;
      toast("Déconnecté ✅", "info");
    } catch (e) {
      toast(`Logout: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("logout", false);
    }
  }

  function actionAdjustKPI(kpi, dir) {
    const delta = dir > 0 ? 1 : -1;
    if (kpi === "recovery") {
      APP.kpis.recovery = Math.max(0, Math.min(100, APP.kpis.recovery + delta * 5));
    } else if (kpi === "weight") {
      APP.kpis.weight = Math.max(30, Math.min(200, APP.kpis.weight + delta));
    } else if (kpi === "sleep") {
      APP.kpis.sleep = Math.max(0, Math.min(12, APP.kpis.sleep + delta * 0.5));
    }
    saveKPIs();
    renderKPIs();
  }

  function actionSaveGoal() {
    const text = ($id("goalText")?.value ?? "").trim();
    const type = $id("goalType")?.value || "muscle_gain";
    const level = $id("goalLevel")?.value || "intermediate";
    if (!text) return toast("Objectif vide.", "error");
    saveGoal({ text, type, level });
    renderGoalSummary();
    toast("Objectif sauvegardé ✅", "info");
  }

  async function actionCoachAsk() {
    const btn = $id("btnCoachAsk");
    const userPrompt = ($id("coachPrompt")?.value ?? "").trim();
    if (isBusy("coach")) return toast("Génération en cours...", "error");
    setBusy("coach", true);
    disable(btn, true);
    showLoader(true);

    const goalContext = APP.goal ? { type: APP.goal.type, level: APP.goal.level, text: APP.goal.text } : null;

    try {
      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userPrompt || "", goalContext }),
      });

      if (!r.ok) {
        const err = await safeJson(r);
        throw new Error(err?.error || `HTTP ${r.status}`);
      }

      const result = await safeJson(r);
      if (!result || result.ok === false) {
        throw new Error(result?.error || "Réponse invalide");
      }

      const plan = result.data || {};
      renderCoachPlan(plan);
      toast("Plan généré ✅", "info");
    } catch (e) {
      toast(`Coach: ${e.message || e}`, "error");
      const out = $id("coachOutput");
      if (out) out.innerHTML = `<div class="card"><div class="empty">Erreur: ${esc(e.message || String(e))}</div></div>`;
    } finally {
      showLoader(false);
      disable(btn, false);
      setBusy("coach", false);
    }
  }

  function renderCoachPlan(plan) {
    const out = $id("coachOutput");
    if (!out) return;
    const title = esc(plan.title || "Séance générée");
    const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
    const blocksHtml = blocks.map(b => {
      const items = Array.isArray(b.items) ? b.items : [];
      const durationSec = b.duration_sec || 0;
      const mins = Math.floor(durationSec / 60);
      return `
        <div class="card" style="margin-bottom:12px">
          <div style="font-weight:950">${esc(b.title || "Block")}</div>
          <div class="hint">${mins} min</div>
          <div class="hint" style="margin-top:8px">${items.map(x => "• " + esc(x)).join("<br>")}</div>
        </div>
      `;
    }).join("");
    out.innerHTML = `
      <div class="card">
        <div class="cardTitle">${title}</div>
        ${blocksHtml || `<div class="empty">Aucun bloc.</div>`}
      </div>
    `;
  }

  function bindEvents() {
    const bindClick = (id, fn) => {
      const el = $id(id);
      if (!el || el._fitaiBound) return;
      el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
      el._fitaiBound = true;
    };
    bindClick("btnMagicLink", actionMagicLink);
    bindClick("btnLogout", actionLogout);
    bindClick("btnSaveGoal", actionSaveGoal);
    bindClick("btnCoachAsk", actionCoachAsk);

    document.querySelectorAll(".kpiBtn").forEach(btn => {
      if (btn._fitaiBound) return;
      btn.addEventListener("click", () => {
        const kpi = btn.getAttribute("data-kpi");
        const dir = parseInt(btn.getAttribute("data-dir") || "0", 10);
        actionAdjustKPI(kpi, dir);
      });
      btn._fitaiBound = true;
    });
  }

  async function boot() {
    if (APP._booted) {
      console.warn("[boot] Already booted, skipping");
      return;
    }
    APP._booted = true;
    console.log("[boot] Starting...");

    try {
      bindTabs();
      bindEvents();
      setActiveTab("tabBtnDash");
      loadKPIs();
      loadGoal();
      renderKPIs();
      renderGoalSummary();
      showLoader(true);

      await loadConfigAndInitSupabase();
      await bootstrapSession();

      renderAuth();
      showLoader(false);
      toast("App ready ✅", "info");
      console.log("[boot] Success");
    } catch (e) {
      showLoader(false);
      console.error("[boot] FAILED:", e);

      const main = document.querySelector("main.container");
      if (main) {
        const banner = document.createElement("div");
        banner.style.cssText = `
          position: fixed; top: 80px; left: 50%; transform: translateX(-50%); z-index: 1000;
          max-width: 800px; width: 90%;
          background: rgba(255,59,48,.15); border: 2px solid rgba(255,59,48,.5);
          border-radius: 16px; padding: 20px; color: rgba(255,59,48,.95);
          font-weight: 900; text-align: center; line-height: 1.6;
          box-shadow: 0 20px 60px rgba(255,59,48,.3);
        `;
        banner.innerHTML = `
          <div style="font-size: 18px; margin-bottom: 10px;">⚠️ ERREUR CONFIGURATION</div>
          <div style="font-size: 13px; font-weight: 700; white-space: pre-wrap; font-family: monospace;">${esc(e.message || String(e))}</div>
        `;
        document.body.appendChild(banner);
      }

      toast(`BOOT FAILED: ${e.message || e}`, "error");
      const btnLogout = $id("btnLogout");
      show(btnLogout, false);
    }
  }

  window.addEventListener("DOMContentLoaded", boot, { once: true });

  window.addEventListener("error", (evt) => {
    const msg = evt?.message || "JS error";
    console.error("[global error]", msg);
    toast(`Erreur: ${msg}`, "error");
  });

  window.addEventListener("unhandledrejection", (evt) => {
    const msg = evt?.reason?.message || String(evt?.reason || "Promise error");
    console.error("[unhandled rejection]", msg);
    toast(`Erreur: ${msg}`, "error");
  });
})();
