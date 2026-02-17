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
    feedFilter: "recent", // recent | top7d | mylikes
    chart: null,
    _createClient: null,
    _supabaseImportPromise: null,
  };

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

  // ============================================================
  // 1) Injecte Planning + Nutrition + BodyScan si manquants
  // ============================================================
  function ensureExtraTabs() {
    const nav = $q(".tabs");
    const main = $q("main.container");
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

    ensureTabButton("tabBtnPlanning", "Planning");
    ensureTabButton("tabBtnNutrition", "Nutrition");
    ensureTabButton("tabBtnBodyScan", "Body Scan");

    ensureSection(
      "tab-planning",
      `
      <div class="card">
        <div class="cardTitle">Planning hebdomadaire</div>
        <div style="height:10px"></div>

        <div class="row" style="gap:10px; flex-wrap:wrap">
          <button class="btn primary" id="btnGeneratePlanning" type="button">Générer Planning IA</button>
          <button class="btn" id="btnRefreshPlanning" type="button">Refresh</button>
        </div>

        <div class="hr"></div>
        <div id="planningList"><div class="empty">À brancher (API + table training_schedule).</div></div>
        <div class="hint" style="margin-top:10px">Note: cet onglet est prêt côté UI. Il manque juste la logique planning si tu ne l’as pas encore câblée.</div>
      </div>
    `
    );

    ensureSection(
      "tab-nutrition",
      `
      <div class="card">
        <div class="cardTitle">Nutrition</div>
        <div style="height:10px"></div>

        <div class="row" style="gap:10px; flex-wrap:wrap">
          <button class="btn primary" id="btnGenerateNutrition" type="button">Générer Macros IA</button>
          <button class="btn" id="btnRefreshNutrition" type="button">Refresh</button>
        </div>

        <div class="hr"></div>
        <div id="nutritionBox"><div class="empty">À brancher (API + table nutrition_targets).</div></div>
        <div class="hint" style="margin-top:10px">Note: cet onglet est prêt côté UI. Il manque juste la logique nutrition si tu ne l’as pas encore câblée.</div>
      </div>
    `
    );

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
        <div class="hint" style="margin-top:10px">Fichiers privés. Accès via signed URLs.</div>
      </div>
    `
    );
  }

  // ============================================================
  // 2) UN SEUL TAB_MAP + navigation
  // ============================================================
  const TAB_MAP = [
    { btn: "tabBtnDash", section: "tab-dash" },
    { btn: "tabBtnCoach", section: "tab-coach" },
    { btn: "tabBtnPlanning", section: "tab-planning" },
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
      throw new Error("Config invalide (supabaseUrl/supabaseAnonKey manquants)");
    }

    const createClient = await getCreateClient();
    APP.cfg = cfg;
    APP.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { "x-client-info": "fitai-pro-v12" } },
    });

    APP.sb.auth.onAuthStateChange((_evt, session) => {
      APP.session = session;
      APP.user = session?.user ?? null;

      renderAuth();
      refreshProfileHint().catch(() => {});
      refreshTrophies().catch(() => {});
      refreshFeed().catch(() => {});
      refreshBodyScans().catch(() => {});
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
      toast("Magic link envoyé. Vérifie ton email.", "info");
    } catch (e) {
      toast(`Magic link: ${e.message || e}`, "error");
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
      toast("Déconnecté.", "info");
    } catch (e) {
      toast(`Logout: ${e.message || e}`, "error");
    } finally {
      disable($id("btnLogout"), false);
      setBusy("logout", false);
    }
  }

  // ============================================================
  // PROFILE HINT
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
      hint.textContent = "Profil: ajoute un nom public (onglet Profile).";
    }
  }

  // ============================================================
  // PROFILE SAVE + TROPHIES
  // ============================================================
  async function actionSaveName() {
    if (!APP.user) return toast("Connecte-toi pour sauvegarder ton profil.", "error");

    const input = $id("displayName");
    const btn = $id("btnSaveName");
    const raw = (input?.value ?? "").trim();

    if (!raw) {
      toast("Display name vide.", "error");
      input?.focus?.();
      return;
    }

    const display_name = raw.slice(0, 40);

    if (isBusy("saveName")) return;
    setBusy("saveName", true);
    disable(btn, true);

    try {
      const { error } = await APP.sb
        .from("public_profiles")
        .upsert({ user_id: APP.user.id, display_name }, { onConflict: "user_id" });

      if (error) throw error;

      toast("Profil sauvegardé ✅", "info");
      await refreshProfileHint();
      await refreshTrophies();
    } catch (e) {
      toast(`Profile Save: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("saveName", false);
    }
  }

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
    const host = $id("trophiesList") || $id("trophies") || $id("profileTrophies");
    if (!host) return;

    safeHTML(
      host,
      list
        .map((t) => {
          const badge = t.ok ? "✅" : "⬜";
          const meta = t.meta ? `<div class="hint" style="margin-top:4px">${esc(t.meta)}</div>` : "";
          return `
            <div class="feedCard" style="padding:12px">
              <div style="font-weight:900">${badge} ${esc(t.title)}</div>
              <div class="hint" style="margin-top:4px">${esc(t.desc)}</div>
              ${meta}
            </div>
          `;
        })
        .join("")
    );
  }

  // V3 perf: parallélisé, + kudos via workouts_feed (sum kudos_count)
  let _trophiesBusy = false;
  async function refreshTrophies() {
    if (_trophiesBusy) return;
    _trophiesBusy = true;

    try {
      if (!APP.user) {
        renderTrophies([
          { title: "Connecte-toi", desc: "Les trophées sont disponibles une fois connecté.", ok: false, meta: "" },
        ]);
        return;
      }

      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const TOP7_MIN = 4;

      const pProfile = APP.sb
        .from("public_profiles")
        .select("display_name")
        .eq("user_id", APP.user.id)
        .maybeSingle();

      const pBody = sbCount("body_scans", (q) => q.eq("user_id", APP.user.id));
      const pWork7d = sbCount("workouts", (q) => q.eq("user_id", APP.user.id).gte("created_at", since));

      // Sum kudos_count for my workouts (fast). If RLS blocks, fallback to 0.
      const pMyKudos = APP.sb
        .from("workouts_feed")
        .select("kudos_count")
        .eq("user_id", APP.user.id)
        .limit(200);

      const [
        { data: profData, error: profErr },
        bodyScanCountRaw,
        workouts7dRaw,
        { data: myRows, error: myKErr },
      ] = await Promise.all([pProfile, pBody, pWork7d, pMyKudos]);

      let hasPublicProfile = false;
      if (!profErr && (profData?.display_name ?? "").trim()) hasPublicProfile = true;

      const bodyScanCount = typeof bodyScanCountRaw === "number" ? bodyScanCountRaw : 0;
      const workouts7d = typeof workouts7dRaw === "number" ? workouts7dRaw : 0;

      let kudosReceived = 0;
      if (!myKErr && Array.isArray(myRows)) {
        kudosReceived = myRows.reduce((acc, r) => acc + (Number(r?.kudos_count ?? 0) || 0), 0);
      }

      renderTrophies([
        {
          title: "Profil public",
          desc: "Définis un display name pour être visible.",
          ok: hasPublicProfile,
          meta: hasPublicProfile ? "OK" : "À faire (onglet Profile)",
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
          title: "Premier kudos reçu",
          desc: "Recevoir 1 kudos sur tes workouts.",
          ok: kudosReceived >= 1,
          meta: `${kudosReceived}/1`,
        },
      ]);
    } finally {
      _trophiesBusy = false;
    }
  }

  // ============================================================
  // FEED (simple + stable)
  // ============================================================
  function normalizeFeedRow(w) {
    return {
      id: w.id,
      display: w.display_name || w.user_display || "Anonymous",
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

    // Bar filtres
    const filterBar = document.createElement("div");
    filterBar.className = "row";
    filterBar.style.marginBottom = "14px";
    filterBar.style.gap = "10px";

    const filters = [
      { key: "recent", label: "Récent" },
      { key: "top7d", label: "Top 7 jours" },
      { key: "mylikes", label: "Mes likes", needsAuth: true },
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
              <button class="${btnClass}" type="button" data-action="toggle-kudos" data-id="${esc(w.id)}" ${APP.user ? "" : "disabled"}>
                ${liked ? "❤️" : "🤍"} Kudos <span style="opacity:.9">(${w.kudos_count})</span>
              </button>
              <span class="hint">${APP.user ? "" : "Connecte-toi pour liker."}</span>
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
        const ids = (liked || []).map((k) => k.workout_id);
        if (!ids.length) {
          APP.feed = [];
          if (chip) safeText(chip, "OK • 0");
          renderFeed();
          return;
        }
        query = query.in("id", ids);
      }

      query = query.order("created_at", { ascending: false }).limit(60);

      const { data, error } = await query;
      if (error) throw error;

      APP.feed = Array.isArray(data) ? data : [];
      if (chip) safeText(chip, `OK • ${APP.feed.length}`);
      renderFeed();
    } catch (e) {
      if (chip) safeText(chip, "Erreur feed");
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
        const { error } = await APP.sb.from("kudos").delete().eq("workout_id", workoutId).eq("user_id", APP.user.id);
        if (error) throw error;
      } else {
        const { error } = await APP.sb.from("kudos").insert({ workout_id: workoutId, user_id: APP.user.id });
        if (error && String(error.code) !== "23505") throw error;
      }

      await refreshFeed();
      await refreshTrophies();
    } catch (e) {
      await refreshFeed();
      await refreshTrophies();
      toast(`Kudos: ${e.message || e}`, "error");
    } finally {
      setBusy(lockKey, false);
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
        notes: "Exemple auto (seed).",
        blocks: [
          { title: "Warm-up", duration_min: 6, items: ["Marche rapide", "Mobilité épaules"] },
          { title: "Main", duration_min: 18, items: ["Pompes x 3 séries", "Squats x 3 séries"] },
          { title: "Cooldown", duration_min: 4, items: ["Respiration", "Stretching"] },
        ],
        created_at: nowISO(),
        source: "seed",
      };

      const { error } = await APP.sb.from("workouts").insert({
        user_id: APP.user.id,
        is_public: true,
        title: example.title,
        intensity: example.intensity,
        notes: example.notes,
        plan_json: example,
      });
      if (error) throw error;

      toast("Séance exemple publiée.", "info");
      await refreshFeed();
      await refreshTrophies();
      setActiveTab("tabBtnCommunity");
    } catch (e) {
      toast(`Seed: ${e.message || e}`, "error");
    } finally {
      setBusy("seed", false);
    }
  }

  // ============================================================
  // BODY SCAN (simple)
  // ============================================================
  async function actionUploadBodyScan() {
    if (!APP.user) return toast("Connecte-toi pour uploader.", "error");

    const fileEl = $id("bodyScanFile");
    const file = fileEl?.files?.[0] || null;
    if (!file) return toast("Choisis un fichier.", "error");

    if (!file.type.startsWith("image/")) {
      toast("Fichier invalide (image uniquement).", "error");
      if (fileEl) fileEl.value = "";
      return;
    }

    const btn = $id("btnUploadBodyScan");
    if (isBusy("uploadScan")) return;
    setBusy("uploadScan", true);
    disable(btn, true);

    try {
      const path = `${APP.user.id}/bodyscans/${Date.now()}_${safeName(file.name)}`;

      const { error: upErr } = await APP.sb.storage.from("user_uploads").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (upErr) throw upErr;

      // tracking DB optional
      try {
        const { error: dbErr } = await APP.sb.from("body_scans").insert({
          user_id: APP.user.id,
          file_path: path,
          meta: { original_name: file.name, content_type: file.type || null, size: file.size || null },
        });
        if (dbErr && String(dbErr.code) !== "42P01") throw dbErr;
      } catch (e) {
        toast(`Upload OK mais tracking DB KO: ${e.message || e}`, "error");
      }

      toast("Upload OK.", "info");
      if (fileEl) fileEl.value = "";
      await refreshBodyScans();
      await refreshTrophies();
    } catch (e) {
      toast(`Upload: ${e.message || e}`, "error");
    } finally {
      disable(btn, false);
      setBusy("uploadScan", false);
    }
  }

  async function refreshBodyScans() {
    const box = $id("bodyScansList");
    if (!box) return;

    if (!APP.user) {
      safeHTML(box, `<div class="empty">Connecte-toi pour voir tes fichiers.</div>`);
      return;
    }

    safeHTML(box, `<div class="row" style="gap:10px"><div class="spinner"></div><div class="muted">Chargement…</div></div>`);

    try {
      const { data, error } = await APP.sb
        .from("body_scans")
        .select("id,file_path,created_at,meta")
        .eq("user_id", APP.user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        if (String(error.code) === "42P01") {
          safeHTML(
            box,
            `<div class="empty">Historique désactivé (table body_scans absente). Upload fonctionne quand même.</div>`
          );
          return;
        }
        throw error;
      }

      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) {
        safeHTML(box, `<div class="empty">Aucun fichier.</div>`);
        return;
      }

      const parts = [];
      for (const r of rows) {
        const { data: signed, error: sErr } = await APP.sb.storage.from("user_uploads").createSignedUrl(r.file_path, 60 * 30);
        const url = !sErr && signed?.signedUrl ? signed.signedUrl : null;

        const name = esc(r.meta?.original_name || r.file_path);
        const when = esc(fmtDate(r.created_at));

        parts.push(`
          <div class="feedCard">
            <div class="feedHeader">
              <div class="feedUser">${name}</div>
              <div class="feedTime">${when}</div>
            </div>
            <div class="row" style="margin-top:10px; gap:10px">
              ${
                url
                  ? `<a class="btn" href="${url}" target="_blank" rel="noreferrer">Ouvrir (signed)</a>`
                  : `<span class="badge red">Signed URL failed</span>`
              }
            </div>
          </div>
        `);
      }

      safeHTML(box, parts.join(""));
    } catch (e) {
      safeHTML(box, `<div class="empty">Erreur: ${esc(e.message || e)}</div>`);
    }
  }

  // ============================================================
  // EVENTS (stable)
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
    bindClick("btnRefreshBodyScans", refreshBodyScans);

    // Profile save
    bindClick("btnSaveName", actionSaveName);
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

    // Delegation actions
    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.("[data-action]");
      if (!el) return;
      const act = el.getAttribute("data-action");
      if (!act) return;

      e.preventDefault();

      if (act === "toggle-kudos") return toggleKudos(el.getAttribute("data-id"));
      if (act === "seed-example") return seedExampleWorkout();
    });
  }

  // ============================================================
  // BOOT (ordre IMPORTANT)
  // ============================================================
  async function boot() {
    try {
      ensureExtraTabs(); // 1) injecte les nouveaux onglets/sections
      bindTabs(); // 2) bind tabs (maintenant les boutons existent)
      bindEvents(); // 3) bind events
      setActiveTab("tabBtnDash");

      await loadConfigAndInitSupabase();
      await bootstrapSession();

      renderAuth();
      await refreshProfileHint();
      await refreshTrophies();
      await refreshFeed();
      await refreshBodyScans();

      toast("App ready.", "info");
    } catch (e) {
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
