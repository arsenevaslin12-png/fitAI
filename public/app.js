/* public/app.js
   FitAI Pro v10 — Cyberpunk Lime/Indigo — Supabase v2

   - Auth email/password
   - Profil public (display_name) via public_profiles
   - Coach (appel /api/workout)
   - Community feed:
       * SELECT sur view public.workouts_feed
         (id,user_id,user_display,title,summary,intensity,kudos_count,created_at)
       * INSERT sur table public.workouts
         (user_id,is_public,title,summary,intensity)
       * likes sur table public.kudos (kudos_count maintenu par trigger)
   - Code défensif: si un élément DOM n’existe pas, ça ne crash pas
*/

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

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
  cfg: null,
  sb: null,
  user: null,

  publicProfile: null,
  likedSet: new Set(),

  lastGeneratedPlan: null,
  lastGeneratedText: "",

  initStarted: false,

  // ---------------------------
  // Init
  // ---------------------------
  async init() {
    if (this.initStarted) return;
    this.initStarted = true;

    this.ensureBaseUI();
    this.bindTabs();
    this.bindUI();

    await this.loadConfigAndInitSupabase();
    if (!this.sb) return;

    await this.bootstrapAuth();
    await this.refreshAll();
  },

  ensureBaseUI() {
    // Toast container
    if (!$("#toast")) {
      const div = document.createElement("div");
      div.id = "toast";
      div.style.position = "fixed";
      div.style.left = "50%";
      div.style.bottom = "22px";
      div.style.transform = "translateX(-50%)";
      div.style.zIndex = "99999";
      div.style.padding = "10px 14px";
      div.style.borderRadius = "12px";
      div.style.maxWidth = "92vw";
      div.style.display = "none";
      div.style.fontFamily = "system-ui, Segoe UI, Arial";
      div.style.fontSize = "14px";
      div.style.backdropFilter = "blur(8px)";
      div.style.border = "1px solid rgba(255,255,255,0.12)";
      div.style.boxShadow = "0 10px 40px rgba(0,0,0,0.35)";
      document.body.appendChild(div);
    }

    // Ensure a "Publish" button exists in Community tab header (optional)
    const community = $("#tab-community") || $("#panel-community") || $("#community");
    if (community && !$("#btnPublishWorkout")) {
      const header =
        community.querySelector(".panelHeader") ||
        community.querySelector(".tabHeader") ||
        community.querySelector(".rowHeader") ||
        community;

      const btn = document.createElement("button");
      btn.id = "btnPublishWorkout";
      btn.type = "button";
      btn.textContent = "Publier ma séance";
      btn.style.marginLeft = "8px";
      btn.style.padding = "10px 12px";
      btn.style.borderRadius = "14px";
      btn.style.border = "1px solid rgba(255,255,255,0.16)";
      btn.style.background = "rgba(0,0,0,0.25)";
      btn.style.color = "white";
      btn.style.cursor = "pointer";
      btn.dataset.cy = "publish-workout";

      const refreshBtn = $("#btnRefreshFeed");
      if (refreshBtn && refreshBtn.parentElement) {
        refreshBtn.parentElement.appendChild(btn);
      } else {
        header.appendChild(btn);
      }
    }
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

    el.textContent = msg;
    el.style.background = palette[type] || palette.info;
    el.style.display = "block";

    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => {
      el.style.display = "none";
    }, 2600);
  },

  safeOn(idOrEl, evt, fn) {
    const el =
      typeof idOrEl === "string"
        ? $(idOrEl.startsWith("#") ? idOrEl : `#${idOrEl}`)
        : idOrEl;
    if (!el) return null;
    el.addEventListener(evt, fn);
    return el;
  },

  setText(id, text) {
    const el = $(id.startsWith("#") ? id : `#${id}`);
    if (el) el.textContent = text;
  },

  // ---------------------------
  // Tabs (optional)
  // ---------------------------
  bindTabs() {
    const btns = $$("[data-tab]");
    const panels = $$("[data-panel]");
    if (!btns.length || !panels.length) return;

    const show = (name) => {
      btns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
    };

    btns.forEach((b) => {
      b.addEventListener("click", () => show(b.dataset.tab));
    });
  },

  // ---------------------------
  // Config + Supabase client
  // ---------------------------
  async loadConfigAndInitSupabase() {
    try {
      const r = await fetch("/api/workout?config=1", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));

      if (!j.SUPABASE_URL || !j.SUPABASE_ANON_KEY) {
        this.toast(
          "Config Supabase manquante. Vérifie tes variables d’environnement sur Vercel.",
          "danger"
        );
        return;
      }

      this.cfg = j;
      this.sb = createClient(j.SUPABASE_URL, j.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    } catch (e) {
      console.error(e);
      this.toast("Impossible d'initialiser Supabase.", "danger");
    }
  },

  // ---------------------------
  // Auth
  // ---------------------------
  async bootstrapAuth() {
    try {
      const { data } = await this.sb.auth.getSession();
      this.user = data?.session?.user || null;

      this.sb.auth.onAuthStateChange(async (_event, session) => {
        this.user = session?.user || null;
        await this.onAuthChanged();
      });

      await this.onAuthChanged();
    } catch (e) {
      console.error(e);
      this.toast("Auth: erreur de session.", "danger");
    }
  },

  bindUI() {
    // Auth UI (if present)
    this.safeOn("btnLogin", "click", () => this.login());
    this.safeOn("btnRegister", "click", () => this.register());
    this.safeOn("btnLogout", "click", () => this.logout());

    // Profile UI
    this.safeOn("btnSaveDisplayName", "click", () => this.saveDisplayName());

    // Coach UI
    this.safeOn("btnGenerateWorkout", "click", () => this.generateWorkout());

    // Feed UI
    this.safeOn("btnRefreshFeed", "click", () => this.refreshFeed());
    this.safeOn("btnPublishWorkout", "click", () => this.openPublishModal());
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
    this.toast("Compte créé ✅ (connecte-toi)", "ok");
  },

  async logout() {
    const { error } = await this.sb.auth.signOut();
    if (error) return this.toast(`Logout: ${error.message}`, "danger");
    this.toast("Déconnecté.", "ok");
  },

  async onAuthChanged() {
    const status = this.user?.email ? `Connecté: ${this.user.email}` : "Non connecté";
    this.setText("authStatus", status);

    const authed = !!this.user;
    const gateOn = $("#authedOnly");
    const gateOff = $("#unauthedOnly");
    if (gateOn) gateOn.style.display = authed ? "" : "none";
    if (gateOff) gateOff.style.display = authed ? "none" : "";

    if (!this.user) {
      this.publicProfile = null;
      this.likedSet = new Set();
      this.renderFeed([]);
      return;
    }

    await this.ensurePublicProfileRow();
    await this.loadPublicProfile();
    await this.loadLikedSet();
    await this.refreshFeed();
  },

  // ---------------------------
  // Profile (public_profiles)
  // ---------------------------
  async ensurePublicProfileRow() {
    try {
      const { data, error } = await this.sb
        .from("public_profiles")
        .select("user_id")
        .eq("user_id", this.user.id)
        .maybeSingle();

      if (error && error.code !== "PGRST116") {
        // not found is ok
      }

      if (!data) {
        const emailName = (this.user.email || "User").split("@")[0].slice(0, 24);
        const { error: e2 } = await this.sb.from("public_profiles").insert({
          user_id: this.user.id,
          display_name: emailName,
        });
        if (e2) console.warn("public_profiles insert:", e2.message);
      }
    } catch (e) {
      console.warn(e);
    }
  },

  async loadPublicProfile() {
    try {
      const { data, error } = await this.sb
        .from("public_profiles")
        .select("user_id, display_name")
        .eq("user_id", this.user.id)
        .maybeSingle();

      if (error) {
        console.warn(error);
        return;
      }
      this.publicProfile = data || null;

      const inp = $("#displayNameInput");
      if (inp && this.publicProfile) inp.value = this.publicProfile.display_name || "";
    } catch (e) {
      console.warn(e);
    }
  },

  async saveDisplayName() {
    if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

    const name = ($("#displayNameInput")?.value || "").trim();
    if (!name) return this.toast("Nom vide.", "warn");

    try {
      const { data: upd, error: e1 } = await this.sb
        .from("public_profiles")
        .update({ display_name: name, updated_at: new Date().toISOString() })
        .eq("user_id", this.user.id)
        .select("user_id")
        .maybeSingle();

      if (e1 && e1.code !== "PGRST116") {
        return this.toast(`Profil: ${e1.message}`, "danger");
      }

      if (!upd) {
        const { error: e2 } = await this.sb.from("public_profiles").insert({
          user_id: this.user.id,
          display_name: name,
        });
        if (e2) return this.toast(`Profil: ${e2.message}`, "danger");
      }

      await this.loadPublicProfile();
      this.toast("Nom public enregistré ✅", "ok");
      await this.refreshFeed();
    } catch (e) {
      console.error(e);
      this.toast("Profil: erreur.", "danger");
    }
  },

  // ---------------------------
  // Coach (/api/workout)
  // ---------------------------
  async generateWorkout() {
    if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

    const prompt = ($("#coachPrompt")?.value || "").trim();
    if (!prompt) return this.toast("Écris un objectif / prompt.", "warn");

    const out = $("#coachOutput");
    if (out) out.innerHTML = "Génération…";

    try {
      const r = await fetch("/api/workout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error || j?.message || `Erreur (${r.status})`;
        if (out) out.innerHTML = esc(msg);
        return this.toast(msg, "danger");
      }

      this.lastGeneratedPlan = j?.plan || null;
      this.lastGeneratedText = j?.text || j?.raw || "";

      if (out) {
        if (j?.plan) {
          out.innerHTML = `<pre style="white-space:pre-wrap;margin:0">${esc(
            JSON.stringify(j.plan, null, 2)
          )}</pre>`;
        } else {
          out.innerHTML = `<pre style="white-space:pre-wrap;margin:0">${esc(
            this.lastGeneratedText || "OK"
          )}</pre>`;
        }
      }

      this.toast("Plan généré ✅", "ok");
    } catch (e) {
      console.error(e);
      if (out) out.innerHTML = "Erreur réseau.";
      this.toast("Coach: erreur réseau.", "danger");
    }
  },

  // ---------------------------
  // Community Feed
  // ---------------------------
  async loadLikedSet() {
    this.likedSet = new Set();
    if (!this.user) return;

    try {
      const { data, error } = await this.sb
        .from("kudos")
        .select("workout_id")
        .eq("user_id", this.user.id);

      if (error) return;

      (data || []).forEach((row) => {
        if (row?.workout_id) this.likedSet.add(row.workout_id);
      });
    } catch (e) {
      console.warn(e);
    }
  },

  async refreshFeed() {
    if (!this.sb) return;

    const list = $("#feedList");
    if (list) list.innerHTML = "Chargement…";

    try {
      // IMPORTANT: on colle au schéma de la VIEW workouts_feed
      const { data, error } = await this.sb
        .from("workouts_feed")
        .select("id,user_id,user_display,title,summary,intensity,kudos_count,created_at")
        .order("created_at", { ascending: false })
        .limit(60);

      if (error) {
        console.warn(error);
        if (list) list.innerHTML = esc(error.message);
        return;
      }

      this.renderFeed(data || []);
    } catch (e) {
      console.error(e);
      if (list) list.innerHTML = "Erreur.";
    }
  },

  renderFeed(items) {
    const list = $("#feedList");
    if (!list) return;

    if (!items.length) {
      list.innerHTML = `<div style="opacity:.8">Aucune publication pour le moment.</div>`;
      return;
    }

    list.innerHTML = items
      .map((it) => {
        const liked = this.likedSet.has(it.id);
        const kudos = Number(it.kudos_count || 0);

        const summary = (it.summary || "").trim();
        const summaryShort =
          summary.length > 220 ? summary.slice(0, 220).trim() + "…" : summary;

        return `
          <div class="card" style="padding:14px;border:1px solid rgba(255,255,255,.10);border-radius:16px;margin:10px 0;background:rgba(0,0,0,.18)">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
              <div style="min-width:0">
                <div style="font-weight:700;letter-spacing:.2px">${esc(it.title || "Séance")}</div>
                <div style="opacity:.8;font-size:13px;margin-top:2px">
                  <span style="opacity:.9">${esc(it.user_display || "User")}</span>
                  <span style="opacity:.45"> • </span>
                  <span>${esc(fmtDate(it.created_at))}</span>
                  <span style="opacity:.45"> • </span>
                  <span style="text-transform:uppercase;font-size:12px;opacity:.9">${esc(
                    it.intensity || "medium"
                  )}</span>
                </div>
              </div>

              <button data-like="${esc(it.id)}"
                style="white-space:nowrap;padding:8px 10px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.22);color:white;cursor:pointer">
                ${liked ? "❤️" : "🤍"} ${kudos}
              </button>
            </div>

            ${
              summaryShort
                ? `<div style="margin-top:10px;opacity:.9;line-height:1.35">${esc(
                    summaryShort
                  )}</div>`
                : ""
            }
          </div>
        `;
      })
      .join("");

    $$("[data-like]", list).forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-like");
        if (id) this.toggleKudos(id);
      });
    });
  },

  async toggleKudos(workoutId) {
    if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

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
        const { error } = await this.sb.from("kudos").insert({
          workout_id: workoutId,
          user_id: this.user.id,
        });

        // unique(workout_id,user_id) -> si double clic on ignore
        const msg = String(error?.message || "").toLowerCase();
        if (error && !msg.includes("duplicate") && !msg.includes("unique")) {
          return this.toast(`Like: ${error.message}`, "danger");
        }
        this.likedSet.add(workoutId);
      }

      await this.refreshFeed();
    } catch (e) {
      console.error(e);
      this.toast("Like: erreur.", "danger");
    }
  },

  // ---------------------------
  // Publish modal -> INSERT workouts (title + summary + intensity)
  // ---------------------------
  openPublishModal() {
    if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.65)";
    overlay.style.backdropFilter = "blur(6px)";
    overlay.style.zIndex = "99998";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const card = document.createElement("div");
    card.style.width = "min(720px, 92vw)";
    card.style.margin = "7vh auto";
    card.style.background = "rgba(10,10,14,0.92)";
    card.style.border = "1px solid rgba(255,255,255,0.14)";
    card.style.borderRadius = "18px";
    card.style.boxShadow = "0 24px 80px rgba(0,0,0,0.55)";
    card.style.padding = "16px";

    const display =
      (this.publicProfile?.display_name || this.user.email || "User").split("@")[0].slice(0, 64);

    const hasPlan = !!this.lastGeneratedPlan;

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div style="font-weight:800;font-size:16px">Publier une séance</div>
        <button id="pubClose" style="padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);color:white;cursor:pointer">Fermer</button>
      </div>

      <div style="margin-top:12px;display:grid;gap:10px">
        <label style="display:grid;gap:6px">
          <div style="opacity:.85;font-size:13px">Titre</div>
          <input id="pubTitle" type="text" maxlength="80" value="${esc(
            hasPlan ? "Séance du coach" : "Séance"
          )}"
            style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none" />
        </label>

        <label style="display:grid;gap:6px">
          <div style="opacity:.85;font-size:13px">Intensité</div>
          <select id="pubIntensity"
            style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none">
            <option value="easy">easy</option>
            <option value="medium" selected>medium</option>
            <option value="hard">hard</option>
          </select>
        </label>

        <label style="display:grid;gap:6px">
          <div style="opacity:.85;font-size:13px">Résumé / notes (summary)</div>
          <textarea id="pubSummary" rows="6"
            style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none;resize:vertical"
          >${esc(hasPlan ? "Plan généré par le coach. ✅" : "")}</textarea>
        </label>

        <label style="display:flex;align-items:center;gap:10px;opacity:.9">
          <input id="pubIncludePlan" type="checkbox" ${hasPlan ? "checked" : ""} />
          <span>Inclure le plan JSON du coach dans le résumé</span>
        </label>

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:2px">
          <button id="pubSend"
            style="padding:10px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.28);color:white;cursor:pointer;font-weight:700">
            Publier
          </button>
        </div>

        <div style="opacity:.7;font-size:12px;margin-top:2px">
          Publié en tant que <b>${esc(display)}</b>
        </div>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    $("#pubClose", card)?.addEventListener("click", () => overlay.remove());
    $("#pubSend", card)?.addEventListener("click", async () => {
      const title = ($("#pubTitle", card)?.value || "").trim() || "Séance";
      const intensity = ($("#pubIntensity", card)?.value || "medium").trim() || "medium";
      let summary = ($("#pubSummary", card)?.value || "").trim();

      const includePlan = !!$("#pubIncludePlan", card)?.checked;

      if (includePlan && this.lastGeneratedPlan) {
        // On met le plan en texte dans summary (compatible partout)
        const planText = JSON.stringify(this.lastGeneratedPlan, null, 2);
        const chunk = planText.length > 4000 ? planText.slice(0, 4000) + "\n…(tronqué)" : planText;

        summary = summary ? `${summary}\n\n---\nPlan JSON:\n${chunk}` : `Plan JSON:\n${chunk}`;
      }

      await this.publishWorkout({ title, intensity, summary });
      overlay.remove();
    });
  },

  async publishWorkout(payload) {
    if (!this.user) return;

    try {
      const { error } = await this.sb.from("workouts").insert({
        user_id: this.user.id,
        is_public: true,
        title: payload.title,
        intensity: payload.intensity,
        summary: payload.summary || "",
      });

      if (error) return this.toast(`Publish: ${error.message}`, "danger");

      this.toast("Séance publiée ✅", "ok");
      await this.refreshFeed();
    } catch (e) {
      console.error(e);
      this.toast("Publish: erreur.", "danger");
    }
  },

  // ---------------------------
  // Global refresh
  // ---------------------------
  async refreshAll() {
    if (!this.user) return;
    await this.loadPublicProfile();
    await this.loadLikedSet();
    await this.refreshFeed();
  },
};

window.addEventListener("DOMContentLoaded", () => App.init());
