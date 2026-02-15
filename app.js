import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CLIENT_TOKEN = "fitai-v18"; // doit matcher ton backend si tu l'as verrouillé

const App = {
  cfg: null,
  supabase: null,
  session: null,
  user: null,
  profile: { kpis: { recovery: 80, weight: 75, sleep: 7.5 } },

  kpiSteps: { recovery: 1, weight: 0.5, sleep: 0.25 },
  kpiSaveTimer: null,

  $: (id) => document.getElementById(id),

  el(tag, opts = {}, children = []) {
    const n = document.createElement(tag);
    if (opts.className) n.className = opts.className;
    if (opts.type) n.type = opts.type;
    if (opts.text != null) n.textContent = String(opts.text);
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, String(v));
    for (const c of children) if (c) n.appendChild(c);
    return n;
  },

  clamp(min, v, max) { return Math.max(min, Math.min(max, v)); },

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
    this.renderKpis();
  },

  bindTabs() {
    this.$("tabBtnDash").addEventListener("click", () => this.setTab("dash"));
    this.$("tabBtnCoach").addEventListener("click", () => this.setTab("coach"));
    this.$("tabBtnProfile").addEventListener("click", () => this.setTab("profile"));
  },

  setTab(tab) {
    const show = (id, on) => { this.$(id).style.display = on ? "block" : "none"; };
    show("tab-dash", tab === "dash");
    show("tab-coach", tab === "coach");
    show("tab-profile", tab === "profile");

    const setActive = (btnId, on) => {
      const b = this.$(btnId);
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    };
    setActive("tabBtnDash", tab === "dash");
    setActive("tabBtnCoach", tab === "coach");
    setActive("tabBtnProfile", tab === "profile");
  },

  bindUI() {
    // KPI +/- buttons
    document.querySelectorAll("button.kpiBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-kpi");
        const dir = Number(btn.getAttribute("data-dir") || "0");
        if (!key || !dir) return;
        this.adjustKpi(key, dir);
      });
    });

    // Coach
    this.$("btnCoachAsk").addEventListener("click", () => this.generateWorkout());

    // RPE display
    const rpe = this.$("rpeRange");
    const rpeValue = this.$("rpeValue");
    const syncRpe = () => { rpeValue.textContent = String(rpe.value); };
    rpe.addEventListener("input", syncRpe);
    syncRpe();

    // Auth
    this.$("btnMagicLink").addEventListener("click", () => this.sendMagicLink());
    this.$("btnLogout").addEventListener("click", () => this.logout());
  },

  async fetchConfig() {
    const r = await fetch("/api/workout?config=1", {
      method: "GET",
      headers: { "X-FitAI-Client": CLIENT_TOKEN }
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Config failed (${r.status}): ${t.slice(0, 160)}`);
    }
    const data = await r.json();
    if (!data?.supabaseUrl || !data?.supabaseAnonKey) throw new Error("Invalid config payload.");
    return data;
  },

  async initAuth() {
    const { data } = await this.supabase.auth.getSession();
    this.session = data.session || null;
    this.user = this.session?.user || null;

    this.supabase.auth.onAuthStateChange((_event, newSession) => {
      this.session = newSession || null;
      this.user = newSession?.user || null;
      this.renderAuthStatus();
    });

    this.renderAuthStatus();
  },

  renderAuthStatus() {
    this.$("authStatus").textContent = this.user
      ? `Connecté : ${this.user.email || this.user.id}`
      : "Non connecté";

    this.$("morningBrief").textContent = this.user
      ? "✅ Mode pro activé. Génère une séance propre."
      : "Connecte-toi pour générer via backend (JWT).";
  },

  renderKpis() {
    const k = this.profile.kpis;
    this.$("val-recovery").textContent = `${Math.round(k.recovery)}%`;
    this.$("val-weight").textContent = `${Number(k.weight).toFixed(1)}`;
    this.$("val-sleep").textContent = `${Number(k.sleep).toFixed(2)}`;
  },

  adjustKpi(key, dir) {
    const k = this.profile.kpis;
    const step = Number(this.kpiSteps[key] || 1) * (dir > 0 ? 1 : -1);

    if (key === "recovery") k.recovery = this.clamp(0, k.recovery + step, 100);
    if (key === "weight") k.weight = this.clamp(0, Number((k.weight + step).toFixed(1)), 400);
    if (key === "sleep") k.sleep = this.clamp(0, Number((k.sleep + step).toFixed(2)), 24);

    this.renderKpis();

    // optionnel : si tu as une table profiles.kpis, tu peux l'enregistrer ici en debounce
    // (gardé “pro” et non intrusif : on ne force pas Supabase DB si tu n'as pas le schema)
  },

  hint(id, msg) {
    const el = this.$(id);
    el.textContent = msg;
  },

  loadingUI(container) {
    container.replaceChildren();
    container.appendChild(this.el("div", { className: "card" }, [
      this.el("div", { className: "loadingRow" }, [
        this.el("div", { className: "spinner" }),
        this.el("div", { text: "L’IA analyse ton contexte…" })
      ]),
      this.el("div", { className: "hint", text: "On simule un délai minimum pour un feeling “premium”." }),
      this.el("div", { className: "skeleton" }),
      this.el("div", { className: "skeleton" }),
      this.el("div", { className: "skeleton" })
    ]));
  },

  coachNote(text) {
    return this.el("div", { className: "coachNote" }, [
      this.el("div", { className: "coachNoteHeader" }, [
        this.el("span", { text: "🤖" }),
        this.el("span", { text: "Note du coach" })
      ]),
      this.el("p", { className: "coachNoteBody", text })
    ]);
  },

  badge(text, kind = "cyan") {
    return this.el("span", { className: `badge ${kind}`, text });
  },

  exerciseCard(ex) {
    const left = this.el("div");
    const name = this.el("div", { className: "exName", text: String(ex?.name || "Exercice") });

    const meta = this.el("div", { className: "exMeta" }, [
      this.badge(String(ex?.muscle || "—"), "cyan"),
      this.badge(`${Number(ex?.sets || 3)} x ${String(ex?.reps || "8-10")}`, "lime")
    ]);

    left.append(name, meta);

    return this.el("div", { className: "exerciseCard" }, [left]);
  },

  renderProgram(container, program, overload) {
    container.replaceChildren();

    const wrap = this.el("div", { className: "card" });

    const top = this.el("div");
    top.style.display = "flex";
    top.style.alignItems = "center";
    top.style.justifyContent = "space-between";
    top.style.gap = "10px";
    top.style.flexWrap = "wrap";

    const title = this.el("div", { text: String(program?.title || "Séance") });
    title.style.fontWeight = "950";
    title.style.textTransform = "uppercase";
    title.style.letterSpacing = ".8px";
    title.style.color = "rgba(255,255,255,.8)";
    title.style.fontSize = "12px";

    const intensity = String(program?.intensity || "moderate");
    const badgeKind = intensity === "hard" ? "red" : (intensity === "light" ? "lime" : "cyan");
    top.append(title, this.badge(intensity, badgeKind));

    wrap.appendChild(top);

    const noteLines = [];
    if (program?.notes) noteLines.push(String(program.notes));
    if (overload?.nextReps != null) {
      noteLines.push(
        `\nSurcharge auto: ${overload.prevReps} reps @ RPE ${overload.rpe} → prochaine cible: ${overload.nextReps} reps`
      );
    }
    if (noteLines.length) wrap.appendChild(this.coachNote(noteLines.join("\n")));

    const exs = Array.isArray(program?.exercises) ? program.exercises : [];
    for (const ex of exs) wrap.appendChild(this.exerciseCard(ex));

    container.appendChild(wrap);
  },

  async generateWorkout() {
    const out = this.$("coachOutput");

    if (!this.user || !this.session) {
      out.replaceChildren(this.el("div", { className: "card" }, [
        this.el("div", { className: "badge red", text: "Auth requise" }),
        this.el("div", { className: "hint", text: "Connecte-toi (magic link) pour utiliser le backend sécurisé." })
      ]));
      this.setTab("profile");
      return;
    }

    const prompt = (this.$("coachPrompt").value || "").trim() || "Séance adaptée à mon état du jour.";
    const prevReps = Number(this.$("prevReps").value || "");
    const rpe = Number(this.$("rpeRange").value || "8");

    // Loading animation “premium”: minimum delay
    this.$("btnCoachAsk").disabled = true;
    this.$("btnCoachAsk").textContent = "Génération…";
    this.loadingUI(out);

    const minDelay = new Promise((res) => setTimeout(res, 900));

    try {
      const req = fetch("/api/workout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.session.access_token}`,
          "X-FitAI-Client": CLIENT_TOKEN
        },
        body: JSON.stringify({
          prompt,
          kpis: this.profile.kpis,
          overload: {
            prevReps: Number.isFinite(prevReps) ? prevReps : null,
            rpe: Number.isFinite(rpe) ? rpe : null
          }
        })
      });

      const [r] = await Promise.all([req, minDelay]);

      const ct = String(r.headers.get("Content-Type") || "");
      const payload = ct.includes("application/json") ? await r.json().catch(() => null) : null;

      if (!r.ok) {
        const msg = payload?.message || payload?.error || `Erreur HTTP ${r.status}`;
        out.replaceChildren(this.el("div", { className: "card" }, [
          this.el("div", { className: "badge red", text: "Erreur" }),
          this.el("div", { className: "hint", text: String(msg) })
        ]));
        return;
      }

      const program = payload?.program;
      const overloadResult = payload?.overload || null;

      if (!program) {
        out.replaceChildren(this.el("div", { className: "card" }, [
          this.el("div", { className: "badge red", text: "Sortie invalide" }),
          this.el("div", { className: "hint", text: "Le backend n’a pas renvoyé de programme." })
        ]));
        return;
      }

      this.renderProgram(out, program, overloadResult);
    } catch (e) {
      out.replaceChildren(this.el("div", { className: "card" }, [
        this.el("div", { className: "badge red", text: "Crash" }),
        this.el("div", { className: "hint", text: String(e?.message || e) })
      ]));
    } finally {
      this.$("btnCoachAsk").disabled = false;
      this.$("btnCoachAsk").textContent = "Générer";
    }
  },

  async sendMagicLink() {
    const email = (this.$("email").value || "").trim();
    if (!email) return this.hint("profileHint", "Entre un email.");

    this.hint("profileHint", "Envoi du magic link…");
    const { error } = await this.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) return this.hint("profileHint", error.message);
    this.hint("profileHint", "Magic link envoyé. Vérifie ta boîte mail.");
  },

  async logout() {
    await this.supabase.auth.signOut();
    this.hint("profileHint", "Déconnecté.");
  }
};

window.addEventListener("DOMContentLoaded", () => {
  App.init().catch((e) => alert("Init error: " + String(e?.message || e)));
});
