"use strict";

let SB = null;
let U = null;
let MODE = "login";
let PLAN = null;
let FILE = null;
const LIKED = new Set(JSON.parse(localStorage.getItem("fp_likes") || "[]"));
const ASYNC_LOCKS = new Set();

const GOAL_LABELS = {
  prise_de_masse: "💪 Prise de masse",
  perte_de_poids: "🔥 Perte de poids",
  endurance: "🏃 Endurance",
  force: "🏋️ Force",
  remise_en_forme: "🌟 Remise en forme",
  maintien: "⚖️ Maintien"
};

async function boot() {
  bootMsg("Chargement du SDK…");
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
  } catch {
    return bootError("Impossible de charger le SDK Supabase.");
  }

  bootMsg("Récupération de la configuration…");
  let cfg;
  try {
    const r = await fetch("/api/config", { headers: { Accept: "application/json" } });
    cfg = await r.json();
    if (!r.ok || !cfg.ok) throw new Error(cfg.error || `HTTP ${r.status}`);
  } catch (e) {
    return bootError(`Config API invalide: ${e.message}`);
  }

  bootMsg("Initialisation Supabase…");
  SB = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  SB.auth.onAuthStateChange((_, session) => {
    if (session?.user) {
      U = session.user;
      showApp();
    } else {
      U = null;
      showAuth();
    }
  });

  const { data: { session } } = await SB.auth.getSession();
  hideBoot();
  if (session?.user) {
    U = session.user;
    showApp();
  } else {
    showAuth();
  }
}

function bootMsg(message) {
  document.getElementById("boot-msg").textContent = message;
}

function bootError(message) {
  document.getElementById("boot-sp").style.display = "none";
  document.getElementById("boot-msg").style.display = "none";
  const err = document.getElementById("boot-err");
  err.style.display = "block";
  err.textContent = message;
}

function hideBoot() {
  const bootEl = document.getElementById("boot");
  bootEl.classList.add("hidden");
  setTimeout(() => { bootEl.style.display = "none"; }, 450);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Échec script ${src}`));
    document.head.appendChild(script);
  });
}

function showAuth() {
  document.getElementById("auth").style.display = "flex";
  document.getElementById("app").classList.remove("on");
}

function showApp() {
  document.getElementById("auth").style.display = "none";
  document.getElementById("app").classList.add("on");
  document.getElementById("tu").textContent = U.email || "Membre";
  gotoTab("dashboard");
}

function authMode(mode) {
  MODE = mode;
  document.getElementById("atab-login").classList.toggle("on", mode === "login");
  document.getElementById("atab-signup").classList.toggle("on", mode === "signup");
  document.getElementById("auth-btn").textContent = mode === "login" ? "Se connecter" : "S'inscrire";
  setAuthMessage("", "");
}

function setAuthMessage(text, cls) {
  const el = document.getElementById("auth-msg");
  el.textContent = text;
  el.className = `auth-msg ${cls ? `auth-${cls}` : ""}`;
}

async function doAuth() {
  const email = document.getElementById("a-email").value.trim();
  const password = document.getElementById("a-pwd").value;
  if (!email || !password) return setAuthMessage("Email et mot de passe requis.", "err");

  const btn = document.getElementById("auth-btn");
  withButton(btn, MODE === "login" ? "Connexion…" : "Inscription…", async () => {
    setAuthMessage("", "");
    let error;
    if (MODE === "login") {
      ({ error } = await SB.auth.signInWithPassword({ email, password }));
    } else {
      ({ error } = await SB.auth.signUp({ email, password }));
      if (!error) setAuthMessage("Compte créé ! Vérifiez vos emails.", "ok");
    }
    if (error) throw error;
  }).catch((e) => setAuthMessage(e.message || "Erreur d'authentification.", "err"));
}

async function doLogout() {
  await SB.auth.signOut();
}

function gotoTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("on"));
  document.querySelectorAll(".bnav-btn").forEach((btn) => btn.classList.remove("on"));
  document.getElementById(`t-${name}`)?.classList.add("on");
  document.getElementById(`n-${name}`)?.classList.add("on");
  document.getElementById("scroll").scrollTop = 0;

  if (name === "dashboard") loadDashboard();
  if (name === "goal") loadGoal();
  if (name === "coach") loadHistory();
  if (name === "nutrition") loadMeals();
  if (name === "community") loadFeed();
  if (name === "bodyscan") loadScans();
  if (name === "profile") {
    loadProfile();
    loadStats();
  }
}

async function loadDashboard() {
  showGlobalLoader(true, "Chargement du dashboard…");
  await Promise.all([loadGoal(), loadMeals(), loadStats(), loadNutritionTargets()]);
  showGlobalLoader(false);
}

async function loadGoal() {
  try {
    const { data } = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    document.getElementById("goal-form").style.display = data ? "none" : "block";
    document.getElementById("goal-view").style.display = data ? "block" : "none";
    if (!data) return;

    document.getElementById("g-type").value = data.type || "";
    document.getElementById("g-level").value = data.level || "";
    document.getElementById("g-text").value = data.text || "";
    document.getElementById("g-constraints").value = data.constraints || "";

    const lines = [
      ["Type", GOAL_LABELS[data.type] || data.type || "—"],
      ["Niveau", data.level || "—"],
      ["Objectif", data.text || "—"],
      ["Contraintes", data.constraints || "Aucune"]
    ];
    document.getElementById("goal-view-body").innerHTML = lines
      .map(([k, v]) => `<div class="goal-saved-row"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`)
      .join("");
  } catch (e) {
    toast(`Erreur objectif: ${e.message}`, "err");
  }
}

function goalEdit() {
  document.getElementById("goal-view").style.display = "none";
  document.getElementById("goal-form").style.display = "block";
}

async function saveGoal() {
  const payload = {
    user_id: U.id,
    type: document.getElementById("g-type").value,
    level: document.getElementById("g-level").value,
    text: document.getElementById("g-text").value.trim(),
    constraints: document.getElementById("g-constraints").value.trim(),
    updated_at: new Date().toISOString()
  };

  const btn = document.getElementById("btn-save-goal");
  await withButton(btn, "Enregistrement…", async () => {
    const { error } = await SB.from("goals").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    toast("Objectif enregistré ✓", "ok");
    await loadGoal();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function generateWorkout() {
  const prompt = document.getElementById("coach-input").value.trim();
  const errorEl = document.getElementById("coach-err");
  errorEl.style.display = "none";
  if (!prompt) {
    errorEl.textContent = "Décrivez la séance souhaitée.";
    errorEl.style.display = "block";
    return;
  }

  const btn = document.getElementById("btn-gen");
  await withButton(btn, "Génération…", async () => {
    const token = await getToken();
    const r = await fetch("/api/workout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt })
    });
    const j = await safeResponseJson(r);
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    PLAN = j.data;
    renderPlan(PLAN);
  }).catch((e) => {
    errorEl.textContent = `Erreur: ${e.message}`;
    errorEl.style.display = "block";
  });
}

function renderPlan(plan) {
  const head = document.getElementById("plan-head");
  const notes = document.getElementById("plan-notes");
  const blocks = document.getElementById("plan-blocks");

  head.innerHTML = `<div><div class="plan-title-text">${escapeHtml(plan.title || "Séance")}</div><div class="page-sub">${escapeHtml(plan.intensity || "medium")} · ${plan.duration || "?"} min</div></div>`;
  notes.textContent = plan.notes || "";
  notes.style.display = plan.notes ? "block" : "none";
  blocks.innerHTML = (plan.blocks || []).map((b) => `
    <div class="block">
      <div class="block-head">
        <span class="block-name">${escapeHtml(b.title)}</span>
        <span class="bdur">⏱ ${formatDuration(b.duration_sec)}</span>
      </div>
      <ul class="block-items">${(b.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join("")}</ul>
    </div>
  `).join("");

  document.getElementById("plan-card").style.display = "block";
}

async function saveSession() {
  if (!PLAN) return toast("Générez d'abord une séance.", "err");
  await guarded("save-session", async () => {
    const { error } = await SB.from("workout_sessions").insert({ user_id: U.id, plan: PLAN });
    if (error) throw error;
    toast("Séance sauvegardée ✓", "ok");
    await loadHistory();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadHistory() {
  const el = document.getElementById("history-list");
  try {
    const { data, error } = await SB.from("workout_sessions")
      .select("id,created_at,plan")
      .eq("user_id", U.id)
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">📋</span>Aucune séance sauvegardée</div>';
      return;
    }
    el.innerHTML = `<div class="sessions-list">${data.map((s) => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR");
      return `<div class="sess-row"><div><strong>${escapeHtml(s.plan?.title || "Séance")}</strong><div class="meal-info">${d}</div></div></div>`;
    }).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function addMeal() {
  const name = document.getElementById("n-name").value.trim();
  if (!name) return toast("Nom du repas requis.", "err");

  const payload = {
    user_id: U.id,
    name,
    calories: toInt("n-kcal"),
    protein: toInt("n-prot"),
    carbs: toInt("n-carb"),
    fat: toInt("n-fat"),
    date: new Date().toISOString().slice(0, 10)
  };

  const btn = document.getElementById("btn-meal");
  await withButton(btn, "Ajout…", async () => {
    const { error } = await SB.from("meals").insert(payload);
    if (error) throw error;
    ["n-name", "n-kcal", "n-prot", "n-carb", "n-fat"].forEach((id) => { document.getElementById(id).value = ""; });
    toast("Repas ajouté ✓", "ok");
    await loadMeals();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function deleteMeal(id) {
  await guarded(`meal-${id}`, async () => {
    const { error } = await SB.from("meals").delete().eq("id", id).eq("user_id", U.id);
    if (error) throw error;
    await loadMeals();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadMeals() {
  const today = new Date().toISOString().slice(0, 10);
  const el = document.getElementById("meals-list");
  try {
    const { data, error } = await SB.from("meals").select("*").eq("user_id", U.id).eq("date", today).order("created_at");
    if (error) throw error;

    const totals = (data || []).reduce((acc, m) => ({
      kcal: acc.kcal + (m.calories || 0),
      protein: acc.protein + (m.protein || 0),
      carbs: acc.carbs + (m.carbs || 0),
      fat: acc.fat + (m.fat || 0)
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

    document.getElementById("m-kcal").textContent = String(totals.kcal);
    const dbKcal = document.getElementById("db-kcal");
    if (dbKcal) dbKcal.textContent = String(totals.kcal);
    document.getElementById("m-prot").textContent = `${totals.protein}g`;
    document.getElementById("m-carb").textContent = `${totals.carbs}g`;
    document.getElementById("m-fat").textContent = `${totals.fat}g`;

    await renderNutritionProgress(totals);

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">🍽️</span>Aucun repas aujourd\'hui</div>';
      return;
    }

    el.innerHTML = data.map((meal) => `
      <div class="meal-row">
        <div class="meal-name">${escapeHtml(meal.name)}</div>
        <div class="meal-info">P:${meal.protein || 0}g · G:${meal.carbs || 0}g · L:${meal.fat || 0}g</div>
        <div class="meal-kcal">${meal.calories || 0} kcal</div>
        <button class="btn btn-g btn-sm" onclick="deleteMeal('${meal.id}')">🗑️</button>
      </div>
    `).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function createPost() {
  const content = document.getElementById("post-input").value.trim();
  if (!content) return toast("Écrivez un message.", "err");
  const btn = document.getElementById("btn-post");
  await withButton(btn, "Publication…", async () => {
    const { error } = await SB.from("community_posts").insert({ user_id: U.id, content, kudos: 0 });
    if (error) throw error;
    document.getElementById("post-input").value = "";
    await loadFeed();
    toast("Publié ✓", "ok");
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function giveKudos(postId, count) {
  if (LIKED.has(postId)) return toast("Déjà kudosé.", "err");
  await guarded(`kudos-${postId}`, async () => {
    const { error } = await SB.from("community_posts").update({ kudos: (count || 0) + 1 }).eq("id", postId);
    if (error) throw error;
    LIKED.add(postId);
    localStorage.setItem("fp_likes", JSON.stringify([...LIKED]));
    await loadFeed();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function deletePost(postId) {
  await guarded(`post-${postId}`, async () => {
    const { error } = await SB.from("community_posts").delete().eq("id", postId).eq("user_id", U.id);
    if (error) throw error;
    await loadFeed();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadFeed() {
  const el = document.getElementById("feed");
  try {
    const { data, error } = await SB.from("community_posts")
      .select("id,user_id,content,kudos,created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Soyez le premier à publier !</div>';
      return;
    }

    el.innerHTML = data.map((post) => {
      const me = post.user_id === U.id;
      const liked = LIKED.has(post.id);
      const date = new Date(post.created_at).toLocaleString("fr-FR");
      return `
        <div class="post">
          <div class="post-head">
            <div class="post-author">${me ? "Vous 👤" : "Membre 💪"}</div>
            <div class="post-date">${date}</div>
          </div>
          <div class="post-body">${escapeHtml(post.content)}</div>
          <div class="post-footer">
            <button class="kudos-btn ${liked ? "on" : ""}" onclick="giveKudos('${post.id}', ${post.kudos || 0})">👊 ${post.kudos || 0}</button>
            ${me ? `<button class="btn btn-g btn-sm" onclick="deletePost('${post.id}')">🗑️</button>` : ""}
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

function handleDrop(event) {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}

function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Format image requis.", "err");
  if (file.size > 6 * 1024 * 1024) return toast("Fichier trop volumineux (max 6MB).", "err");
  FILE = file;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById("scan-img").src = reader.result;
    document.getElementById("scan-preview").style.display = "flex";
  };
  reader.readAsDataURL(file);
}

async function doScan() {
  if (!FILE) return toast("Sélectionnez une image.", "err");
  const btn = document.getElementById("btn-scan");
  const errEl = document.getElementById("scan-err");
  errEl.style.display = "none";

  await withButton(btn, "Analyse…", async () => {
    const ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${U.id}/bodyscans/${Date.now()}.${ext}`;
    const token = await getToken();

    const upload = await SB.storage.from("user_uploads").upload(path, FILE, { contentType: FILE.type });
    if (upload.error) throw upload.error;

    const ins = await SB.from("body_scans").insert({ user_id: U.id, image_path: path });
    if (ins.error) throw ins.error;

    const r = await fetch("/api/bodyscan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_id: U.id, image_path: path })
    });
    const j = await safeResponseJson(r);
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);

    FILE = null;
    document.getElementById("file-input").value = "";
    document.getElementById("scan-preview").style.display = "none";
    toast("Analyse terminée ✓", "ok");
    await loadScans();
  }).catch((e) => {
    errEl.textContent = `Erreur: ${e.message}`;
    errEl.style.display = "block";
  });
}

async function loadScans() {
  const el = document.getElementById("scans-list");
  try {
    const { data, error } = await SB.from("body_scans").select("*").eq("user_id", U.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">🔬</span>Aucune analyse</div>';
      return;
    }

    el.innerHTML = data.map((scan) => {
      const done = Boolean(scan.ai_feedback);
      return `
        <div class="scan-card">
          <div class="post-head"><strong>${new Date(scan.created_at).toLocaleDateString("fr-FR")}</strong><span class="badge ${done ? "bg-green" : "bg-orange"}">${done ? "Analysé" : "En attente"}</span></div>
          ${done ? `
            <div class="scores-row">
              <div class="score-chip"><div class="score-v">${scan.symmetry_score ?? "—"}</div><div class="score-l">Symétrie</div></div>
              <div class="score-chip"><div class="score-v">${scan.posture_score ?? "—"}</div><div class="score-l">Posture</div></div>
              <div class="score-chip"><div class="score-v">${scan.bodyfat_proxy ?? "—"}</div><div class="score-l">Bodyfat</div></div>
            </div>
            <div class="scan-feedback">${escapeHtml(scan.ai_feedback || "")}</div>
          ` : '<div class="meal-info">Analyse en cours…</div>'}
        </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadProfile() {
  try {
    const { data } = await SB.from("profiles").select("display_name").eq("id", U.id).maybeSingle();
    const name = data?.display_name || U.email?.split("@")[0] || "Membre";
    document.getElementById("p-name").textContent = name;
    document.getElementById("p-email").textContent = U.email || "";
    document.getElementById("p-avatar").textContent = name.charAt(0).toUpperCase();
    document.getElementById("p-pseudo").value = data?.display_name || "";
    document.getElementById("tu").textContent = name;
  } catch {}
}

async function saveProfile() {
  const display_name = document.getElementById("p-pseudo").value.trim();
  if (!display_name) return toast("Pseudo requis.", "err");
  const btn = document.getElementById("btn-save-profile");
  await withButton(btn, "Enregistrement…", async () => {
    const { error } = await SB.from("profiles").upsert({ id: U.id, display_name, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw error;
    toast("Profil mis à jour ✓", "ok");
    await loadProfile();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadStats() {
  const [sessions, scans, posts] = await Promise.all([
    SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
    SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
    SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id)
  ]);
  document.getElementById("st-sess").textContent = sessions.count ?? "0";
  document.getElementById("st-scans").textContent = scans.count ?? "0";
  document.getElementById("st-posts").textContent = posts.count ?? "0";
  const dbSess = document.getElementById("db-sess");
  if (dbSess) dbSess.textContent = sessions.count ?? "0";
  const totalSess = document.getElementById("db-total-sessions");
  if (totalSess) totalSess.textContent = sessions.count ?? "0";
  document.getElementById("d-stats").innerHTML = `
    <div class="stat"><div class="stat-v">${sessions.count ?? 0}</div><div class="stat-l">Séances</div></div>
    <div class="stat"><div class="stat-v">${scans.count ?? 0}</div><div class="stat-l">Scans</div></div>
    <div class="stat"><div class="stat-v">${posts.count ?? 0}</div><div class="stat-l">Posts</div></div>`;
}

async function loadNutritionTargets() {
  const { data } = await SB.from("nutrition_targets").select("calories,protein,carbs,fats").eq("user_id", U.id).maybeSingle();
  const target = data || { calories: 2200, protein: 140, carbs: 260, fats: 70 };
  document.getElementById("target-kcal").textContent = String(target.calories);
  document.getElementById("target-prot").textContent = `${target.protein}g`;
  document.getElementById("target-carb").textContent = `${target.carbs}g`;
  document.getElementById("target-fat").textContent = `${target.fats}g`;
}

async function renderNutritionProgress(totals) {
  const { data } = await SB.from("nutrition_targets").select("calories").eq("user_id", U.id).maybeSingle();
  const targetKcal = data?.calories || 2200;
  const pct = Math.max(0, Math.min(100, Math.round((totals.kcal / targetKcal) * 100)));
  document.getElementById("cal-progress-fill").style.width = `${pct}%`;
  document.getElementById("cal-progress-text").textContent = `${totals.kcal} / ${targetKcal} kcal`;
}

function showGlobalLoader(show, text = "Chargement…") {
  const loader = document.getElementById("global-loader");
  if (!loader) return;
  loader.style.display = show ? "flex" : "none";
  loader.querySelector(".boot-msg").textContent = text;
}

async function getToken() {
  const { data } = await SB.auth.getSession();
  return data.session?.access_token || "";
}

function toInt(id) {
  return parseInt(document.getElementById(id).value, 10) || 0;
}

function formatDuration(seconds) {
  const m = Math.round((seconds || 0) / 60);
  return `${m} min`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer;
function toast(message, cls = "ok") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `on ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "";
  }, 3000);
}

async function withButton(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function guarded(key, fn) {
  if (ASYNC_LOCKS.has(key)) return;
  ASYNC_LOCKS.add(key);
  try {
    return await fn();
  } finally {
    ASYNC_LOCKS.delete(key);
  }
}

async function safeResponseJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: text || "Réponse invalide" }; }
}

boot();

window.authTab = authMode;
window.gotoTab = gotoTab;
window.doAuth = doAuth;
window.doLogout = doLogout;
window.goalEdit = goalEdit;
window.saveGoal = saveGoal;
window.generateWorkout = generateWorkout;
window.saveSession = saveSession;
window.addMeal = addMeal;
window.deleteMeal = deleteMeal;
window.createPost = createPost;
window.loadFeed = loadFeed;
window.giveKudos = giveKudos;
window.deletePost = deletePost;
window.handleDrop = handleDrop;
window.handleFile = handleFile;
window.doScan = doScan;
window.saveProfile = saveProfile;
