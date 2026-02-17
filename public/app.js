(() => {
"use strict";

const APP = {
sb: null,
cfg: null,
session: null,
user: null,
busy: new Set(),
lastCoachPlan: null,
feed: [],
chart: null,
_createClient: null,
_supabaseImportPromise: null,
};

// -----------------------------
// DOM utils (defensive)
// -----------------------------
const $id = (id) => document.getElementById(id);
const $q = (sel, root = document) => root.querySelector(sel);

const esc = (s) =>
String(s ?? "")
.replaceAll("&", "&amp;")
.replaceAll("<", "&lt;")
.replaceAll(">", "&gt;")
.replaceAll('"', "&quot;")
.replaceAll("'", "&#39;");

const safeText = (el, t) => {
if (!el) return;
el.textContent = String(t ?? "");
};

const safeHTML = (el, html) => {
if (!el) return;
el.innerHTML = html ?? "";
};

const show = (el, yes) => {
if (!el) return;
el.style.display = yes ? "" : "none";
};

const disable = (el, yes) => {
if (!el) return;
el.disabled = !!yes;
el.setAttribute("aria-disabled", yes ? "true" : "false");
};

const isBusy = (k) => APP.busy.has(k);
const setBusy = (k, yes) => {
if (yes) APP.busy.add(k);
else APP.busy.delete(k);
};

const nowISO = () => new Date().toISOString();

const fmtDate = (iso) => {
if (!iso) return "";
try {
const d = new Date(iso);
return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
} catch {
return String(iso);
}
};

function toast(msg, kind = "info") {
if (kind === "error") console.error(msg);
else console.log(msg);

const hint = $id("profileHint");
if (hint) {
  hint.textContent = String(msg);
  hint.style.color = kind === "error" ? "rgba(255,59,48,.95)" : "rgba(183,255,42,.95)";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    hint.textContent = "";
    hint.style.color = "";
  }, 4000);
}
}

async function safeJson(res) {
try {
return await res.json();
} catch {
return null;
}
}

function safeName(name) {
return String(name || "upload").replace(/[^\w.-]+/g, "_");
}

function getTodayKey() {
const d = new Date();
const yyyy = d.getFullYear();
const mm = String(d.getMonth() + 1).padStart(2, "0");
const dd = String(d.getDate()).padStart(2, "0");
return `${yyyy}-${mm}-${dd}`;
}

// -----------------------------
// Supabase loader (NO top-level import)
// -----------------------------
async function getCreateClient() {
if (APP._createClient) return APP._createClient;

if (!APP._supabaseImportPromise) {
  APP._supabaseImportPromise = import("https://esm.sh/@supabase/supabase-js@2");
}

const mod = await APP._supabaseImportPromise;
if (!mod || typeof mod.createClient !== "function") {
  throw new Error("Supabase module: createClient introuvable");
}
APP._createClient = mod.createClient;
return APP._createClient;
}

// -----------------------------
// Supabase init via /api/workout?config=1
// -----------------------------
async function loadConfigAndInitSupabase() {
const r = await fetch("/api/workout?config=1", { cache: "no-store" });
if (!r.ok) throw new Error(`Config endpoint HTTP ${r.status}`);

const cfg = await safeJson(r);
if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) {
  throw new Error("Config invalide (supabaseUrl/supabaseAnonKey manquants)");
}

const createClient = await getCreateClient();

APP.cfg = cfg;
APP.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: { headers: { "x-client-info": "fitai-pro-v10" } },
});

APP.sb.auth.onAuthStateChange((_evt, session) => {
  APP.session = session;
  APP.user = session?.user ?? null;

  renderAuth();
  refreshMorningBrief();
  refreshProfileHint().catch(() => {});
  refreshDash().catch(() => {});
  refreshFeed().catch(() => {});
  refreshBodyScans().catch(() => {});
  refreshTrophies().catch(() => {});
});
}

async function bootstrapSession() {
const { data, error } = await APP.sb.auth.getSession();
if (error) throw error;
APP.session = data?.session ?? null;
APP.user = data?.session?.user ?? null;
}

// -----------------------------
// Tabs
// -----------------------------
const TAB_MAP = [
{ btn: "tabBtnDash", section: "tab-dash" },
{ btn: "tabBtnCoach", section: "tab-coach" },
{ btn: "tabBtnNutrition", section: "tab-nutrition" },
{ btn: "tabBtnCommunity", section: "tab-community" },
{ btn: "tabBtnProfile", section: "tab-profile" },
{ btn: "tabBtnBodyScan", section: "tab-bodyscan" },
];

function setActiveTab(btnId) {
for (const t of TAB_MAP) {
const b = $id(t.btn);
const s = $id(t.section);
const active = t.btn === btnId;
if (b) {
b.classList.toggle("active", active);
b.setAttribute("aria-selected", active ? "true" : "false");
}
if (s) s.style.display = active ? "" : "none";
}
}

function bindTabs() {
for (const t of TAB_MAP) {
const b = $id(t.btn);
if (!b || b._fitaiBound) continue;
b.addEventListener("click", () => setActiveTab(t.btn));
b._fitaiBound = true;
}
}

function ensureBodyScanTab() {
const nav = $q(".tabs");
if (!nav) return;

if (!$id("tabBtnBodyScan")) {
  const btn = document.createElement("button");
  btn.className = "tabBtn";
  btn.id = "tabBtnBodyScan";
  btn.type = "button";
  btn.textContent = "Body Scan";
  btn.setAttribute("aria-selected", "false");
  nav.appendChild(btn);
}

if (!$id("tab-bodyscan")) {
  const main = $q("main.container");
  if (!main) return;

  const section = document.createElement("section");
  section.id = "tab-bodyscan";
  section.style.display = "none";
  section.innerHTML = `
    <div class="card">
      <div class="row between">
        <div class="cardTitle" style="margin:0">Body Scan (privé)</div>
        <span class="chip">Bucket: <span style="font-weight:950;margin-left:6px">user_uploads</span></span>
      </div>
      <div style="height:10px"></div>

      <div class="row" style="gap:10px; align-items:center">
        <input class="input" id="bodyScanFile" type="file" style="flex:1" />
        <button class="btn primary" id="btnUploadBodyScan" type="button">Upload</button>
        <button class="btn" id="btnRefreshBodyScans" type="button">Refresh</button>
      </div>

      <div class="hr"></div>
      <div id="bodyScansList"></div>
      <div class="hint" style="margin-top:10px">
        Les fichiers sont privés. Accès via signed URLs uniquement.
      </div>
    </div>
  `;
  main.appendChild(section);
}
}

// -----------------------------
// Auth
// -----------------------------
function renderAuth() {
const authStatus = $id("authStatus");
const btnLogout = $id("btnLogout");

if (!APP.user) {
  safeText(authStatus, "Non connecté");
  show(btnLogout, false);
  return;
}
safeText(authStatus, "Connecté");
show(btnLogout, true);
}

async function actionMagicLink() {
const email = ($id("email")?.value ?? "").trim();
if (!email) return toast("Email manquant.", "error");

if (isBusy("magic")) return;
setBusy("magic", true);
disable($id("btnMagicLink"), true);

try {
  const { error } = await APP.sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  toast("Magic link envoyé. Vérifie ton email.", "info");
} catch (e) {
  toast(`Magic link: ${e.message || e}`, "error");
} finally {
  disable($id("btnMagicLink"), false);
  setBusy("magic", false);
}
}

async function actionLogout() {
if (isBusy("logout")) return;
setBusy("logout", true);
disable($id("btnLogout"), true);

try {
  const { error } = await APP.sb.auth.signOut();
  if (error) throw error;
  toast("Déconnecté.", "info");
} catch (e) {
  toast(`Logout: ${e.message || e}`, "error");
} finally {
  disable($id("btnLogout"), false);
  setBusy("logout", false);
}
}

// -----------------------------
// Profile
// -----------------------------
async function refreshProfileHint() {
const hint = $id("profileHint");
if (!hint) return;

if (!APP.user) {
  hint.textContent = "Connecte-toi pour activer le feed + publier.";
  return;
}

try {
  const { data, error } = await APP.sb
    .from("public_profiles")
    .select("display_name")
    .eq("user_id", APP.user.id)
    .maybeSingle();

  if (error) throw error;

  const dn = (data?.display_name ?? "").trim();
  hint.textContent = dn ? `Profil: ${dn}` : "Profil: ajoute un nom public (onglet Profile).";
} catch {
  hint.textContent = "Profil: ajoute un nom public (onglet Profile).";
}
}

async function actionSaveName() {
if (!APP.user) return toast("Connecte-toi d'abord.", "error");

const displayName = ($id("displayName")?.value ?? "").trim();
if (!displayName) return toast("Nom public manquant.", "error");

if (isBusy("saveName")) return;
setBusy("saveName", true);
disable($id("btnSaveName"), true);

try {
  const payload = { user_id: APP.user.id, display_name: displayName, updated_at: nowISO() };
  const { error } = await APP.sb.from("public_profiles").upsert(payload, { onConflict: "user_id" });
  if (error) throw error;

  toast("Nom public sauvegardé.", "info");
  await refreshProfileHint();
  await refreshFeed();
  await refreshTrophies();
} catch (e) {
  toast(`Save name: ${e.message || e}`, "error");
} finally {
  disable($id("btnSaveName"), false);
  setBusy("saveName", false);
}
}

// Equipment (local)
function loadEquipment() {
try {
return JSON.parse(localStorage.getItem("fitai_equipment") || "{}");
} catch {
return {};
}
}

function saveEquipment(obj) {
localStorage.setItem("fitai_equipment", JSON.stringify(obj));
}

function applyEquipmentToUI() {
const eq = loadEquipment();
const map = [
["eqDumbbells", "dumbbells"],
["eqBarbell", "barbell"],
["eqBodyweight", "bodyweight"],
["eqMachines", "machines"],
];
for (const [id, key] of map) {
const el = $id(id);
if (el) el.checked = !!eq[key];
}
}

async function actionSaveEquipment() {
const eq = {
dumbbells: !!$id("eqDumbbells")?.checked,
barbell: !!$id("eqBarbell")?.checked,
bodyweight: !!$id("eqBodyweight")?.checked,
machines: !!$id("eqMachines")?.checked,
};
saveEquipment(eq);
toast("Équipement sauvegardé (local).", "info");
}

// -----------------------------
// KPIs (local)
// -----------------------------
function loadKPIs() {
try {
const v = JSON.parse(localStorage.getItem("fitai_kpis") || "{}");
return {
recovery: Number.isFinite(v.recovery) ? v.recovery : 65,
weight: Number.isFinite(v.weight) ? v.weight : 75,
sleep: Number.isFinite(v.sleep) ? v.sleep : 7,
};
} catch {
return { recovery: 65, weight: 75, sleep: 7 };
}
}

function saveKPIs(k) {
localStorage.setItem("fitai_kpis", JSON.stringify(k));
}

function renderKPIs() {
const k = loadKPIs();
safeText($id("val-recovery"), `${Math.round(k.recovery)}`);
safeText($id("val-weight"), `${Math.round(k.weight)}`);
safeText($id("val-sleep"), `${(Math.round(k.sleep * 10) / 10).toFixed(1)}`);
safeText($id("protein-target"), Math.round(k.weight * 1.8));
safeText($id("cal-target"), Math.round(k.weight * 30));
}

function refreshMorningBrief() {
const el = $id("morningBrief");
if (!el) return;

if (!APP.user) {
  el.textContent = "Connecte-toi pour activer le suivi.";
  return;
}
const k = loadKPIs();
el.textContent = `Salut 👋 Recovery ${Math.round(k.recovery)} • Poids ${Math.round(k.weight)}kg • Sommeil ${Math.round(k.sleep * 10) / 10}h`;
}

function onKpiClick(btn) {
const kpi = btn.getAttribute("data-kpi");
const dir = Number(btn.getAttribute("data-dir") || "0");
if (!kpi || !dir) return;

const k = loadKPIs();
if (kpi === "recovery") k.recovery = Math.max(0, Math.min(100, k.recovery + dir * 2));
if (kpi === "weight") k.weight = Math.max(30, Math.min(250, k.weight + dir * 1));
if (kpi === "sleep") k.sleep = Math.max(0, Math.min(24, k.sleep + dir * 0.25));

saveKPIs(k);
renderKPIs();
refreshMorningBrief();
renderNutrition();
}

// -----------------------------
// Nutrition (local modal)
// -----------------------------
function mealKey() {
return `fitai_meals_${getTodayKey()}`;
}

function loadMeals() {
try {
return JSON.parse(localStorage.getItem(mealKey()) || "[]");
} catch {
return [];
}
}

function saveMeals(arr) {
localStorage.setItem(mealKey(), JSON.stringify(arr));
}

function openMealModal(open) {
const modal = $id("mealModal");
if (!modal) return;
modal.style.display = open ? "flex" : "none";
modal.setAttribute("aria-hidden", open ? "false" : "true");
}

function clearMealForm() {
const ids = ["mealCal", "mealDesc", "mealProt", "mealCarbs", "mealFats"];
for (const id of ids) {
const el = $id(id);
if (el) el.value = "";
}
}

function renderNutrition() {
const meals = loadMeals();
let cal = 0, prot = 0, carbs = 0, fats = 0;

for (const m of meals) {
  cal += Number(m.cal || 0);
  prot += Number(m.prot || 0);
  carbs += Number(m.carbs || 0);
  fats += Number(m.fats || 0);
}

safeText($id("cal-total"), Math.round(cal));
safeText($id("macro-protein"), `${Math.round(prot)}g`);
safeText($id("macro-carbs"), Math.round(carbs));
safeText($id("macro-fats"), Math.round(fats));

const container = $id("mealsContainer");
if (!container) return;

if (!meals.length) {
  safeHTML(container, `<div class="empty">Aucun repas aujourd'hui.</div>`);
  return;
}

const html = meals
  .slice()
  .reverse()
  .map((m, idx) => {
    const t = esc(m.type || "Repas");
    const d = esc(m.desc || "");
    return `
      <div class="feedCard">
        <div class="feedHeader">
          <div class="feedUser">${t}</div>
          <div class="feedTime">${esc(m.time || "")}</div>
        </div>
        <div class="hint" style="margin-top:8px">${d}</div>
        <div class="row" style="margin-top:10px; gap:10px">
          <span class="badge cyan">${Math.round(m.cal || 0)} kcal</span>
          <span class="badge">${Math.round(m.prot || 0)}g P</span>
          <span class="badge">${Math.round(m.carbs || 0)}g G</span>
          <span class="badge">${Math.round(m.fats || 0)}g L</span>
          <button class="btn" data-action="delete-meal" data-index="${idx}" type="button" style="margin-left:auto">Suppr</button>
        </div>
      </div>
    `;
  })
  .join("");

safeHTML(container, html);
}

function actionSaveMeal() {
const type = ($id("mealType")?.value ?? "Repas").trim();
const cal = Number($id("mealCal")?.value || 0);
const desc = ($id("mealDesc")?.value ?? "").trim();
const prot = Number($id("mealProt")?.value || 0);
const carbs = Number($id("mealCarbs")?.value || 0);
const fats = Number($id("mealFats")?.value || 0);

const meals = loadMeals();
meals.push({
  type,
  cal: Math.max(0, cal),
  desc,
  prot: Math.max(0, prot),
  carbs: Math.max(0, carbs),
  fats: Math.max(0, fats),
  time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
});
saveMeals(meals);
clearMealForm();
openMealModal(false);
renderNutrition();
toast("Repas ajouté.", "info");
}

function actionDeleteMeal(indexFromUI) {
const meals = loadMeals();
const idx = Number(indexFromUI);
const actualIndex = meals.length - 1 - idx;
if (actualIndex < 0 || actualIndex >= meals.length) return;
meals.splice(actualIndex, 1);
saveMeals(meals);
renderNutrition();
toast("Repas supprimé.", "info");
}

// -----------------------------
// Coach
// -----------------------------
function fallbackPlan(prompt) {
return {
title: "Séance générée",
intensity: "medium",
notes: prompt ? `Prompt: ${prompt}` : "",
blocks: [
{ title: "Warm-up", duration_min: 8, items: ["Mobilité", "Cardio léger"] },
{ title: "Main", duration_min: 25, items: ["3x mouvement principal", "2x accessoire"] },
{ title: "Cooldown", duration_min: 5, items: ["Respiration", "Stretching"] },
],
created_at: nowISO(),
source: "fallback",
};
}

async function actionCoachAsk() {
const btn = $id("btnCoachAsk");
const prompt = ($id("coachPrompt")?.value ?? "").trim();

if (isBusy("coach")) return;
setBusy("coach", true);
disable(btn, true);

try {
  let plan = null;

  const r = await fetch("/api/workout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (r.ok) {
    const out = await safeJson(r);
    plan = out?.plan_json ?? out?.plan ?? out ?? null;
  }

  if (!plan || typeof plan !== "object") plan = fallbackPlan(prompt);

  if (!plan.title) plan.title = "Séance générée";
  if (!plan.intensity) plan.intensity = "medium";
  if (!plan.created_at) plan.created_at = nowISO();

  APP.lastCoachPlan = plan;
  renderCoach(plan);
  toast("Coach: plan généré.", "info");
} catch (e) {
  const plan = fallbackPlan(prompt);
  APP.lastCoachPlan = plan;
  renderCoach(plan);
  toast(`Coach (fallback): ${e.message || e}`, "error");
} finally {
  disable(btn, false);
  setBusy("coach", false);
}
}

function renderCoach(plan) {
const out = $id("coachOutput");
if (!out) return;

const title = esc(plan.title || "Séance");
const intensity = esc(plan.intensity || "");
const notes = esc(plan.notes || "");
const when = fmtDate(plan.created_at || nowISO());

const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
const blocksHtml = blocks
  .map((b) => {
    const items = Array.isArray(b.items) ? b.items : [];
    const specs = [
      b.duration_min != null ? `${esc(b.duration_min)} min` : "",
      b.reps != null ? `${esc(b.reps)} reps` : "",
      b.sets != null ? `${esc(b.sets)} sets` : "",
    ].filter(Boolean).join(" • ");

    return `
      <div class="exerciseCard">
        <div class="exerciseInfo">
          <div class="exerciseName">${esc(b.title || "Block")}</div>
          <div class="exerciseSpecs">${esc(specs)}</div>
          <div class="hint">${items.map((x) => "• " + esc(x)).join("<br>")}</div>
        </div>
        <div class="exerciseRPE">${esc(b.rpe ?? "")}</div>
      </div>
    `;
  })
  .join("");

const publishDisabled = APP.user ? "" : "disabled";

safeHTML(out, `
  <div class="card">
    <div class="cardTitle">Plan généré</div>
    <div class="row" style="gap:10px; margin-bottom:10px;">
      ${intensity ? `<span class="badge orange">${intensity}</span>` : ""}
      <span class="badge cyan">${esc(when)}</span>
      ${plan.source ? `<span class="badge">${esc(plan.source)}</span>` : ""}
    </div>

    <div class="feedTitle">${title}</div>
    ${notes ? `<div class="hint" style="margin-bottom:12px;">${notes}</div>` : ""}
    <div>${blocksHtml || `<div class="empty">Aucun bloc.</div>`}</div>

    <div class="hr"></div>
    <div class="row between">
      <div class="hint">Publier = INSERT dans la table workouts.</div>
      <div class="row" style="gap:10px;">
        <button class="btn" type="button" data-action="copy-plan">Copier JSON</button>
        <button class="btn primary" type="button" data-action="publish-plan" data-public="1" ${publishDisabled}>Publier</button>
        <button class="btn" type="button" data-action="publish-plan" data-public="0" ${publishDisabled}>Privé</button>
      </div>
    </div>
  </div>
`);
}

async function actionPublishPlan(isPublic) {
if (!APP.user) return toast("Connecte-toi pour publier.", "error");
if (!APP.lastCoachPlan) return toast("Génère une séance d'abord.", "error");
if (isBusy("publish")) return;

setBusy("publish", true);
try {
  const p = APP.lastCoachPlan;

  const payload = {
    user_id: APP.user.id,
    is_public: !!isPublic,
    title: String(p.title || "Séance"),
    intensity: String(p.intensity || "medium"),
    notes: String(p.notes || ""),
    plan_json: p,
  };

  const { error } = await APP.sb.from("workouts").insert(payload);
  if (error) throw error;

  toast(isPublic ? "Publié dans le feed." : "Sauvé (privé).", "info");
  await refreshFeed();
  await refreshDash();
  await refreshTrophies();
  setActiveTab("tabBtnCommunity");
} catch (e) {
  toast(`Publish: ${e.message || e}`, "error");
} finally {
  setBusy("publish", false);
}
}

async function actionCopyPlan() {
if (!APP.lastCoachPlan) return toast("Rien à copier.", "error");
try {
const txt = JSON.stringify(APP.lastCoachPlan, null, 2);
await navigator.clipboard.writeText(txt);
toast("JSON copié.", "info");
} catch {
toast("Copie impossible (clipboard).", "error");
}
}

// -----------------------------
// Feed
// -----------------------------
function normalizeFeedRow(w) {
return {
id: w.id,
display: w.display_name || w.user_display || "Anonymous",
title: w.title || "Untitled",
intensity: w.intensity || "",
notes: w.notes || "",
created_at: w.created_at || "",
kudos_count: Number(w.kudos_count ?? 0),
liked_by_me: typeof w.liked_by_me === "boolean" ? w.liked_by_me : false,
is_public: typeof w.is_public === "boolean" ? w.is_public : true,
};
}

function renderFeed() {
const container = $id("feedContainer");
if (!container) return;

if (!APP.feed.length) {
  safeHTML(container, `
    <div class="empty">Feed vide.</div>
    <div style="height:10px"></div>
    <button class="btn primary" type="button" data-action="seed-example" ${APP.user ? "" : "disabled"}>
      Publier une séance exemple
    </button>
  `);
  return;
}

const html = APP.feed
  .map((raw) => {
    const w = normalizeFeedRow(raw);
    const liked = !!w.liked_by_me;
    const btnClass = liked ? "kudosBtn liked" : "kudosBtn";
    const badgeIntensity = w.intensity ? `<span class="badge orange">${esc(w.intensity)}</span>` : "";
    const badgePublic = w.is_public ? `<span class="badge lime">PUBLIC</span>` : `<span class="badge red">PRIVÉ</span>`;

    return `
      <div class="feedCard" data-workout-id="${esc(w.id)}">
        <div class="feedHeader">
          <div class="feedUser">${esc(w.display)} <span class="feedBadges" style="margin-left:8px">${badgePublic}</span></div>
          <div class="feedTime">${esc(fmtDate(w.created_at))}</div>
        </div>

        <div class="feedTitle">${esc(w.title)}</div>

        <div class="row" style="gap:10px; margin-bottom:10px">
          ${badgeIntensity}
          ${w.notes ? `<span class="hint">${esc(w.notes)}</span>` : ""}
        </div>

        <div class="feedActions">
          <button class="${btnClass}" type="button" data-action="toggle-kudos" data-id="${esc(w.id)}" ${APP.user ? "" : "disabled"}>
            ${liked ? "❤️" : "🤍"} Kudos <span style="opacity:.9">(${w.kudos_count})</span>
          </button>

          <span class="hint">${APP.user ? "" : "Connecte-toi pour liker."}</span>
        </div>
      </div>
    `;
  })
  .join("");

safeHTML(container, html);
}

async function refreshFeed() {
const chip = $id("feedStatus");
const btn = $id("btnRefreshFeed");

if (btn) disable(btn, true);
safeText(chip, "Chargement…");

try {
  const { data, error } = await APP.sb
    .from("workouts_feed")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) throw error;

  APP.feed = Array.isArray(data) ? data : [];
  safeText(chip, `OK • ${APP.feed.length}`);
  renderFeed();
} catch (e) {
  safeText(chip, "Erreur feed");
  toast(`Feed: ${e.message || e}`, "error");
} finally {
  if (btn) disable(btn, false);
}
}

async function toggleKudos(workoutId) {
if (!APP.user) return toast("Connecte-toi pour liker.", "error");
if (!workoutId) return;

const idx = APP.feed.findIndex((x) => x.id === workoutId);
if (idx < 0) return;

const lockKey = `kudos:${workoutId}`;
if (isBusy(lockKey)) return;
setBusy(lockKey, true);

const row = { ...APP.feed[idx] };
const w = normalizeFeedRow(row);
const wasLiked = !!w.liked_by_me;

try {
  if (wasLiked) {
    row.liked_by_me = false;
    row.kudos_count = Math.max(0, Number(row.kudos_count ?? 0) - 1);
    APP.feed[idx] = row;
    renderFeed();

    const { error } = await APP.sb
      .from("kudos")
      .delete()
      .eq("workout_id", workoutId)
      .eq("user_id", APP.user.id);

    if (error) throw error;
  } else {
    row.liked_by_me = true;
    row.kudos_count = Number(row.kudos_count ?? 0) + 1;
    APP.feed[idx] = row;
    renderFeed();

    const { error } = await APP.sb.from("kudos").insert({
      workout_id: workoutId,
      user_id: APP.user.id,
    });

    if (error && String(error.code) !== "23505") throw error;
  }

  await refreshFeed();
  await refreshTrophies();
} catch (e) {
  await refreshFeed();
  toast(`Kudos: ${e.message || e}`, "error");
} finally {
  setBusy(lockKey, false);
}
}

async function seedExampleWorkout() {
if (!APP.user) return toast("Connecte-toi d'abord.", "error");
if (isBusy("seed")) return;
setBusy("seed", true);

try {
  const example = {
    title: "Séance exemple (FitAI)",
    intensity: "easy",
    notes: "Exemple auto (seed).",
    blocks: [
      { title: "Warm-up", duration_min: 6, items: ["Marche rapide", "Mobilité épaules"] },
      { title: "Main", duration_min: 18, items: ["Pompes x 3 séries", "Squats x 3 séries"] },
      { title: "Cooldown", duration_min: 4, items: ["Respiration", "Stretching"] },
    ],
    created_at: nowISO(),
    source: "seed",
  };

  const { error } = await APP.sb.from("workouts").insert({
    user_id: APP.user.id,
    is_public: true,
    title: example.title,
    intensity: example.intensity,
    notes: example.notes,
    plan_json: example,
  });

  if (error) throw error;

  toast("Séance exemple publiée.", "info");
  await refreshFeed();
  await refreshDash();
  await refreshTrophies();
} catch (e) {
  toast(`Seed: ${e.message || e}`, "error");
} finally {
  setBusy("seed", false);
}
}

// -----------------------------
// Dash (minimal)
// -----------------------------
async function refreshDash() {
renderKPIs();
refreshMorningBrief();

const recentEl = $id("recentWorkouts");
const heatEl = $id("activityHeatmap");

if (!APP.user) {
  if (recentEl) safeHTML(recentEl, `<div class="empty">Connecte-toi pour voir tes séances.</div>`);
  if (heatEl) safeHTML(heatEl, "");
  safeText($id("stat-workouts"), "0");
  safeText($id("stat-volume"), "0");
  safeText($id("stat-workouts-trend"), "→ +0%");
  renderChart([], []);
  return;
}

try {
  const since28 = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString();

  const { data, error } = await APP.sb
    .from("workouts")
    .select("id,created_at,title,plan_json")
    .eq("user_id", APP.user.id)
    .gte("created_at", since28)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  safeText($id("stat-workouts"), String(rows.length));
  safeText($id("stat-volume"), String(rows.length));
  safeText($id("stat-workouts-trend"), "→ +0%");

  if (recentEl) {
    const recent = rows.slice(0, 5);
    safeHTML(
      recentEl,
      recent.length
        ? recent
            .map((r) => `
              <div class="feedCard">
                <div class="feedHeader">
                  <div class="feedUser">${esc(r.title || "Séance")}</div>
                  <div class="feedTime">${esc(fmtDate(r.created_at))}</div>
                </div>
              </div>
            `)
            .join("")
        : `<div class="empty">Aucune séance.</div>`
    );
  }

  if (heatEl) {
    const setDays = new Set(rows.map((r) => String(r.created_at || "").slice(0, 10)));
    const days = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, active: setDays.has(key), label: String(d.getDate()) });
    }
    safeHTML(
      heatEl,
      days.map((d) => `<div class="heatmapDay ${d.active ? "active" : ""}" title="${esc(d.key)}">${esc(d.label)}</div>`).join("")
    );
  }

  renderChart([], []);
} catch (e) {
  toast(`Dash: ${e.message || e}`, "error");
}
}

function renderChart(labels, values) {
const canvas = $id("chartVolume");
if (!canvas) return;

const ChartLib = window.Chart;
if (!ChartLib) return;

try {
  if (APP.chart) {
    APP.chart.data.labels = labels;
    APP.chart.data.datasets[0].data = values;
    APP.chart.update();
    return;
  }

  APP.chart = new ChartLib(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets: [{ label: "Volume", data: values }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
} catch {}
}

// -----------------------------
// Body Scan
// -----------------------------
async function actionUploadBodyScan() {
if (!APP.user) return toast("Connecte-toi pour uploader.", "error");

const fileEl = $id("bodyScanFile");
const file = fileEl?.files?.[0] || null;
if (!file) return toast("Choisis un fichier.", "error");

const btn = $id("btnUploadBodyScan");
if (isBusy("uploadScan")) return;

setBusy("uploadScan", true);
disable(btn, true);

try {
  const path = `${APP.user.id}/bodyscans/${Date.now()}_${safeName(file.name)}`;

  const { error: upErr } = await APP.sb.storage
    .from("user_uploads")
    .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });

  if (upErr) throw upErr;

  try {
    const { error: dbErr } = await APP.sb.from("body_scans").insert({
      user_id: APP.user.id,
      file_path: path,
      meta: { original_name: file.name, content_type: file.type || null, size: file.size || null },
    });

    if (dbErr && String(dbErr.code) !== "42P01") throw dbErr;
  } catch (e) {
    toast(`Upload OK mais tracking DB KO: ${e.message || e}`, "error");
  }

  toast("Upload OK.", "info");
  if (fileEl) fileEl.value = "";
  await refreshBodyScans();
} catch (e) {
  toast(`Upload: ${e.message || e}`, "error");
} finally {
  disable(btn, false);
  setBusy("uploadScan", false);
}
}

async function refreshBodyScans() {
const box = $id("bodyScansList");
if (!box) return;

if (!APP.user) {
  safeHTML(box, `<div class="empty">Connecte-toi pour voir tes fichiers.</div>`);
  return;
}

safeHTML(box, `<div class="row" style="gap:10px"><div class="spinner"></div><div class="muted">Chargement…</div></div>`);

try {
  const { data, error } = await APP.sb
    .from("body_scans")
    .select("id,file_path,created_at,meta")
    .eq("user_id", APP.user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (String(error.code) === "42P01") {
      safeHTML(box, `<div class="empty">Historique désactivé (table body_scans absente). Upload fonctionne quand même.</div>`);
      return;
    }
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) {
    safeHTML(box, `<div class="empty">Aucun fichier.</div>`);
    return;
  }

  const parts = [];
  for (const r of rows) {
    const { data: signed, error: sErr } = await APP.sb.storage
      .from("user_uploads")
      .createSignedUrl(r.file_path, 60 * 30);

    const url = !sErr && signed?.signedUrl ? signed.signedUrl : null;
    const name = esc(r.meta?.original_name || r.file_path);
    const when = esc(fmtDate(r.created_at));

    parts.push(`
      <div class="feedCard">
        <div class="feedHeader">
          <div class="feedUser">${name}</div>
          <div class="feedTime">${when}</div>
        </div>
        <div class="row" style="margin-top:10px; gap:10px">
          ${url ? `<a class="btn" href="${url}" target="_blank" rel="noreferrer">Ouvrir (signed)</a>` : `<span class="badge red">Signed URL failed</span>`}
        </div>
      </div>
    `);
  }

  safeHTML(box, parts.join(""));
} catch (e) {
  safeHTML(box, `<div class="empty">Erreur: ${esc(e.message || e)}</div>`);
}
}

// -----------------------------
// Trophies (EXISTS, not ghost)
// -----------------------------
async function refreshTrophies() {
const wall = $id("trophyWall");
const hint = $id("trophyHint");
if (!wall || !hint) return;

if (!APP.user) {
  hint.textContent = "Connecte-toi pour débloquer des trophées.";
  safeHTML(wall, `<div class="empty">Non connecté.</div>`);
  return;
}

let workoutCount = 0;
let kudosGiven = 0;
let hasName = false;

try {
  const { data: prof } = await APP.sb
    .from("public_profiles")
    .select("display_name")
    .eq("user_id", APP.user.id)
    .maybeSingle();
  hasName = !!(prof?.display_name || "").trim();

  const { count: wc } = await APP.sb
    .from("workouts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", APP.user.id);
  workoutCount = Number(wc || 0);

  const { count: kc } = await APP.sb
    .from("kudos")
    .select("id", { count: "exact", head: true })
    .eq("user_id", APP.user.id);
  kudosGiven = Number(kc || 0);
} catch {}

const trophies = [
  { title: "Identité", desc: "Ajouter un nom public", unlocked: hasName, meta: hasName ? "OK" : "À faire" },
  { title: "Premier workout", desc: "Publier une première séance", unlocked: workoutCount >= 1, meta: `${workoutCount}/1` },
  { title: "Régularité", desc: "Faire 5 séances", unlocked: workoutCount >= 5, meta: `${workoutCount}/5` },
  { title: "Supporter", desc: "Donner 1 kudos", unlocked: kudosGiven >= 1, meta: `${kudosGiven}/1` },
];

const unlockedCount = trophies.filter((t) => t.unlocked).length;
hint.textContent = `${unlockedCount}/${trophies.length} trophées débloqués.`;

safeHTML(
  wall,
  trophies
    .map((t) => {
      const cls = t.unlocked ? "trophyCard unlocked" : "trophyCard locked";
      return `
        <div class="${cls}">
          <div class="trophyIcon">${t.unlocked ? "🏆" : "🔒"}</div>
          <div class="trophyInfo">
            <div class="trophyTitle">${esc(t.title)}</div>
            <div class="trophyDesc">${esc(t.desc)}</div>
            <div class="trophyMeta">${esc(t.meta)}</div>
          </div>
        </div>
      `;
    })
    .join("")
);
}

// -----------------------------
// Bind events
// -----------------------------
function bindEvents() {
const bind = (id, fn) => {
const el = $id(id);
if (!el || el._fitaiBound) return;
el.addEventListener("click", (e) => {
e.preventDefault();
fn();
});
el._fitaiBound = true;
};

bind("btnMagicLink", actionMagicLink);
bind("btnLogout", actionLogout);

bind("btnCoachAsk", actionCoachAsk);
bind("btnRefreshFeed", refreshFeed);

bind("btnSaveName", actionSaveName);
bind("btnSaveEquipment", actionSaveEquipment);
bind("btnRefreshTrophies", refreshTrophies);

bind("btnAddMeal", () => openMealModal(true));
bind("btnCancelMeal", () => openMealModal(false));
bind("btnSaveMeal", actionSaveMeal);

bind("btnUploadBodyScan", actionUploadBodyScan);
bind("btnRefreshBodyScans", refreshBodyScans);

document.addEventListener("click", (e) => {
  const k = e.target?.closest?.("[data-kpi][data-dir]");
  if (!k) return;
  e.preventDefault();
  onKpiClick(k);
});

document.addEventListener("click", (e) => {
  const el = e.target?.closest?.("[data-action]");
  if (!el) return;

  const act = el.getAttribute("data-action");
  if (!act) return;

  e.preventDefault();

  if (act === "publish-plan") {
    const pub = el.getAttribute("data-public");
    return actionPublishPlan(pub === "1");
  }
  if (act === "copy-plan") return actionCopyPlan();

  if (act === "toggle-kudos") {
    const id = el.getAttribute("data-id");
    return toggleKudos(id);
  }

  if (act === "seed-example") return seedExampleWorkout();

  if (act === "delete-meal") {
    const idx = el.getAttribute("data-index");
    return actionDeleteMeal(idx);
  }
});

const mealModal = $id("mealModal");
if (mealModal && !mealModal._fitaiBound) {
  mealModal.addEventListener("click", (e) => {
    if (e.target === mealModal) openMealModal(false);
  });
  mealModal._fitaiBound = true;
}
}

// -----------------------------
// Boot
// -----------------------------
async function boot() {
try {
ensureBodyScanTab();
bindTabs();
bindEvents();

  setActiveTab("tabBtnDash");

  await loadConfigAndInitSupabase();
  await bootstrapSession();

  renderAuth();
  applyEquipmentToUI();
  renderKPIs();
  refreshMorningBrief();
  renderNutrition();

  await refreshProfileHint();
  await refreshDash();
  await refreshFeed();
  await refreshBodyScans();
  await refreshTrophies();

  toast("App ready.", "info");
} catch (e) {
  toast(`BOOT FAILED: ${e.message || e}`, "error");
  show($id("btnLogout"), false);
}
}

if (document.readyState === "loading") {
document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
boot();
}

window.addEventListener("error", (evt) => {
const msg = evt?.message || "JS error";
toast(`JS error: ${msg}`, "error");
});

window.addEventListener("unhandledrejection", (evt) => {
const msg = evt?.reason?.message || String(evt?.reason || "Promise error");
toast(`Promise: ${msg}`, "error");
});
})();
