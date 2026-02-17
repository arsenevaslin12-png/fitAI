import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const norm = (s = "") =>
  String(s).toLowerCase().replace(/\s+/g, " ").trim();

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

function allClickable(root = document) {
  return [
    ...root.querySelectorAll(
      "button, a, [role='button'], input[type='button'], input[type='submit']"
    ),
  ];
}

function buttonText(el) {
  return norm(el?.innerText || el?.value || el?.textContent || "");
}

function findByTextIncludes(textIncludes = [], root = document) {
  const els = allClickable(root);
  for (const el of els) {
    const t = buttonText(el);
    if (!t) continue;
    if (textIncludes.some((k) => t.includes(k))) return el;
  }
  return null;
}

function findNear(refEl, textIncludes = []) {
  if (!refEl) return null;
  // remonte jusqu’à un conteneur raisonnable
  let p = refEl;
  for (let i = 0; i < 5 && p; i++) {
    const found = findByTextIncludes(textIncludes, p);
    if (found) return found;
    p = p.parentElement;
  }
  // fallback global
  return findByTextIncludes(textIncludes, document);
}

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

    this.ensureToast();
    this.autofixButtonIds(); // <-- le fix principal
    this.bindButtons();      // bind par id + delegation
    this.bindLikes();

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

  setAuthStatus() {
    const s = $("#authStatus");
    if (s) s.textContent = this.user?.email ? `Connecté: ${this.user.email}` : "Non connecté";
  },

  // === AUTOFIX IDS ===
  // Tu avais: btnLogout=true, btnRefreshFeed=true, le reste false.
  // Ici on retrouve tes boutons par texte et on leur met les IDs attendus.
  autofixButtonIds() {
    const want = [
      {
        id: "btnLogin",
        keys: ["login", "connexion", "connecter", "sign in", "se connecter"],
      },
      {
        id: "btnRegister",
        keys: ["register", "inscription", "sign up", "créer", "creer", "create"],
      },
      {
        id: "btnLogout",
        keys: ["logout", "déconnexion", "deconnexion", "sign out"],
      },
      {
        id: "btnSaveDisplayName",
        keys: ["save", "enregistrer", "valider", "ok", "mettre à jour", "mettre a jour"],
        near: "#displayNameInput",
      },
      {
        id: "btnGenerateWorkout",
        keys: ["generate", "générer", "generer", "coach", "plan", "séance", "seance"],
        near: "#coachPrompt",
      },
      {
        id: "btnRefreshFeed",
        keys: ["refresh", "actualiser", "recharger", "feed", "fil", "timeline"],
      },
      {
        id: "btnPublishWorkout",
        keys: ["publish", "publier", "poster", "post", "publication"],
      },
    ];

    for (const w of want) {
      if (document.getElementById(w.id)) continue;

      let found = null;

      if (w.near) {
        const ref = $(w.near);
        found = findNear(ref, w.keys);
      } else {
        found = findByTextIncludes(w.keys);
      }

      if (found && !found.id) {
        found.id = w.id;
      }
    }

    // log rapide (utile)
    const ids = [
      "btnLogin",
      "btnRegister",
      "btnLogout",
      "btnSaveDisplayName",
      "btnGenerateWorkout",
      "btnRefreshFeed",
      "btnPublishWorkout",
    ];
    const status = ids.map((id) => [id, !!document.getElementById(id)]);
    console.log("[FitAI] button ids:", status);
  },

  // === BIND ===
  bindButtons() {
    const map = {
      btnLogin: () => this.login(),
      btnRegister: () => this.register(),
      btnLogout: () => this.logout(),
      btnSaveDisplayName: () => this.saveDisplayName(),
      btnGenerateWorkout: () => this.generateWorkout(),
      btnRefreshFeed: () => this.refreshFeed(),
      btnPublishWorkout: () => this.openPublish(),
    };

    // bind direct
    for (const id of Object.keys(map)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener("click", (e) => {
        e.preventDefault();
        Promise.resolve(map[id]()).catch((err) => {
          console.error(err);
          this.toast("Erreur action.", "danger");
        });
      });
    }

    // delegation fallback (si ton HTML change / wrappers)
    document.addEventListener("click", (e) => {
      const el = e.target?.closest?.("button, a, [role='button'], input[type='button'], input[type='submit']");
      if (!el) return;

      // data-action="login" etc (si jamais)
      const action = el.dataset?.action;
      if (action && typeof this[action] === "function") {
        e.preventDefault();
        this[action]();
        return;
      }

      // id mapping
      if (el.id && map[el.id]) {
        e.preventDefault();
        map[el.id]();
        return;
      }

      // ultime fallback par texte (si rien n’a d’id)
      const t = buttonText(el);
      const looks = (keys) => keys.some((k) => t.includes(k));

      if (looks(["login", "connexion", "sign in"])) return (e.preventDefault(), this.login());
      if (looks(["register", "inscription", "sign up", "créer", "creer"])) return (e.preventDefault(), this.register());
      if (looks(["logout", "deconnexion", "déconnexion", "sign out"])) return (e.preventDefault(), this.logout());
      if (looks(["enregistrer", "save", "mettre à jour", "mettre a jour"])) return (e.preventDefault(), this.saveDisplayName());
      if (looks(["generate", "générer", "generer"])) return (e.preventDefault(), this.generateWorkout());
      if (looks(["refresh", "actualiser", "recharger"])) return (e.preventDefault(), this.refreshFeed());
      if (looks(["publish", "publier", "poster"])) return (e.preventDefault(), this.openPublish());
    });
  },

  bindLikes() {
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-like]");
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute("data-like");
      if (id) this.toggleKudos(id);
    });
  },

  // === SUPABASE INIT ===
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
    try {
      const { data } = await this.sb.auth.getSession();
      this.user = data?.session?.user || null;
      this.setAuthStatus();

      this.sb.auth.onAuthStateChange(async (_evt, session) => {
        this.user = session?.user || null;
        this.setAuthStatus();

        if (this.user) {
          await this.ensureProfileRow().catch(() => {});
          await this.loadProfile().catch(() => {});
          await this.loadLikedSet().catch(() => {});
        } else {
          this.publicProfile = null;
          this.likedSet = new Set();
        }

        await this.refreshFeed().catch(() => {});
      });

      if (this.user) {
        await this.ensureProfileRow().catch(() => {});
        await this.loadProfile().catch(() => {});
        await this.loadLikedSet().catch(() => {});
      }
    } catch (e) {
      console.error(e);
      this.toast("Auth init erreur.", "danger");
    }
  },

  // === AUTH ACTIONS ===
  async login() {
    if (!this.sb) return;
    const email = ($("#authEmail")?.value || "").trim();
    const password = ($("#authPassword")?.value || "").trim();
    if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) return this.toast(`Login: ${error.message}`, "danger");
    this.toast("Connecté ✅", "ok");
  },

  async register() {
    if (!this.sb) return;
    const email = ($("#authEmail")?.value || "").trim();
    const password = ($("#authPassword")?.value || "").trim();
    if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

    const { error } = await this.sb.auth.signUp({ email, password });
    if (error) return this.toast(`Register: ${error.message}`, "danger");
    this.toast("Compte créé ✅", "ok");
  },

  async logout() {
    if (!this.sb) return;
    const { error } = await this.sb.auth.signOut();
    if (error) return this.toast(`Logout: ${error.message}`, "danger");
    this.toast("Déconnecté.", "ok");
  },

  // === PROFILE ===
  async ensureProfileRow() {
    if (!this.user) return;
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
    if (!this.user) return;
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
      .update({ display_name: name, updated_at: new Date().toISOString() })
      .eq("user_id", this.user.id);

    if (error) return this.toast(`Profil: ${error.message}`, "danger");
    this.toast("Nom public enregistré ✅", "ok");
    await this.refreshFeed().catch(() => {});
  },

  // === COACH ===
  async generateWorkout() {
    if (!this.user) return this.toast("Connecte-toi.", "warn");
    const prompt = ($("#coachPrompt")?.value || "").trim();
    if (!prompt) return this.toast("Écris un prompt.", "warn");

    const out = $("#coachOutput");
    if (out) out.textContent = "Génération…";

    try {
      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error || j?.message || `Erreur ${r.status}`;
        if (out) out.textContent = msg;
        return this.toast(msg, "danger");
      }

      this.lastGeneratedPlan = j?.plan || null;
      if (out) out.textContent = this.lastGeneratedPlan ? JSON.stringify(this.lastGeneratedPlan, null, 2) : (j?.text || "OK");
      this.toast("Plan généré ✅", "ok");
    } catch (e) {
      console.error(e);
      if (out) out.textContent = "Erreur réseau.";
      this.toast("Coach: erreur réseau.", "danger");
    }
  },

  // === FEED ===
  async loadLikedSet() {
    this.likedSet = new Set();
    if (!this.user) return;

    const { data, error } = await this.sb
      .from("kudos")
      .select("workout_id")
      .eq("user_id", this.user.id);

    if (error) return;
    (data || []).forEach((r) => r?.workout_id && this.likedSet.add(r.workout_id));
  },

  async refreshFeed() {
    if (!this.sb) return;

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
      host.innerHTML = `<div style="opacity:.8">Aucune publication.</div>`;
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

    try {
      if (liked) {
        const { error } = await this.sb
          .from("kudos")
          .delete()
          .eq("workout_id", workoutId)
          .eq("user_id", this.user.id);

        if (error) return this.toast(`Unlike: ${error.message}`, "danger");
        this.likedSet.delete(workoutId);
      } else {
        const { error } = await this.sb
          .from("kudos")
          .insert({ workout_id: workoutId, user_id: this.user.id });

        if (error) {
          const msg = String(error.message || "").toLowerCase();
          if (!msg.includes("duplicate")) return this.toast(`Like: ${error.message}`, "danger");
        }
        this.likedSet.add(workoutId);
      }

      await this.refreshFeed();
    } catch (e) {
      console.error(e);
      this.toast("Like: erreur.", "danger");
    }
  },

  openPublish() {
    if (!this.user) return this.toast("Connecte-toi.", "warn");

    // fallback simple (marche même si ton UI publish est différente)
    const title = (prompt("Titre ?", "Séance") || "Séance").trim() || "Séance";
    const intensity = (prompt("Intensité (easy/medium/hard) ?", "medium") || "medium").trim() || "medium";
    const notes = (prompt("Notes (optionnel)", "") || "").trim();

    this.publishWorkout({ title, intensity, notes, plan_json: this.lastGeneratedPlan || null });
  },

  async publishWorkout(p) {
    if (!this.user) return;

    const { error } = await this.sb.from("workouts").insert({
      user_id: this.user.id,
      is_public: true,
      title: p.title,
      intensity: p.intensity,
      notes: p.notes || "",
      plan_json: p.plan_json || null,
    });

    if (error) return this.toast(`Publish: ${error.message}`, "danger");
    this.toast("Publié ✅", "ok");
    await this.refreshFeed();
  },
};

const boot = () => App.init();
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot);
else boot();
