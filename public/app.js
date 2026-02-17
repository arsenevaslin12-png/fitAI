import { createClient } from "https://esm.sh/@supabase/supabase-js@2
";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s = "") =>
String(s)
.replace(/&/g, "&")
.replace(/</g, "<")
.replace(/>/g, ">")
.replace(/"/g, """)
.replace(/'/g, "'");

const norm = (s = "") =>
String(s)
.toLowerCase()
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "")
.replace(/\s+/g, " ")
.trim();

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

// Fix overlays qui bloquent les clics
this.autoFixOverlays();
this.installClickGuard();

this.bindUI();

await this.loadConfigAndInitSupabase();
if (!this.sb) return;

await this.bootstrapAuth();
await this.refreshAll();

// Expose for debug if needed
window.__App = this;


},

// ---------------------------
// UI Helpers
// ---------------------------
ensureBaseUI() {
// Toast container
if (!$("#toast")) {
const div = document.createElement("div");
div.id = "toast";
div.style.position = "fixed";
div.style.left = "50%";
div.style.bottom = "22px";
div.style.transform = "translateX(-50%)";
div.style.zIndex = "999999";
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

// Ensure "Publish" button exists in Community tab header (optional)
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

setText(id, text) {
const el = $(id.startsWith("#") ? id : #${id});
if (el) el.textContent = text;
},

// ---------------------------
// Anti-overlay: si un calque plein écran capte les clics, on le neutralise
// ---------------------------
autoFixOverlays() {
const maybeOverlay = (el) => {
if (!el || el === document.documentElement || el === document.body) return false;
const tag = (el.tagName || "").toLowerCase();
if (["button", "a", "input", "textarea", "select", "label"].includes(tag)) return false;

  const cs = window.getComputedStyle(el);
  const pos = cs.position;
  if (!(pos === "fixed" || pos === "absolute")) return false;

  const zi = parseInt(cs.zIndex || "0", 10);
  if (!(zi >= 10 || cs.zIndex === "auto")) {
    // auto parfois, on laisse passer
  }

  const r = el.getBoundingClientRect();
  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);

  const covers =
    r.width >= vw * 0.92 &&
    r.height >= vh * 0.92 &&
    r.left <= 5 &&
    r.top <= 5;

  if (!covers) return false;

  // overlay décoratif probable
  const idc = norm(el.id || "");
  const cls = norm(el.className || "");
  const looksFx =
    idc.includes("noise") ||
    idc.includes("scan") ||
    idc.includes("grain") ||
    idc.includes("overlay") ||
    idc.includes("fx") ||
    cls.includes("noise") ||
    cls.includes("scan") ||
    cls.includes("grain") ||
    cls.includes("overlay") ||
    cls.includes("fx") ||
    cls.includes("crt") ||
    tag === "canvas";

  return looksFx;
};

// Passe 1: neutralise overlays évidents
const all = $$("canvas, div, section, main, header, footer, aside");
let fixed = 0;
for (const el of all) {
  if (maybeOverlay(el)) {
    el.style.pointerEvents = "none";
    fixed++;
  }
}
if (fixed) this.toast(`Fix overlay: ${fixed} calque(s) neutralisé(s)`, "ok");


},

installClickGuard() {
// Passe 2: si un élément au-dessus bloque un bouton, on le désactive en live
document.addEventListener(
"pointerdown",
(e) => {
try {
const x = e.clientX;
const y = e.clientY;
const stack = document.elementsFromPoint(x, y) || [];
if (stack.length < 2) return;

      const top = stack[0];
      const behindButton = stack.find((el) => {
        const tag = (el.tagName || "").toLowerCase();
        return tag === "button" || (tag === "a" && (el.getAttribute("role") || "") === "button");
      });

      if (!behindButton) return;

      const topTag = (top.tagName || "").toLowerCase();
      if (["button", "a", "input", "textarea", "select", "label"].includes(topTag)) return;

      const cs = window.getComputedStyle(top);
      const pos = cs.position;
      const zi = parseInt(cs.zIndex || "0", 10);

      // Si c'est un calque au-dessus, fixe/absolute + z-index élevé + couvre l'écran
      const r = top.getBoundingClientRect();
      const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
      const covers =
        (pos === "fixed" || pos === "absolute") &&
        (zi >= 10 || cs.zIndex === "auto") &&
        r.width >= vw * 0.9 &&
        r.height >= vh * 0.9;

      if (!covers) return;

      // On neutralise
      top.style.pointerEvents = "none";
      const id = top.id ? `#${top.id}` : "";
      const cls = top.className ? `.${String(top.className).split(" ").filter(Boolean).join(".")}` : "";
      this.toast(`Overlay bloquant neutralisé (${topTag}${id}${cls})`, "warn");
    } catch {
      // ignore
    }
  },
  true
);


},

// ---------------------------
// Tabs (optional)
// ---------------------------
bindTabs() {
const btns = 
(
"
[
𝑑
𝑎
𝑡
𝑎
−
𝑡
𝑎
𝑏
]
"
)
;
𝑐
𝑜
𝑛
𝑠
𝑡
𝑝
𝑎
𝑛
𝑒
𝑙
𝑠
=
("[data−tab]");constpanels=("[data-panel]");
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
// Robust DOM lookup (IDs OU fallback)
// ---------------------------
findButtonByText(variants = []) {
const buttons = $$("button, a[role='button'], [data-action], [data-cy]");
const v = variants.map(norm).filter(Boolean);
if (!v.length) return null;

for (const el of buttons) {
  const txt = norm(el.textContent || "");
  const cy = norm(el.getAttribute("data-cy") || "");
  const act = norm(el.getAttribute("data-action") || "");
  if (v.some((k) => txt.includes(k) || cy.includes(k) || act.includes(k))) return el;
}
return null;


},

safeOnAny(target, evt, fn, fallbacks = []) {
// target: "btnLogin" OR "#btnLogin" OR element
let el = null;

if (typeof target === "string") {
  const id = target.startsWith("#") ? target.slice(1) : target;
  el = document.getElementById(id) || $(target);
} else {
  el = target;
}

if (!el && fallbacks?.length) {
  el = this.findButtonByText(fallbacks);
}

if (!el) return null;
el.addEventListener(evt, fn);
return el;


},

// Inputs fallback
getAuthEmail() {
return ($("#authEmail")?.value || $("input[type='email']")?.value || $("input[name='email']")?.value || "").trim();
},
getAuthPassword() {
return ($("#authPassword")?.value || $("input[type='password']")?.value || $("input[name='password']")?.value || "").trim();
},

getDisplayNameValue() {
return ($("#displayNameInput")?.value || $("input[name='display_name']")?.value || $("input[name='displayName']")?.value || "").trim();
},

getCoachPromptValue() {
return ($("#coachPrompt")?.value || $("textarea#coachPrompt")?.value || $("textarea[name='prompt']")?.value || $("textarea")?.value || "").trim();
},

// ---------------------------
// Config + Supabase client
// ---------------------------
async loadConfigAndInitSupabase() {
try {
const url = "/api/workout?config=1";
const r = await fetch(url, { cache: "no-store" });
const j = await r.json().catch(() => ({}));

  const sbUrl = j.SUPABASE_URL || j.supabaseUrl || j.supabase_url;
  const sbKey = j.SUPABASE_ANON_KEY || j.supabaseAnonKey || j.supabase_anon_key || j.supabaseKey;

  if (!sbUrl || !sbKey) {
    this.toast(
      `Config Supabase manquante. Vérifie Vercel ENV. Test: ${window.location.origin}${url}`,
      "danger"
    );
    return;
  }

  this.cfg = { SUPABASE_URL: sbUrl, SUPABASE_ANON_KEY: sbKey };
  this.sb = createClient(sbUrl, sbKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  this.toast("Supabase OK ✅", "ok");
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
// IMPORTANT: on bind d’abord via IDs, sinon fallback via texte
this.safeOnAny("btnLogin", "click", () => this.login(), ["login", "connexion", "se connecter", "sign in", "connecter"]);
this.safeOnAny("btnRegister", "click", () => this.register(), ["register", "inscription", "creer un compte", "sign up", "s'inscrire", "creer"]);
this.safeOnAny("btnLogout", "click", () => this.logout(), ["logout", "deconnexion", "se deconnecter"]);

this.safeOnAny("btnSaveDisplayName", "click", () => this.saveDisplayName(), ["enregistrer", "save", "sauvegarder", "nom public", "profil"]);

this.safeOnAny("btnGenerateWorkout", "click", () => this.generateWorkout(), ["generer", "generate", "coach", "workout", "entrainement"]);

this.safeOnAny("btnRefreshFeed", "click", () => this.refreshFeed(), ["refresh", "rafraichir", "actualiser", "feed"]);
this.safeOnAny("btnPublishWorkout", "click", () => this.openPublishModal(), ["publier", "publish", "post", "publication", "publish-workout"]);

// Si rien n'est bindé (IDs absents), on alerte
const needed = ["btnLogin", "btnRegister", "btnLogout", "btnGenerateWorkout", "btnRefreshFeed"];
const missing = needed.filter((id) => !document.getElementById(id));
if (missing.length) {
  this.toast(`IDs manquants (fallback actif): ${missing.join(", ")}`, "warn");
}


},

async login() {
const email = this.getAuthEmail();
const password = this.getAuthPassword();
if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

const { error } = await this.sb.auth.signInWithPassword({ email, password });
if (error) return this.toast(`Login: ${error.message}`, "danger");
this.toast("Connecté ✅", "ok");


},

async register() {
const email = this.getAuthEmail();
const password = this.getAuthPassword();
if (!email || !password) return this.toast("Email + mot de passe requis.", "warn");

const { error } = await this.sb.auth.signUp({ email, password });
if (error) return this.toast(`Register: ${error.message}`, "danger");
this.toast("Compte créé ✅ (connecte-toi)", "ok");


},

async logout() {
const { error } = await this.sb.auth.signOut();
if (error) return this.toast(Logout: ${error.message}, "danger");
this.toast("Déconnecté.", "ok");
},

async onAuthChanged() {
const status = this.user?.email ? Connecté: ${this.user.email} : "Non connecté";
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
const { data } = await this.sb
.from("public_profiles")
.select("user_id")
.eq("user_id", this.user.id)
.maybeSingle();

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

  if (error) return console.warn(error);

  this.publicProfile = data || null;

  const inp = $("#displayNameInput") || $("input[name='display_name']") || $("input[name='displayName']");
  if (inp && this.publicProfile) inp.value = this.publicProfile.display_name || "";
} catch (e) {
  console.warn(e);
}


},

async saveDisplayName() {
if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

const name = this.getDisplayNameValue();
if (!name) return this.toast("Nom vide.", "warn");

try {
  const { data: upd, error: e1 } = await this.sb
    .from("public_profiles")
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq("user_id", this.user.id)
    .select("user_id")
    .maybeSingle();

  if (e1 && e1.code !== "PGRST116") return this.toast(`Profil: ${e1.message}`, "danger");

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

const prompt = this.getCoachPromptValue();
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
      out.innerHTML = `<pre style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(j.plan, null, 2))}</pre>`;
    } else {
      out.innerHTML = `<pre style="white-space:pre-wrap;margin:0">${esc(this.lastGeneratedText || "OK")}</pre>`;
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
  const { data, error } = await this.sb.from("kudos").select("workout_id").eq("user_id", this.user.id);
  if (error) return;
  (data || []).forEach((row) => row?.workout_id && this.likedSet.add(row.workout_id));
} catch (e) {
  console.warn(e);
}


},

async refreshFeed() {
if (!this.sb) return;

const list = $("#feedList") || $("#communityFeed") || $("[data-feed]") || $("#feed");
if (list) list.innerHTML = "Chargement…";

try {
  const { data, error } = await this.sb
    .from("workouts_feed")
    .select("id,user_id,user_display,title,intensity,notes,plan_json,kudos_count,created_at")
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
const list = $("#feedList") || $("#communityFeed") || $("[data-feed]") || $("#feed");
if (!list) return;

if (!items.length) {
  list.innerHTML = `<div style="opacity:.8">Aucune publication pour le moment.</div>`;
  return;
}

list.innerHTML = items
  .map((it) => {
    const liked = this.likedSet.has(it.id);
    const kudos = Number(it.kudos_count || 0);
    const notes = (it.notes || "").trim();
    const notesShort = notes.length > 180 ? notes.slice(0, 180).trim() + "…" : notes;

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
              <span style="text-transform:uppercase;font-size:12px;opacity:.9">${esc(it.intensity || "medium")}</span>
            </div>
          </div>

          <button data-like="${esc(it.id)}"
            style="white-space:nowrap;padding:8px 10px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.22);color:white;cursor:pointer">
            ${liked ? "❤️" : "🤍"} ${kudos}
          </button>
        </div>

        ${notesShort ? `<div style="margin-top:10px;opacity:.9;line-height:1.35">${esc(notesShort)}</div>` : ""}
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
    const { error } = await this.sb.from("kudos").delete().eq("workout_id", workoutId).eq("user_id", this.user.id);
    if (error) return this.toast(`Unlike: ${error.message}`, "danger");
    this.likedSet.delete(workoutId);
  } else {
    const { error } = await this.sb.from("kudos").insert({ workout_id: workoutId, user_id: this.user.id });
    if (error && !String(error.message || "").toLowerCase().includes("duplicate")) {
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
// Publish modal -> INSERT workouts
// ---------------------------
openPublishModal() {
if (!this.user) return this.toast("Connecte-toi d’abord.", "warn");

const overlay = document.createElement("div");
overlay.style.position = "fixed";
overlay.style.inset = "0";
overlay.style.background = "rgba(0,0,0,0.65)";
overlay.style.backdropFilter = "blur(6px)";
overlay.style.zIndex = "999998";
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

const display = (this.publicProfile?.display_name || this.user.email || "User").split("@")[0].slice(0, 64);
const hasPlan = !!this.lastGeneratedPlan;

card.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
    <div style="font-weight:800;font-size:16px">Publier une séance</div>
    <button id="pubClose" style="padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);color:white;cursor:pointer">Fermer</button>
  </div>

  <div style="margin-top:12px;display:grid;gap:10px">
    <label style="display:grid;gap:6px">
      <div style="opacity:.85;font-size:13px">Titre</div>
      <input id="pubTitle" type="text" maxlength="80" value="${esc(hasPlan ? "Séance du coach" : "Séance")}"
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
      <div style="opacity:.85;font-size:13px">Notes (optionnel)</div>
      <textarea id="pubNotes" rows="5"
        style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none;resize:vertical"
      >${esc(hasPlan ? "Plan généré par le coach. ✅" : "")}</textarea>
    </label>

    <label style="display:flex;align-items:center;gap:10px;opacity:.9">
      <input id="pubIncludePlan" type="checkbox" ${hasPlan ? "checked" : ""} />
      <span>Inclure le plan JSON du coach (si dispo)</span>
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
  const notes = ($("#pubNotes", card)?.value || "").trim();
  const includePlan = !!$("#pubIncludePlan", card)?.checked;

  await this.publishWorkout({
    title,
    intensity,
    notes,
    user_display: display,
    plan_json: includePlan ? this.lastGeneratedPlan : null,
  });

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
    notes: payload.notes || "",
    user_display: payload.user_display || null,
    plan_json: payload.plan_json || null,
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
