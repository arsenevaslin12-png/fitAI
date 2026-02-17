import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

(() => {
  "use strict";

  const APP = {
    supabase: null,
    session: null,
    user: null,
    feed: [],
    likedSet: new Set(),
    config: null,
    isReady: false,
  };

  // -------------------------
  // DOM utils (défensif)
  // -------------------------
  const $id = (id) => document.getElementById(id);
  const $q = (sel, root = document) => root.querySelector(sel);
  const $qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setText(el, text) {
    if (!el) return;
    el.textContent = String(text ?? "");
  }

  function setHTML(el, html) {
    if (!el) return;
    el.innerHTML = html ?? "";
  }

  function show(el, yes) {
    if (!el) return;
    el.style.display = yes ? "" : "none";
  }

  function disable(el, yes) {
    if (!el) return;
    el.disabled = !!yes;
    el.setAttribute("aria-disabled", yes ? "true" : "false");
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function toast(msg, kind = "info") {
    const box = $id("toast");
    if (box) {
      box.setAttribute("data-kind", kind);
      box.textContent = msg;
      box.style.opacity = "1";
      clearTimeout(toast._t);
      toast._t = setTimeout(() => {
        box.style.opacity = "0";
      }, 3500);
    }
    // console fallback
    if (kind === "error") console.error(msg);
    else console.log(msg);
  }

  function readValueAny(ids, fallback = "") {
    for (const id of ids) {
      const el = $id(id);
      if (el && typeof el.value === "string") return el.value.trim();
    }
    return fallback;
  }

  function readFileAny(ids) {
    for (const id of ids) {
      const el = $id(id);
      if (el && el.files && el.files[0]) return el.files[0];
    }
    return null;
  }

  // -------------------------
  // Config + Supabase init
  // -------------------------
  async function loadConfig() {
    const res = await fetch("/api/workout?config=1", { cache: "no-store" });
    if (!res.ok) throw new Error(`Config endpoint failed: HTTP ${res.status}`);
    const cfg = await res.json();

    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
      throw new Error("Config endpoint did not return supabaseUrl + supabaseAnonKey");
    }
    APP.config = cfg;

    APP.supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      global: { headers: { "x-client-info": "fitai-pro-v10" } },
    });

    // Auth listener
    APP.supabase.auth.onAuthStateChange((_event, session) => {
      APP.session = session;
      APP.user = session?.user ?? null;
      renderAuth();
      // refresh feed state (liked_by_me + likedSet)
      refreshFeed().catch(() => {});
      refreshBodyScans().catch(() => {});
    });
  }

  async function bootstrapSession() {
    const { data, error } = await APP.supabase.auth.getSession();
    if (error) throw error;
    APP.session = data?.session ?? null;
    APP.user = data?.session?.user ?? null;
  }

  // -------------------------
  // Render
  // -------------------------
  function renderAuth() {
    const st = $id("statusAuth");
    const who = $id("statusWho");
    const btnLogout = $id("btnLogout");

    if (!APP.user) {
      setText(st, "Not signed in");
      setText(who, "");
      if (btnLogout) show(btnLogout, false);
      show($id("authBox"), true);
      show($id("appBox"), false);
      return;
    }

    setText(st, "Signed in");
    setText(who, APP.user.email || APP.user.id);
    if (btnLogout) show(btnLogout, true);

    show($id("authBox"), false);
    show($id("appBox"), true);
  }

  function renderFeed() {
    const list = $id("feedList");
    if (!list) return;

    if (!APP.feed.length) {
      setHTML(list, `<div class="empty">No workouts yet.</div>`);
      return;
    }

    const items = APP.feed
      .map((w) => {
        const id = w.id;
        const title = escapeHtml(w.title || "Untitled");
        const display = escapeHtml(w.display_name || "Anonymous");
        const intensity = escapeHtml(w.intensity || "");
        const notes = escapeHtml(w.notes || "");
        const created = escapeHtml(w.created_at || "");
        const kudos = Number(w.kudos_count || 0);
        const liked =
          typeof w.liked_by_me === "boolean"
            ? w.liked_by_me
            : APP.likedSet.has(id);

        const likeLabel = liked ? "Unlike" : "Like";

        return `
          <div class="feedItem" data-workout-id="${id}">
            <div class="feedTop">
              <div class="feedTitle">${title}</div>
              <div class="feedMeta">by ${display} • ${created}</div>
            </div>
            <div class="feedBody">
              ${intensity ? `<div class="chip">Intensity: ${intensity}</div>` : ""}
              ${notes ? `<div class="notes">${notes}</div>` : ""}
            </div>
            <div class="feedActions">
              <button type="button"
                data-action="toggle-like"
                data-workout-id="${id}"
                ${APP.user ? "" : "disabled"}
              >${likeLabel} (${kudos})</button>
            </div>
          </div>
        `;
      })
      .join("");

    setHTML(list, items);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // -------------------------
  // Auth actions
  // -------------------------
  async function actionLogin() {
    const email = readValueAny(["authEmail", "email", "loginEmail"], "");
    const password = readValueAny(["authPassword", "password", "loginPassword"], "");
    if (!email || !password) return toast("Missing email/password", "error");

    disable($id("btnLogin"), true);
    try {
      const { error } = await APP.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast("Logged in");
    } catch (e) {
      toast(`Login failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnLogin"), false);
    }
  }

  async function actionRegister() {
    const email = readValueAny(["authEmail", "email", "loginEmail"], "");
    const password = readValueAny(["authPassword", "password", "loginPassword"], "");
    if (!email || !password) return toast("Missing email/password", "error");

    disable($id("btnRegister"), true);
    try {
      const { error } = await APP.supabase.auth.signUp({ email, password });
      if (error) throw error;
      toast("Registered. Check your email if confirmation is enabled.");
    } catch (e) {
      toast(`Register failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnRegister"), false);
    }
  }

  async function actionLogout() {
    disable($id("btnLogout"), true);
    try {
      const { error } = await APP.supabase.auth.signOut();
      if (error) throw error;
      toast("Logged out");
    } catch (e) {
      toast(`Logout failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnLogout"), false);
    }
  }

  // -------------------------
  // Profile
  // -------------------------
  async function actionSaveDisplayName() {
    if (!APP.user) return toast("Sign in first", "error");
    const displayName = readValueAny(["displayName", "profileDisplayName"], "");
    if (!displayName) return toast("Missing display name", "error");

    disable($id("btnSaveDisplayName"), true);
    try {
      const payload = {
        user_id: APP.user.id,
        display_name: displayName,
        updated_at: nowISO(),
      };
      const { error } = await APP.supabase
        .from("public_profiles")
        .upsert(payload, { onConflict: "user_id" });
      if (error) throw error;
      toast("Profile saved");
      refreshFeed().catch(() => {});
    } catch (e) {
      toast(`Save profile failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnSaveDisplayName"), false);
    }
  }

  // -------------------------
  // Workouts: generate (API) + publish (DB)
  // -------------------------
  function fallbackPlan(prompt) {
    return {
      prompt: prompt || "",
      blocks: [
        { title: "Warm-up", duration_min: 8, items: ["Mobility", "Light cardio"] },
        { title: "Main", duration_min: 25, items: ["3x compound movement", "2x accessory"] },
        { title: "Cooldown", duration_min: 5, items: ["Breathing", "Stretching"] },
      ],
      created_at: nowISO(),
      source: "fallback",
    };
  }

  async function actionGenerateWorkout() {
    if (!APP.user) return toast("Sign in first", "error");

    const prompt = readValueAny(["workoutPrompt", "promptWorkout"], "");
    disable($id("btnGenerateWorkout"), true);

    try {
      let plan = null;

      // Try API
      const res = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (res.ok) {
        const out = await res.json();
        plan = out?.plan_json ?? out?.plan ?? null;
      }

      if (!plan) plan = fallbackPlan(prompt);

      // Write into textarea if present
      const planEl = $id("workoutPlanJson") || $id("planJson") || $id("workoutPlan");
      if (planEl && typeof planEl.value === "string") {
        planEl.value = JSON.stringify(plan, null, 2);
      }

      // Optional title/intensity fill
      const titleEl = $id("workoutTitle") || $id("titleWorkout");
      const intensityEl = $id("workoutIntensity") || $id("intensityWorkout");
      if (titleEl && !titleEl.value) titleEl.value = "Generated workout";
      if (intensityEl && !intensityEl.value) intensityEl.value = "medium";

      toast("Workout generated (or fallback)");
    } catch (e) {
      toast(`Generate failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnGenerateWorkout"), false);
    }
  }

  async function actionPublishWorkout() {
    if (!APP.user) return toast("Sign in first", "error");

    const title = readValueAny(["workoutTitle", "titleWorkout", "title"], "Untitled");
    const intensity = readValueAny(["workoutIntensity", "intensityWorkout"], "");
    const notes = readValueAny(["workoutNotes", "notesWorkout", "notes"], "");
    const planRaw = readValueAny(["workoutPlanJson", "planJson", "workoutPlan"], "");

    let plan_json = null;
    if (planRaw) {
      try {
        plan_json = JSON.parse(planRaw);
      } catch {
        plan_json = { raw: planRaw };
      }
    } else {
      plan_json = fallbackPlan("");
    }

    const isPublicEl = $id("workoutIsPublic");
    const is_public = isPublicEl ? !!isPublicEl.checked : true; // default: publish public

    disable($id("btnPublishWorkout"), true);
    try {
      const payload = {
        user_id: APP.user.id,
        is_public,
        title,
        intensity,
        notes,
        plan_json,
      };

      const { error } = await APP.supabase.from("workouts").insert(payload);
      if (error) throw error;

      toast("Workout published");
      await refreshFeed();
    } catch (e) {
      toast(`Publish failed: ${e.message || e}`, "error");
    } finally {
      disable($id("btnPublishWorkout"), false);
    }
  }

  // -------------------------
  // Feed + Likes
  // -------------------------
  async function refreshFeed() {
    const btn = $id("btnRefreshFeed");
    if (btn) disable(btn, true);

    try {
      // Prefer view
      const { data, error } = await APP.supabase
        .from("workouts_feed")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      APP.feed = Array.isArray(data) ? data : [];
      APP.likedSet.clear();

      // If the view doesn't compute liked_by_me (or if you want extra safety), re-check quickly
      if (APP.user && APP.feed.length) {
        const ids = APP.feed.map((w) => w.id).filter(Boolean);
        if (ids.length) {
          const { data: lk, error: lkErr } = await APP.supabase
            .from("kudos")
            .select("workout_id")
            .in("workout_id", ids);

          if (!lkErr && Array.isArray(lk)) {
            for (const row of lk) APP.likedSet.add(row.workout_id);
          }
        }
      }

      renderFeed();
      const st = $id("statusFeed");
      if (st) setText(st, `Feed loaded: ${APP.feed.length}`);
    } catch (e) {
      toast(`Feed failed: ${e.message || e}`, "error");
    } finally {
      if (btn) disable(btn, false);
    }
  }

  async function toggleLike(workoutId) {
    if (!APP.user) return toast("Sign in first", "error");
    if (!workoutId) return;

    const liked = APP.likedSet.has(workoutId);

    try {
      if (liked) {
        const { error } = await APP.supabase
          .from("kudos")
          .delete()
          .eq("workout_id", workoutId)
          .eq("user_id", APP.user.id);
        if (error) throw error;
        APP.likedSet.delete(workoutId);
      } else {
        const { error } = await APP.supabase.from("kudos").insert({
          workout_id: workoutId,
          user_id: APP.user.id,
        });
        if (error) {
          // ignore duplicate unique violation
          if (String(error.code) !== "23505") throw error;
        }
        APP.likedSet.add(workoutId);
      }

      // Refresh to sync kudos_count + liked_by_me
      await refreshFeed();
    } catch (e) {
      toast(`Like toggle failed: ${e.message || e}`, "error");
    }
  }

  // -------------------------
  // Storage: Body Scans (upload + list + signed urls)
  // -------------------------
  async function actionUploadBodyScan() {
    if (!APP.user) return toast("Sign in first", "error");

    const file = readFileAny(["bodyScanFile", "uploadBodyScan", "fileBodyScan"]);
    if (!file) return toast("Pick a file first", "error");

    const btn = $id("btnUploadBodyScan");
    if (btn) disable(btn, true);

    try {
      // IMPORTANT: policy expects top-level folder = userId
      const safeName = String(file.name || "upload").replace(/[^\w.\-]+/g, "_");
      const path = `${APP.user.id}/bodyscans/${Date.now()}_${safeName}`;

      const { error: upErr } = await APP.supabase.storage
        .from("user_uploads")
        .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });

      if (upErr) throw upErr;

      const { error: dbErr } = await APP.supabase.from("body_scans").insert({
        user_id: APP.user.id,
        file_path: path,
        meta: { original_name: file.name, content_type: file.type || null },
      });

      if (dbErr) throw dbErr;

      toast("Upload OK");
      await refreshBodyScans();
    } catch (e) {
      toast(`Upload failed: ${e.message || e}`, "error");
    } finally {
      if (btn) disable(btn, false);
    }
  }

  async function refreshBodyScans() {
    const box = $id("bodyScansList");
    if (!box) return;

    if (!APP.user) {
      setHTML(box, `<div class="empty">Sign in to see your uploads.</div>`);
      return;
    }

    try {
      const { data, error } = await APP.supabase
        .from("body_scans")
        .select("id,file_path,created_at,meta")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) {
        setHTML(box, `<div class="empty">No uploads yet.</div>`);
        return;
      }

      // signed urls
      const parts = [];
      for (const r of rows) {
        const { data: signed, error: sErr } = await APP.supabase.storage
          .from("user_uploads")
          .createSignedUrl(r.file_path, 60 * 30);

        const url = !sErr && signed?.signedUrl ? signed.signedUrl : null;
        const name = escapeHtml(r.meta?.original_name || r.file_path);
        const when = escapeHtml(r.created_at || "");
        parts.push(`
          <div class="scanRow">
            <div class="scanMeta">${when} • ${name}</div>
            ${url ? `<a href="${url}" target="_blank" rel="noreferrer">Open (signed)</a>` : `<span class="muted">signed url failed</span>`}
          </div>
        `);
      }
      setHTML(box, parts.join(""));
    } catch (e) {
      toast(`Body scans list failed: ${e.message || e}`, "error");
    }
  }

  // -------------------------
  // Event binding (IDs + delegation data-action)
  // -------------------------
  function bindEvents() {
    // Direct IDs (si présents)
    const map = [
      ["btnLogin", actionLogin],
      ["btnRegister", actionRegister],
      ["btnLogout", actionLogout],
      ["btnSaveDisplayName", actionSaveDisplayName],
      ["btnGenerateWorkout", actionGenerateWorkout],
      ["btnPublishWorkout", actionPublishWorkout],
      ["btnRefreshFeed", refreshFeed],
      ["btnUploadBodyScan", actionUploadBodyScan],
      ["btnRefreshBodyScans", refreshBodyScans],
    ];

    for (const [id, fn] of map) {
      const el = $id(id);
      if (el && !el._fitaiBound) {
        el.addEventListener("click", (e) => {
          e.preventDefault();
          fn();
        });
        el._fitaiBound = true;
      }
    }

    // Delegation via data-action (robuste si IDs manquent)
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-action]");
      if (!btn) return;

      const act = btn.getAttribute("data-action");
      if (!act) return;

      e.preventDefault();

      if (act === "login") return actionLogin();
      if (act === "register") return actionRegister();
      if (act === "logout") return actionLogout();
      if (act === "save-display-name") return actionSaveDisplayName();
      if (act === "generate-workout") return actionGenerateWorkout();
      if (act === "publish-workout") return actionPublishWorkout();
      if (act === "refresh-feed") return refreshFeed();
      if (act === "upload-bodyscan") return actionUploadBodyScan();
      if (act === "refresh-bodyscans") return refreshBodyScans();

      if (act === "toggle-like") {
        const wid = btn.getAttribute("data-workout-id") || btn.closest("[data-workout-id]")?.getAttribute("data-workout-id");
        return toggleLike(wid);
      }
    });
  }

  // -------------------------
  // Init
  // -------------------------
  async function init() {
    const st = $id("statusBoot");
    try {
      setText(st, "Loading config…");
      await loadConfig();

      setText(st, "Bootstrapping session…");
      await bootstrapSession();

      bindEvents();
      renderAuth();

      setText(st, "Loading feed…");
      await refreshFeed();

      await refreshBodyScans();

      APP.isReady = true;
      setText(st, "Ready");
      toast("FitAI Pro v10 ready");
    } catch (e) {
      setText(st, `BOOT FAILED: ${e.message || e}`);
      toast(`BOOT FAILED: ${e.message || e}`, "error");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
