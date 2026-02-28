// app.js — FitAI Pro v3.4.0 — tous les onglets réels
"use strict";

/* ─────────── ÉTAT GLOBAL ─────────── */
let SB = null;        // client Supabase
let USER = null;      // utilisateur connecté
let AUTH_MODE = "login";
let CURRENT_PLAN = null;
let PENDING_FILE = null;
let LIKED = new Set(JSON.parse(localStorage.getItem("fap_likes") || "[]"));

const API_CONFIG   = "/api/config";
const API_WORKOUT  = "/api/workout";
const API_BODYSCAN = "/api/bodyscan";
const BUCKET       = "user_uploads";

/* ─────────── BOOT ─────────── */
async function boot() {
  setBootMsg("Chargement…");

  // 1. Charger le SDK Supabase
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
  } catch (e) {
    return bootFail("Impossible de charger Supabase SDK. Vérifiez votre connexion internet.");
  }

  // 2. Récupérer la config depuis l'API (doit retourner JSON)
  setBootMsg("Connexion au serveur…");
  let cfg;
  try {
    const r = await fetch(API_CONFIG, {
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" }
    });

    // Vérifier que c'est bien du JSON et pas du HTML
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      const txt = await r.text();
      console.error("[boot] Réponse non-JSON:", txt.slice(0, 200));
      return bootFail(
        `L'endpoint /api/config retourne du HTML au lieu de JSON (HTTP ${r.status}).\n\n` +
        `Causes possibles :\n` +
        `• api/config.js n'est pas dans votre repo git\n` +
        `• Vercel n'a pas reçu ce fichier (vérifiez git status)\n` +
        `• Les variables d'env ne sont pas configurées dans Vercel Dashboard`
      );
    }

    cfg = await r.json();
    if (!r.ok || !cfg.ok) {
      return bootFail(`Erreur config (${r.status}): ${cfg.detail || cfg.error || "inconnue"}\n\n${cfg.fix || ""}`);
    }
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      return bootFail("Variables SUPABASE_URL / SUPABASE_ANON_KEY absentes dans Vercel.\nAllez dans Vercel Dashboard → Settings → Environment Variables.");
    }
  } catch (e) {
    return bootFail(`Erreur réseau: ${e.message}`);
  }

  // 3. Init Supabase
  setBootMsg("Connexion Supabase…");
  try {
    SB = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (e) {
    return bootFail(`Init Supabase échouée: ${e.message}`);
  }

  // 4. Écouter les changements auth
  SB.auth.onAuthStateChange((_ev, sess) => {
    if (sess?.user) { USER = sess.user; showApp(); }
    else { USER = null; showAuth(); }
  });

  // 5. Vérifier session existante
  const { data: { session } } = await SB.auth.getSession();
  hideBoot();
  if (session?.user) { USER = session.user; showApp(); }
  else { showAuth(); }
}

function setBootMsg(msg) { document.getElementById("boot-msg").textContent = msg; }

function bootFail(msg) {
  document.getElementById("boot-msg").style.display = "none";
  document.querySelector("#boot .spinner").style.display = "none";
  const el = document.getElementById("boot-err");
  el.style.display = "block";
  el.textContent = msg;
  console.error("[boot] FAIL:", msg);
}

function hideBoot() {
  const b = document.getElementById("boot");
  b.classList.add("hidden");
  setTimeout(() => { b.style.display = "none"; }, 400);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = res;
    s.onerror = () => rej(new Error(`Impossible de charger: ${src}`));
    document.head.appendChild(s);
  });
}

/* ─────────── AUTH ─────────── */
function showAuth() {
  document.getElementById("auth").style.display = "flex";
  document.getElementById("app").classList.remove("on");
}

function showApp() {
  document.getElementById("auth").style.display = "none";
  document.getElementById("app").classList.add("on");
  document.getElementById("tu").textContent = USER.email || "";
  // Init données
  loadGoal();
  loadHistory();
  loadMeals();
  loadFeed();
  loadScans();
  loadProfile();
  loadStats();
}

function authTab(mode) {
  AUTH_MODE = mode;
  document.getElementById("atab-login").classList.toggle("on", mode === "login");
  document.getElementById("atab-signup").classList.toggle("on", mode === "signup");
  document.getElementById("auth-btn").textContent = mode === "login" ? "Se connecter" : "S'inscrire";
  setAuthMsg("", "");
}

function setAuthMsg(msg, cls) {
  const el = document.getElementById("auth-msg");
  el.textContent = msg;
  el.className = `auth-msg ${cls}`;
}

async function doAuth() {
  const email = document.getElementById("a-email").value.trim();
  const pwd = document.getElementById("a-pwd").value;
  if (!email || !pwd) return setAuthMsg("Email et mot de passe requis.", "auth-err");

  const btn = document.getElementById("auth-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span>';
  setAuthMsg("", "");

  try {
    let err;
    if (AUTH_MODE === "login") {
      ({ error: err } = await SB.auth.signInWithPassword({ email, password: pwd }));
    } else {
      ({ error: err } = await SB.auth.signUp({ email, password: pwd }));
      if (!err) return setAuthMsg("Compte créé ! Vérifiez votre email si la confirmation est requise.", "auth-ok");
    }
    if (err) throw err;
  } catch (e) {
    setAuthMsg(e.message || "Erreur d'authentification.", "auth-err");
  } finally {
    btn.disabled = false;
    btn.textContent = AUTH_MODE === "login" ? "Se connecter" : "S'inscrire";
  }
}

async function doLogout() {
  await SB.auth.signOut();
  USER = null; CURRENT_PLAN = null; PENDING_FILE = null;
}

/* ─────────── NAVIGATION ─────────── */
function gotoTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  document.querySelectorAll(".bnav-btn").forEach(b => b.classList.remove("on"));
  document.getElementById(`t-${name}`)?.classList.add("on");
  document.getElementById(`n-${name}`)?.classList.add("on");
  document.getElementById("scroll").scrollTop = 0;
  if (name === "community") loadFeed();
  if (name === "nutrition") loadMeals();
  if (name === "coach") loadHistory();
  if (name === "bodyscan") loadScans();
  if (name === "profile") { loadProfile(); loadStats(); }
}

/* ─────────── GOAL ─────────── */
const GOAL_LABELS = {
  prise_de_masse:"💪 Prise de masse", perte_de_poids:"🔥 Perte de poids",
  endurance:"🏃 Endurance", force:"🏋️ Force",
  remise_en_forme:"🌟 Remise en forme", maintien:"⚖️ Maintien"
};

async function loadGoal() {
  try {
    const { data } = await SB.from("goals").select("*").eq("user_id", USER.id).maybeSingle();
    if (!data) return;
    document.getElementById("goal-form").style.display = "none";
    document.getElementById("goal-view").style.display = "block";
    // Pré-remplir le form aussi
    document.getElementById("g-type").value = data.type || "";
    document.getElementById("g-level").value = data.level || "";
    document.getElementById("g-text").value = data.text || "";
    document.getElementById("g-constraints").value = data.constraints || "";
    // Afficher la vue
    const rows = [
      ["Type", GOAL_LABELS[data.type] || data.type || "—"],
      ["Niveau", data.level || "—"],
      ["Objectif", data.text || "—"],
      data.constraints ? ["Contraintes", data.constraints] : null
    ].filter(Boolean);
    document.getElementById("goal-view-body").innerHTML = rows.map(([k,v]) =>
      `<div class="goal-saved-row"><strong>${k}</strong><span>${esc(v)}</span></div>`
    ).join("");
  } catch { /* pas d'objectif */ }
}

function goalEdit() {
  document.getElementById("goal-view").style.display = "none";
  document.getElementById("goal-form").style.display = "block";
}

async function saveGoal() {
  const type = document.getElementById("g-type").value;
  const level = document.getElementById("g-level").value;
  const text = document.getElementById("g-text").value.trim();
  const constraints = document.getElementById("g-constraints").value.trim();
  if (!type && !text) return toast("Remplissez au moins le type ou la description.", "err");

  const btn = document.getElementById("btn-save-goal");
  setBtnLoading(btn, "Enregistrement…");
  try {
    const { error } = await SB.from("goals").upsert(
      { user_id: USER.id, type, level, text, constraints },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    toast("Objectif enregistré ✓", "ok");
    loadGoal();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
  finally { resetBtn(btn, "💾 Enregistrer l'objectif"); }
}

/* ─────────── COACH ─────────── */
async function generateWorkout() {
  const prompt = document.getElementById("coach-input").value.trim();
  const errEl = document.getElementById("coach-err");
  errEl.style.display = "none";
  if (!prompt) { errEl.textContent = "Décrivez la séance souhaitée."; errEl.style.display = "block"; return; }

  const btn = document.getElementById("btn-gen");
  setBtnLoading(btn, "Génération en cours…");
  document.getElementById("plan-card").style.display = "none";

  // Contexte objectif
  let goalContext = null;
  try {
    const { data } = await SB.from("goals").select("*").eq("user_id", USER.id).maybeSingle();
    if (data) goalContext = { type: data.type, level: data.level, text: data.text, constraints: data.constraints };
  } catch {}

  try {
    const token = await getToken();
    const r = await fetch(API_WORKOUT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ prompt, goalContext })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || j.detail || `HTTP ${r.status}`);
    CURRENT_PLAN = j.data;
    renderPlan(j.data);
  } catch (e) {
    errEl.textContent = `Erreur: ${e.message}`;
    errEl.style.display = "block";
  } finally {
    resetBtn(btn, "✨ Générer ma séance");
  }
}

function renderPlan(plan) {
  const intBadge = { low:"bg-green", medium:"bg-purple", high:"bg-orange" }[plan.intensity] || "bg-purple";
  document.getElementById("plan-head").innerHTML = `
    <span class="plan-title-text">${esc(plan.title)}</span>
    <span class="badge ${intBadge}">${plan.intensity}</span>
  `;
  document.getElementById("plan-notes").textContent = plan.notes || "";
  document.getElementById("plan-blocks").innerHTML = plan.blocks.map(b => `
    <div class="block">
      <div class="block-head">
        <span class="block-name">${esc(b.title)}</span>
        <div class="block-meta">
          ${b.rpe ? `<span class="rpe">RPE ${esc(b.rpe)}</span>` : ""}
          <span class="bdur">⏱ ${fmtDur(b.duration_sec)}</span>
        </div>
      </div>
      <ul class="block-items">${(b.items||[]).map(i => `<li>${esc(i)}</li>`).join("")}</ul>
    </div>`).join("");
  document.getElementById("plan-card").style.display = "block";
}

async function saveSession() {
  if (!CURRENT_PLAN) return;
  try {
    const { error } = await SB.from("workout_sessions").insert({ user_id: USER.id, plan: CURRENT_PLAN });
    if (error) throw error;
    toast("Séance sauvegardée ✓", "ok");
    loadHistory();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
}

async function loadHistory() {
  const el = document.getElementById("history-list");
  try {
    const { data, error } = await SB.from("workout_sessions")
      .select("id, created_at, plan").eq("user_id", USER.id)
      .order("created_at", { ascending: false }).limit(8);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">📋</span>Aucune séance sauvegardée</div>';
      return;
    }
    el.innerHTML = `<div class="sessions-list">${data.map(s => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short" });
      const p = s.plan || {};
      const ib = { low:"bg-green", medium:"bg-purple", high:"bg-orange" }[p.intensity] || "bg-purple";
      return `<div class="sess-row">
        <div>
          <div style="font-weight:800;font-size:.88rem">${esc(p.title || "Séance")}</div>
          <div style="font-size:.73rem;color:var(--muted)">${d} · ${p.blocks?.length || 0} blocs</div>
        </div>
        <span class="badge ${ib}">${p.intensity || "medium"}</span>
      </div>`;
    }).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${esc(e.message)}</div>`;
  }
}

/* ─────────── NUTRITION ─────────── */
async function addMeal() {
  const name = document.getElementById("n-name").value.trim();
  if (!name) return toast("Donnez un nom au repas.", "err");

  const kcal = parseInt(document.getElementById("n-kcal").value) || 0;
  const prot = parseInt(document.getElementById("n-prot").value) || 0;
  const carb = parseInt(document.getElementById("n-carb").value) || 0;
  const fat  = parseInt(document.getElementById("n-fat").value)  || 0;

  const btn = document.getElementById("btn-meal");
  setBtnLoading(btn, "Ajout…");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await SB.from("meals").insert({
      user_id: USER.id, name, calories: kcal, protein: prot, carbs: carb, fat, date: today
    });
    if (error) throw error;
    ["n-name","n-kcal","n-prot","n-carb","n-fat"].forEach(id => document.getElementById(id).value = "");
    toast("Repas ajouté ✓", "ok");
    loadMeals();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
  finally { resetBtn(btn, "➕ Ajouter ce repas"); }
}

async function deleteMeal(id) {
  try {
    const { error } = await SB.from("meals").delete().eq("id", id).eq("user_id", USER.id);
    if (error) throw error;
    toast("Repas supprimé", "ok");
    loadMeals();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
}

async function loadMeals() {
  const el = document.getElementById("meals-list");
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await SB.from("meals")
      .select("*").eq("user_id", USER.id).eq("date", today).order("created_at");
    if (error) throw error;

    // Totaux
    const tot = (data || []).reduce((a, m) => ({
      kcal: a.kcal + (m.calories||0), prot: a.prot + (m.protein||0),
      carb: a.carb + (m.carbs||0), fat: a.fat + (m.fat||0)
    }), { kcal:0, prot:0, carb:0, fat:0 });
    document.getElementById("m-kcal").textContent = tot.kcal;
    document.getElementById("m-prot").textContent = tot.prot + "g";
    document.getElementById("m-carb").textContent = tot.carb + "g";
    document.getElementById("m-fat").textContent = tot.fat + "g";

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">🍽️</span>Aucun repas aujourd\'hui</div>';
      return;
    }
    el.innerHTML = `<div>${data.map(m => `
      <div class="meal-row">
        <div class="meal-name">${esc(m.name)}</div>
        <div class="meal-info">P:${m.protein}g G:${m.carbs}g L:${m.fat}g</div>
        <div class="meal-kcal">${m.calories} kcal</div>
        <button class="btn btn-d btn-sm" onclick="deleteMeal('${m.id}')">🗑️</button>
      </div>`).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${esc(e.message)}</div>`;
  }
}

/* ─────────── COMMUNITY ─────────── */
async function createPost() {
  const content = document.getElementById("post-input").value.trim();
  if (!content) return toast("Écrivez quelque chose.", "err");

  const btn = document.getElementById("btn-post");
  setBtnLoading(btn, "Publication…");
  try {
    const { error } = await SB.from("community_posts").insert({ user_id: USER.id, content, kudos: 0 });
    if (error) throw error;
    document.getElementById("post-input").value = "";
    toast("Publié ✓", "ok");
    loadFeed();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
  finally { resetBtn(btn, "📢 Publier"); }
}

async function giveKudos(postId, current) {
  if (LIKED.has(postId)) return toast("Déjà liké !", "err");
  try {
    const { error } = await SB.from("community_posts").update({ kudos: current + 1 }).eq("id", postId);
    if (error) throw error;
    LIKED.add(postId);
    localStorage.setItem("fap_likes", JSON.stringify([...LIKED]));
    toast("👊 Kudos envoyé !", "ok");
    loadFeed();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
}

async function deletePost(postId) {
  try {
    const { error } = await SB.from("community_posts").delete().eq("id", postId).eq("user_id", USER.id);
    if (error) throw error;
    toast("Post supprimé", "ok");
    loadFeed();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
}

async function loadFeed() {
  const el = document.getElementById("feed");
  try {
    const { data, error } = await SB.from("community_posts")
      .select("id, user_id, content, kudos, created_at")
      .order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Aucune publication. Soyez le premier !</div>';
      return;
    }
    el.innerHTML = data.map(p => {
      const d = new Date(p.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
      const isMe = p.user_id === USER.id;
      const liked = LIKED.has(p.id);
      return `<div class="post">
        <div class="post-head">
          <span class="post-author">${isMe ? "Vous 👤" : "Membre 💪"}</span>
          <span class="post-date">${d}</span>
        </div>
        <div class="post-body">${esc(p.content)}</div>
        <div class="post-footer">
          <button class="kudos-btn ${liked?"on":""}" onclick="giveKudos('${p.id}', ${p.kudos})">
            👊 Kudos · ${p.kudos}
          </button>
          ${isMe ? `<button class="btn btn-d btn-sm" onclick="deletePost('${p.id}')">🗑️</button>` : ""}
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${esc(e.message)}</div>`;
  }
}

/* ─────────── BODYSCAN ─────────── */
function handleDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}

function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Fichier image requis (JPG, PNG, WEBP).", "err");
  if (file.size > 6 * 1024 * 1024) return toast("Fichier trop grand (max 6MB).", "err");
  PENDING_FILE = file;
  const reader = new FileReader();
  reader.onload = e => { document.getElementById("scan-img").src = e.target.result; };
  reader.readAsDataURL(file);
  document.getElementById("scan-preview").style.display = "flex";
  document.getElementById("scan-err").style.display = "none";
}

async function doScan() {
  if (!PENDING_FILE) return;
  const errEl = document.getElementById("scan-err");
  const btn = document.getElementById("btn-scan");
  errEl.style.display = "none";
  setBtnLoading(btn, "Upload en cours…");

  try {
    const token = await getToken();
    const ext = PENDING_FILE.name.split(".").pop().replace(/[^a-z0-9]/gi, "") || "jpg";
    const path = `${USER.id}/${Date.now()}.${ext}`;

    // 1. Upload storage
    const { error: upErr } = await SB.storage.from(BUCKET).upload(path, PENDING_FILE, {
      contentType: PENDING_FILE.type, upsert: false
    });
    if (upErr) throw new Error(`Upload échoué: ${upErr.message}`);

    // 2. Insérer en base
    const { error: dbErr } = await SB.from("body_scans").insert({ user_id: USER.id, image_path: path });
    if (dbErr) throw new Error(`Base de données: ${dbErr.message}`);

    // 3. Appel API analyse IA
    btn.textContent = "Analyse IA…";
    const r = await fetch(API_BODYSCAN, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ user_id: USER.id, image_path: path })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || j.detail || `HTTP ${r.status}`);

    PENDING_FILE = null;
    document.getElementById("scan-preview").style.display = "none";
    document.getElementById("file-input").value = "";
    toast("Analyse terminée ✓", "ok");
    loadScans();
  } catch (e) {
    errEl.textContent = `Erreur: ${e.message}`;
    errEl.style.display = "block";
  } finally {
    resetBtn(btn, "🔬 Analyser avec l'IA");
  }
}

async function loadScans() {
  const el = document.getElementById("scans-list");
  try {
    const { data, error } = await SB.from("body_scans")
      .select("*").eq("user_id", USER.id)
      .order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">🔬</span>Aucune analyse. Uploadez votre première photo !</div>';
      return;
    }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">${data.map(s => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"numeric" });
      const done = !!s.ai_feedback;
      return `<div class="scan-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:800;font-size:.86rem">📸 Scan — ${d}</span>
          <span class="badge ${done?"bg-green":"bg-orange"}">${done ? "✓ Analysé" : "En attente"}</span>
        </div>
        ${done ? `
        <div class="scores-row">
          <div class="score-chip"><div class="score-v">${s.symmetry_score ?? "—"}</div><div class="score-l">Symétrie</div></div>
          <div class="score-chip"><div class="score-v">${s.posture_score ?? "—"}</div><div class="score-l">Posture</div></div>
          <div class="score-chip"><div class="score-v">${s.bodyfat_proxy ?? "—"}</div><div class="score-l">% MG proxy</div></div>
        </div>
        <div class="scan-feedback">${esc(s.ai_feedback || "")}</div>
        ` : `<div style="font-size:.8rem;color:var(--muted);font-style:italic">L'analyse IA sera disponible après traitement.</div>`}
      </div>`;
    }).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${esc(e.message)}</div>`;
  }
}

/* ─────────── PROFILE ─────────── */
async function loadProfile() {
  try {
    const { data } = await SB.from("profiles").select("display_name").eq("id", USER.id).maybeSingle();
    const name = data?.display_name || USER.email?.split("@")[0] || "?";
    document.getElementById("p-name").textContent = name;
    document.getElementById("p-email").textContent = USER.email || "";
    document.getElementById("p-avatar").textContent = name.charAt(0).toUpperCase();
    document.getElementById("p-pseudo").value = data?.display_name || "";
  } catch {}
}

async function saveProfile() {
  const name = document.getElementById("p-pseudo").value.trim();
  if (!name) return toast("Entrez un pseudo.", "err");

  const btn = document.getElementById("btn-save-profile");
  setBtnLoading(btn, "Enregistrement…");
  try {
    const { error } = await SB.from("profiles").upsert(
      { id: USER.id, display_name: name, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
    if (error) throw error;
    toast("Profil mis à jour ✓", "ok");
    loadProfile();
  } catch (e) { toast(`Erreur: ${e.message}`, "err"); }
  finally { resetBtn(btn, "💾 Enregistrer"); }
}

async function loadStats() {
  try {
    const [a, b, c] = await Promise.all([
      SB.from("workout_sessions").select("id", { count:"exact", head:true }).eq("user_id", USER.id),
      SB.from("body_scans").select("id", { count:"exact", head:true }).eq("user_id", USER.id),
      SB.from("community_posts").select("id", { count:"exact", head:true }).eq("user_id", USER.id),
    ]);
    document.getElementById("st-sess").textContent = a.count ?? "0";
    document.getElementById("st-scans").textContent = b.count ?? "0";
    document.getElementById("st-posts").textContent = c.count ?? "0";
  } catch {}
}

/* ─────────── HELPERS ─────────── */
async function getToken() {
  const { data } = await SB.auth.getSession();
  return data.session?.access_token || "";
}

function fmtDur(sec) {
  if (!sec) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m}min ${s}s` : `${m}min`;
}

function esc(str) {
  return String(str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

let _tid = null;
function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `on ${type}`;
  if (_tid) clearTimeout(_tid);
  _tid = setTimeout(() => { el.className = ""; }, 3200);
}

function setBtnLoading(btn, label) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;border-width:2px"></span> ${label}`;
}

function resetBtn(btn, label) {
  btn.disabled = false;
  btn.textContent = label;
}

/* ─────────── START ─────────── */
boot();
