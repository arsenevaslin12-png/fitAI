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
  
  // ============ NOUVEAU : Timer Workout ============
  workoutTimer: null,
  currentExerciseIndex: 0,
  currentPhase: "work", // "work" ou "rest"
  timerInterval: null,
  audioContext: null,

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
    this.initAudioContext(); // Pour les sons du timer
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

    // ============ NOUVEAU : Bindings Profil ============
    // Si tu as des inputs age/weight/height dans le HTML, bind-les ici
    const ageInput = this.$("profileAge");
    const weightInput = this.$("profileWeight");
    const heightInput = this.$("profileHeight");
    
    if (ageInput) ageInput.addEventListener("change", () => this.saveProfileData());
    if (weightInput) weightInput.addEventListener("change", () => this.saveProfileData());
    if (heightInput) heightInput.addEventListener("change", () => this.saveProfileData());

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
    this.loadProfileData(); // ============ NOUVEAU ============
  },

  async ensureProfiles(userId) {
    const selP = await this.supabase
      .from("profiles")
      .select("kpis,equipment,last_workout_date,age,weight,height") // ============ NOUVEAU ============
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

  // ============ NOUVEAU : Gestion Profil (age, weight, height) ============
  loadProfileData() {
    if (!this.profile) return;
    
    const ageInput = this.$("profileAge");
    const weightInput = this.$("profileWeight");
    const heightInput = this.$("profileHeight");
    
    if (ageInput && this.profile.age) ageInput.value = this.profile.age;
    if (weightInput && this.profile.weight) weightInput.value = this.profile.weight;
    if (heightInput && this.profile.height) heightInput.value = this.profile.height;
  },

  async saveProfileData() {
    if (!this.user) return;
    
    const ageInput = this.$("profileAge");
    const weightInput = this.$("profileWeight");
    const heightInput = this.$("profileHeight");
    
    const updates = {};
    if (ageInput && ageInput.value) updates.age = Number(ageInput.value);
    if (weightInput && weightInput.value) updates.weight = Number(weightInput.value);
    if (heightInput && heightInput.value) updates.height = Number(heightInput.value);
    
    if (Object.keys(updates).length === 0) return;
    
    const { error } = await this.supabase
      .from("profiles")
      .update(updates)
      .eq("user_id", this.user.id);
    
    if (error) {
      console.error("Save profile error:", error);
      this.hint("profileHint", "Erreur sauvegarde profil", "err");
    } else {
      this.hint("profileHint", "✅ Profil sauvegardé", "ok");
      Object.assign(this.profile, updates);
    }
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

  // ============ MODIFIÉ : generateWorkout avec prompt JSON structuré ============
  async generateWorkout() {
    if (!this.user) return this.setCoachEmpty("Connecte-toi.");
    const prompt = this.$("coachPrompt").value.trim();
    if (!prompt) return this.setCoachEmpty("Décris ta séance souhaitée.");

    this.setCoachLoading();

    try {
      // ============ NOUVEAU : Prompt modifié pour demander JSON structuré ============
      const enhancedPrompt = this.buildStructuredPrompt(prompt);

      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-FitAI-Client": CLIENT_TOKEN },
        body: JSON.stringify({ prompt: enhancedPrompt, userId: this.user.id })
      });

      if (!r.ok) throw new Error("Erreur API");
      const data = await r.json();
      
      // ============ NOUVEAU : Détection du type de réponse ============
      this.handleAIResponse(data);
      
    } catch (err) {
      this.setCoachEmpty("Erreur : " + err.message);
    }
  },

  // ============ NOUVEAU : Construction du prompt structuré ============
  buildStructuredPrompt(userPrompt) {
    const lowerPrompt = userPrompt.toLowerCase();
    const isRecipe = lowerPrompt.includes("recette") || 
                     lowerPrompt.includes("ingrédients") || 
                     lowerPrompt.includes("cuisine") ||
                     lowerPrompt.includes("plat");

    if (isRecipe) {
      return `Tu es un chef cuisinier expert. L'utilisateur demande : "${userPrompt}"

RÉPONDS UNIQUEMENT avec ce JSON STRICT (sans markdown, sans texte avant/après) :
{
  "type": "recipe",
  "title": "Nom de la recette",
  "ingredients": ["Ingrédient 1", "Ingrédient 2", "..."],
  "steps": ["Étape 1", "Étape 2", "..."],
  "prep_time": 15,
  "cook_time": 30
}`;
    } else {
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
      "reps": "10-12"
    }
  ]
}

IMPORTANT : duration et rest sont en SECONDES. Si l'exercice est basé sur des répétitions, mets duration à 0.`;
    }
  },

  // ============ NOUVEAU : Gestion de la réponse IA (workout ou recipe) ============
  handleAIResponse(data) {
    // Essayer de parser si c'est du texte contenant du JSON
    let parsedData = data;
    
    if (typeof data === 'string') {
      try {
        // Nettoyer le markdown si présent
        const cleaned = data.replace(/```json|```/g, '').trim();
        parsedData = JSON.parse(cleaned);
      } catch (e) {
        console.error("Parse error:", e);
        this.setCoachEmpty("Erreur : réponse invalide de l'IA");
        return;
      }
    }

    // Si l'API renvoie déjà un objet avec exercises (ancien format)
    if (!parsedData.type && parsedData.exercises) {
      parsedData.type = "workout";
    }

    // Router selon le type
    if (parsedData.type === "recipe") {
      this.renderRecipe(parsedData);
    } else if (parsedData.type === "workout") {
      this.renderWorkoutPlan(parsedData);
    } else {
      // Fallback : ancien format
      this.renderWorkoutPlan(parsedData);
    }
  },

  setCoachLoading() {
    this.$("coachOutput").innerHTML = `<div class="card"><div style="display:flex; align-items:center; gap:12px;"><div class="spinner"></div><span>Génération en cours...</span></div></div>`;
  },

  setCoachEmpty(msg) {
    this.$("coachOutput").innerHTML = `<div class="card"><div class="empty">${msg}</div></div>`;
  },

  // ============ MODIFIÉ : renderWorkoutPlan avec bouton Timer ============
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
        const specs = ex.duration > 0 
          ? `${ex.duration}s work • ${ex.rest}s rest`
          : `${ex.sets} × ${ex.reps} • Repos ${ex.rest || "2min"}`;
        
        const exCard = this.el("div", { className: "exerciseCard" }, [
          this.el("div", { className: "exerciseInfo" }, [
            this.el("div", { className: "exerciseName", text: ex.name }),
            this.el("div", { className: "exerciseSpecs", text: specs })
          ]),
          this.el("div", { className: "exerciseRPE", text: `RPE ${ex.rpe || "7-8"}` })
        ]);
        card.appendChild(exCard);
      });
    }

    const btnRow = this.el("div", { style: { display: "flex", gap: "12px", marginTop: "20px", flexWrap: "wrap" } }, [
      this.el("button", { className: "btn primary", text: "💾 Sauvegarder", style: { flex: "1", minWidth: "140px" } }),
      this.el("button", { className: "btn cyan", text: "⏱️ Lancer Timer", style: { flex: "1", minWidth: "140px" } }),
      this.el("button", { className: "btn", text: "🔄 Régénérer", style: { flex: "1", minWidth: "140px" } })
    ]);
    
    btnRow.children[0].addEventListener("click", () => this.saveWorkout(data));
    btnRow.children[1].addEventListener("click", () => this.startWorkout(data)); // ============ NOUVEAU ============
    btnRow.children[2].addEventListener("click", () => this.generateWorkout());
    
    card.appendChild(btnRow);
    c.appendChild(card);
  },

  // ============ NOUVEAU : Affichage Recette ============
  renderRecipe(data) {
    const c = this.$("coachOutput");
    c.innerHTML = "";

    const card = this.el("div", { className: "card" });
    
    // Titre
    const title = this.el("div", { 
      style: { 
        fontSize: "24px", 
        fontWeight: "950", 
        color: "var(--lime)", 
        marginBottom: "16px",
        letterSpacing: ".5px"
      }, 
      text: `🍳 ${data.title}` 
    });
    card.appendChild(title);

    // Temps
    if (data.prep_time || data.cook_time) {
      const timingRow = this.el("div", { 
        style: { 
          display: "flex", 
          gap: "16px", 
          marginBottom: "20px",
          fontSize: "13px",
          color: "var(--muted)"
        }
      }, [
        data.prep_time ? this.el("div", { text: `⏱️ Préparation : ${data.prep_time}min` }) : null,
        data.cook_time ? this.el("div", { text: `🔥 Cuisson : ${data.cook_time}min` }) : null
      ].filter(Boolean));
      card.appendChild(timingRow);
    }

    // Ingrédients
    const ingredientsSection = this.el("div", { style: { marginBottom: "24px" } });
    ingredientsSection.appendChild(this.el("div", { 
      className: "coachNoteHeader", 
      text: "🛒 Ingrédients",
      style: { marginBottom: "12px" }
    }));
    
    const ingredientsList = this.el("ul", { 
      style: { 
        listStyle: "none", 
        padding: "0", 
        display: "grid", 
        gap: "8px" 
      } 
    });
    
    data.ingredients.forEach(ing => {
      const li = this.el("li", {
        style: {
          padding: "10px 14px",
          background: "rgba(255,255,255,.03)",
          border: "1px solid var(--stroke)",
          borderRadius: "10px",
          fontSize: "14px"
        },
        text: `• ${ing}`
      });
      ingredientsList.appendChild(li);
    });
    ingredientsSection.appendChild(ingredientsList);
    card.appendChild(ingredientsSection);

    // Étapes
    const stepsSection = this.el("div");
    stepsSection.appendChild(this.el("div", { 
      className: "coachNoteHeader", 
      text: "👨‍🍳 Préparation",
      style: { marginBottom: "12px" }
    }));
    
    data.steps.forEach((step, idx) => {
      const stepCard = this.el("div", {
        className: "exerciseCard",
        style: { marginBottom: "12px" }
      }, [
        this.el("div", { 
          style: { 
            width: "32px", 
            height: "32px", 
            borderRadius: "50%", 
            background: "var(--lime)", 
            color: "#000", 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            fontWeight: "950",
            fontSize: "14px",
            flexShrink: "0"
          }, 
          text: idx + 1 
        }),
        this.el("div", { 
          style: { flex: "1", fontSize: "14px", lineHeight: "1.6" }, 
          text: step 
        })
      ]);
      stepsSection.appendChild(stepCard);
    });
    card.appendChild(stepsSection);

    // Boutons
    const btnRow = this.el("div", { style: { display: "flex", gap: "12px", marginTop: "20px" } }, [
      this.el("button", { className: "btn primary", text: "📋 Copier Recette", style: { flex: "1" } }),
      this.el("button", { className: "btn", text: "🔄 Nouvelle Recette", style: { flex: "1" } })
    ]);
    
    btnRow.children[0].addEventListener("click", () => this.copyRecipe(data));
    btnRow.children[1].addEventListener("click", () => this.generateWorkout());
    
    card.appendChild(btnRow);
    c.appendChild(card);
  },

  copyRecipe(data) {
    const text = `${data.title}\n\n` +
      `Ingrédients:\n${data.ingredients.map(i => `- ${i}`).join('\n')}\n\n` +
      `Préparation:\n${data.steps.map((s, i) => `${i+1}. ${s}`).join('\n')}`;
    
    navigator.clipboard.writeText(text).then(() => {
      alert("✅ Recette copiée dans le presse-papier !");
    }).catch(() => {
      alert("❌ Erreur de copie");
    });
  },

  // ============ NOUVEAU : Timer Workout ============
  initAudioContext() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn("Audio not supported:", e);
    }
  },

  playBeep(frequency = 800, duration = 200) {
    if (!this.audioContext) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    
    gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration / 1000);
    
    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + duration / 1000);
  },

  startWorkout(data) {
    // Vérifier qu'il y a des exercices avec duration
    const timerExercises = data.exercises.filter(ex => ex.duration > 0);
    if (timerExercises.length === 0) {
      alert("ℹ️ Ce workout n'a pas de timer (exercices basés sur répétitions)");
      return;
    }

    this.workoutTimer = {
      exercises: timerExercises,
      currentIndex: 0,
      phase: "work", // "work" ou "rest"
      timeLeft: timerExercises[0].duration,
      isPaused: false
    };

    this.renderTimerUI();
    this.startTimerLoop();
  },

  renderTimerUI() {
    const c = this.$("coachOutput");
    c.innerHTML = "";

    const card = this.el("div", { className: "card", style: { textAlign: "center" } });
    
    const wt = this.workoutTimer;
    const currentEx = wt.exercises[wt.currentIndex];
    
    // Progress
    const progress = this.el("div", {
      style: {
        fontSize: "14px",
        color: "var(--muted)",
        marginBottom: "20px",
        fontWeight: "900"
      },
      text: `Exercice ${wt.currentIndex + 1} / ${wt.exercises.length}`
    });
    card.appendChild(progress);

    // Exercise name
    const exName = this.el("div", {
      style: {
        fontSize: "28px",
        fontWeight: "950",
        color: "var(--lime)",
        marginBottom: "10px",
        letterSpacing: ".5px"
      },
      text: currentEx.name
    });
    card.appendChild(exName);

    // Phase
    const phase = this.el("div", {
      style: {
        fontSize: "16px",
        color: wt.phase === "work" ? "var(--lime)" : "var(--cyan)",
        marginBottom: "24px",
        fontWeight: "950",
        textTransform: "uppercase"
      },
      text: wt.phase === "work" ? "🏋️ TRAVAIL" : "😌 REPOS"
    });
    card.appendChild(phase);

    // Timer display
    const timerDisplay = this.el("div", {
      id: "timerDisplay",
      style: {
        fontSize: "80px",
        fontWeight: "950",
        color: "#fff",
        marginBottom: "30px",
        letterSpacing: "-2px",
        fontVariantNumeric: "tabular-nums"
      },
      text: wt.timeLeft
    });
    card.appendChild(timerDisplay);

    // Controls
    const controls = this.el("div", { style: { display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" } }, [
      this.el("button", { 
        className: "btn cyan", 
        id: "btnPauseResume",
        text: wt.isPaused ? "▶️ Reprendre" : "⏸️ Pause",
        style: { minWidth: "140px" }
      }),
      this.el("button", { 
        className: "btn", 
        text: "⏭️ Skip",
        style: { minWidth: "120px" }
      }),
      this.el("button", { 
        className: "btn pink", 
        text: "🛑 Arrêter",
        style: { minWidth: "120px" }
      })
    ]);
    
    controls.children[0].addEventListener("click", () => this.togglePause());
    controls.children[1].addEventListener("click", () => this.skipExercise());
    controls.children[2].addEventListener("click", () => this.stopWorkout());
    
    card.appendChild(controls);
    c.appendChild(card);
  },

  startTimerLoop() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    this.timerInterval = setInterval(() => {
      if (this.workoutTimer.isPaused) return;
      
      this.workoutTimer.timeLeft--;
      
      // Update display
      const display = this.$("timerDisplay");
      if (display) {
        display.textContent = this.workoutTimer.timeLeft;
        
        // Color change on last 3 seconds
        if (this.workoutTimer.timeLeft <= 3 && this.workoutTimer.timeLeft > 0) {
          display.style.color = "var(--red)";
          this.playBeep(600, 100);
        } else {
          display.style.color = "#fff";
        }
      }
      
      // Phase transition
      if (this.workoutTimer.timeLeft <= 0) {
        this.playBeep(1000, 300);
        this.nextPhase();
      }
    }, 1000);
  },

  nextPhase() {
    const wt = this.workoutTimer;
    
    if (wt.phase === "work") {
      // Passer au repos
      wt.phase = "rest";
      wt.timeLeft = wt.exercises[wt.currentIndex].rest || 10;
    } else {
      // Passer à l'exercice suivant
      wt.currentIndex++;
      
      if (wt.currentIndex >= wt.exercises.length) {
        // Workout terminé
        this.completeWorkout();
        return;
      }
      
      wt.phase = "work";
      wt.timeLeft = wt.exercises[wt.currentIndex].duration;
    }
    
    this.renderTimerUI();
  },

  skipExercise() {
    const wt = this.workoutTimer;
    wt.currentIndex++;
    
    if (wt.currentIndex >= wt.exercises.length) {
      this.completeWorkout();
      return;
    }
    
    wt.phase = "work";
    wt.timeLeft = wt.exercises[wt.currentIndex].duration;
    this.renderTimerUI();
  },

  togglePause() {
    this.workoutTimer.isPaused = !this.workoutTimer.isPaused;
    const btn = this.$("btnPauseResume");
    if (btn) {
      btn.textContent = this.workoutTimer.isPaused ? "▶️ Reprendre" : "⏸️ Pause";
    }
  },

  stopWorkout() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.workoutTimer = null;
    this.setCoachEmpty("Timer arrêté. Lance une nouvelle génération si besoin.");
  },

  completeWorkout() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    
    this.playBeep(1200, 500);
    
    const c = this.$("coachOutput");
    c.innerHTML = "";
    
    const card = this.el("div", { className: "card", style: { textAlign: "center" } });
    card.appendChild(this.el("div", {
      style: {
        fontSize: "60px",
        marginBottom: "20px"
      },
      text: "🎉"
    }));
    card.appendChild(this.el("div", {
      style: {
        fontSize: "32px",
        fontWeight: "950",
        color: "var(--lime)",
        marginBottom: "16px"
      },
      text: "Workout Terminé !"
    }));
    card.appendChild(this.el("div", {
      style: {
        fontSize: "16px",
        color: "var(--muted)",
        marginBottom: "30px"
      },
      text: "Bravo ! N'oublie pas de t'étirer."
    }));
    
    const btnRow = this.el("div", { style: { display: "flex", gap: "12px", justifyContent: "center" } }, [
      this.el("button", { className: "btn primary", text: "🔄 Nouveau Workout" })
    ]);
    btnRow.children[0].addEventListener("click", () => this.generateWorkout());
    card.appendChild(btnRow);
    
    c.appendChild(card);
    this.workoutTimer = null;
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
    if (!this.user) return;
    
    const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data: recentWorkouts } = await this.supabase
      .from("workouts")
      .select("created_at")
      .eq("user_id", this.user.id)
      .gte("created_at", threeDaysAgo)
      .order("created_at", { ascending: true });

    if (recentWorkouts && recentWorkouts.length >= 3) {
      const uniqueDays = new Set(recentWorkouts.map(w => new Date(w.created_at).toDateString()));
      if (uniqueDays.size >= 3) {
        await this.supabase
          .from("achievements")
          .insert({ user_id: this.user.id, badge_type: "STREAK" })
          .onConflict("user_id,badge_type")
          .ignore();
      }
    }

    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay() + 1);
    startOfWeek.setHours(0, 0, 0, 0);

    const { data: hardWorkouts } = await this.supabase
      .from("workouts")
      .select("id")
      .eq("user_id", this.user.id)
      .eq("intensity", "hard")
      .gte("created_at", startOfWeek.toISOString());

    if (hardWorkouts && hardWorkouts.length >= 3) {
      await this.supabase
        .from("achievements")
        .insert({ user_id: this.user.id, badge_type: "MACHINE" })
        .onConflict("user_id,badge_type")
        .ignore();
    }

    if (this.profile?.kpis?.recovery >= 90) {
      const { data: lightWorkouts } = await this.supabase
        .from("workouts")
        .select("id")
        .eq("user_id", this.user.id)
        .eq("intensity", "light")
        .limit(1);

      if (lightWorkouts && lightWorkouts.length > 0) {
        await this.supabase
          .from("achievements")
          .insert({ user_id: this.user.id, badge_type: "CLOWN" })
          .onConflict("user_id,badge_type")
          .ignore();
      }
    }
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
      const isUnlocked = !!unlockedAt;
      const card = this.el("div", { className: "trophyCard" + (isUnlocked ? " unlocked" : " locked") }, [
        this.el("div", { className: "trophyIcon", text: badge.emoji }),
        this.el("div", { className: "trophyInfo" }, [
          this.el("div", { className: "trophyTitle", text: badge.title }),
          this.el("div", { className: "trophyDesc", text: badge.desc }),
          isUnlocked 
            ? this.el("div", { className: "trophyMeta", text: `Débloqué le ${new Date(unlockedAt).toLocaleDateString("fr-FR")}` }) 
            : this.el("div", { className: "trophyMeta", text: "🔒 Non débloqué" })
        ])
      ]);
      c.appendChild(card);
    });
  },

  showMealModal() {
    this.$("mealModal").style.display = "block";
    this.$("mealType").value = "Petit-déj";
    this.$("mealDesc").value = "";
    this.$("mealCal").value = "";
    this.$("mealProt").value = "";
    this.$("mealCarbs").value = "";
    this.$("mealFats").value = "";
  },

  hideMealModal() {
    this.$("mealModal").style.display = "none";
  },

  async saveMeal() {
    const meal = {
      type: this.$("mealType").value,
      desc: this.$("mealDesc").value.trim(),
      cal: Number(this.$("mealCal").value) || 0,
      prot: Number(this.$("mealProt").value) || 0,
      carbs: Number(this.$("mealCarbs").value) || 0,
      fats: Number(this.$("mealFats").value) || 0,
      date: new Date().toISOString()
    };
    if (!meal.desc || meal.cal === 0) {
      alert("Description et calories obligatoires.");
      return;
    }
    this.meals.push(meal);
    this.hideMealModal();
    this.renderNutrition();
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

    if (this.profile?.kpis?.weight) {
      const weight = Number(this.profile.kpis.weight);
      const proteinTarget = Math.round(weight * 2);
      const calTarget = Math.round(weight * 30);
      this.$("protein-target").textContent = proteinTarget;
      this.$("cal-target").textContent = calTarget;
    }
  },

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
          fill: true,
          borderWidth: 3,
          pointRadius: 5,
          pointBackgroundColor: "#b7ff2a"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { 
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(0,0,0,.85)",
            titleColor: "#b7ff2a",
            bodyColor: "#fff",
            borderColor: "#b7ff2a",
            borderWidth: 1
          }
        },
        scales: {
          y: { 
            beginAtZero: true, 
            ticks: { color: "#a7adbd", font: { size: 11 } }, 
            grid: { color: "rgba(255,255,255,.05)" } 
          },
          x: { 
            ticks: { color: "#a7adbd", font: { size: 11 } }, 
            grid: { display: false } 
          }
        }
      }
    });
    this.updateVolumeChart();
  },

  async updateVolumeChart() {
    if (!this.chartVolume || !this.user) return;

    const weeks = [];
    const volumes = [];
    
    for (let i = 4; i >= 0; i--) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (i * 7));
      weekStart.setHours(0, 0, 0, 0);
      
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      
      const { data } = await this.supabase
        .from("workouts")
        .select("exercises")
        .eq("user_id", this.user.id)
        .gte("created_at", weekStart.toISOString())
        .lt("created_at", weekEnd.toISOString());

      let weekVolume = 0;
      if (data) {
        data.forEach(w => {
          if (w.exercises && Array.isArray(w.exercises)) {
            w.exercises.forEach(ex => {
              const sets = ex.sets || 3;
              const repsRange = String(ex.reps || "8-10").split("-");
              const avgReps = repsRange.length === 2 
                ? (Number(repsRange[0]) + Number(repsRange[1])) / 2 
                : Number(repsRange[0]) || 8;
              weekVolume += sets * avgReps * 50;
            });
          }
        });
      }
      
      weeks.push(i === 0 ? "Maintenant" : `S-${i}`);
      volumes.push(Math.round(weekVolume));
    }

    this.chartVolume.data.labels = weeks;
    this.chartVolume.data.datasets[0].data = volumes;
    this.chartVolume.update();
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());
        
