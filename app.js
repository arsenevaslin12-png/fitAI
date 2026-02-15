import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_TOKEN = "fitai-v18";

const BADGES = {
  STREAK:     { emoji: "🔥", title: "STREAK",     desc: "3 jours consécutifs (au moins 1 séance/jour)." },
  CLOWN:      { emoji: "🤡", title: "CLOWN",      desc: "Séance Light avec Recovery ≥ 90%." },
  MACHINE:    { emoji: "🦾", title: "MACHINE",    desc: "3 séances Hard dans la semaine ISO." },
  KUDOS_KING: { emoji: "👑", title: "KUDOS KING", desc: "Une séance qui dépasse 10 kudos." }
};

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
  kpiSaveTimer: null,
  kpiSteps: { recovery: 1, weight: 0.5, sleep: 0.25 },
  meals: [],
  chartVolume: null,

  $: (id) => document.getElementById(id),

  el(tag, opts = {}, children = []) {
    const n = document.createElement(tag);
    if (opts.className) n.className = opts.className;
    if (opts.type) n.type = opts.type;
    if (opts.text != null) n.textContent = String(opts.text);
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, String(v));
    if (opts.style) for (const [k, v] of Object.entries(opts.style)) n.style[k] = v;
    for (const c of children) if (c) n.appendChild(c);
    return n;
  },

  clamp(min, v, max) { return Math.max(min, Math.min(max, v)); },

  getAggressiveRoast() {
    const roasts = [
      "48h sans séance. Ton canapé vient de demander ta main en mariage.",
      "Deux jours off ? Même ta motivation s'est mise en arrêt maladie.",
      "Ton cardio fait la grève. Et apparemment, toi aussi.",
      "Aucun entraînement depuis 48h : tu collectes des excuses ou tu veux des résultats ?",
      "Tu t'es évaporé 48h. Reviens : barre fixe, haltères, ou au moins des squats."
    ];
    return roasts[Math.floor(Math.random() * roasts.length)];
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

  async init() {
    this.bindTabs();
    this.bindUI();
    this.cfg = await this.fetchConfig();
    this.supabase = createClient(this.cfg.supabaseUrl, this.cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        storage: window.sessionStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    await this.initAuth();
    this.setTab("dash");
    await this.refreshFeed();
    this.initCharts();
  },

  bindTabs() {
    this.$("tabBtnDash").addEventListener("click", () => this.setTab("dash"));
    this.$("tabBtnCoach").addEventListener("click", () => this.setTab("coach"));
    this.$("tabBtnNutrition").addEventListener("click", () => this.setTab("nutrition"));
    this.$("tabBtnCommunity").addEventListener("click", () => this.setTab("community"));
    this.$("tabBtnProfile").addEventListener("click", () => this.setTab("profile"));
  },

  setTab(tab) {
    const tabs = ["dash", "coach", "nutrition", "community", "profile"];
    tabs.forEach(t => {
      this.$(`tab-${t}`).style.display = t === tab ? "block" : "none";
      const btn = this.$(`tabBtn${t.charAt(0).toUpperCase() + t.slice(1)}`);
      btn.classList.toggle("active", t === tab);
      btn.setAttribute("aria-selected", String(t === tab));
    });
  },

  bindUI() {
    this.$("btnMagicLink").addEventListener("click", () => this.sendMagicLink());
    this.$("btnLogout").addEventListener("click", () => this.logout());
    this.$("btnSaveName").addEventListener("click", () => this.saveDisplayName());
    this.$("btnSaveEquipment").addEventListener("click", () => this.saveEquipment());
    this.$("btnRefreshTrophies").addEventListener("click", () => this.refreshTrophies());
    this.$("btnCoachAsk").addEventListener("click", () => this.generateWorkout());
    this.$("btnRefreshFeed").addEventListener("click", () => this.refreshFeed());
    this.$("btnAddMeal").addEventListener("click", () => this.showMealModal());
    this.$("btnSaveMeal").addEventListener("click", () => this.saveMeal());
    this.$("btnCancelMeal").addEventListener("click", () => this.hideMealModal());

    document.querySelectorAll("button.kpiBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-kpi");
        const dir = Number(btn.getAttribute("data-dir") || "0");
        if (!key || !dir) return;
        this.adjustKpi(key, dir);
      });
    });
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

  async initAuth() {
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

  async afterAuthChanged() {
    this.$("authStatus").textContent = this.user ? `Connecté : ${this.user.email || this.user.id}` : "Non connecté";

    if (!this.user) {
      this.profile = null;
      this.publicProfile = null;
      this.renderProfileForm(null, null);
      this.renderKpis(null);
      this.renderRoastState(null);
      this.renderRecent([]);
      this.renderStats(null);
      this.renderHeatmap(null);
      this.setCoachEmpty("Connecte-toi pour activer le Coach IA.");
      this.$("feedStatus").textContent = "Lecture seule";
      this.hint("trophyHint", "Connecte-toi pour voir tes trophées.", "info");
      this.renderTrophyWall(new Map());
      this.renderNutrition();
      await this.refreshFeed();
      return;
    }

    await this.ensureProfiles(this.user.id);
    this.renderProfileForm(this.profile, this.publicProfile);
    this.renderKpis(this.profile);
    this.renderRoastState(this.profile);
    await this.refreshRecent();
    await this.refreshStats();
    await this.refreshHeatmap();
    await this.refreshFeed();
    await this.evaluateAchievements();
    await this.refreshTrophies();
    this.renderNutrition();
  },

  async ensureProfiles(userId) {
    const selP = await this.supabase
      .from("profiles")
      .select("kpis,equipment,last_workout_date")
      .eq("user_id", userId)
      .maybeSingle();
    this.profile = selP.data || null;

    const selPub = await this.supabase
      .from("public_profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    this.publicProfile = selPub.data || null;

    this.hint("profileHint", "Profil synchronisé ✅", "ok");
  },

  renderProfileForm(p, pub) {
    this.$("eqDumbbells").checked = !!p?.equipment?.dumbbells;
    this.$("eqBarbell").checked = !!p?.equipment?.barbell;
    this.$("eqBodyweight").checked = p ? (p.equipment?.bodyweight !== false) : true;
    this.$("eqMachines").checked = !!p?.equipment?.machines;
    this.$("displayName").value = pub?.display_name || "";
  },

  renderKpis(p) {
    if (!p?.kpis) {
      this.$("val-recovery").textContent = "--";
      this.$("val-weight").textContent = "--";
      this.$("val-sleep").textContent = "--";
      this.$("morningBrief").textContent = "Connecte-toi pour activer le suivi.";
      return;
    }
    const k = p.kpis;
    const rec = Number(k.recovery || 0);
    this.$("val-recovery").textContent = `${Math.round(rec)}%`;
    this.$("val-weight").textContent = `${Number(k.weight || 0).toFixed(1)}`;
    this.$("val-sleep").textContent = `${Number(k.sleep || 0).toFixed(2)}`;

    this.$("morningBrief").textContent =
      rec < 40 ? "🛑 Recovery basse : mobilité / récupération."
      : rec < 70 ? "⚠️ Recovery modérée : technique / volume léger."
      : "🔥 Recovery haute : tu sais ce qu'il te reste à faire.";
  },

  renderRoastState(profile) {
    const banner = this.$("roastBanner");
    banner.classList.remove("on");
    banner.textContent = "";

    if (!this.user || !profile) return;

    const last = profile.last_workout_date ? new Date(profile.last_workout_date) : null;
    if (!last) {
      banner.classList.add("on");
      banner.textContent = `🔴 Aucun historique. ${this.getAggressiveRoast()}`;
      return;
    }

    const diffH = (Date.now() - last.getTime()) / 36e5;
    if (diffH >= 48) {
      banner.classList.add("on");
      banner.textContent = `🔴 Honte officielle : 48h sans séance. ${this.getAggressiveRoast()}`;
    }
  },

  adjustKpi(key, dir) {
    if (!this.profile?.kpis) return;
    const step = this.kpiSteps[key] || 1;
    const current = Number(this.profile.kpis[key] || 0);
    let newVal = current + (dir * step);

    if (key === "recovery") newVal = this.clamp(0, newVal, 100);
    if (key === "weight") newVal = this.clamp(40, newVal, 200);
    if (key === "sleep") newVal = this.clamp(0, newVal, 12);

    this.profile.kpis[key] = newVal;
    this.renderKpis(this.profile);

    clearTimeout(this.kpiSaveTimer);
    this.kpiSaveTimer = setTimeout(() => this.saveKpis(), 1500);
  },

  async saveKpis() {
    if (!this.user || !this.profile) return;
    const { error } = await this.supabase
      .from("profiles")
      .update({ kpis: this.profile.kpis })
      .eq("user_id", this.user.id);
    if (error) console.error("Save KPI error:", error);
  },

  async sendMagicLink() {
    const email = this.$("email").value.trim();
    if (!email) return this.hint("profileHint", "Email requis.", "err");
    this.hint("profileHint", "Envoi en cours...", "info");
    const { error } = await this.supabase.auth.signInWithOtp({ email });
    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Magic link envoyé ! Vérifie tes emails.", "ok");
  },

  async logout() {
    await this.supabase.auth.signOut();
    this.hint("profileHint", "Déconnecté.", "info");
  },

  async saveDisplayName() {
    if (!this.user) return;
    const name = this.$("displayName").value.trim();
    const { error } = await this.supabase
      .from("public_profiles")
      .upsert({ user_id: this.user.id, display_name: name });
    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Prénom sauvegardé.", "ok");
    this.publicProfile = { display_name: name };
  },

  async saveEquipment() {
    if (!this.user) return;
    const equipment = {
      dumbbells: this.$("eqDumbbells").checked,
      barbell: this.$("eqBarbell").checked,
      bodyweight: this.$("eqBodyweight").checked,
      machines: this.$("eqMachines").checked
    };
    const { error } = await this.supabase
      .from("profiles")
      .update({ equipment })
      .eq("user_id", this.user.id);
    if (error) return this.hint("profileHint", error.message, "err");
    this.hint("profileHint", "✅ Matériel sauvegardé.", "ok");
    this.profile.equipment = equipment;
  },

  async refreshRecent() {
    if (!this.user) return this.renderRecent([]);
    const { data, error } = await this.supabase
      .from("workouts")
      .select("id,created_at,title,intensity")
      .eq("user_id", this.user.id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) return console.error(error);
    this.renderRecent(data || []);
  },

  renderRecent(workouts) {
    const c = this.$("recentWorkouts");
    c.innerHTML = "";
    if (!workouts.length) {
      c.appendChild(this.el("div", { className: "empty", text: "Aucune séance enregistrée." }));
      return;
    }
    workouts.forEach(w => {
      const badge = w.intensity === "hard" ? "🔴 HARD" : w.intensity === "medium" ? "🟠 MEDIUM" : "🟢 LIGHT";
      const card = this.el("div", { className: "mealCard" }, [
        this.el("div", { className: "mealHeader" }, [
          this.el("div", { className: "mealType", text: w.title }),
          this.el("span", { className: "badge orange", text: badge })
        ]),
        this.el("div", { style: { fontSize: "11px", color: "var(--muted)" }, text: new Date(w.created_at).toLocaleString("fr-FR") })
      ]);
      c.appendChild(card);
    });
  },

  async refreshStats() {
    if (!this.user) return this.renderStats(null);
    const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 864e5).toISOString();

    const { data: current } = await this.supabase
      .from("workouts")
      .select("id")
      .eq("user_id", this.user.id)
      .gte("created_at", sevenDaysAgo);

    const { data: previous } = await this.supabase
      .from("workouts")
      .select("id")
      .eq("user_id", this.user.id)
      .gte("created_at", fourteenDaysAgo)
      .lt("created_at", sevenDaysAgo);

    const currentCount = current?.length || 0;
    const previousCount = previous?.length || 0;
    const change = previousCount ? Math.round(((currentCount - previousCount) / previousCount) * 100) : 0;

    this.renderStats({ workouts: currentCount, volume: currentCount * 1000, change });
  },

  renderStats(stats) {
    if (!stats) {
      this.$("stat-workouts").textContent = "0";
      this.$("stat-volume").textContent = "0";
      this.$("stat-workouts-trend").innerHTML = `<span>→</span> <span>+0%</span>`;
      this.$("stat-volume-trend").innerHTML = `<span>→</span> <span>+0%</span>`;
      return;
    }
    this.$("stat-workouts").textContent = stats.workouts;
    this.$("stat-volume").textContent = Math.round(stats.volume / 1000) + "k";
    
    const trendEl = this.$("stat-workouts-trend");
    trendEl.className = "statTrend " + (stats.change > 0 ? "up" : stats.change < 0 ? "down" : "");
    trendEl.innerHTML = `<span>${stats.change > 0 ? "↗" : stats.change < 0 ? "↘" : "→"}</span> <span>${stats.change > 0 ? "+" : ""}${stats.change}%</span>`;
  },

  async refreshHeatmap() {
    if (!this.user) return this.renderHeatmap(null);
    const twentyEightDaysAgo = new Date(Date.now() - 28 * 864e5).toISOString();
    const { data } = await this.supabase
      .from("workouts")
      .select("created_at")
      .eq("user_id", this.user.id)
      .gte("created_at", twentyEightDaysAgo);

    const workoutDates = new Set((data || []).map(w => new Date(w.created_at).toDateString()));
    const days = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      days.push({ date: d.toDateString(), active: workoutDates.has(d.toDateString()), label: d.getDate() });
    }
    this.renderHeatmap(days);
  },

  renderHeatmap(days) {
    const c = this.$("activityHeatmap");
    c.innerHTML = "";
    if (!days) {
      for (let i = 0; i < 28; i++) {
        c.appendChild(this.el("div", { className: "heatmapDay" }));
      }
      return;
    }
    days.forEach(d => {
      const el = this.el("div", {
        className: "heatmapDay" + (d.active ? " active" : ""),
        text: d.label
      });
      c.appendChild(el);
    });
  },

  async generateWorkout() {
    if (!this.user) return this.setCoachEmpty("Connecte-toi.");
    const prompt = this.$("coachPrompt").value.trim();
    if (!prompt) return this.setCoachEmpty("Décris ta séance souhaitée.");

    this.setCoachLoading();

    try {
      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-FitAI-Client": CLIENT_TOKEN },
        body: JSON.stringify({ prompt, userId: this.user.id })
      });

      if (!r.ok) throw new Error("Erreur API");
      const data = await r.json();
      this.renderWorkoutPlan(data);
    } catch (err) {
      this.setCoachEmpty("Erreur : " + err.message);
    }
  },

  setCoachLoading() {
    this.$("coachOutput").innerHTML = `<div class="card"><div style="display:flex; align-items:center; gap:12px;"><div class="spinner"></div><span>Génération en cours...</span></div></div>`;
  },

  setCoachEmpty(msg) {
    this.$("coachOutput").innerHTML = `<div class="card"><div class="empty">${msg}</div></div>`;
  },

  renderWorkoutPlan(data) {
    const c = this.$("coachOutput");
    c.innerHTML = "";

    const card = this.el("div", { className: "card" });
    if (data.note) {
      const note = this.el("div", { className: "coachNote" }, [
        this.el("div", { className: "coachNoteHeader", text: "📋 Note du Coach" }),
        this.el("p", { className: "coachNoteBody", text: data.note })
      ]);
      card.appendChild(note);
    }

    if (data.exercises?.length) {
      data.exercises.forEach(ex => {
        const exCard = this.el("div", { className: "exerciseCard" }, [
          this.el("div", { className: "exerciseInfo" }, [
            this.el("div", { className: "exerciseName", text: ex.name }),
            this.el("div", { className: "exerciseSpecs", text: `${ex.sets} × ${ex.reps} ${ex.rest ? `• Repos ${ex.rest}` : ""}` })
          ]),
          this.el("div", { className: "exerciseRPE", text: `RPE ${ex.rpe || "7-8"}` })
        ]);
        card.appendChild(exCard);
      });
    }

    const btnRow = this.el("div", { style: { display: "flex", gap: "12px", marginTop: "20px" } }, [
      this.el("button", { className: "btn primary", text: "💾 Sauvegarder cette Séance", style: { flex: "1" } }),
      this.el("button", { className: "btn", text: "🔄 Nouvelle Génération", style: { flex: "1" } })
    ]);
    btnRow.children[0].addEventListener("click", () => this.saveWorkout(data));
    btnRow.children[1].addEventListener("click", () => this.generateWorkout());
    card.appendChild(btnRow);

    c.appendChild(card);
  },

  async saveWorkout(data) {
    if (!this.user) return;
    const title = data.exercises?.[0]?.name || "Séance générée";
    const { error } = await this.supabase.from("workouts").insert({
      user_id: this.user.id,
      title,
      intensity: "medium",
      is_public: true,
      exercises: data.exercises
    });
    if (error) return alert("Erreur : " + error.message);
    alert("✅ Séance sauvegardée !");
    await this.refreshRecent();
    await this.refreshStats();
    await this.refreshHeatmap();
    this.updateVolumeChart();
  },

  async refreshFeed() {
    this.$("feedStatus").textContent = "Chargement...";
    const { data, error } = await this.supabase
      .from("workouts_feed")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      this.$("feedStatus").textContent = "Erreur";
      return console.error(error);
    }

    this.feedItems = data || [];
    this.$("feedStatus").textContent = `${this.feedItems.length} séances`;
    await this.loadLikedWorkouts();
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
    c.innerHTML = "";
    if (!this.feedItems.length) {
      c.appendChild(this.el("div", { className: "empty", text: "Aucune séance publique." }));
      return;
    }

    this.feedItems.forEach(item => {
      const liked = this.likedSet.has(item.id);
      const card = this.el("div", { className: "feedCard" }, [
        this.el("div", { className: "feedHeader" }, [
          this.el("div", { className: "feedUser" }, [
            this.el("span", { text: item.user_display }),
            this.el("span", { className: "feedBadges", text: item.badges || "" })
          ]),
          this.el("div", { className: "feedTime", text: new Date(item.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short" }) })
        ]),
        this.el("div", { className: "feedTitle", text: item.title }),
        this.el("div", { className: "feedActions" }, [
          this.el("div", {}, [
            this.el("span", { className: `badge ${item.intensity === "hard" ? "red" : item.intensity === "medium" ? "orange" : "lime"}`, text: item.intensity.toUpperCase() })
          ]),
          this.el("div", { style: { display: "flex", gap: "10px", alignItems: "center" } }, [
            this.el("button", {
              className: "kudosBtn" + (liked ? " liked" : ""),
              text: (liked ? "💖" : "🤍") + " " + (item.kudos_count || 0)
            }),
          ])
        ])
      ]);

      const kudosBtn = card.querySelector(".kudosBtn");
      kudosBtn.addEventListener("click", () => this.toggleKudos(item.id));

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

  async evaluateAchievements() {
    // Client-side achievement evaluation (simplified)
    // Real logic should be in triggers, but we can add UI feedback here
    if (!this.user) return;
    // Placeholder for future client-side checks
  },

  async refreshTrophies() {
    if (!this.user) return this.renderTrophyWall(new Map());
    const { data } = await this.supabase
      .from("achievements")
      .select("badge_type,unlocked_at")
      .eq("user_id", this.user.id);

    const unlocked = new Map((data || []).map(a => [a.badge_type, a.unlocked_at]));
    this.renderTrophyWall(unlocked);
    this.hint("trophyHint", `${unlocked.size}/4 trophées débloqués.`, "ok");
  },

  renderTrophyWall(unlocked) {
    const c = this.$("trophyWall");
    c.innerHTML = "";
    Object.entries(BADGES).forEach(([key, badge]) => {
      const unlockedAt = unlocked.get(key);
      const card = this.el("div", { className: "trophyCard" + (unlockedAt ? " unlocked" : " locked") }, [
        this.el("div", { className: "trophyIcon", text: badge.emoji }),
        this.el("div", { className: "trophyInfo" }, [
          this.el("div", { className: "trophyTitle", text: badge.title }),
          this.el("div", { className: "trophyDesc", text: badge.desc }),
          unlockedAt ? this.el("div", { className: "trophyMeta", text: `Débloqué le ${new Date(unlockedAt).toLocaleDateString("fr-FR")}` }) : null
        ])
      ]);
      c.appendChild(card);
    });
  },

  // Nutrition
  showMealModal() {
    this.$("mealModal").style.display = "block";
  },

  hideMealModal() {
    this.$("mealModal").style.display = "none";
  },

  saveMeal() {
    const meal = {
      type: this.$("mealType").value,
      desc: this.$("mealDesc").value,
      cal: Number(this.$("mealCal").value) || 0,
      prot: Number(this.$("mealProt").value) || 0,
      carbs: Number(this.$("mealCarbs").value) || 0,
      fats: Number(this.$("mealFats").value) || 0,
      date: new Date().toISOString()
    };
    this.meals.push(meal);
    this.hideMealModal();
    this.renderNutrition();
    // TODO: Save to Supabase nutrition table
  },

  renderNutrition() {
    const today = this.meals.filter(m => new Date(m.date).toDateString() === new Date().toDateString());
    const totalCal = today.reduce((s, m) => s + m.cal, 0);
    const totalProt = today.reduce((s, m) => s + m.prot, 0);
    const totalCarbs = today.reduce((s, m) => s + m.carbs, 0);
    const totalFats = today.reduce((s, m) => s + m.fats, 0);

    this.$("cal-total").textContent = totalCal;
    this.$("macro-protein").textContent = totalProt + "g";
    this.$("macro-carbs").textContent = totalCarbs;
    this.$("macro-fats").textContent = totalFats;

    const c = this.$("mealsContainer");
    c.innerHTML = "";
    if (!today.length) {
      c.appendChild(this.el("div", { className: "empty", text: "Aucun repas enregistré aujourd'hui." }));
      return;
    }
    today.forEach(m => {
      const card = this.el("div", { className: "mealCard" }, [
        this.el("div", { className: "mealHeader" }, [
          this.el("div", { className: "mealType", text: m.type }),
          this.el("span", { className: "badge cyan", text: `${m.cal} kcal` })
        ]),
        this.el("div", { text: m.desc, style: { fontSize: "13px", color: "var(--muted)", marginBottom: "8px" } }),
        this.el("div", { className: "mealMacros" }, [
          this.el("span", { text: `P: ${m.prot}g` }),
          this.el("span", { text: `G: ${m.carbs}g` }),
          this.el("span", { text: `L: ${m.fats}g` })
        ])
      ]);
      c.appendChild(card);
    });
  },

  // Charts
  initCharts() {
    const ctx = this.$("chartVolume")?.getContext("2d");
    if (!ctx) return;

    this.chartVolume = new Chart(ctx, {
      type: "line",
      data: {
        labels: ["S-4", "S-3", "S-2", "S-1", "Maintenant"],
        datasets: [{
          label: "Volume (kg)",
          data: [0, 0, 0, 0, 0],
          borderColor: "#b7ff2a",
          backgroundColor: "rgba(183,255,42,.10)",
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { color: "#a7adbd" }, grid: { color: "rgba(255,255,255,.05)" } },
          x: { ticks: { color: "#a7adbd" }, grid: { display: false } }
        }
      }
    });
  },

  updateVolumeChart() {
    if (!this.chartVolume) return;
    // Placeholder data - replace with real calculations from workouts
    this.chartVolume.data.datasets[0].data = [800, 1200, 1500, 1800, 2000];
    this.chartVolume.update();
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());

