import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const fmtDate = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const App = {
  sb: null,
  user: null,
  publicProfile: null,
  likedSet: new Set(),
  lastGeneratedPlan: null,

  async init() {
    this.ensureToast();
    this.bindButtons();
    this.bindLikeDelegation();

    await this.initSupabase();
    if (!this.sb) return;

    await this.initAuth();
    await this.refreshFeed().catch(() => {});
  },

  ensureToast() {
    if ($("#toast")) return;
    const el = document.createElement("div");
    el.id = "toast";
    el.style.position = "fixed";
    el.style.left = "50%";
    el.style.bottom = "22px";
    el.style.transform = "translateX(-50%)";
    el.style.zIndex = "99999";
    el.style.padding = "10px 14px";
    el.style.borderRadius = "12px";
    el.style.maxWidth = "92vw";
    el.style.display = "none";
    el.style.fontFamily = "system-ui, Segoe UI, Arial";
    el.style.fontSize = "14px";
    el.style.backdropFilter = "blur(8px)";
    el.style.border = "1px solid rgba(255,255,255,0.12)";
    el.style.boxShadow = "0 10px 40px rgba(0,0,0,0.35)";
    document.body.appendChild(el);
  },

  toast(msg, type = "info") {
    const el = $("#toast");
    if (!el) return;
    const palette = {
      info: "rgba(0,0,0,0.55)",
      ok: "rgba(0,80,40,0.55)",
      warn: "rgba(120,80,0,0.55)",
      danger: "rgba(120,0,0,0.55)",
    };
    el.textContent = String(msg || "");
    el.style.background = palette[type] || palette.info;
    el.style.display = "block";
    clearTimeout(this._t);
    this._t = setTimeout(() => (el.style.display = "none"), 2400);
  },

  bindButtons() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        Promise.resolve(fn()).catch((err) => {
          console.error(err);
          this.toast("Erreur action.", "danger");
        });
      });
    };

    on("btnLogin", () => this.login());
    on("btnRegister", () => this.register());
    on("btnLogout", () => this.logout());

    on("btnSaveDisplayName", () => this.saveDisplayName());

    on("btnGenerateWorkout", () => this.generateWorkout());

    on("btnRefreshFeed", () => this.refreshFeed());
    on("btnPublishWorkout", () => this.openPublishModal());
  },

  bindLikeDelegation() {
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-like]");
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute("data-like");
      if (id) this.toggleKudos(id);
    });
  },

  async initSupabase() {
    try {
      const r = await fetch("/api/workout?config=1", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const url = j.supabaseUrl || j.SUPABASE_URL;
      const key = j.supabaseAnonKey || j.SUPABASE_ANON_KEY;

      if (!url || !key) {
        console.warn("Config reçue:", j);
        this.toast("Config Supabase manquante.", "danger");
        return;
      }

      this.sb = createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });

      this.toast("Supabase OK ✅", "ok");
    } catch (e) {
      console.error(e);
      this.toast("Init Supabase échouée.", "danger");
    }
  },

  async initAuth() {
    const { data } = await this.sb.auth.getSession();
    this.user = data?.session?.user || null;
    this.updateAuthUI();

    this.sb.auth.onAuthStateChange(async (_evt, session) => {
      this.user = session?.user || null;
      this.updateAuthUI();
      if (this.user) {
        await this.ensureProfile();
        await this.loadProfile();
        await this.loadLikedSet();
      } else {
        this.publicProfile = null;
        this.likedSet = new Set();
      }
      await this.refreshFeed();
    });

    if (this.user) {
      await this.ensureProfile();
      await this.loadProfile();
      await this.loadLikedSet();
    }
  },

  updateAuthUI() {
    const s = document.getElementById("authStatus");
    if (s) s.textContent = this.user?.email ? `Connecté: ${this.user.email}` : "Non connecté";
  },

  async login() {
    const email = ($("#authEmail")?.value || "").trim();
    const password = ($("#authPassword")?.value || "").trim();
    if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) return this.toast(error.message, "danger");
    this.toast("Connecté ✅", "ok");
  },

  async register() {
    const email = ($("#authEmail")?.value || "").trim();
    const password = ($("#authPassword")?.value || "").trim();
    if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

    const { error } = await this.sb.auth.signUp({ email, password });
    if (error) return this.toast(error.message, "danger");
    this.toast("Compte créé ✅", "ok");
  },

  async logout() {
    const { error } = await this.sb.auth.signOut();
    if (error) return this.toast(error.message, "danger");
    this.toast("Déconnecté.", "ok");
  },

  async ensureProfile() {
    const { data } = await this.sb
      .from("public_profiles")
      .select("user_id")
      .eq("user_id", this.user.id)
      .maybeSingle();

    if (!data) {
      const name = (this.user.email || "User").split("@")[0].slice(0, 24);
      await this.sb.from("public_profiles").insert({ user_id: this.user.id, display_name: name });
    }
  },

  async loadProfile() {
    const { data } = await this.sb
      .from("public_profiles")
      .select("user_id, display_name")
      .eq("user_id", this.user.id)
      .maybeSingle();

    this.publicProfile = data || null;
    const inp = $("#displayNameInput");
    if (inp && this.publicProfile) inp.value = this.publicProfile.display_name || "";
  },

  async saveDisplayName() {
    if (!this.user) return this.toast("Connecte-toi.", "warn");
    const name = ($("#displayNameInput")?.value || "").trim();
    if (!name) return this.toast("Nom vide.", "warn");

    const { error } = await this.sb
      .from("public_profiles")
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq("user_id", this.user.id);

    if (error) return this.toast(error.message, "danger");
    this.toast("Nom public enregistré ✅", "ok");
    await this.loadProfile();
    await this.refreshFeed();
  },

  async generateWorkout() {
    if (!this.user) return this.toast("Connecte-toi.", "warn");
    const prompt = ($("#coachPrompt")?.value || "").trim();
    if (!prompt) return this.toast("Écris un prompt.", "warn");

    const out = $("#coachOutput");
    if (out) out.textContent = "Génération…";

    const r = await fetch("/api/workout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error || `Erreur ${r.status}`;
      if (out) out.textContent = msg;
      return this.toast(msg, "danger");
    }

    this.lastGeneratedPlan = j?.plan || null;
    if (out) out.textContent = j?.plan ? JSON.stringify(j.plan, null, 2) : "OK";
    this.toast("Plan généré ✅", "ok");
  },

  async loadLikedSet() {
    this.likedSet = new Set();
    const { data, error } = await this.sb.from("kudos").select("workout_id").eq("user_id", this.user.id);
    if (error) return;
    (data || []).forEach((r) => r?.workout_id && this.likedSet.add(r.workout_id));
  },

  async refreshFeed() {
    const host = $("#feedList");
    if (host) host.textContent = "Chargement…";

    const { data, error } = await this.sb
      .from("workouts_feed")
      .select("id,user_id,user_display,title,intensity,notes,plan_json,kudos_count,created_at")
      .order("created_at", { ascending: false })
      .limit(60);

    if (error) {
      console.warn(error);
      if (host) host.textContent = error.message;
      return;
    }

    this.renderFeed(data || []);
  },

  renderFeed(items) {
    const host = $("#feedList");
    if (!host) return;

    if (!items.length) {
      host.innerHTML = '<div style="opacity:.8">Aucune publication.</div>';
      return;
    }

    host.innerHTML = items
      .map((it) => {
        const liked = this.likedSet.has(it.id);
        const kudos = Number(it.kudos_count || 0);
        const notes = (it.notes || "").trim();
        const notesShort = notes.length > 180 ? notes.slice(0, 180).trim() + "…" : notes;

        return (
          `<div style="padding:14px;border:1px solid rgba(255,255,255,.10);border-radius:16px;margin:10px 0;background:rgba(0,0,0,.18)">` +
          `<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">` +
          `<div style="min-width:0">` +
          `<div style="font-weight:700">${esc(it.title || "Séance")}</div>` +
          `<div style="opacity:.8;font-size:13px;margin-top:2px">` +
          `<span>${esc(it.user_display || "User")}</span>` +
          `<span style="opacity:.45"> • </span>` +
          `<span>${esc(fmtDate(it.created_at))}</span>` +
          `<span style="opacity:.45"> • </span>` +
          `<span style="text-transform:uppercase;font-size:12px">${esc(it.intensity || "medium")}</span>` +
          `</div>` +
          `</div>` +
          `<button data-like="${esc(it.id)}" style="white-space:nowrap;padding:8px 10px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.22);color:white;cursor:pointer">` +
          `${liked ? "❤️" : "🤍"} ${kudos}` +
          `</button>` +
          `</div>` +
          (notesShort ? `<div style="margin-top:10px;opacity:.9">${esc(notesShort)}</div>` : ``) +
          `</div>`
        );
      })
      .join("");
  },

  async toggleKudos(workoutId) {
    if (!this.user) return this.toast("Connecte-toi.", "warn");

    const liked = this.likedSet.has(workoutId);

    if (liked) {
      const { error } = await this.sb
        .from("kudos")
        .delete()
        .eq("workout_id", workoutId)
        .eq("user_id", this.user.id);

      if (error) return this.toast(error.message, "danger");
      this.likedSet.delete(workoutId);
    } else {
      const { error } = await this.sb.from("kudos").insert({ workout_id: workoutId, user_id: this.user.id });
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (!msg.includes("duplicate")) return this.toast(error.message, "danger");
      }
      this.likedSet.add(workoutId);
    }

    await this.refreshFeed();
  },

  openPublishModal() {
    if (!this.user) return this.toast("Connecte-toi.", "warn");

    const title = prompt("Titre de la séance ?", "Séance") || "Séance";
    const intensity = prompt("Intensité ? easy/medium/hard", "medium") || "medium";
    const notes = prompt("Notes (optionnel)", "") || "";

    this.publishWorkout({
      title: title.trim() || "Séance",
      intensity: intensity.trim() || "medium",
      notes: notes.trim(),
      plan_json: this.lastGeneratedPlan || null,
    });
  },

  async publishWorkout(p) {
    const { error } = await this.sb.from("workouts").insert({
      user_id: this.user.id,
      is_public: true,
      title: p.title,
      intensity: p.intensity,
      notes: p.notes,
      plan_json: p.plan_json,
    });

    if (error) return this.toast(error.message, "danger");
    this.toast("Publié ✅", "ok");
    await this.refreshFeed();
  },
};

const boot = () => App.init();
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
else boot();
