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
    return d.toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
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
  initStarted: false,

  async init() {
    if (this.initStarted) return;
    this.initStarted = true;

    console.log("[FitAI] app.js loaded");

    this.ensureToast();
    this.bindButtonsDefensive();
    this.bindLikeDelegation();

    await this.initSupabase();
    if (!this.sb) return;

    await this.initAuth();
    await this.refreshFeed();
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

  bindButtonsDefensive() {
    const map = {
      btnLogin: () => this.login(),
      btnRegister: () => this.register(),
      btnLogout: () => this.logout(),
      btnSaveDisplayName: () => this.saveDisplayName(),
      btnGenerateWorkout: () => this.generateWorkout(),
      btnRefreshFeed: () => this.refreshFeed(),
      btnPublishWorkout: () => this.publishQuick(),
    };

    // bind direct si les IDs existent
    Object.keys(map).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        Promise.resolve(map[id]()).catch((err) => {
          console.error(err);
          this.toast("Erreur action.", "danger");
        });
      });
    });

    // fallback: delegation (si tes boutons sont <a> ou wrappers)
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button, a, [role='button']");
      if (!btn) return;
      const id = btn.id || "";
      if (map[id]) {
        e.preventDefault();
        map[id]();
      }
    });
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
        console.warn("[FitAI] config:", j);
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
        await this.ensureProfileRow();
        await this.loadProfile();
        await this.loadLikedSet();
      } else {
        this.publicProfile = null;
        this.likedSet = new Set();
      }

      await this.refreshFeed();
    });

    if (this.user) {
      await this.ensureProfileRow();
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
    if (error) return this.toast(`Login: ${error.message}`, "danger");
    this.toast("Connecté ✅", "ok");
  },

  async register() {
    const email = ($("#authEmail")?.value || "").trim();
    const password = ($("#authPassword")?.value || "").trim();
    if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

    const { error } = await this.sb.auth.signUp({ email, password });
    if (error) return this.toast(`Register: ${error.message}`, "danger");
    this.toast("Compte créé ✅", "ok");
  },

  async logout() {
    const { error } = await this.sb.auth.signOut();
    if (error) return this.toast(`Logout: ${error.message}`, "danger");
    this.toast("Déconnecté.", "ok");
  },

  async ensureProfileRow() {
    const { data } = await this.sb
      .from("public_profiles")
      .select("user_id")
      .eq("user_id", this.user.id)
      .maybeSingle();

    if (!data) {
      const name = (this.user.email || "User").split("@")[0].slice(0, 24);
      const { error } = await this.sb.from("public_profiles").insert({
        user_id: this.user.id,
        display_name: name,
      });
      if (error) console.warn("public_profiles insert:", error.message);
    }
  },

  async loadProfile() {
    const { data, error } = await this.sb
      .from("public_profiles")
      .select("user_id, display_name")
      .eq("user_id", this.user.id)
      .maybeSingle();

    if (error) return console.warn(error);

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
      .update({ display_name: name, updated_at:
