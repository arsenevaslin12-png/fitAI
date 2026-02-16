import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ============================================================
   FitAI Pro — app.js (restore style + buttons + chart)
   - Restores your original FitAI flow (tabs, IDs, design)
   - Fixes: profile fields not persisting (ensures profiles row exists)
   - Adds: Body Scan tab WITHOUT changing index.html (auto-inject UI)
   - Keeps: /api/workout (config + generation)
   ============================================================ */

const CLIENT_TOKEN = "fitai-v18";
const BUCKET_UPLOADS = "user_uploads";
const BODYSCAN_SIGNED_URL_TTL = 60 * 60; // 1h
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const App = {
  cfg: null,
  supabase: null,
  session: null,
  user: null,

  profile: null,
  publicProfile: null,

  feedItems: [],
  likedSet: new Set(),
  kudosBusy: new Set(),

  chartVolume: null,

  workoutTimer: null,
  timerInterval: null,
  audioContext: null,

  bodyScans: [],
  signedUrlCache: new Map(), // path -> { url, expMs }
  bodyScanBusy: false,

  $: (id) => document.getElementById(id),

  el(tag, opts = {}, children = []) {
    const n = document.createElement(tag);
    if (opts.className) n.className = opts.className;
    if (opts.id) n.id = opts.id;
    if (opts.type) n.type = opts.type;
    if (opts.text != null) n.textContent = String(opts.text);
    if (opts.html != null) n.textContent = String(opts.html); // never innerHTML
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, String(v));
    if (opts.style) for (const [k, v] of Object.entries(opts.style)) n.style[k] = v;
    for (const c of children) if (c) n.appendChild(c);
    return n;
  },

  clamp(min, v, max) {
    return Math.max(min, Math.min(max, v));
  },

  hint(id, msg, type = "info") {
    const el = this.$(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color =
      type === "err" ? "rgba(255,59,48,.95)" :
      type === "ok"  ? "rgba(183,255,42,.95)" :
                       "rgba(255,255,255,.65)";
  },

  async loadScriptOnce(id, src) {
    if (document.getElementById(id)) return;
    await new Promise((resolve) => {
      const s = document.createElement("script");
      s.id = id;
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  },

  /* =========================
     Boot
     ========================= */
  async init() {
    // 0) Ensure Body Scan tab exists (no index edit needed)
    this.ensureBodyScanTabDOM();

    // 1) Lucide (optional)
    await this.initLucide();

    // 2) Bind UI safely (no crash if element missing)
    this.bindTabs();
    this.bindUI();

    // 3) Config + Supabase
    this.cfg = await this.fetchConfig();
    this.supabase = createClient(this.cfg.supabaseUrl, this.cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    // 4) Session bootstrap
    await this.bootstrapSession();

    // 5) Default tab
    this.setTab("dash");

    // 6) Data
    await this.refreshFeed().catch(() => {});
    await this.initCharts().catch(() => {});
    this.initAudioContext();
  },

  async fetchConfig() {
    const r = await fetch("/api/workout?config=1", {
      method: "GET",
      headers: { "X-FitAI-Client": CLIENT_TOKEN }
    });
    if (!r.ok) throw new Error(`Config failed (${r.status})`);
    const data = await r.json();
    if (!data?.supabaseUrl || !data?.supabaseAnonKey) throw new Error("Invalid config.");
    return data;
  },

  async bootstrapSession() {
    const { data } = await this.supabase.auth.getSession();
    this.session = data.session || null;
    this.user = this.session?.user || null;

    this.supabase.auth.onAuthStateChange(async (_event, newSession) => {
      this.session = newSession || null;
      this.user = newSession?.user || null;
      await this.afterAuthChanged();
    });

    await this.afterAuthChanged();
  },

  async initLucide() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
      return;
    }
    await this.loadScriptOnce("fitai-lucide", "https://unpkg.com/lucide@latest");
    if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons();
  },

  refreshLucideIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons();
  },

  /* =========================
     Tabs (keeps your original)
     ========================= */
  bindTabs() {
    this.$("tabBtnDash")?.addEventListener("click", () => this.setTab("dash"));
    this.$("tabBtnCoach")?.addEventListener("click", () => this.setTab("coach"));
    this.$("tabBtnNutrition")?.addEventListener("click", () => this.setTab("nutrition"));
    this.$("tabBtnCommunity")?.addEventListener("click", () => this.setTab("community"));
    this.$("tabBtnProfile")?.addEventListener("click", () => this.setTab("profile"));
    this.$("tabBtnBodyScan")?.addEventListener("click", () => this.setTab("bodyscan"));
  },

  setTab(tab) {
    const tabs = ["dash", "coach", "nutrition", "community", "profile", "bodyscan"];
    tabs.forEach((t) => {
      const panel = this.$(`tab-${t}`);
      if (panel) panel.style.display = t === tab ? "block" : "none";
      const btn = this.$(`tabBtn${t === "bodyscan" ? "BodyScan" : (t.charAt(0).toUpperCase() + t.slice(1))}`);
      if (btn) {
        btn.classList.toggle("active", t === tab);
        btn.setAttribute("aria-selected", String(t === tab));
      }
    });

    // Lazy hydrate body scan view when opened
    if (tab === "bodyscan") this.hydrateBodyScanTab().catch(() => {});
  },

  /* =========================
     UI bindings (restore buttons)
     ========================= */
  bindUI() {
    this.$("btnMagicLink")?.addEventListener("click", () => this.sendMagicLink());
    this.$("btnLogout")?.addEventListener("click", () => this.logout());

    this.$("btnSaveName")?.addEventListener("click", () => this.saveDisplayName());
    this.$("btnSaveEquipment")?.addEventListener("click", () => this.saveEquipment());
    this.$("btnCoachAsk")?.addEventListener("click", () => this.generateWorkout());

    this.$("btnRefreshFeed")?.addEventListener("click", () => this.refreshFeed());

    // Profile numeric fields
    this.$("profileAge")?.addEventListener("change", () => this.saveProfileData());
    this.$("profileWeight")?.addEventListener("change", () => this.saveProfileData());
    this.$("profileHeight")?.addEventListener("change", () => this.saveProfileData());

    // KPI +/- buttons
    document.querySelectorAll("button.kpiBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-kpi");
        const dir = Number(btn.getAttribute("data-dir") || "0");
        if (!key || !dir) return;
        this.adjustKpi(key, dir);
      });
    });

    // Body scan controls (injected DOM)
    this.$("bsFile")?.addEventListener("change", (e) => this.onBodyScanFilePicked(e));
    this.$("btnBodyScanUpload")?.addEventListener("click", () => this.uploadAndAnalyzeBodyScan());
    this.$("btnBodyScanRefresh")?.addEventListener("click", () => this.refreshBodyScans());
  },

  /* =========================
     Auth + Profiles (FIX persistence)
     ========================= */
  async afterAuthChanged() {
    const authStatus = this.$("authStatus");
    if (authStatus) authStatus.textContent = this.user ? `Connecté : ${this.user.email || this.user.id}` : "Non connecté";

    if (!this.user) {
      this.profile = null;
      this.publicProfile = null;
      this.renderProfileForm(null, null);
      this.renderKpis(null);
      this.setCoachEmpty("Connecte-toi pour activer le Coach IA.");
      this.renderBodyScanEmpty();
      this.refreshLucideIcons();
      return;
    }

    // Ensure rows exist (THIS fixes "it says saved but doesn't persist")
    await this.ensureProfileRows(this.user.id);

    this.renderProfileForm(this.profile, this.publicProfile);
    this.renderKpis(this.profile);

    await this.refreshFeed().catch(() => {});
    this.refreshLucideIcons();
  },

  async ensureProfileRows(userId) {
    // profiles
    const selP = await this.supabase
      .from("profiles")
      .select("user_id,kpis,equipment,last_workout_date,age,weight,height")
      .eq("user_id", userId)
      .maybeSingle();

    if (!selP.data) {
      // Create default row (idempotent-ish)
      const defaults = {
        user_id: userId,
        kpis: { recovery: 70, weight: 70, sleep: 7 },
        equipment: { bodyweight: true }
      };
      await this.supabase.from("profiles").insert(defaults).catch(() => {});
      const again = await this.supabase
        .from("profiles")
        .select("user_id,kpis,equipment,last_workout_date,age,weight,height")
        .eq("user_id", userId)
        .maybeSingle();
      this.profile = again.data || defaults;
    } else {
      this.profile = selP.data;
    }

    // public_profiles
    const selPub = await this.supabase
      .from("public_profiles")
      .select("user_id,display_name")
      .eq("user_id", userId)
      .maybeSingle();
    this.publicProfile = selPub.data || null;
  },

  renderProfileForm(p, pub) {
    const d = this.$("eqDumbbells"); if (d) d.checked = !!p?.equipment?.dumbbells;
    const b = this.$("eqBarbell");   if (b) b.checked = !!p?.equipment?.barbell;
    const bw = this.$("eqBodyweight"); if (bw) bw.checked = p ? (p.equipment?.bodyweight !== false) : true;
    const m = this.$("eqMachines");  if (m) m.checked = !!p?.equipment?.machines;

    const name = this.$("displayName"); if (name) name.value = pub?.display_name || "";

    // numeric inputs
    const ageInput = this.$("profileAge");
    const weightInput = this.$("profileWeight");
    const heightInput = this.$("profileHeight");
    if (ageInput) ageInput.value = p?.age ?? "";
    if (weightInput) weightInput.value = p?.weight ?? "";
    if (heightInput) heightInput.value = p?.height ?? "";
  },

  renderKpis(p) {
    const vr = this.$("val-recovery");
    const vw = this.$("val-weight");
    const vs = this.$("val-sleep");
    const brief = this.$("morningBrief");

    if (!p?.kpis) {
      if (vr) vr.textContent = "--";
      if (vw) vw.textContent = "--";
      if (vs) vs.textContent = "--";
      if (brief) brief.textContent = "Connecte-toi pour activer le suivi.";
      return;
    }

    const k = p.kpis;
    const rec = Number(k.recovery || 0);
    if (vr) vr.textContent = `${Math.round(rec)}%`;
    if (vw) vw.textContent = `${Number(k.weight || 0).toFixed(1)}`;
    if (vs) vs.textContent = `${Number(k.sleep || 0).toFixed(2)}`;

    if (brief) {
      brief.textContent =
        rec < 40 ? "🛑 Recovery basse : mobilité / récupération."
        : rec < 70 ? "⚠️ Recovery modérée : technique / volume léger."
        : "🔥 Recovery haute : tu sais ce qu'il te reste à faire.";
    }
  },

  adjustKpi(key, dir) {
    if (!this.profile?.kpis) return;
    const steps = { recovery: 1, weight: 0.5, sleep: 0.25 };
    const step = steps[key] || 1;
    const current = Number(this.profile.kpis[key] || 0);
    let newVal = current + (dir * step);

    if (key === "recovery") newVal = this.clamp(0, newVal, 100);
    if (key === "weight") newVal = this.clamp(40, newVal, 200);
    if (key === "sleep") newVal = this.clamp(0, newVal, 12);

    this.profile.kpis[key] = newVal;
    this.renderKpis(this.profile);

    clearTimeout(this._kpiSaveT);
    this._kpiSaveT = setTimeout(() => this.saveKpis(), 800);
  },

  async saveKpis() {
    if (!this.user || !this.profile?.kpis) return;
    await this.supabase
      .from("profiles")
      .update({ kpis: this.profile.kpis })
      .eq("user_id", this.user.id);
  },

  async saveProfileData() {
    if (!this.user) return;

    const ageInput = this.$("profileAge");
    const weightInput = this.$("profileWeight");
    const heightInput = this.$("profileHeight");

    const updates = {};
    if (ageInput && ageInput.value !== "") updates.age = Number(ageInput.value);
    if (weightInput && weightInput.value !== "") updates.weight = Number(weightInput.value);
    if (heightInput && heightInput.value !== "") updates.height = Number(heightInput.value);
    if (Object.keys(updates).length === 0) return;

    const { error } = await this.supabase
      .from("profiles")
      .update(updates)
      .eq("user_id", this.user.id);

    if (error) {
      console.error("Save profile error:", error);
      this.hint("profileHint", "Erreur sauvegarde profil", "err");
      return;
    }

    this.hint("profileHint", "✅ Profil sauvegardé", "ok");
    this.profile = { ...(this.profile || {}), ...updates };
  },

  async saveDisplayName() {
    if (!this.user) return;
    const nameEl = this.$("displayName");
    const name = nameEl ? nameEl.value.trim() : "";

    // Important: this requires UNIQUE or PK on user_id in public_profiles
    const { error } = await this.supabase
      .from("public_profiles")
      .upsert({ user_id: this.user.id, display_name: name }, { onConflict: "user_id" });

    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Prénom sauvegardé.", "ok");
    this.publicProfile = { user_id: this.user.id, display_name: name };
  },

  async saveEquipment() {
    if (!this.user) return;

    const equipment = {
      dumbbells: !!this.$("eqDumbbells")?.checked,
      barbell: !!this.$("eqBarbell")?.checked,
      bodyweight: this.$("eqBodyweight") ? (this.$("eqBodyweight").checked) : true,
      machines: !!this.$("eqMachines")?.checked
    };

    const { error } = await this.supabase
      .from("profiles")
      .update({ equipment })
      .eq("user_id", this.user.id);

    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Matériel sauvegardé.", "ok");
    this.profile = { ...(this.profile || {}), equipment };
  },

  /* =========================
     Magic link (more reliable)
     ========================= */
  async sendMagicLink() {
    const emailEl = this.$("email");
    const email = emailEl ? emailEl.value.trim() : "";
    if (!email) return this.hint("profileHint", "Email requis.", "err");

    this.hint("profileHint", "Envoi en cours...", "info");

    const { error } = await this.supabase.auth.signInWithOtp({
      email,
      options: {
        // IMPORTANT: avoid hash routing issues
        emailRedirectTo: window.location.origin
      }
    });

    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Magic link envoyé ! Ouvre le DERNIER email reçu.", "ok");
  },

  async logout() {
    await this.supabase.auth.signOut();
    this.hint("profileHint", "Déconnecté.", "info");
  },

  /* =========================
     Coach (keeps your API)
     ========================= */
  setCoachLoading() {
    const c = this.$("coachOutput");
    if (!c) return;
    c.replaceChildren(
      this.el("div", { className: "card" }, [
        this.el("div", { style: { display: "flex", alignItems: "center", gap: "12px" } }, [
          this.el("div", { className: "spinner" }),
          this.el("span", { text: "Génération en cours..." })
        ])
      ])
    );
  },

  setCoachEmpty(msg) {
    const c = this.$("coachOutput");
    if (!c) return;
    c.replaceChildren(
      this.el("div", { className: "card" }, [
        this.el("div", { className: "empty", text: msg })
      ])
    );
  },

  buildStructuredPrompt(userPrompt) {
    return `Tu es un coach sportif expert. L'utilisateur demande : "${userPrompt}"

Recovery actuelle : ${this.profile?.kpis?.recovery || 70}%
Équipement : ${Object.keys(this.profile?.equipment || {}).filter(k => this.profile?.equipment[k]).join(", ")}

RÉPONDS UNIQUEMENT avec ce JSON STRICT (sans markdown, sans texte avant/après) :
{
  "type": "workout",
  "note": "Conseil du coach en 1-2 phrases",
  "exercises": [
    {
      "name": "Nom de l'exercice",
      "duration": 30,
      "rest": 10,
      "sets": 3,
      "reps": "10-12",
      "rpe": 8
    }
  ]
}

IMPORTANT : duration et rest sont en SECONDES. Si l'exercice est basé sur des répétitions, mets duration à 0.`;
  },

  async generateWorkout() {
    if (!this.user) return this.setCoachEmpty("Connecte-toi.");
    const promptEl = this.$("coachPrompt");
    const prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) return this.setCoachEmpty("Décris ta séance souhaitée.");

    this.setCoachLoading();

    try {
      const enhancedPrompt = this.buildStructuredPrompt(prompt);

      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-FitAI-Client": CLIENT_TOKEN },
        body: JSON.stringify({ prompt: enhancedPrompt, userId: this.user.id })
      });

      if (!r.ok) throw new Error("Erreur API");
      const data = await r.json();
      this.renderWorkoutPlan(typeof data === "string" ? JSON.parse(data) : data);
      this.refreshLucideIcons();
    } catch (err) {
      this.setCoachEmpty("Erreur : " + (err?.message || "inconnue"));
    }
  },

  renderWorkoutPlan(data) {
    const c = this.$("coachOutput");
    if (!c) return;
    c.replaceChildren();

    const card = this.el("div", { className: "card" });

    if (data?.note) {
      card.appendChild(
        this.el("div", { className: "coachNote" }, [
          this.el("div", { className: "coachNoteHeader", text: "📋 Note du Coach" }),
          this.el("p", { className: "coachNoteBody", text: data.note })
        ])
      );
    }

    (data?.exercises || []).forEach(ex => {
      const specs = ex.duration > 0
        ? `${ex.duration}s work • ${ex.rest || 10}s rest`
        : `${ex.sets || 3} × ${ex.reps || "10-12"} • Repos ${ex.rest || "2min"}`;

      const exCard = this.el("div", { className: "exerciseCard" }, [
        this.el("div", { className: "exerciseInfo" }, [
          this.el("div", { className: "exerciseName", text: ex.name || "Exercice" }),
          this.el("div", { className: "exerciseSpecs", text: specs })
        ]),
        this.el("div", { className: "exerciseRPE", text: `RPE ${ex.rpe || "7-8"}` })
      ]);

      card.appendChild(exCard);
    });

    c.appendChild(card);
  },

  /* =========================
     Community feed (kudos button works)
     ========================= */
  async refreshFeed() {
    const fs = this.$("feedStatus");
    if (fs) fs.textContent = "Chargement...";

    const { data, error } = await this.supabase
      .from("workouts_feed")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      if (fs) fs.textContent = "Erreur";
      console.error(error);
      return;
    }

    this.feedItems = data || [];
    if (fs) fs.textContent = `${this.feedItems.length} séances`;
    await this.loadLikedWorkouts().catch(() => {});
    this.renderFeed();
  },

  async loadLikedWorkouts() {
    if (!this.user) return;
    const { data } = await this.supabase
      .from("kudos")
      .select("workout_id")
      .eq("user_id", this.user.id);
    this.likedSet = new Set((data || []).map(k => k.workout_id));
  },

  renderFeed() {
    const c = this.$("feedContainer");
    if (!c) return;
    c.replaceChildren();

    if (!this.feedItems.length) {
      c.appendChild(this.el("div", { className: "empty", text: "Aucune séance publique." }));
      return;
    }

    this.feedItems.forEach(item => {
      const liked = this.likedSet.has(item.id);

      const card = this.el("div", { className: "feedCard" }, [
        this.el("div", { className: "feedHeader" }, [
          this.el("div", { className: "feedUser" }, [
            this.el("span", { text: item.user_display || "User" }),
            this.el("span", { className: "feedBadges", text: item.badges || "" })
          ]),
          this.el("div", { className: "feedTime", text: new Date(item.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short" }) })
        ]),
        this.el("div", { className: "feedTitle", text: item.title || "Séance" }),
        this.el("div", { className: "feedActions" }, [
          this.el("div", {}, [
            this.el("span", {
              className: `badge ${item.intensity === "hard" ? "red" : item.intensity === "medium" ? "orange" : "lime"}`,
              text: String(item.intensity || "").toUpperCase()
            })
          ]),
          this.el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, [
            this.el("button", { className: "kudosBtn" + (liked ? " liked" : ""), text: (liked ? "💖" : "🤍") + " " + (item.kudos_count || 0) })
          ])
        ])
      ]);

      const kudosBtn = card.querySelector(".kudosBtn");
      if (kudosBtn) kudosBtn.addEventListener("click", () => this.toggleKudos(item.id));

      c.appendChild(card);
    });
  },

  async toggleKudos(workoutId) {
    if (!this.user) return alert("Connecte-toi pour liker.");
    if (this.kudosBusy.has(workoutId)) return;
    this.kudosBusy.add(workoutId);

    const liked = this.likedSet.has(workoutId);
    if (liked) {
      const { error } = await this.supabase
        .from("kudos")
        .delete()
        .eq("workout_id", workoutId)
        .eq("user_id", this.user.id);
      if (!error) this.likedSet.delete(workoutId);
    } else {
      const { error } = await this.supabase
        .from("kudos")
        .insert({ workout_id: workoutId, user_id: this.user.id });
      if (!error) this.likedSet.add(workoutId);
    }

    this.kudosBusy.delete(workoutId);
    await this.refreshFeed();
  },

  /* =========================
     Charts (restore "like before")
     ========================= */
  async initCharts() {
    // Load Chart.js only if not already in index
    if (!window.Chart) {
      await this.loadScriptOnce("fitai-chartjs", "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js");
    }
    if (!window.Chart) return;

    const canvas = this.$("volumeChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    this.chartVolume = new window.Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{ label: "Volume", data: [] }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });

    await this.updateVolumeChart().catch(() => {});
  },

  async updateVolumeChart() {
    if (!this.chartVolume || !this.user) return;

    // last 6 weeks
    const weeks = [];
    const volumes = [];

    for (let i = 5; i >= 0; i--) {
      const start = new Date();
      start.setDate(start.getDate() - (i * 7));
      start.setHours(0, 0, 0, 0);

      const end = new Date(start);
      end.setDate(end.getDate() + 7);

      const { data } = await this.supabase
        .from("workouts")
        .select("exercises")
        .eq("user_id", this.user.id)
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString());

      let weekVolume = 0;

      (data || []).forEach(w => {
        const exs = w.exercises || [];
        exs.forEach(ex => {
          const sets = Number(ex.sets || 0) || 0;
          const reps = String(ex.reps || "");
          const m = reps.match(/(\d+)\s*-\s*(\d+)/);
          const single = reps.match(/^\s*(\d+)\s*$/);
          let avgReps = 8;
          if (m) avgReps = (Number(m[1]) + Number(m[2])) / 2;
          else if (single) avgReps = Number(single[1]) || 8;
          weekVolume += sets * avgReps * 50;
        });
      });

      weeks.push(i === 0 ? "Maintenant" : `S-${i}`);
      volumes.push(Math.round(weekVolume));
    }

    this.chartVolume.data.labels = weeks;
    this.chartVolume.data.datasets[0].data = volumes;
    this.chartVolume.update();
  },

  /* =========================
     Body Scan (tab + upload + signed urls + call /api/bodyscan)
     ========================= */
  ensureBodyScanTabDOM() {
    // 1) Add button to existing tab bar if present
    const existingBtn = this.$("tabBtnBodyScan");
    if (!existingBtn) {
      // Try to find a container that already has tab buttons
      const dashBtn = this.$("tabBtnDash");
      const tabBar = dashBtn?.parentElement || document.querySelector(".tabs") || document.querySelector(".tabBar") || null;

      if (tabBar) {
        const btn = document.createElement("button");
        btn.id = "tabBtnBodyScan";
        btn.className = dashBtn?.className || "tabBtn";
        btn.type = "button";
        btn.textContent = "Body Scan";
        tabBar.appendChild(btn);
      }
    }

    // 2) Add panel container if missing
    if (!this.$("tab-bodyscan")) {
      const host =
        this.$("tab-profile")?.parentElement ||
        document.querySelector("[id^='tab-']")?.parentElement ||
        document.body;

      const panel = document.createElement("section");
      panel.id = "tab-bodyscan";
      panel.style.display = "none";
      host.appendChild(panel);
    }
  },

  renderBodyScanEmpty() {
    const panel = this.$("tab-bodyscan");
    if (!panel) return;
    panel.replaceChildren(
      this.el("div", { className: "card" }, [
        this.el("div", { className: "empty", text: "Connecte-toi pour activer Body Scan." })
      ])
    );
  },

  async hydrateBodyScanTab() {
    const panel = this.$("tab-bodyscan");
    if (!panel) return;

    if (!this.user) return this.renderBodyScanEmpty();

    // Build UI once
    if (!this.$("bsFile")) {
      const left = this.el("div", { className: "card" }, [
        this.el("div", { style: { fontSize: "18px", fontWeight: "950", color: "var(--lime)", marginBottom: "6px" }, text: "📸 Body Scan" }),
        this.el("div", { style: { fontSize: "12px", color: "var(--muted)", marginBottom: "14px" }, text: "Upload privé + analyse Gemini + historique." }),

        this.el("div", { style: { fontSize: "12px", color: "var(--muted)", marginBottom: "6px" }, text: "Image (JPG/PNG/WEBP, max 10MB)" }),
        this.el("input", { attrs: { id: "bsFile", type: "file", accept: "image/*" }, className: "input" }),

        this.el("div", { attrs: { id: "bsPickInfo" }, style: { marginTop: "10px", fontSize: "12px", color: "var(--muted)" }, text: "Aucune image sélectionnée." }),

        this.el("img", { attrs: { id: "bsPreview", alt: "Preview" }, style: { width: "100%", marginTop: "12px", borderRadius: "14px", display: "none", border: "1px solid var(--stroke)" } }),

        this.el("div", { attrs: { id: "bsHint" }, style: { marginTop: "10px", fontSize: "12px", color: "var(--muted)" }, text: "" }),

        this.el("div", { style: { display: "flex", gap: "12px", marginTop: "16px", flexWrap: "wrap" } }, [
          this.el("button", { attrs: { id: "btnBodyScanRefresh", type: "button" }, className: "btn", text: "↻ Rafraîchir", style: { flex: "1", minWidth: "140px" } }),
          this.el("button", { attrs: { id: "btnBodyScanUpload", type: "button" }, className: "btn primary", text: "🚀 Uploader + analyser", style: { flex: "1", minWidth: "180px" } })
        ])
      ]);

      const right = this.el("div", { className: "card" }, [
        this.el("div", { style: { fontSize: "18px", fontWeight: "950", color: "var(--cyan)", marginBottom: "6px" }, text: "🧬 Historique" }),
        this.el("div", { attrs: { id: "bsTimeline" }, className: "empty", text: "Chargement..." })
      ]);

      const row = this.el("div", { style: { display: "grid", gridTemplateColumns: "1.1fr .9fr", gap: "16px" } }, [left, right]);
      row.style.alignItems = "start";
      row.style.marginTop = "10px";

      panel.replaceChildren(row);

      // (re)bind body scan UI
      this.$("bsFile")?.addEventListener("change", (e) => this.onBodyScanFilePicked(e));
      this.$("btnBodyScanUpload")?.addEventListener("click", () => this.uploadAndAnalyzeBodyScan());
      this.$("btnBodyScanRefresh")?.addEventListener("click", () => this.refreshBodyScans());
    }

    await this.refreshBodyScans();
  },

  onBodyScanFilePicked(e) {
    const file = e?.target?.files?.[0] || null;
    const info = this.$("bsPickInfo");
    const img = this.$("bsPreview");
    const btn = this.$("btnBodyScanUpload");

    if (!file) {
      if (info) info.textContent = "Aucune image sélectionnée.";
      if (img) { img.src = ""; img.style.display = "none"; }
      if (btn) btn.disabled = true;
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      this.hint("bsHint", "Image trop lourde (max 10MB).", "err");
      e.target.value = "";
      if (btn) btn.disabled = true;
      return;
    }

    if (info) info.textContent = `${file.name} • ${(file.size / (1024 * 1024)).toFixed(2)} MB`;
    this.hint("bsHint", "", "info");

    const url = URL.createObjectURL(file);
    if (img) {
      img.src = url;
      img.style.display = "block";
      img.onload = () => { try { URL.revokeObjectURL(url); } catch {} };
    }
    if (btn) btn.disabled = false;
  },

  async refreshBodyScans() {
    if (!this.user) return;
    const tl = this.$("bsTimeline");
    if (tl) tl.textContent = "Chargement...";

    const { data, error } = await this.supabase
      .from("body_scans")
      .select("id,user_id,image_path,ai_feedback,ai_version,created_at,symmetry_score,posture_score,bodyfat_proxy")
      .eq("user_id", this.user.id)
      .order("created_at", { ascending: false })
      .limit(40);

    if (error) {
      console.error(error);
      if (tl) tl.textContent = "Erreur lecture body_scans (RLS / table).";
      return;
    }

    this.bodyScans = data || [];
    this.renderBodyScanTimeline();
  },

  async getSignedUrl(path) {
    const now = Date.now();
    const cached = this.signedUrlCache.get(path);
    if (cached && cached.url && cached.expMs - now > 60_000) return cached.url;

    const { data, error } = await this.supabase
      .storage
      .from(BUCKET_UPLOADS)
      .createSignedUrl(path, BODYSCAN_SIGNED_URL_TTL);

    if (error || !data?.signedUrl) throw error || new Error("Signed URL failed");
    const expMs = now + BODYSCAN_SIGNED_URL_TTL * 1000;
    this.signedUrlCache.set(path, { url: data.signedUrl, expMs });
    return data.signedUrl;
  },

  renderBodyScanTimeline() {
    const tl = this.$("bsTimeline");
    if (!tl) return;

    tl.replaceChildren();

    if (!this.bodyScans.length) {
      tl.className = "empty";
      tl.textContent = "Aucun scan pour le moment.";
      return;
    }

    tl.className = "";

    this.bodyScans.forEach((s, idx) => {
      const wrap = this.el("div", { className: "feedCard" });
      wrap.style.marginBottom = "12px";

      const title = this.el("div", { style: { fontWeight: "950" }, text: new Date(s.created_at).toLocaleString("fr-FR") });
      const sub = this.el("div", { style: { fontSize: "12px", color: "var(--muted)", marginTop: "4px" }, text: s.ai_version ? `IA: ${s.ai_version}` : "IA: —" });

      const img = this.el("img", { attrs: { alt: "Body scan" } });
      img.style.width = "100%";
      img.style.borderRadius = "14px";
      img.style.border = "1px solid var(--stroke)";
      img.style.marginTop = "10px";

      this.getSignedUrl(s.image_path)
        .then((u) => { img.src = u; })
        .catch(() => { img.remove(); });

      const scores = this.el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "10px" } }, [
        this.el("span", { className: "badge lime", text: `Sym ${s.symmetry_score ?? "—"}` }),
        this.el("span", { className: "badge cyan", text: `Post ${s.posture_score ?? "—"}` }),
        this.el("span", { className: "badge orange", text: `Sec ${s.bodyfat_proxy ?? "—"}` })
      ]);

      const feedback = this.el("div", { style: { fontSize: "12px", color: "var(--muted)", marginTop: "10px", whiteSpace: "pre-wrap", lineHeight: "1.5" }, text: s.ai_feedback || "Analyse en attente (ou erreur IA)." });

      const btnRow = this.el("div", { style: { display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" } }, [
        this.el("button", { className: "btn", text: "Comparer (N-1)" }),
        this.el("button", { className: "btn pink", text: "Supprimer" })
      ]);

      // Compare
      btnRow.children[0].disabled = !(this.bodyScans[idx + 1]);
      btnRow.children[0].addEventListener("click", async () => {
        const prev = this.bodyScans[idx + 1];
        if (!prev) return;
        try {
          const [a, b] = await Promise.all([this.getSignedUrl(s.image_path), this.getSignedUrl(prev.image_path)]);
          this.openCompareModal(a, b, s, prev);
        } catch {
          alert("Erreur signed URL / policies.");
        }
      });

      // Delete
      btnRow.children[1].addEventListener("click", async () => {
        const ok = confirm("Supprimer ce scan ? (fichier + DB)");
        if (!ok) return;
        await this.deleteBodyScan(s).catch((e) => alert(e?.message || "Erreur suppression"));
        await this.refreshBodyScans();
      });

      wrap.appendChild(title);
      wrap.appendChild(sub);
      wrap.appendChild(img);
      wrap.appendChild(scores);
      wrap.appendChild(feedback);
      wrap.appendChild(btnRow);

      tl.appendChild(wrap);
    });
  },

  openCompareModal(urlA, urlB) {
    // Simple overlay slider (no design change: uses existing card look)
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,.72)";
    overlay.style.backdropFilter = "blur(10px)";
    overlay.style.zIndex = "9999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.padding = "18px";

    const box = this.el("div", { className: "card" });
    box.style.width = "min(980px, 100%)";
    box.style.maxHeight = "86vh";
    box.style.overflow = "auto";

    const title = this.el("div", { style: { fontSize: "18px", fontWeight: "950", color: "var(--lime)" }, text: "Comparaison Body Scan" });
    const hint = this.el("div", { style: { fontSize: "12px", color: "var(--muted)", marginTop: "6px" }, text: "Glisse le curseur pour voir Avant/Après." });

    const stage = document.createElement("div");
    stage.style.position = "relative";
    stage.style.marginTop = "14px";
    stage.style.borderRadius = "14px";
    stage.style.overflow = "hidden";
    stage.style.border = "1px solid var(--stroke)";
    stage.style.width = "100%";
    stage.style.aspectRatio = "16/10";
    stage.style.background = "rgba(255,255,255,.03)";

    const imgB = document.createElement("img");
    imgB.src = urlB;
    imgB.style.position = "absolute";
    imgB.style.inset = "0";
    imgB.style.width = "100%";
    imgB.style.height = "100%";
    imgB.style.objectFit = "cover";

    const imgA = document.createElement("img");
    imgA.src = urlA;
    imgA.style.position = "absolute";
    imgA.style.inset = "0";
    imgA.style.width = "100%";
    imgA.style.height = "100%";
    imgA.style.objectFit = "cover";
    imgA.style.clipPath = "inset(0 50% 0 0)";

    stage.appendChild(imgB);
    stage.appendChild(imgA);

    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.value = "50";
    range.style.width = "100%";
    range.style.marginTop = "12px";

    range.addEventListener("input", () => {
      const v = Number(range.value || 50);
      imgA.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    });

    const close = this.el("button", { className: "btn", text: "Fermer" });
    close.addEventListener("click", () => overlay.remove());

    const footer = this.el("div", { style: { display: "flex", gap: "12px", justifyContent: "flex-end", marginTop: "14px" } }, [close]);

    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(stage);
    box.appendChild(range);
    box.appendChild(footer);

    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  },

  async deleteBodyScan(scan) {
    if (!this.user) throw new Error("Not authed");

    // remove storage object
    const { error: rmErr } = await this.supabase.storage.from(BUCKET_UPLOADS).remove([scan.image_path]);
    if (rmErr) throw rmErr;

    // delete DB row
    const { error: delErr } = await this.supabase
      .from("body_scans")
      .delete()
      .eq("id", scan.id)
      .eq("user_id", this.user.id);

    if (delErr) throw delErr;

    this.signedUrlCache.delete(scan.image_path);
  },

  async uploadAndAnalyzeBodyScan() {
    if (!this.user) return this.hint("bsHint", "Connecte-toi.", "err");
    if (this.bodyScanBusy) return;
    this.bodyScanBusy = true;

    const fileInput = this.$("bsFile");
    const file = fileInput?.files?.[0] || null;
    if (!file) {
      this.bodyScanBusy = false;
      return this.hint("bsHint", "Choisis une image.", "err");
    }

    if (file.size > MAX_IMAGE_BYTES) {
      this.bodyScanBusy = false;
      return this.hint("bsHint", "Image trop lourde (max 10MB).", "err");
    }

    const mime = String(file.type || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      this.bodyScanBusy = false;
      return this.hint("bsHint", "Format non supporté (JPG/PNG/WEBP).", "err");
    }

    try {
      this.hint("bsHint", "Upload en cours...", "info");

      const uid = this.user.id;
      const rand = (crypto?.randomUUID?.() || (Math.random().toString(16).slice(2) + Date.now())).replace(/-/g, "");
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      const path = `${uid}/bodyscans/bodyscan_${rand}_${Date.now()}.${ext}`;

      // 1) upload private
      const { error: upErr } = await this.supabase.storage.from(BUCKET_UPLOADS).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: mime
      });
      if (upErr) throw upErr;

      // 2) create DB row (analysis will UPDATE it)
      const { error: insErr } = await this.supabase.from("body_scans").insert({
        user_id: uid,
        image_path: path,
        ai_feedback: ""
      });
      if (insErr) throw insErr;

      // 3) call server brain (Gemini) to update row
      const accessToken = this.session?.access_token || (await this.supabase.auth.getSession()).data?.session?.access_token;
      if (!accessToken) throw new Error("No access token");

      this.hint("bsHint", "Analyse Gemini en cours...", "info");

      const r = await fetch("/api/bodyscan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({ user_id: uid, image_path: path })
      });

      const out = await r.json().catch(() => null);
      if (!r.ok || !out?.ok) {
        console.error("bodyscan api error:", out);
        this.hint("bsHint", "Upload OK, mais analyse IA a échoué. (voir console)", "err");
      } else {
        this.hint("bsHint", "✅ Scan analysé et sauvegardé.", "ok");
      }

      // reset picker
      if (fileInput) fileInput.value = "";
      const prev = this.$("bsPreview");
      if (prev) { prev.src = ""; prev.style.display = "none"; }
      const info = this.$("bsPickInfo");
      if (info) info.textContent = "Aucune image sélectionnée.";

      await this.refreshBodyScans();
    } catch (e) {
      console.error(e);
      this.hint("bsHint", e?.message || "Erreur upload/analyse", "err");
    } finally {
      this.bodyScanBusy = false;
    }
  },

  /* =========================
     Audio (kept)
     ========================= */
  initAudioContext() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.audioContext = null;
    }
  }
};

/* ============================================================
   Boot
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => App.init());
