(() => {
  "use strict";

  // ============================================================
  // APP STATE
  // ============================================================
  const APP = {
    sb: null,
    cfg: null,
    session: null,
    user: null,
    busy: new Set(),
    lastCoachPlan: null,
    feed: [],
    feedFilter: "recent",
    chart: null,
    _createClient: null,
    _supabaseImportPromise: null,
    _trophyCache: null,
    _trophyCacheExpiry: 0,
    _signedUrlCache: new Map(),
    timer: {
      blockId: null,
      totalSeconds: 0,
      remainingSeconds: 0,
      intervalId: null,
      isPaused: false,
    },
  };

  // ============================================================
  // CONSTANTS
  // ============================================================
  const MAX_DISPLAY_NAME_LENGTH = 40;
  const MAX_TITLE_LENGTH = 120;
  const MAX_NOTES_LENGTH = 500;
  const MAX_REPORT_REASON_LENGTH = 200;
  const MAX_GOAL_TEXT_LENGTH = 500;
  const MIN_GOAL_TEXT_LENGTH = 10;
  const MAX_GOAL_CONSTRAINTS_LENGTH = 300;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_COMPRESSED_SIZE = 4 * 1024 * 1024;
  const TROPHY_CACHE_MS = 45000;
  const SIGNED_URL_CACHE_MS = 30 * 60 * 1000;
  const SIGNED_URL_BUFFER_MS = 60 * 1000;
  const COACH_TIMEOUT_MS = 30000;
  const IMAGE_MAX_DIMENSION = 1200;
  const IMAGE_QUALITY = 0.78;
  const GOAL_STORAGE_KEY = "fitai_goal_v1";

  // ============================================================
  // DOM UTILS
  // ============================================================
  const $id = (id) => document.getElementById(id);
  const $q = (sel, root = document) => root.querySelector(sel);

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const safeText = (el, t) => {
    if (!el) return;
    el.textContent = String(t ?? "");
  };

  const safeHTML = (el, html) => {
    if (!el) return;
    el.innerHTML = html ?? "";
  };

  const show = (el, yes) => {
    if (!el) return;
    el.style.display = yes ? "" : "none";
  };

  const disable = (el, yes) => {
    if (!el) return;
    el.disabled = !!yes;
    el.setAttribute("aria-disabled", yes ? "true" : "false");
  };

  const isBusy = (k) => APP.busy.has(k);
  const setBusy = (k, yes) => {
    if (yes) APP.busy.add(k);
    else APP.busy.delete(k);
  };

  const nowISO = () => new Date().toISOString();

  const fmtDate = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    } catch {
      return String(iso);
    }
  };

  function toast(msg, kind = "info") {
    if (kind === "error") console.error(msg);
    else console.log(msg);

    const hint = $id("profileHint");
    if (hint) {
      hint.textContent = String(msg);
      hint.style.color = kind === "error" ? "rgba(255,59,48,.95)" : "rgba(183,255,42,.95)";
      clearTimeout(toast._t);
      toast._t = setTimeout(() => {
        hint.textContent = "";
        hint.style.color = "";
      }, 4000);
    }
  }

  async function safeJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function safeName(name) {
    return String(name || "upload").replace(/[^\w.-]+/g, "_");
  }

  function getTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ============================================================
  // LOADER GLOBAL
  // ============================================================
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

  // ============================================================
  // IMAGE COMPRESSION
  // ============================================================
  async function readImageMeta(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
        img.src = url;
      });
      return { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
    } finally {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  }

  async function compressToJpeg(file, maxDim = IMAGE_MAX_DIMENSION, quality = IMAGE_QUALITY) {
    const meta = await readImageMeta(file).catch(() => ({ width: 0, height: 0 }));
    const w = meta.width || 0;
    const h = meta.height || 0;

    if (!w || !h) return { blob: file, mime: file.type || "image/jpeg" };

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    if (scale === 1 && (file.type === "image/jpeg" || file.type === "image/jpg") && file.size <= MAX_COMPRESSED_SIZE) {
      return { blob: file, mime: "image/jpeg" };
    }

    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image decode failed"));
        img.src = url;
      });

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { blob: file, mime: file.type || "image/jpeg" };

      ctx.drawImage(img, 0, 0, outW, outH);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return { blob: file, mime: file.type || "image/jpeg" };
      return { blob, mime: "image/jpeg" };
    } finally {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  }

  // ============================================================
  // SIGNED URL CACHE
  // ============================================================
  async function getSignedUrl(path, forceRefresh = false) {
    const now = Date.now();
    const cached = APP._signedUrlCache.get(path);

    if (!forceRefresh && cached && cached.expiresAt > now + SIGNED_URL_BUFFER_MS) {
      return cached.url;
    }

    const { data, error } = await APP.sb.storage.from("user_uploads").createSignedUrl(path, SIGNED_URL_CACHE_MS / 1000);

    if (error || !data?.signedUrl) {
      APP._signedUrlCache.delete(path);
      return null;
    }

    APP._signedUrlCache.set(path, {
      url: data.signedUrl,
      expiresAt: now + SIGNED_URL_CACHE_MS,
    });

    return data.signedUrl;
  }

  // ============================================================
  // GOAL (OBJECTIF)
  // ============================================================
  function loadGoal() {
    try {
      const raw = localStorage.getItem(GOAL_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveGoal(obj) {
    localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify(obj));
  }

  function getGoalContext() {
    const goal = loadGoal();
    if (!goal) return null;

    return {
      text: goal.text || "",
      type: goal.type || "",
      level: goal.level || "",
      constraints: goal.constraints || "",
      hasPhoto: !!(goal.photo_path || ""),
      updatedAt: goal.updated_at || "",
    };
  }

  function renderGoal() {
    const container = $id("goalSummary");
    if (!container) return;

    const goal = loadGoal();
    if (!goal || !goal.text) {
      safeHTML(container, `<div class="empty">Aucun objectif défini.</div>`);
      return;
    }

    const type = esc(goal.type || "—");
    const level = esc(goal.level || "—");
    const text = esc(goal.text);
    const constraints = goal.constraints ? esc(goal.constraints) : "";
    const updated = fmtDate(goal.updated_at);
    const hasPhoto = !!(goal.photo_path || "");

    safeHTML(
      container,
      `
      <div class="feedCard">
        <div class="feedHeader">
          <div class="feedUser">Objectif actif</div>
          <div class="feedTime">${updated}</div>
        </div>
        <div class="row" style="gap:10px; margin-top:10px">
          <span class="badge orange">${type}</span>
          <span class="badge cyan">${level}</span>
          ${hasPhoto ? `<span class="badge lime">📷 Photo</span>` : ""}
        </div>
        <div class="feedTitle" style="margin-top:12px">${text}</div>
        ${constraints ? `<div class="hint" style="margin-top:8px">Contraintes: ${constraints}</div>` : ""}
      </div>
    `
    );
  }

  async function actionSaveGoal() {
    const textEl = $id("goalText");
    const typeEl = $id("goalType");
    const levelEl = $id("goalLevel");
    const constraintsEl = $id("goalConstraints");
    const fileEl = $id("goalPhoto");

    const text = (textEl?.value ?? "").trim();
    const type = (typeEl?.value ?? "").trim();
    const level = (levelEl?.value ?? "").trim();
    const constraints = (constraintsEl?.value ?? "").trim();
    const file = fileEl?.files?.[0] || null;

    if (!text) {
      toast("Objectif vide.", "error");
      textEl?.focus?.();
      return;
    }

    if (text.length < MIN_GOAL_TEXT_LENGTH) {
      toast(`Min ${MIN_GOAL_TEXT_LENGTH} caractères.`, "error");
      textEl?.focus?.();
      return;
    }

    if (text.length > MAX_GOAL_TEXT_LENGTH) {
      toast(`Max ${MAX_GOAL_TEXT_LENGTH} caractères.`, "error");
      textEl?.focus?.();
      return;
    }

    if (constraints.length > MAX_GOAL_CONSTRAINTS_LENGTH) {
      toast(`Max ${MAX_GOAL_CONSTRAINTS_LENGTH} caractères pour contraintes.`, "error");
      constraintsEl?.focus?.();
      return;
    }

    if (isBusy("saveGoal")) return toast("Enregistrement en cours...", "error");
    setBusy("saveGoal", true);
    showLoader(true);

    try {
      let photoPath = null;

      if (file) {
        if (!file.type.startsWith("image/")) {
          toast("Image uniquement.", "error");
          return;
        }

        if (file.size > MAX_FILE_SIZE) {
          toast("Max 10MB.", "error");
          return;
        }

        if (!APP.user) {
          toast("Connecte-toi pour uploader une photo.", "error");
        } else {
          const { blob } = await compressToJpeg(file).catch(() => ({ blob: file }));

          if (blob.size > MAX_COMPRESSED_SIZE) {
            toast("Compression insuffisante. Photo trop lourde.", "error");
            return;
          }

          const base = safeName(file.name).replace(/\.[^.]+$/, "");
          const path = `${APP.user.id}/goals/${Date.now()}_${base}.jpg`;

          const { error: upErr } = await APP.sb.storage.from("user_uploads").upload(path, blob, {
            upsert: false,
            contentType: "image/jpeg",
          });
          if (upErr) throw upErr;

          photoPath = path;
        }
      }

      const goalObj = {
        text,
        type,
        level,
        constraints,
        photo_path: photoPath || (loadGoal()?.photo_path ?? null),
        updated_at: nowISO(),
      };

      saveGoal(goalObj);

      toast("Objectif enregistré ✅", "info");
      renderGoal();

      if (textEl) textEl.value = "";
      if (constraintsEl) constraintsEl.value = "";
      if (fileEl) fileEl.value = "";
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      showLoader(false);
      setBusy("saveGoal", false);
    }
  }

  // ============================================================
  // TIMER
  // ============================================================
  function stopAllTimers() {
    if (APP.timer.intervalId) {
      clearInterval(APP.timer.intervalId);
      APP.timer.intervalId = null;
    }
    APP.timer.blockId = null;
    APP.timer.totalSeconds = 0;
    APP.timer.remainingSeconds = 0;
    APP.timer.isPaused = false;
  }

  function startTimer(blockId, seconds) {
    stopAllTimers();

    APP.timer.blockId = blockId;
    APP.timer.totalSeconds = seconds;
    APP.timer.remainingSeconds = seconds;
    APP.timer.isPaused = false;

    updateTimerDisplay(blockId);

    APP.timer.intervalId = setInterval(() => {
      if (APP.timer.isPaused) return;

      APP.timer.remainingSeconds--;

      if (APP.timer.remainingSeconds <= 0) {
        stopAllTimers();
        toast("Timer terminé ✅", "info");
      }

      updateTimerDisplay(blockId);
    }, 1000);
  }

  function pauseTimer() {
    APP.timer.isPaused = !APP.timer.isPaused;
    if (APP.timer.blockId) {
      updateTimerDisplay(APP.timer.blockId);
    }
  }

  function resetTimer(blockId, seconds) {
    stopAllTimers();
    APP.timer.blockId = blockId;
    APP.timer.totalSeconds = seconds;
    APP.timer.remainingSeconds = seconds;
    APP.timer.isPaused = false;
    updateTimerDisplay(blockId);
  }

  function updateTimerDisplay(blockId) {
    const displayEl = $q(`[data-timer-display="${blockId}"]`);
    if (!displayEl) return;

    const mins = Math.floor(APP.timer.remainingSeconds / 60);
    const secs = APP.timer.remainingSeconds % 60;
    displayEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    const pauseBtn = $q(`[data-timer-pause="${blockId}"]`);
    if (pauseBtn) pauseBtn.textContent = APP.timer.isPaused ? "Reprendre" : "Pause";
  }

  // ============================================================
  // TAB INJECTION
  // ============================================================
  function ensureExtraTabs() {
    const nav = $q(".tabs");
    const main = $q("main") || document.body;
    if (!nav || !main) return;

    const ensureTabButton = (id, label) => {
      if ($id(id)) return;
      const btn = document.createElement("button");
      btn.className = "tabBtn";
      btn.id = id;
      btn.type = "button";
      btn.textContent = label;
      btn.setAttribute("aria-selected", "false");
      nav.appendChild(btn);
    };

    const ensureSection = (id, html) => {
      if ($id(id)) return;
      const section = document.createElement("section");
      section.id = id;
      section.style.display = "none";
      section.innerHTML = html;
      main.appendChild(section);
    };

    ensureSection(
      "tab-goal",
      `
      <div class="card">
        <div class="cardTitle">Définir ton Objectif</div>
        <div class="hint">Ton objectif sera automatiquement utilisé par le Coach IA pour personnaliser tes séances.</div>
        <div style="height:12px"></div>

        <label class="hint" for="goalText">Objectif (min 10 car, max 500)</label>
        <textarea id="goalText" placeholder="Ex: Je veux perdre 5kg en 3 mois tout en gagnant en force sur le haut du corps."></textarea>

        <div style="height:10px"></div>
        <div class="grid two">
          <div>
            <label class="hint" for="goalType">Type</label>
            <select id="goalType">
              <option>Perte poids</option>
              <option>Masse</option>
              <option>Endurance</option>
              <option>Force</option>
              <option>Mobilité</option>
              <option>Santé</option>
              <option>Autre</option>
            </select>
          </div>
          <div>
            <label class="hint" for="goalLevel">Niveau</label>
            <select id="goalLevel">
              <option>débutant</option>
              <option>intermédiaire</option>
              <option>avancé</option>
            </select>
          </div>
        </div>

        <div style="height:10px"></div>
        <label class="hint" for="goalConstraints">Contraintes / Limitations (max 300 car, optionnel)</label>
        <textarea id="goalConstraints" placeholder="Ex: Blessure genou, disponible 3x/semaine, préfère séances courtes"></textarea>

        <div style="height:10px"></div>
        <label class="hint" for="goalPhoto">Photo (optionnel, 10MB max)</label>
        <input class="input" id="goalPhoto" type="file" accept="image/*" />

        <div style="height:12px"></div>
        <button class="btn primary" id="btnSaveGoal" type="button">Enregistrer Objectif</button>

        <div class="hr"></div>
        <div class="cardTitle">Objectif actuel</div>
        <div id="goalSummary"></div>
      </div>
    `
    );

    ensureTabButton("tabBtnBodyScan", "Body Scan");
    ensureSection(
      "tab-bodyscan",
      `
      <div class="card">
        <div class="row between">
          <div class="cardTitle" style="margin:0">Body Scan (privé)</div>
          <span class="chip">Bucket: <span style="font-weight:950;margin-left:6px">user_uploads</span></span>
        </div>
        <div style="height:10px"></div>

        <div id="goalBadgeBodyScan"></div>

        <div class="row" style="gap:10px; align-items:center">
          <input class="input" id="bodyScanFile" type="file" accept="image/*" style="flex:1" />
          <button class="btn primary" id="btnUploadBodyScan" type="button">Upload</button>
          <button class="btn" id="btnRefreshBodyScans" type="button">Refresh</button>
        </div>

        <div class="hr"></div>
        <div id="bodyScansList"></div>
        <div class="hint" style="margin-top:10px">
          Fichiers privés. Max 10MB. Compression auto avant upload. L'upload enrichit les métadonnées avec ton Objectif actuel.
        </div>
      </div>
    `
    );

    if (!$id("globalLoader")) {
      const loader = document.createElement("div");
      loader.id = "globalLoader";
      loader.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(0,0,0,.65);
        backdrop-filter: blur(10px);
        display: none;
        align-items: center;
        justify-content: center;
      `;
      loader.innerHTML = `
        <div class="card" style="padding: 28px; text-align: center">
          <div class="spinner" style="width: 32px; height: 32px; margin: 0 auto 14px"></div>
          <div style="font-weight: 900; color: rgba(183,255,42,.95)">Chargement...</div>
        </div>
      `;
      document.body.appendChild(loader);
    }
  }

  // ============================================================
  // TAB MAP
  // ============================================================
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
    stopAllTimers();

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
      b.addEventListener("click", () => setActiveTab(t.btn));
      b._fitaiBound = true;
    }
  }

  // ============================================================
  // SUPABASE LOADER
  // ============================================================
  async function getCreateClient() {
    if (APP._createClient) return APP._createClient;
    if (!APP._supabaseImportPromise) {
      APP._supabaseImportPromise = import("https://esm.sh/@supabase/supabase-js@2");
    }
    const mod = await APP._supabaseImportPromise;
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("Supabase module introuvable");
    }
    APP._createClient = mod.createClient;
    return APP._createClient;
  }

  async function loadConfigAndInitSupabase() {
    const r = await fetch("/api/workout?config=1", { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Config endpoint HTTP ${r.status}: ${txt}`);
    }

    const cfg = await safeJson(r);
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      throw new Error("Config invalide");
    }

    const createClient = await getCreateClient();
    APP.cfg = cfg;
    APP.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { "x-client-info": "fitai-v3.2-prod" } },
    });

    APP.sb.auth.onAuthStateChange((_evt, session) => {
      APP.session = session;
      APP.user = session?.user ?? null;

      renderAuth();
      refreshProfileHint().catch(() => {});
      refreshTrophies().catch(() => {});
      refreshFeed().catch(() => {});
      refreshBodyScans().catch(() => {});
      refreshKPIs();
      refreshMorningBrief();
      renderGoal();
    });
  }

  async function bootstrapSession() {
    const { data, error } = await APP.sb.auth.getSession();
    if (error) throw error;
    APP.session = data?.session ?? null;
    APP.user = data?.session?.user ?? null;
  }

  // ============================================================
  // AUTH
  // ============================================================
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
    const email = ($id("email")?.value ?? "").trim();
    if (!email) return toast("Email manquant.", "error");
    if (isBusy("magic")) return;
    setBusy("magic", true);
    disable($id("btnMagicLink"), true);

    try {
      const { error } = await APP.sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      toast("Magic link envoyé ✅", "info");
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      disable($id("btnMagicLink"), false);
      setBusy("magic", false);
    }
  }

  async function actionLogout() {
    if (isBusy("logout")) return;
    setBusy("logout", true);
    disable($id("btnLogout"), true);

    try {
      const { error } = await APP.sb.auth.signOut();
      if (error) throw error;
      toast("Déconnecté ✅", "info");
    } catch (e) {
      toast(`Logout: ${e.message || e}`, "error");
    } finally {
      disable($id("btnLogout"), false);
      setBusy("logout", false);
    }
  }

  // ============================================================
  // PROFILE
  // ============================================================
  async function refreshProfileHint() {
    const hint = $id("profileHint");
    if (!hint) return;

    if (!APP.user) {
      hint.textContent = "Connecte-toi pour activer le feed + publier.";
      return;
    }

    try {
      const { data, error } = await APP.sb
        .from("public_profiles")
        .select("display_name")
        .eq("user_id", APP.user.id)
        .maybeSingle();
      if (error) throw error;

      const dn = (data?.display_name ?? "").trim();
      hint.textContent = dn ? `Profil: ${dn}` : "Profil: ajoute un nom (onglet Profile).";
    } catch {
      hint.textContent = "Profil: ajoute un nom (onglet Profile).";
    }
  }

  async function actionSaveName() {
    if (!APP.user) return toast("Connecte-toi d'abord.", "error");

    const input = $id("displayName");
    const btn = $id("btnSaveName");
    const raw = (input?.value ?? "").trim();

    if (!raw) {
      toast("Nom vide.", "error");
      input?.focus?.();
      return;
    }

    if (raw.length > MAX_DISPLAY_NAME_LENGTH) {
      toast(`Max ${MAX_DISPLAY_NAME_LENGTH} caractères.`, "error");
      return;
    }

    if (isBusy("saveName")) return;
    setBusy("saveName", true);
    disable(btn, true);

    try {
      const { error } = await APP.sb
        .from("public_profiles")
        .upsert({ user_id: APP.user.id, display_name: raw }, { onConflict: "user_id" });

      if (error) throw error;

      toast("Profil sauvegardé ✅", "info");
      await refreshProfileHint();
      await refreshTrophies(true);
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("saveName", false);
    }
  }

  function loadEquipment() {
    try {
      return JSON.parse(localStorage.getItem("fitai_equipment") || "{}");
    } catch {
      return {};
    }
  }

  function saveEquipment(obj) {
    localStorage.setItem("fitai_equipment", JSON.stringify(obj));
  }

  function applyEquipmentToUI() {
    const eq = loadEquipment();
    const map = [
      ["eqDumbbells", "dumbbells"],
      ["eqBarbell", "barbell"],
      ["eqBodyweight", "bodyweight"],
      ["eqMachines", "machines"],
    ];
    for (const [id, key] of map) {
      const el = $id(id);
      if (el) el.checked = !!eq[key];
    }
  }

  async function actionSaveEquipment() {
    const eq = {
      dumbbells: !!$id("eqDumbbells")?.checked,
      barbell: !!$id("eqBarbell")?.checked,
      bodyweight: !!$id("eqBodyweight")?.checked,
      machines: !!$id("eqMachines")?.checked,
    };
    saveEquipment(eq);
    toast("Équipement sauvegardé ✅", "info");
  }

  // ============================================================
  // TROPHIES
  // ============================================================
  async function sbCount(table, builderFn) {
    try {
      let q = APP.sb.from(table).select("*", { count: "exact", head: true });
      if (typeof builderFn === "function") q = builderFn(q) || q;
      const { count, error } = await q;
      if (error) return null;
      return typeof count === "number" ? count : null;
    } catch {
      return null;
    }
  }

  function renderTrophies(list) {
    const wall = $id("trophyWall");
    if (!wall) return;

    safeHTML(
      wall,
      list
        .map((t) => {
          const cls = t.ok ? "trophyCard unlocked" : "trophyCard locked";
          const icon = t.ok ? "🏆" : "🔒";
          return `
          <div class="${cls}">
            <div class="trophyIcon">${icon}</div>
            <div class="trophyInfo">
              <div class="trophyTitle">${esc(t.title)}</div>
              <div class="trophyDesc">${esc(t.desc)}</div>
              <div class="trophyMeta">${esc(t.meta)}</div>
            </div>
          </div>`;
        })
        .join("")
    );
  }

  let _trophiesBusy = false;
  async function refreshTrophies(force = false) {
    if (_trophiesBusy) return;

    if (!force && APP._trophyCache && Date.now() < APP._trophyCacheExpiry) {
      renderTrophies(APP._trophyCache);
      return;
    }

    _trophiesBusy = true;

    try {
      if (!APP.user) {
        const empty = [{ title: "Connecte-toi", desc: "Trophées disponibles une fois connecté.", ok: false, meta: "" }];
        renderTrophies(empty);
        return;
      }

      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const TOP7_MIN = 4;

      const [profData, bodyScanCountRaw, workouts7dRaw, myKudosData] = await Promise.all([
        APP.sb.from("public_profiles").select("display_name").eq("user_id", APP.user.id).maybeSingle(),
        sbCount("body_scans", (q) => q.eq("user_id", APP.user.id)),
        sbCount("workouts", (q) => q.eq("user_id", APP.user.id).gte("created_at", since)),
        APP.sb.from("workouts_feed").select("kudos_count").eq("user_id", APP.user.id).limit(200),
      ]);

      const hasPublicProfile = !!(profData?.data?.display_name ?? "").trim();
      const bodyScanCount = typeof bodyScanCountRaw === "number" ? bodyScanCountRaw : 0;
      const workouts7d = typeof workouts7dRaw === "number" ? workouts7dRaw : 0;

      let kudosReceived = 0;
      if (!myKudosData.error && Array.isArray(myKudosData.data)) {
        kudosReceived = myKudosData.data.reduce((acc, r) => acc + (Number(r?.kudos_count ?? 0) || 0), 0);
      }

      const list = [
        {
          title: "Profil public",
          desc: "Définis un display name.",
          ok: hasPublicProfile,
          meta: hasPublicProfile ? "OK" : "À faire",
        },
        {
          title: "Body Scan upload",
          desc: "Uploader au moins 1 body scan.",
          ok: bodyScanCount >= 1,
          meta: `${bodyScanCount}/1`,
        },
        {
          title: "Top 7 jours",
          desc: `Faire au moins ${TOP7_MIN} séances sur 7 jours.`,
          ok: workouts7d >= TOP7_MIN,
          meta: `${workouts7d}/${TOP7_MIN}`,
        },
        {
          title: "Premier kudos",
          desc: "Recevoir 1 kudos sur tes workouts.",
          ok: kudosReceived >= 1,
          meta: `${kudosReceived}/1`,
        },
      ];

      APP._trophyCache = list;
      APP._trophyCacheExpiry = Date.now() + TROPHY_CACHE_MS;

      renderTrophies(list);
    } finally {
      _trophiesBusy = false;
    }
  }

  // ============================================================
  // COACH
  // ============================================================
  function normalizePlan(rawPlan) {
    const plan = typeof rawPlan === "object" && rawPlan !== null ? rawPlan : {};

    const normalized = {
      title: String(plan.title || "Séance générée"),
      intensity: String(plan.intensity || "medium"),
      notes: String(plan.notes || ""),
      created_at: plan.created_at || nowISO(),
      source: plan.source || "coach",
      blocks: [],
    };

    const rawBlocks = Array.isArray(plan.blocks) ? plan.blocks : [];

    for (const b of rawBlocks) {
      if (!b || typeof b !== "object") continue;

      let durationSec = 0;

      if (typeof b.duration_sec === "number" && b.duration_sec > 0) durationSec = b.duration_sec;
      else if (typeof b.duration_min === "number" && b.duration_min > 0) durationSec = b.duration_min * 60;
      else durationSec = 180;

      normalized.blocks.push({
        title: String(b.title || "Block"),
        duration_sec: Math.max(10, durationSec),
        items: Array.isArray(b.items) ? b.items.map(String) : [],
        rpe: b.rpe || "",
      });
    }

    if (!normalized.blocks.length) {
      normalized.blocks = [
        { title: "Warm-up", duration_sec: 480, items: ["Mobilité", "Cardio léger"], rpe: "" },
        { title: "Main", duration_sec: 1500, items: ["3x mouvement principal", "2x accessoire"], rpe: "" },
        { title: "Cooldown", duration_sec: 300, items: ["Respiration", "Stretching"], rpe: "" },
      ];
    }

    return normalized;
  }

  function fallbackPlan(prompt) {
    return {
      title: "Séance générée (fallback)",
      intensity: "medium",
      notes: prompt ? `Prompt: ${prompt.slice(0, 100)}` : "",
      blocks: [
        { title: "Warm-up", duration_sec: 480, items: ["Mobilité", "Cardio léger"] },
        { title: "Main", duration_sec: 1500, items: ["3x mouvement principal", "2x accessoire"] },
        { title: "Cooldown", duration_sec: 300, items: ["Respiration", "Stretching"] },
      ],
      created_at: nowISO(),
      source: "fallback",
    };
  }

  async function actionCoachAsk() {
    const btn = $id("btnCoachAsk");
    const userPrompt = ($id("coachPrompt")?.value ?? "").trim();

    if (isBusy("coach")) return toast("Génération en cours...", "error");
    setBusy("coach", true);
    disable(btn, true);
    showLoader(true);

    stopAllTimers();

    let timeoutId = null;

    try {
      const goalContext = getGoalContext();

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), COACH_TIMEOUT_MS);
      });

      const fetchPromise = fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userPrompt || "", goalContext: goalContext || null }),
      }).then(async (r) => {
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}${txt ? `: ${txt}` : ""}`);
        }
        const out = await safeJson(r);
        return out?.data ?? out?.plan ?? out?.plan_json ?? null;
      });

      const rawPlan = await Promise.race([fetchPromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);

      const plan = normalizePlan(rawPlan);

      APP.lastCoachPlan = plan;
      renderCoach(plan);

      toast("Plan généré ✅", "info");
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);

      const plan = normalizePlan(fallbackPlan(userPrompt));
      APP.lastCoachPlan = plan;
      renderCoach(plan);

      const msg = e?.message === "TIMEOUT" ? "Coach: timeout (fallback)" : `Coach (fallback): ${e.message || e}`;
      toast(msg, "error");
    } finally {
      showLoader(false);
      disable(btn, false);
      setBusy("coach", false);
    }
  }

  function renderCoach(plan) {
    const out = $id("coachOutput");
    if (!out) return;

    const title = esc(plan.title || "Séance");
    const intensity = esc(plan.intensity || "");
    const notes = esc(plan.notes || "");
    const when = fmtDate(plan.created_at || nowISO());

    const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
    const blocksHtml = blocks
      .map((b, idx) => {
        const blockId = `block-${idx}`;
        const items = Array.isArray(b.items) ? b.items : [];
        const durationSec = b.duration_sec || 180;
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;

        return `
          <div class="exerciseCard">
            <div class="exerciseInfo">
              <div class="exerciseName">${esc(b.title || "Block")}</div>
              <div class="exerciseSpecs">${mins}min ${secs}s</div>
              <div class="hint">${items.map((x) => "• " + esc(x)).join("<br>")}</div>
              <div class="timerControls">
                <span class="timerDisplay" data-timer-display="${blockId}">00:00</span>
                <button class="btn" type="button" data-timer-start="${blockId}" data-duration="${durationSec}">Start</button>
                <button class="btn" type="button" data-timer-pause="${blockId}">Pause</button>
                <button class="btn" type="button" data-timer-reset="${blockId}" data-duration="${durationSec}">Reset</button>
              </div>
            </div>
            <div class="exerciseRPE">${esc(b.rpe ?? "")}</div>
          </div>
        `;
      })
      .join("");

    const publishDisabled = APP.user ? "" : "disabled";

    safeHTML(
      out,
      `
      <div class="card">
        <div class="cardTitle">Plan généré</div>
        <div class="row" style="gap:10px; margin-bottom:10px;">
          ${intensity ? `<span class="badge orange">${intensity}</span>` : ""}
          <span class="badge cyan">${esc(when)}</span>
          ${plan.source ? `<span class="badge">${esc(plan.source)}</span>` : ""}
        </div>

        <div class="feedTitle">${title}</div>
        ${notes ? `<div class="hint" style="margin-bottom:12px;">${notes}</div>` : ""}
        <div>${blocksHtml || `<div class="empty">Aucun bloc.</div>`}</div>

        <div class="hr"></div>
        <div class="row between">
          <div class="hint">Publier = INSERT dans workouts.</div>
          <div class="row" style="gap:10px;">
            <button class="btn" type="button" data-action="copy-plan">Copier JSON</button>
            <button class="btn primary" type="button" data-action="publish-plan" data-public="1" ${publishDisabled}>Publier</button>
            <button class="btn" type="button" data-action="publish-plan" data-public="0" ${publishDisabled}>Privé</button>
          </div>
        </div>
      </div>
    `
    );

    for (let idx = 0; idx < blocks.length; idx++) {
      const blockId = `block-${idx}`;
      const durationSec = blocks[idx].duration_sec || 180;
      resetTimer(blockId, durationSec);
    }
  }

  async function actionPublishPlan(isPublic) {
    if (!APP.user) return toast("Connecte-toi pour publier.", "error");
    if (!APP.lastCoachPlan) return toast("Génère une séance d'abord.", "error");
    if (isBusy("publish")) return toast("Action en cours...", "error");

    setBusy("publish", true);
    try {
      const p = APP.lastCoachPlan;

      const payload = {
        user_id: APP.user.id,
        is_public: !!isPublic,
        title: String(p.title || "Séance"),
        intensity: String(p.intensity || "medium"),
        notes: String(p.notes || ""),
        plan_json: p,
      };

      const { error } = await APP.sb.from("workouts").insert(payload);
      if (error) throw error;

      toast(isPublic ? "Publié ✅" : "Sauvé (privé) ✅", "info");
      await refreshFeed();
      await refreshTrophies(true);
      setActiveTab("tabBtnCommunity");
    } catch (e) {
      toast(`Publish: ${e.message || e}`, "error");
    } finally {
      setBusy("publish", false);
    }
  }

  async function actionCopyPlan() {
    if (!APP.lastCoachPlan) return toast("Rien à copier.", "error");
    try {
      const txt = JSON.stringify(APP.lastCoachPlan, null, 2);
      await navigator.clipboard.writeText(txt);
      toast("JSON copié ✅", "info");
    } catch {
      toast("Copie impossible.", "error");
    }
  }

  // ============================================================
  // FEED (unchanged functional)
  // ============================================================
  function normalizeFeedRow(w) {
    return {
      id: w.id,
      display: w.display_name || "Anonymous",
      title: w.title || "Untitled",
      intensity: w.intensity || "",
      notes: w.notes || "",
      created_at: w.created_at || "",
      kudos_count: Number(w.kudos_count ?? 0),
      liked_by_me: typeof w.liked_by_me === "boolean" ? w.liked_by_me : false,
      is_public: typeof w.is_public === "boolean" ? w.is_public : true,
      user_id: w.user_id || "",
    };
  }

  function renderFeed() {
    const container = $id("feedContainer");
    if (!container) return;

    const filterBar = document.createElement("div");
    filterBar.className = "row";
    filterBar.style.marginBottom = "14px";
    filterBar.style.gap = "10px";

    const filters = [
      { key: "recent", label: "Récent" },
      { key: "top7d", label: "Top 7j" },
      { key: "mylikes", label: "Mes likes", needsAuth: true },
      { key: "myworkouts", label: "Mes séances", needsAuth: true },
    ];

    for (const f of filters) {
      if (f.needsAuth && !APP.user) continue;
      const btn = document.createElement("button");
      btn.className = APP.feedFilter === f.key ? "btn primary" : "btn";
      btn.type = "button";
      btn.textContent = f.label;
      btn.addEventListener("click", async () => {
        APP.feedFilter = f.key;
        await refreshFeed();
      });
      filterBar.appendChild(btn);
    }

    safeHTML(container, "");
    container.appendChild(filterBar);

    const list = document.createElement("div");
    list.id = "feedList";
    container.appendChild(list);

    if (!APP.feed.length) {
      safeHTML(
        list,
        `
        <div class="empty">Feed vide.</div>
        <div style="height:10px"></div>
        <button class="btn primary" type="button" data-action="seed-example" ${APP.user ? "" : "disabled"}>Publier une séance exemple</button>
      `
      );
      return;
    }

    safeHTML(
      list,
      APP.feed
        .map((raw) => {
          const w = normalizeFeedRow(raw);
          const liked = !!w.liked_by_me;
          const btnClass = liked ? "kudosBtn liked" : "kudosBtn";
          const badgeIntensity = w.intensity ? `<span class="badge orange">${esc(w.intensity)}</span>` : "";
          const badgePublic = w.is_public ? `<span class="badge lime">PUBLIC</span>` : `<span class="badge red">PRIVÉ</span>`;

          const isOwn = APP.user && APP.user.id === w.user_id;
          const ownerActions = isOwn
            ? `
            <button class="btn" data-action="edit-workout" data-id="${esc(w.id)}" type="button">Éditer</button>
            <button class="btn" data-action="delete-workout" data-id="${esc(w.id)}" type="button" style="border-color:rgba(255,59,48,.3);color:rgba(255,59,48,.9)">Supprimer</button>
          `
            : "";

          const reportBtn =
            APP.user && !isOwn
              ? `<button class="btn" data-action="report-workout" data-id="${esc(w.id)}" type="button" style="font-size:11px;padding:8px 10px">⚠️ Signaler</button>`
              : "";

          return `
          <div class="feedCard" data-workout-id="${esc(w.id)}">
            <div class="feedHeader">
              <div class="feedUser">${esc(w.display)} <span class="feedBadges" style="margin-left:8px">${badgePublic}</span></div>
              <div class="feedTime">${esc(fmtDate(w.created_at))}</div>
            </div>
            <div class="feedTitle">${esc(w.title)}</div>
            <div class="row" style="gap:10px; margin-bottom:10px">
              ${badgeIntensity}
              ${w.notes ? `<span class="hint">${esc(w.notes)}</span>` : ""}
            </div>
            <div class="feedActions">
              <div class="row" style="gap:8px; flex-wrap:wrap">
                <button class="${btnClass}" type="button" data-action="toggle-kudos" data-id="${esc(w.id)}" ${APP.user ? "" : "disabled"}>
                  ${liked ? "❤️" : "🤍"} Kudos <span style="opacity:.9">(${w.kudos_count})</span>
                </button>
                ${ownerActions}
                ${reportBtn}
              </div>
              ${!APP.user ? `<span class="hint">Connecte-toi pour interagir.</span>` : ""}
            </div>
          </div>`;
        })
        .join("")
    );
  }

  async function refreshFeed() {
    const chip = $id("feedStatus");
    const btn = $id("btnRefreshFeed");
    if (btn) disable(btn, true);
    if (chip) safeText(chip, "Chargement…");

    try {
      let query = APP.sb.from("workouts_feed").select("*");

      if (APP.feedFilter === "top7d") {
        const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        query = query.gte("created_at", since).order("kudos_count", { ascending: false }).order("created_at", { ascending: false });
      } else if (APP.feedFilter === "mylikes" && APP.user) {
        const { data: liked } = await APP.sb.from("kudos").select("workout_id").eq("user_id", APP.user.id);
        const ids = (liked || []).map((k) => k.workout_id).slice(0, 200);
        if (!ids.length) {
          APP.feed = [];
          if (chip) safeText(chip, "OK • 0");
          renderFeed();
          return;
        }
        query = query.in("id", ids).order("created_at", { ascending: false });
      } else if (APP.feedFilter === "myworkouts" && APP.user) {
        query = query.eq("user_id", APP.user.id).order("created_at", { ascending: false });
      } else {
        query = query.order("created_at", { ascending: false });
      }

      query = query.limit(60);

      const { data, error } = await query;
      if (error) throw error;

      APP.feed = Array.isArray(data) ? data : [];
      if (chip) safeText(chip, `OK • ${APP.feed.length}`);
      renderFeed();
    } catch (e) {
      if (chip) safeText(chip, "Erreur");
      toast(`Feed: ${e.message || e}`, "error");
    } finally {
      if (btn) disable(btn, false);
    }
  }

  async function toggleKudos(workoutId) {
    if (!APP.user) return toast("Connecte-toi pour liker.", "error");
    if (!workoutId) return;

    const idx = APP.feed.findIndex((x) => x.id === workoutId);
    if (idx < 0) return;

    const lockKey = `kudos:${workoutId}`;
    if (isBusy(lockKey)) return toast("Action en cours...", "error");
    setBusy(lockKey, true);

    const row = { ...APP.feed[idx] };
    const w = normalizeFeedRow(row);
    const wasLiked = !!w.liked_by_me;

    try {
      if (wasLiked) {
        row.liked_by_me = false;
        row.kudos_count = Math.max(0, Number(row.kudos_count ?? 0) - 1);
      } else {
        row.liked_by_me = true;
        row.kudos_count = Number(row.kudos_count ?? 0) + 1;
      }
      APP.feed[idx] = row;
      renderFeed();

      if (wasLiked) {
        await APP.sb.from("kudos").delete().eq("workout_id", workoutId).eq("user_id", APP.user.id);
      } else {
        await APP.sb.from("kudos").insert({ workout_id: workoutId, user_id: APP.user.id });
      }

      await refreshFeed();
      await refreshTrophies(true);
    } catch (e) {
      await refreshFeed();
      toast(`Kudos: ${e.message || e}`, "error");
    } finally {
      setBusy(lockKey, false);
    }
  }

  async function actionDeleteWorkout(workoutId) {
    if (!APP.user) return toast("Connecte-toi.", "error");
    if (!workoutId) return;

    if (!confirm("Supprimer cette séance définitivement ?")) return;

    if (isBusy("deleteWorkout")) return toast("Action en cours...", "error");
    setBusy("deleteWorkout", true);
    showLoader(true);

    try {
      const { error } = await APP.sb.from("workouts").delete().eq("id", workoutId).eq("user_id", APP.user.id);
      if (error) throw error;

      toast("Séance supprimée ✅", "info");
      await refreshFeed();
      await refreshTrophies(true);
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      showLoader(false);
      setBusy("deleteWorkout", false);
    }
  }

  async function actionEditWorkout(workoutId) {
    if (!APP.user) return toast("Connecte-toi.", "error");
    if (!workoutId) return;

    if (isBusy("editWorkout")) return toast("Action en cours...", "error");
    setBusy("editWorkout", true);
    showLoader(true);

    try {
      const { data, error } = await APP.sb
        .from("workouts")
        .select("title, notes, is_public")
        .eq("id", workoutId)
        .eq("user_id", APP.user.id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return toast("Séance introuvable.", "error");

      const newTitle = prompt("Titre (max 120 car):", data.title || "")?.trim();
      if (newTitle === null) return;
      if (!newTitle || newTitle.length === 0) return toast("Titre vide.", "error");
      if (newTitle.length > MAX_TITLE_LENGTH) return toast(`Max ${MAX_TITLE_LENGTH} car.`, "error");

      const newNotes = prompt("Notes (max 500 car):", data.notes || "")?.trim() || "";
      if (newNotes.length > MAX_NOTES_LENGTH) return toast(`Max ${MAX_NOTES_LENGTH} car.`, "error");

      const newPublic = confirm("Public ? (OK = oui, Annuler = privé)");

      const { error: updateErr } = await APP.sb
        .from("workouts")
        .update({ title: newTitle, notes: newNotes, is_public: newPublic })
        .eq("id", workoutId)
        .eq("user_id", APP.user.id);

      if (updateErr) throw updateErr;

      toast("Séance modifiée ✅", "info");
      await refreshFeed();
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      showLoader(false);
      setBusy("editWorkout", false);
    }
  }

  async function actionReportWorkout(workoutId) {
    if (!APP.user) return toast("Connecte-toi.", "error");
    if (!workoutId) return;

    const reason = prompt("Raison du signalement (max 200 car):")?.trim();
    if (!reason) return;
    if (reason.length > MAX_REPORT_REASON_LENGTH) return toast(`Max ${MAX_REPORT_REASON_LENGTH} car.`, "error");

    if (isBusy("report")) return toast("Action en cours...", "error");
    setBusy("report", true);

    try {
      const { error } = await APP.sb.from("reports").insert({
        workout_id: workoutId,
        reporter_user_id: APP.user.id,
        reason,
      });

      if (error) {
        if (String(error.code) === "23505") return toast("Déjà signalé.", "info");
        throw error;
      }

      toast("Signalement envoyé ✅", "info");
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      setBusy("report", false);
    }
  }

  async function seedExampleWorkout() {
    if (!APP.user) return toast("Connecte-toi d'abord.", "error");
    if (isBusy("seed")) return toast("Action en cours...", "error");
    setBusy("seed", true);

    try {
      const example = {
        title: "Séance exemple (FitAI)",
        intensity: "easy",
        notes: "Exemple auto.",
        blocks: [
          { title: "Warm-up", duration_sec: 360, items: ["Marche", "Mobilité"] },
          { title: "Main", duration_sec: 1080, items: ["Pompes", "Squats"] },
          { title: "Cooldown", duration_sec: 240, items: ["Stretching"] },
        ],
      };

      await APP.sb.from("workouts").insert({
        user_id: APP.user.id,
        is_public: true,
        title: example.title,
        intensity: example.intensity,
        notes: example.notes,
        plan_json: example,
      });

      toast("Séance exemple publiée ✅", "info");
      await refreshFeed();
      await refreshTrophies(true);
      setActiveTab("tabBtnCommunity");
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      setBusy("seed", false);
    }
  }

  // ============================================================
  // BODY SCAN
  // ============================================================
  let _bodyScanOffset = 0;
  const BODYSCAN_LIMIT = 10;

  function renderGoalBadgeBodyScan() {
    const container = $id("goalBadgeBodyScan");
    if (!container) return;

    const goal = loadGoal();
    if (!goal || !goal.text) {
      safeHTML(container, "");
      return;
    }

    const type = esc(goal.type || "—");
    const level = esc(goal.level || "—");

    safeHTML(
      container,
      `
      <div class="card" style="background: rgba(183,255,42,.06); border-color: rgba(183,255,42,.20); margin-bottom:12px">
        <div class="hint" style="color: rgba(183,255,42,.95); font-weight:950">🎯 Objectif actif</div>
        <div class="row" style="gap:10px; margin-top:8px">
          <span class="badge orange">${type}</span>
          <span class="badge cyan">${level}</span>
        </div>
        <div class="hint" style="margin-top:8px">Les uploads enrichissent automatiquement les métadonnées avec ton objectif.</div>
      </div>
    `
    );
  }

  async function actionUploadBodyScan() {
    if (!APP.user) return toast("Connecte-toi.", "error");

    const fileEl = $id("bodyScanFile");
    const file = fileEl?.files?.[0] || null;
    if (!file) return toast("Choisis un fichier.", "error");

    if (!file.type.startsWith("image/")) {
      toast("Image uniquement.", "error");
      if (fileEl) fileEl.value = "";
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      toast("Max 10MB.", "error");
      if (fileEl) fileEl.value = "";
      return;
    }

    const btn = $id("btnUploadBodyScan");
    if (isBusy("uploadScan")) return toast("Upload en cours...", "error");
    setBusy("uploadScan", true);
    disable(btn, true);
    showLoader(true);

    try {
      const { blob } = await compressToJpeg(file).catch(() => ({ blob: file }));

      if (blob.size > MAX_COMPRESSED_SIZE) {
        toast("Compression insuffisante. Choisis une photo plus petite.", "error");
        return;
      }

      const base = safeName(file.name).replace(/\.[^.]+$/, "");
      const path = `${APP.user.id}/bodyscans/${Date.now()}_${base}.jpg`;

      const { error: upErr } = await APP.sb.storage.from("user_uploads").upload(path, blob, {
        upsert: false,
        contentType: "image/jpeg",
      });
      if (upErr) throw upErr;

      const goalContext = getGoalContext();
      const meta = {
        original_name: file.name,
        content_type: "image/jpeg",
        size: blob.size || null,
      };

      if (goalContext) {
        meta.goal_type = goalContext.type;
        meta.goal_level = goalContext.level;
        meta.goal_text_excerpt = goalContext.text.slice(0, 100);
        meta.constraints_excerpt = goalContext.constraints.slice(0, 100);
        meta.goal_photo_enabled = goalContext.hasPhoto;
        meta.goal_updated_at = goalContext.updatedAt;
      }

      try {
        await APP.sb.from("body_scans").insert({
          user_id: APP.user.id,
          file_path: path,
          meta,
        });
      } catch (e) {
        if (String(e?.code) !== "42P01") throw e;
      }

      toast("Upload OK ✅", "info");
      if (fileEl) fileEl.value = "";
      _bodyScanOffset = 0;
      await refreshBodyScans();
      await refreshTrophies(true);
    } catch (e) {
      toast(`Upload: ${e.message || e}`, "error");
    } finally {
      showLoader(false);
      disable(btn, false);
      setBusy("uploadScan", false);
    }
  }

  async function refreshBodyScans(loadMore = false) {
    const box = $id("bodyScansList");
    if (!box) return;

    renderGoalBadgeBodyScan();

    if (!APP.user) {
      safeHTML(box, `<div class="empty">Connecte-toi.</div>`);
      return;
    }

    if (!loadMore) {
      _bodyScanOffset = 0;
      safeHTML(box, `<div class="row" style="gap:10px"><div class="spinner"></div><div class="muted">Chargement…</div></div>`);
    }

    try {
      const { data, error, count } = await APP.sb
        .from("body_scans")
        .select("id,file_path,created_at,meta", { count: "exact" })
        .eq("user_id", APP.user.id)
        .order("created_at", { ascending: false })
        .range(_bodyScanOffset, _bodyScanOffset + BODYSCAN_LIMIT - 1);

      if (error) {
        if (String(error.code) === "42P01") {
          safeHTML(box, `<div class="empty">Historique désactivé (table body_scans absente).</div>`);
          return;
        }
        throw error;
      }

      const rows = Array.isArray(data) ? data : [];
      const total = typeof count === "number" ? count : 0;

      if (!loadMore && !rows.length) {
        safeHTML(box, `<div class="empty">Aucun fichier.</div>`);
        return;
      }

      const urls = await Promise.all(rows.map((r) => getSignedUrl(r.file_path)));

      const parts = rows.map((r, idx) => {
        const url = urls[idx];
        const name = esc(r.meta?.original_name || r.file_path);
        const when = esc(fmtDate(r.created_at));

        const goalBadge = r.meta?.goal_type ? `<span class="badge lime">🎯 ${esc(r.meta.goal_type)}</span>` : "";

        return `
          <div class="feedCard">
            <div class="feedHeader">
              <div class="feedUser">${name}</div>
              <div class="feedTime">${when}</div>
            </div>
            ${goalBadge ? `<div class="row" style="margin-top:8px">${goalBadge}</div>` : ""}
            <div class="row" style="margin-top:10px; gap:10px">
              ${url ? `<a class="btn" href="${url}" target="_blank" rel="noreferrer">Ouvrir</a>` : `<span class="badge red">URL failed</span>`}
            </div>
          </div>
        `;
      });

      _bodyScanOffset += rows.length;
      const hasMore = _bodyScanOffset < total;

      if (!loadMore) safeHTML(box, parts.join(""));
      else box.insertAdjacentHTML("beforeend", parts.join(""));

      const existingBtn = $id("btnLoadMoreBodyScans");
      if (existingBtn) existingBtn.remove();

      if (hasMore) {
        const btn = document.createElement("button");
        btn.id = "btnLoadMoreBodyScans";
        btn.className = "btn primary";
        btn.type = "button";
        btn.textContent = "Charger plus";
        btn.style.marginTop = "12px";
        btn.addEventListener("click", () => refreshBodyScans(true));
        box.appendChild(btn);
      }
    } catch (e) {
      safeHTML(box, `<div class="empty">Erreur: ${esc(e.message || e)}</div>`);
    }
  }

  // ============================================================
  // KPIs + NUTRITION (same)
  // ============================================================
  function loadKPIs() {
    try {
      const v = JSON.parse(localStorage.getItem("fitai_kpis") || "{}");
      return {
        recovery: Number.isFinite(v.recovery) ? v.recovery : 65,
        weight: Number.isFinite(v.weight) ? v.weight : 75,
        sleep: Number.isFinite(v.sleep) ? v.sleep : 7,
      };
    } catch {
      return { recovery: 65, weight: 75, sleep: 7 };
    }
  }

  function saveKPIs(k) {
    localStorage.setItem("fitai_kpis", JSON.stringify(k));
  }

  function refreshKPIs() {
    const k = loadKPIs();
    safeText($id("val-recovery"), `${Math.round(k.recovery)}`);
    safeText($id("val-weight"), `${Math.round(k.weight)}`);
    safeText($id("val-sleep"), `${(Math.round(k.sleep * 10) / 10).toFixed(1)}`);
    safeText($id("protein-target"), Math.round(k.weight * 1.8));
    safeText($id("cal-target"), Math.round(k.weight * 30));
  }

  function refreshMorningBrief() {
    const el = $id("morningBrief");
    if (!el) return;

    if (!APP.user) {
      el.textContent = "Connecte-toi pour activer le suivi.";
      return;
    }
    const k = loadKPIs();
    el.textContent = `Recovery ${Math.round(k.recovery)} • ${Math.round(k.weight)}kg • ${Math.round(k.sleep * 10) / 10}h`;
  }

  function onKpiClick(btn) {
    const kpi = btn.getAttribute("data-kpi");
    const dir = Number(btn.getAttribute("data-dir") || "0");
    if (!kpi || !dir) return;

    const k = loadKPIs();
    if (kpi === "recovery") k.recovery = Math.max(0, Math.min(100, k.recovery + dir * 2));
    if (kpi === "weight") k.weight = Math.max(30, Math.min(250, k.weight + dir * 1));
    if (kpi === "sleep") k.sleep = Math.max(0, Math.min(24, k.sleep + dir * 0.25));

    saveKPIs(k);
    refreshKPIs();
    refreshMorningBrief();
  }

  function mealKey() {
    return `fitai_meals_${getTodayKey()}`;
  }

  function loadMeals() {
    try {
      return JSON.parse(localStorage.getItem(mealKey()) || "[]");
    } catch {
      return [];
    }
  }

  function saveMeals(arr) {
    localStorage.setItem(mealKey(), JSON.stringify(arr));
  }

  function renderNutrition() {
    const meals = loadMeals();
    let cal = 0,
      prot = 0,
      carbs = 0,
      fats = 0;

    for (const m of meals) {
      cal += Number(m.cal || 0);
      prot += Number(m.prot || 0);
      carbs += Number(m.carbs || 0);
      fats += Number(m.fats || 0);
    }

    safeText($id("cal-total"), Math.round(cal));
    safeText($id("macro-protein"), `${Math.round(prot)}g`);
    safeText($id("macro-carbs"), Math.round(carbs));
    safeText($id("macro-fats"), Math.round(fats));

    const container = $id("mealsContainer");
    if (!container) return;

    if (!meals.length) {
      safeHTML(container, `<div class="empty">Aucun repas aujourd'hui.</div>`);
      return;
    }

    safeHTML(
      container,
      meals
        .slice()
        .reverse()
        .map(
          (m, idx) => `
        <div class="feedCard">
          <div class="feedHeader">
            <div class="feedUser">${esc(m.type || "Repas")}</div>
            <div class="feedTime">${esc(m.time || "")}</div>
          </div>
          <div class="hint" style="margin-top:8px">${esc(m.desc || "")}</div>
          <div class="row" style="margin-top:10px; gap:10px">
            <span class="badge cyan">${Math.round(m.cal || 0)} kcal</span>
            <span class="badge">${Math.round(m.prot || 0)}g P</span>
            <span class="badge">${Math.round(m.carbs || 0)}g G</span>
            <span class="badge">${Math.round(m.fats || 0)}g L</span>
            <button class="btn" data-action="delete-meal" data-index="${idx}" type="button" style="margin-left:auto">Suppr</button>
          </div>
        </div>`
        )
        .join("")
    );
  }

  function openMealModal(open) {
    const modal = $id("mealModal");
    if (!modal) return;
    modal.style.display = open ? "flex" : "none";
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function clearMealForm() {
    const ids = ["mealCal", "mealDesc", "mealProt", "mealCarbs", "mealFats"];
    for (const id of ids) {
      const el = $id(id);
      if (el) el.value = "";
    }
  }

  function actionSaveMeal() {
    const type = ($id("mealType")?.value ?? "Repas").trim();
    const cal = Number($id("mealCal")?.value || 0);
    const desc = ($id("mealDesc")?.value ?? "").trim();
    const prot = Number($id("mealProt")?.value || 0);
    const carbs = Number($id("mealCarbs")?.value || 0);
    const fats = Number($id("mealFats")?.value || 0);

    const meals = loadMeals();
    meals.push({
      type,
      cal: Math.max(0, cal),
      desc,
      prot: Math.max(0, prot),
      carbs: Math.max(0, carbs),
      fats: Math.max(0, fats),
      time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    });
    saveMeals(meals);
    clearMealForm();
    openMealModal(false);
    renderNutrition();
    toast("Repas ajouté ✅", "info");
  }

  function actionDeleteMeal(indexFromUI) {
    const meals = loadMeals();
    const idx = Number(indexFromUI);
    const actualIndex = meals.length - 1 - idx;
    if (actualIndex < 0 || actualIndex >= meals.length) return;
    meals.splice(actualIndex, 1);
    saveMeals(meals);
    renderNutrition();
    toast("Repas supprimé ✅", "info");
  }

  // ============================================================
  // EVENTS
  // ============================================================
  function bindEvents() {
    const bindClick = (id, fn) => {
      const el = $id(id);
      if (!el || el._fitaiBound) return;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        fn();
      });
      el._fitaiBound = true;
    };

    bindClick("btnMagicLink", actionMagicLink);
    bindClick("btnLogout", actionLogout);
    bindClick("btnCoachAsk", actionCoachAsk);
    bindClick("btnRefreshFeed", refreshFeed);
    bindClick("btnUploadBodyScan", actionUploadBodyScan);
    bindClick("btnRefreshBodyScans", () => {
      _bodyScanOffset = 0;
      refreshBodyScans();
    });
    bindClick("btnSaveName", actionSaveName);
    bindClick("btnSaveEquipment", actionSaveEquipment);
    bindClick("btnRefreshTrophies", () => refreshTrophies(true));
    bindClick("btnAddMeal", () => openMealModal(true));
    bindClick("btnCancelMeal", () => openMealModal(false));
    bindClick("btnSaveMeal", actionSaveMeal);
    bindClick("btnSaveGoal", actionSaveGoal);

    const dn = $id("displayName");
    if (dn && !dn._fitaiBoundEnter) {
      dn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          actionSaveName();
        }
      });
      dn._fitaiBoundEnter = true;
    }

    document.addEventListener("click", (e) => {
      const k = e.target?.closest?.("[data-kpi][data-dir]");
      if (!k) return;
      e.preventDefault();
      onKpiClick(k);
    });

    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.("[data-action]");
      if (!el) return;
      const act = el.getAttribute("data-action");
      if (!act) return;

      e.preventDefault();

      if (act === "toggle-kudos") return toggleKudos(el.getAttribute("data-id"));
      if (act === "seed-example") return seedExampleWorkout();
      if (act === "delete-meal") return actionDeleteMeal(el.getAttribute("data-index"));
      if (act === "delete-workout") return actionDeleteWorkout(el.getAttribute("data-id"));
      if (act === "edit-workout") return actionEditWorkout(el.getAttribute("data-id"));
      if (act === "report-workout") return actionReportWorkout(el.getAttribute("data-id"));
      if (act === "publish-plan") {
        const pub = el.getAttribute("data-public");
        return actionPublishPlan(pub === "1");
      }
      if (act === "copy-plan") return actionCopyPlan();
    });

    document.addEventListener("click", (e) => {
      const startEl = e.target?.closest?.("[data-timer-start]");
      if (startEl) {
        const blockId = startEl.getAttribute("data-timer-start");
        const duration = Number(startEl.getAttribute("data-duration") || 0);
        startTimer(blockId, duration);
        return;
      }

      const pauseEl = e.target?.closest?.("[data-timer-pause]");
      if (pauseEl) {
        pauseTimer();
        return;
      }

      const resetEl = e.target?.closest?.("[data-timer-reset]");
      if (resetEl) {
        const blockId = resetEl.getAttribute("data-timer-reset");
        const duration = Number(resetEl.getAttribute("data-duration") || 0);
        resetTimer(blockId, duration);
        return;
      }
    });

    const mealModal = $id("mealModal");
    if (mealModal && !mealModal._fitaiBound) {
      mealModal.addEventListener("click", (e) => {
        if (e.target === mealModal) openMealModal(false);
      });
      mealModal._fitaiBound = true;
    }
  }

  // ============================================================
  // BOOT
  // ============================================================
  async function boot() {
    try {
      ensureExtraTabs();
      bindTabs();
      bindEvents();
      setActiveTab("tabBtnDash");

      showLoader(true);

      await loadConfigAndInitSupabase();
      await bootstrapSession();

      renderAuth();
      refreshKPIs();
      refreshMorningBrief();
      renderNutrition();
      renderGoal();
      applyEquipmentToUI();
      await refreshProfileHint();
      await refreshTrophies();
      await refreshFeed();
      await refreshBodyScans();

      showLoader(false);
      toast("App ready ✅", "info");
    } catch (e) {
      showLoader(false);
      toast(`BOOT FAILED: ${e.message || e}`, "error");
      console.error("Boot error:", e);
      show($id("btnLogout"), false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.addEventListener("error", (evt) => {
    const msg = evt?.message || "JS error";
    console.error("Global error:", msg);
    toast(`Erreur: ${msg}`, "error");
  });

  window.addEventListener("unhandledrejection", (evt) => {
    const msg = evt?.reason?.message || String(evt?.reason || "Promise error");
    console.error("Unhandled rejection:", msg);
    toast(`Erreur: ${msg}`, "error");
  });
})();
