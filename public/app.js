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
    feedFilter: "recent", // recent | top7d | mylikes | myworkouts
    chart: null,
    _createClient: null,
    _supabaseImportPromise: null,
    _trophyCache: null,
    _trophyCacheExpiry: 0,
  };

  // ============================================================
  // CONSTANTS
  // ============================================================
  const MAX_DISPLAY_NAME_LENGTH = 40;
  const MAX_TITLE_LENGTH = 120;
  const MAX_NOTES_LENGTH = 500;
  const MAX_REPORT_REASON_LENGTH = 200;
  const TROPHY_CACHE_MS = 45000; // 45s

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
  // TAB INJECTION
  // ============================================================
  function ensureExtraTabs() {
    const nav = $q(".tabs");
    const main = $q("main.container");
    if (!nav || !main) return;

    const ensureTabButton = (id, label, beforeId) => {
      if ($id(id)) return;
      const btn = document.createElement("button");
      btn.className = "tabBtn";
      btn.id = id;
      btn.type = "button";
      btn.textContent = label;
      btn.setAttribute("aria-selected", "false");
      
      if (beforeId) {
        const ref = $id(beforeId);
        if (ref) {
          nav.insertBefore(btn, ref);
          return;
        }
      }
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

    // Inject Body Scan tab AFTER Profile
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

        <div class="row" style="gap:10px; align-items:center">
          <input class="input" id="bodyScanFile" type="file" accept="image/*" style="flex:1" />
          <button class="btn primary" id="btnUploadBodyScan" type="button">Upload</button>
          <button class="btn" id="btnRefreshBodyScans" type="button">Refresh</button>
        </div>

        <div class="hr"></div>
        <div id="bodyScansList"></div>
        <div class="hint" style="margin-top:10px">
          Fichiers privés. Accès via signed URLs. Max 10 affichés, bouton "Charger plus" si > 10.
        </div>
      </div>
    `
    );

    // Inject global loader
    if (!$id("globalLoader")) {
      const loader = document.createElement("div");
      loader.id = "globalLoader";
      loader.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(0,0,0,.55);
        backdrop-filter: blur(8px);
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
  // TAB MAP (UN SEUL)
  // ============================================================
  const TAB_MAP = [
    { btn: "tabBtnDash", section: "tab-dash" },
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
      throw new Error("Supabase module: createClient introuvable");
    }
    APP._createClient = mod.createClient;
    return APP._createClient;
  }

  async function loadConfigAndInitSupabase() {
    const r = await fetch("/api/workout?config=1", { cache: "no-store" });
    if (!r.ok) throw new Error(`Config endpoint HTTP ${r.status}`);

    const cfg = await safeJson(r);
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      throw new Error("Config invalide");
    }

    const createClient = await getCreateClient();
    APP.cfg = cfg;
    APP.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { "x-client-info": "fitai-v3-prod" } },
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
      hint.textContent = dn ? `Profil: ${dn}` : "Profil: ajoute un nom public (onglet Profile).";
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
      await refreshTrophies();
    } catch (e) {
      toast(`Erreur: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("saveName", false);
    }
  }

  // ============================================================
  // TROPHIES (avec cache)
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

    // Cache check
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
  // FEED (avec filter "Mes séances" + delete + edit + report)
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

    // Filter bar
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

          const reportBtn = APP.user && !isOwn
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
              <div class="row" style="gap:8px">
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
        query = query.gte("created_at", since).order("kudos_count", { ascending: false });
      } else if (APP.feedFilter === "mylikes" && APP.user) {
        const { data: liked } = await APP.sb.from("kudos").select("workout_id").eq("user_id", APP.user.id);
        const ids = (liked || []).map((k) => k.workout_id).slice(0, 200);
        if (!ids.length) {
          APP.feed = [];
          if (chip) safeText(chip, "OK • 0");
          renderFeed();
          return;
        }
        query = query.in("id", ids);
      } else if (APP.feedFilter === "myworkouts" && APP.user) {
        query = query.eq("user_id", APP.user.id);
      }

      query = query.order("created_at", { ascending: false }).limit(60);

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
    if (isBusy(lockKey)) return;
    setBusy(lockKey, true);

    const row = { ...APP.feed[idx] };
    const w = normalizeFeedRow(row);
    const wasLiked = !!w.liked_by_me;

    try {
      // Optimistic
      if (wasLiked) {
        row.liked_by_me = false;
        row.kudos_count = Math.max(0, Number(row.kudos_count ?? 0) - 1);
      } else {
        row.liked_by_me = true;
        row.kudos_count = Number(row.kudos_count ?? 0) + 1;
      }
      APP.feed[idx] = row;
      renderFeed();

      // DB
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

    if (isBusy("deleteWorkout")) return;
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

    if (isBusy("editWorkout")) return;
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
      if (!newTitle) return;
      if (newTitle.length > MAX_TITLE_LENGTH) return toast(`Max ${MAX_TITLE_LENGTH} car.`, "error");

      const newNotes = prompt("Notes (max 500 car):", data.notes || "")?.trim();
      if (newNotes && newNotes.length > MAX_NOTES_LENGTH) return toast(`Max ${MAX_NOTES_LENGTH} car.`, "error");

      const newPublic = confirm("Public ? (OK = oui, Annuler = privé)");

      const { error: updateErr } = await APP.sb
        .from("workouts")
        .update({ title: newTitle, notes: newNotes || "", is_public: newPublic })
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

    if (isBusy("report")) return;
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
    if (isBusy("seed")) return;
    setBusy("seed", true);

    try {
      const example = {
        title: "Séance exemple (FitAI)",
        intensity: "easy",
        notes: "Exemple auto.",
        blocks: [
          { title: "Warm-up", duration_min: 6, items: ["Marche", "Mobilité"] },
          { title: "Main", duration_min: 18, items: ["Pompes", "Squats"] },
          { title: "Cooldown", duration_min: 4, items: ["Stretching"] },
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
  // BODY SCAN (pagination: 10 max, bouton "Charger plus")
  // ============================================================
  let _bodyScanOffset = 0;
  const BODYSCAN_LIMIT = 10;

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

    if (file.size > 10 * 1024 * 1024) {
      toast("Max 10MB.", "error");
      if (fileEl) fileEl.value = "";
      return;
    }

    const btn = $id("btnUploadBodyScan");
    if (isBusy("uploadScan")) return;
    setBusy("uploadScan", true);
    disable(btn, true);
    showLoader(true);

    try {
      const path = `${APP.user.id}/bodyscans/${Date.now()}_${safeName(file.name)}`;

      await APP.sb.storage.from("user_uploads").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });

      try {
        await APP.sb.from("body_scans").insert({
          user_id: APP.user.id,
          file_path: path,
          meta: { original_name: file.name, content_type: file.type || null, size: file.size || null },
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

      const parts = [];
      for (const r of rows) {
        const { data: signed, error: sErr } = await APP.sb.storage.from("user_uploads").createSignedUrl(r.file_path, 60 * 30);
        const url = !sErr && signed?.signedUrl ? signed.signedUrl : null;

        parts.push(`
          <div class="feedCard">
            <div class="feedHeader">
              <div class="feedUser">${esc(r.meta?.original_name || r.file_path)}</div>
              <div class="feedTime">${esc(fmtDate(r.created_at))}</div>
            </div>
            <div class="row" style="margin-top:10px; gap:10px">
              ${url ? `<a class="btn" href="${url}" target="_blank" rel="noreferrer">Ouvrir</a>` : `<span class="badge red">URL failed</span>`}
            </div>
          </div>
        `);
      }

      _bodyScanOffset += rows.length;
      const hasMore = _bodyScanOffset < total;

      if (!loadMore) {
        safeHTML(box, parts.join(""));
      } else {
        box.insertAdjacentHTML("beforeend", parts.join(""));
      }

      // Bouton "Charger plus"
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
  // KPIs + NUTRITION (localStorage, existant)
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
    bindClick("btnRefreshFeed", refreshFeed);
    bindClick("btnUploadBodyScan", actionUploadBodyScan);
    bindClick("btnRefreshBodyScans", () => {
      _bodyScanOffset = 0;
      refreshBodyScans();
    });
    bindClick("btnSaveName", actionSaveName);
    bindClick("btnRefreshTrophies", () => refreshTrophies(true));
    bindClick("btnAddMeal", () => openMealModal(true));
    bindClick("btnCancelMeal", () => openMealModal(false));
    bindClick("btnSaveMeal", actionSaveMeal);

    // Enter sur displayName
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

    // KPI clicks
    document.addEventListener("click", (e) => {
      const k = e.target?.closest?.("[data-kpi][data-dir]");
      if (!k) return;
      e.preventDefault();
      onKpiClick(k);
    });

    // Delegated actions
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
    });

    // Modal click outside
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
      await refreshProfileHint();
      await refreshTrophies();
      await refreshFeed();
      await refreshBodyScans();

      showLoader(false);
      toast("App ready ✅", "info");
    } catch (e) {
      showLoader(false);
      toast(`BOOT FAILED: ${e.message || e}`, "error");
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
    toast(`JS error: ${msg}`, "error");
  });

  window.addEventListener("unhandledrejection", (evt) => {
    const msg = evt?.reason?.message || String(evt?.reason || "Promise error");
    toast(`Promise: ${msg}`, "error");
  });
})();
