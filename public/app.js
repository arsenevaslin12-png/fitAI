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

const ls = {
get(key, fallback) {
try {
const raw = localStorage.getItem(key);
return raw ? JSON.parse(raw) : fallback;
} catch {
return fallback;
}
},
set(key, value) {
try {
localStorage.setItem(key, JSON.stringify(value));
} catch {}
},
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
_warnedBtnIds: new Set(),

async init() {
if (this.initStarted) return;
this.initStarted = true;

this.ensureToast();
this.bindTabs();
this.bindGlobalClicks();

await this.loadConfigAndInitSupabase();
if (!this.sb) return;

await this.bootstrapAuth();

// Optionnel (si tu as une UI meals)
this.renderMeals();

// Premier refresh
await this.refreshAll();


},

ensureToast() {
if ($("#toast")) return;
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
this._toastT = setTimeout(() => (el.style.display = "none"), 2600);
},

setText(id, text) {
const el = $(id.startsWith("#") ? id : #${id});
if (el) el.textContent = text;
},

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

btns.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));


},

bindGlobalClicks() {
// Mapping des IDs les plus probables
this._clickMap = {
// Auth
btnLogin: () => this.login(),
btnRegister: () => this.register(),
btnLogout: () => this.logout(),

  // Profile
  btnSaveDisplayName: () => this.saveDisplayName(),

  // Coach
  btnGenerateWorkout: () => this.generateWorkout(),

  // Feed
  btnRefreshFeed: () => this.refreshFeed(),
  btnPublishWorkout: () => this.openPublishModal(),

  // Meals (IDs que TU as montré)
  btnCancelMeal: () => this.closeMealModal(),
  btnSaveMeal: () => this.saveMeal(),
};

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button, a, [role='button']");
  if (!btn) return;

  // data-action="xxx" => App.xxx()
  const action = btn.dataset?.action;
  if (action && typeof this[action] === "function") {
    e.preventDefault();
    this[action](btn, e);
    return;
  }

  const id = btn.id || "";
  if (id && this._clickMap[id]) {
    e.preventDefault();
    this._clickMap[id]();
    return;
  }

  // Debug soft: si un bouton btnXXX n’est pas câblé, on le dit 1 fois
  if (id && id.startsWith("btn") && !this._warnedBtnIds.has(id)) {
    this._warnedBtnIds.add(id);
    console.warn("Bouton non câblé:", id);
    this.toast(`Bouton non câblé: ${id}`, "warn");
  }
});


},

async loadConfigAndInitSupabase() {
try {
const r = await fetch("/api/workout?config=1", { cache: "no-store" });
const j = await r.json().catch(() => ({}));

  const url = j.SUPABASE_URL || j.supabaseUrl || j.supabase_url;
  const key = j.SUPABASE_ANON_KEY || j.supabaseAnonKey || j.supabase_anon_key;

  if (!url || !key) {
    this.toast("Config Supabase manquante (URL/ANON).", "danger");
    console.warn("Config reçue:", j);
    return;
  }

  this.cfg = j;
  this.sb = createClient(url, key, {
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
this.toast("Compte créé ✅ (connecte-toi)", "ok");


},

async logout() {
if (!this.sb) return;
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

async ensurePublicProfileRow() {
try {
const { data } = await this.sb
.from("public_profiles")
.select("user_id")
.eq("user_id", this.user.id)
.maybeSingle();

  if (!data) {
    const emailName = (this.user.email || "User").split("@")[0].slice(0, 24);
    const { error } = await this.sb.from("public_profiles").insert({
      user_id: this.user.id,
      display_name: emailName,
    });
    if (error) console.warn("public_profiles insert:", error.message);
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
      out.innerHTML =
        '<pre style="white-space:pre-wrap;margin:0">' +
        esc(JSON.stringify(j.plan, null, 2)) +
        "</pre>";
    } else {
      out.innerHTML =
        '<pre style="white-space:pre-wrap;margin:0">' +
        esc(this.lastGeneratedText || "OK") +
        "</pre>";
    }
  }

  this.toast("Plan généré ✅", "ok");
} catch (e) {
  console.error(e);
  if (out) out.innerHTML = "Erreur réseau.";
  this.toast("Coach: erreur réseau.", "danger");
}


},

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
const list = $("#feedList");
if (!list) return;

if (!items.length) {
  list.innerHTML = '<div style="opacity:.8">Aucune publication pour le moment.</div>';
  return;
}

list.innerHTML = items
  .map((it) => {
    const liked = this.likedSet.has(it.id);
    const kudos = Number(it.kudos_count || 0);
    const notes = (it.notes || "").trim();
    const notesShort = notes.length > 180 ? notes.slice(0, 180).trim() + "…" : notes;

    return (
      '<div class="card" style="padding:14px;border:1px solid rgba(255,255,255,.10);border-radius:16px;margin:10px 0;background:rgba(0,0,0,.18)">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">' +
      '<div style="min-width:0">' +
      '<div style="font-weight:700;letter-spacing:.2px">' +
      esc(it.title || "Séance") +
      "</div>" +
      '<div style="opacity:.8;font-size:13px;margin-top:2px">' +
      '<span style="opacity:.9">' +
      esc(it.user_display || "User") +
      "</span>" +
      '<span style="opacity:.45"> • </span>' +
      "<span>" +
      esc(fmtDate(it.created_at)) +
      "</span>" +
      '<span style="opacity:.45"> • </span>' +
      '<span style="text-transform:uppercase;font-size:12px;opacity:.9">' +
      esc(it.intensity || "medium") +
      "</span>" +
      "</div>" +
      "</div>" +
      '<button data-like="' +
      esc(it.id) +
      '" style="white-space:nowrap;padding:8px 10px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.22);color:white;cursor:pointer">' +
      (liked ? "❤️" : "🤍") +
      " " +
      kudos +
      "</button>" +
      "</div>" +
      (notesShort
        ? '<div style="margin-top:10px;opacity:.9;line-height:1.35">' + esc(notesShort) + "</div>"
        : "") +
      "</div>"
    );
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

const display = (this.publicProfile?.display_name || this.user.email || "User")
  .split("@")[0]
  .slice(0, 64);

const hasPlan = !!this.lastGeneratedPlan;

card.innerHTML =
  '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
  '<div style="font-weight:800;font-size:16px">Publier une séance</div>' +
  '<button id="pubClose" style="padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.25);color:white;cursor:pointer">Fermer</button>' +
  "</div>" +
  '<div style="margin-top:12px;display:grid;gap:10px">' +
  '<label style="display:grid;gap:6px">' +
  '<div style="opacity:.85;font-size:13px">Titre</div>' +
  '<input id="pubTitle" type="text" maxlength="80" value="' +
  esc(hasPlan ? "Séance du coach" : "Séance") +
  '" style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none" />' +
  "</label>" +
  '<label style="display:grid;gap:6px">' +
  '<div style="opacity:.85;font-size:13px">Intensité</div>' +
  '<select id="pubIntensity" style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none">' +
  '<option value="easy">easy</option>' +
  '<option value="medium" selected>medium</option>' +
  '<option value="hard">hard</option>' +
  "</select>" +
  "</label>" +
  '<label style="display:grid;gap:6px">' +
  '<div style="opacity:.85;font-size:13px">Notes (optionnel)</div>' +
  '<textarea id="pubNotes" rows="5" style="padding:10px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:white;outline:none;resize:vertical">' +
  esc(hasPlan ? "Plan généré par le coach. ✅" : "") +
  "</textarea>" +
  "</label>" +
  '<label style="display:flex;align-items:center;gap:10px;opacity:.9">' +
  '<input id="pubIncludePlan" type="checkbox" ' +
  (hasPlan ? "checked" : "") +
  " />" +
  "<span>Inclure le plan JSON du coach (si dispo)</span>" +
  "</label>" +
  '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:2px">' +
  '<button id="pubSend" style="padding:10px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.28);color:white;cursor:pointer;font-weight:700">Publier</button>' +
  "</div>" +
  '<div style="opacity:.7;font-size:12px;margin-top:2px">Publié en tant que <b>' +
  esc(display) +
  "</b></div>" +
  "</div>";

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

// ---------- Meals (localStorage) ----------
findMealModalRoot() {
// Essaie plusieurs IDs/classes probables
return (
$("#mealModal") ||
$("#modalMeal") ||
$("#mealSheet") ||
$("#mealOverlay") ||
document.querySelector("[data-modal='meal']") ||
document.querySelector(".mealModal") ||
null
);
},

closeMealModal() {
const root = this.findMealModalRoot();
if (!root) return this.toast("Modal repas introuvable.", "warn");

// Plusieurs systèmes possibles
root.classList.remove("open", "active", "show");
root.style.display = "none";
root.setAttribute("aria-hidden", "true");
this.toast("Fermé.", "ok");


},

saveMeal() {
// Inputs probables
const name = ($("#mealName")?.value || "").trim() || "Repas";
const calories = Number($("#mealCalories")?.value || 0) || 0;
const protein = Number($("#mealProtein")?.value || 0) || 0;
const carbs = Number($("#mealCarbs")?.value || 0) || 0;
const fats = Number($("#mealFats")?.value || 0) || 0;

const meal = {
  id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
  at: new Date().toISOString(),
  name,
  calories,
  protein,
  carbs,
  fats,
};

const key = "fitai_meals";
const arr = ls.get(key, []);
arr.unshift(meal);
ls.set(key, arr);

this.toast("Repas sauvegardé ✅", "ok");
this.renderMeals();
this.closeMealModal();


},

renderMeals() {
const arr = ls.get("fitai_meals", []);
const host =
$("#mealsList") || $("#mealList") || $("#mealsContainer") || $("#mealsItems") || null;
if (!host) return;

if (!arr.length) {
  host.innerHTML = '<div style="opacity:.7">Aucun repas enregistré.</div>';
  return;
}

host.innerHTML = arr
  .slice(0, 30)
  .map((m) => {
    return (
      '<div style="padding:10px 12px;margin:8px 0;border:1px solid rgba(255,255,255,.10);border-radius:14px;background:rgba(0,0,0,.18)">' +
      '<div style="display:flex;justify-content:space-between;gap:10px">' +
      "<b>" +
      esc(m.name) +
      "</b>" +
      '<span style="opacity:.7;font-size:12px">' +
      esc(fmtDate(m.at)) +
      "</span>" +
      "</div>" +
      '<div style="opacity:.85;font-size:13px;margin-top:6px">' +
      "Kcal: " +
      esc(m.calories) +
      " • P: " +
      esc(m.protein) +
      "g • G: " +
      esc(m.carbs) +
      "g • L: " +
      esc(m.fats) +
      "g" +
      "</div>" +
      "</div>"
    );
  })
  .join("");


},

async refreshAll() {
if (!this.user) return;
await this.loadPublicProfile();
await this.loadLikedSet();
await this.refreshFeed();
},
};

const boot = () => App.init();
if (document.readyState === "loading") {
window.addEventListener("DOMContentLoaded", boot);
} else {
boot();
}
