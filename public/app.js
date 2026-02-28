// FitAI Pro v3.5.0 — app.js
"use strict";

/* ══ ÉTAT ══ */
let SB = null, U = null, MODE = "login", PLAN = null, FILE = null;
let LIKED = new Set(JSON.parse(localStorage.getItem("fp_likes") || "[]"));

/* ══ BOOT ══ */
async function boot() {
  bMsg("Chargement du SDK…");
  try { await loadJS("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"); }
  catch { return bErr("Impossible de charger le SDK Supabase. Vérifiez votre connexion."); }

  bMsg("Récupération de la configuration…");
  let cfg;
  try {
    const r = await fetch("/api/config", { headers: { "Accept": "application/json" } });
    const ct = r.headers.get("content-type") || "";

    // Si on reçoit du HTML (Vercel 404), expliquer clairement
    if (!ct.includes("json")) {
      const preview = (await r.text()).slice(0, 120);
      return bErr(
        `⛔ /api/config retourne du HTML (HTTP ${r.status}), pas du JSON.\n\n` +
        `→ Vérifiez que api/config.js est bien dans votre repo git (git status)\n` +
        `→ Puis : git add api/config.js && git push\n` +
        `→ Redéployez sur Vercel\n\n` +
        `Aperçu reçu : ${preview}`
      );
    }

    cfg = await r.json();
    if (!cfg.ok) {
      return bErr((cfg.error || "Erreur config") + (cfg.fix ? "\n\n" + cfg.fix : ""));
    }
  } catch (e) { return bErr("Erreur réseau: " + e.message); }

  bMsg("Initialisation Supabase…");
  try {
    SB = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (e) { return bErr("Init Supabase: " + e.message); }

  SB.auth.onAuthStateChange((_, sess) => {
    if (sess?.user) { U = sess.user; showApp(); }
    else { U = null; showAuth(); }
  });

  const { data: { session } } = await SB.auth.getSession();
  hideBoot();
  if (session?.user) { U = session.user; showApp(); } else { showAuth(); }
}

function bMsg(m) { document.getElementById("boot-msg").textContent = m; }
function bErr(m) {
  document.getElementById("boot-sp").style.display = "none";
  document.getElementById("boot-msg").style.display = "none";
  const el = document.getElementById("boot-err");
  el.style.display = "block";
  el.style.whiteSpace = "pre-line";
  el.textContent = m;
}
function hideBoot() {
  const b = document.getElementById("boot");
  b.classList.add("gone");
  setTimeout(() => b.style.display = "none", 400);
}
function loadJS(src) {
  return new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Echec chargement: " + src));
    document.head.appendChild(s);
  });
}

/* ══ AUTH ══ */
function showAuth() {
  document.getElementById("auth").style.display = "flex";
  document.getElementById("app").classList.remove("on");
}
function showApp() {
  document.getElementById("auth").style.display = "none";
  document.getElementById("app").classList.add("on");
  document.getElementById("top-em").textContent = U.email || "";
  loadGoal(); loadHist(); loadMeals(); loadFeed(); loadScans(); loadProfile(); loadStats();
}
function authMode(m) {
  MODE = m;
  document.getElementById("abt-l").classList.toggle("on", m === "login");
  document.getElementById("abt-s").classList.toggle("on", m === "signup");
  document.getElementById("a-btn").textContent = m === "login" ? "Se connecter" : "S'inscrire";
  setAMsg("", "");
}
function setAMsg(txt, cls) {
  const el = document.getElementById("a-msg");
  el.textContent = txt; el.className = "amsg " + cls;
}
async function doAuth() {
  const em = document.getElementById("a-em").value.trim();
  const pw = document.getElementById("a-pw").value;
  if (!em || !pw) return setAMsg("Email et mot de passe requis.", "er");
  const btn = document.getElementById("a-btn");
  btn.disabled = true; btn.innerHTML = '<span class="sp" style="width:15px;height:15px;border-width:2px"></span>';
  setAMsg("", "");
  try {
    let err;
    if (MODE === "login") { ({ error: err } = await SB.auth.signInWithPassword({ email: em, password: pw })); }
    else { ({ error: err } = await SB.auth.signUp({ email: em, password: pw })); if (!err) return setAMsg("Compte créé ! Vérifiez votre email.", "ok"); }
    if (err) throw err;
  } catch (e) { setAMsg(e.message || "Erreur.", "er"); }
  finally { btn.disabled = false; btn.textContent = MODE === "login" ? "Se connecter" : "S'inscrire"; }
}
async function doLogout() { await SB.auth.signOut(); U = null; }

/* ══ NAVIGATION ══ */
function go(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("on"));
  document.querySelectorAll(".nb").forEach(b => b.classList.remove("on"));
  document.getElementById("t-" + name)?.classList.add("on");
  document.getElementById("n-" + name)?.classList.add("on");
  document.getElementById("scroll").scrollTop = 0;
  if (name === "nutrition") loadMeals();
  if (name === "community") loadFeed();
  if (name === "coach") loadHist();
  if (name === "bodyscan") loadScans();
  if (name === "profile") { loadProfile(); loadStats(); }
}

/* ══ GOAL ══ */
const GLBL = { prise_de_masse:"💪 Prise de masse", perte_de_poids:"🔥 Perte de poids", endurance:"🏃 Endurance", force:"🏋️ Force", remise_en_forme:"🌟 Remise en forme", maintien:"⚖️ Maintien" };

async function loadGoal() {
  try {
    const { data } = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    if (!data) return;
    document.getElementById("gf").style.display = "none";
    document.getElementById("gv").style.display = "block";
    document.getElementById("g-type").value = data.type || "";
    document.getElementById("g-lvl").value = data.level || "";
    document.getElementById("g-txt").value = data.text || "";
    document.getElementById("g-con").value = data.constraints || "";
    const rows = [
      ["Type", GLBL[data.type] || data.type || "—"],
      ["Niveau", data.level || "—"],
      ["Objectif", data.text || "—"],
      data.constraints ? ["Contraintes", data.constraints] : null
    ].filter(Boolean);
    document.getElementById("gv-body").innerHTML = rows.map(([k,v]) =>
      `<div class="gline"><strong>${k}</strong><span>${esc(v)}</span></div>`).join("");
  } catch {}
}
function goalEdit() {
  document.getElementById("gv").style.display = "none";
  document.getElementById("gf").style.display = "block";
}
async function saveGoal() {
  const type = document.getElementById("g-type").value;
  const level = document.getElementById("g-lvl").value;
  const text = document.getElementById("g-txt").value.trim();
  const constraints = document.getElementById("g-con").value.trim();
  if (!type && !text) return toast("Remplissez au moins le type ou la description.", "er");
  const btn = document.getElementById("btn-sg");
  busy(btn, "Enregistrement…");
  try {
    const { error } = await SB.from("goals").upsert({ user_id: U.id, type, level, text, constraints }, { onConflict: "user_id" });
    if (error) throw error;
    toast("Objectif enregistré ✓", "ok"); loadGoal();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
  finally { free(btn, "💾 Enregistrer"); }
}

/* ══ COACH ══ */
async function genWorkout() {
  const prompt = document.getElementById("c-prompt").value.trim();
  const errEl = document.getElementById("c-err");
  errEl.style.display = "none";
  if (!prompt) { errEl.textContent = "Décrivez la séance souhaitée."; errEl.style.display = "block"; return; }

  const btn = document.getElementById("btn-gen");
  busy(btn, "Génération en cours…");
  document.getElementById("plan-card").style.display = "none";

  let goalContext = null;
  try {
    const { data } = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    if (data) goalContext = { type: data.type, level: data.level, text: data.text, constraints: data.constraints };
  } catch {}

  try {
    const token = await tok();
    const r = await fetch("/api/workout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ prompt, goalContext })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    PLAN = j.data;
    renderPlan(j.data);
  } catch (e) { errEl.textContent = "Erreur: " + e.message; errEl.style.display = "block"; }
  finally { free(btn, "✨ Générer ma séance"); }
}

function renderPlan(p) {
  const ib = { low:"bgreen", medium:"bpurple", high:"borange" }[p.intensity] || "bpurple";
  const typeLabels = { strength:"🏋️ Force", cardio:"🏃 Cardio", hiit:"⚡ HIIT", flexibility:"🧘 Flex", recovery:"💆 Récup", muay_thai:"🥊 Muay Thai" };
  const tl = typeLabels[p.type] || "";
  document.getElementById("plan-hd").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;flex:1">
      <span class="plan-t">${esc(p.title)}</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span class="bdg ${ib}">${p.intensity}</span>
        ${tl ? `<span class="bdg bpurple">${tl}</span>` : ""}
        ${p.duration ? `<span class="bdg" style="background:var(--s2);color:var(--m)">⏱ ${p.duration} min</span>` : ""}
        ${p.calories_burned ? `<span class="bdg" style="background:#fb923c18;color:var(--o)">🔥 ~${p.calories_burned} kcal</span>` : ""}
        ${p.difficulty ? `<span class="bdg" style="background:var(--s2);color:var(--a2)">${'★'.repeat(Math.round(p.difficulty))}${'☆'.repeat(5-Math.round(p.difficulty))}</span>` : ""}
      </div>
    </div>`;
  document.getElementById("plan-notes").textContent = p.notes || "";
  document.getElementById("plan-notes").style.display = p.notes ? "block" : "none";
  document.getElementById("plan-blocs").innerHTML = p.blocks.map(b => `
    <div class="bloc">
      <div class="bloc-hd">
        <span class="bloc-name">${esc(b.title)}</span>
        <div class="bloc-meta">
          ${b.rpe ? `<span class="rpe">RPE ${esc(b.rpe)}</span>` : ""}
          <span class="bdur">⏱ ${fmtD(b.duration_sec)}</span>
        </div>
      </div>
      <ul class="bloc-items">${(b.items||[]).map(i => `<li>${esc(i)}</li>`).join("")}</ul>
    </div>`).join("");
  document.getElementById("plan-card").style.display = "block";
  document.getElementById("plan-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveSess() {
  if (!PLAN) return;
  try {
    const { error } = await SB.from("workout_sessions").insert({ user_id: U.id, plan: PLAN });
    if (error) throw error;
    toast("Séance sauvegardée ✓", "ok"); loadHist();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
}

async function loadHist() {
  const el = document.getElementById("hist");
  try {
    const { data, error } = await SB.from("workout_sessions")
      .select("id, created_at, plan").eq("user_id", U.id)
      .order("created_at", { ascending: false }).limit(8);
    if (error) throw error;
    if (!data?.length) { el.innerHTML = '<div class="empty"><span class="eic">📋</span>Aucune séance sauvegardée</div>'; return; }
    el.innerHTML = data.map(s => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short" });
      const p = s.plan || {};
      const ib = { low:"bgreen", medium:"bpurple", high:"borange" }[p.intensity] || "bpurple";
      return `<div class="hist-row">
        <div><div style="font-weight:800;font-size:.86rem">${esc(p.title || "Séance")}</div>
        <div style="font-size:.72rem;color:var(--m)">${d} · ${(p.blocks||[]).length} blocs</div></div>
        <span class="bdg ${ib}">${p.intensity || "medium"}</span>
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = `<div class="empty" style="color:var(--r)">Erreur: ${esc(e.message)}</div>`; }
}

/* ══ NUTRITION ══ */
async function addMeal() {
  const name = document.getElementById("n-name").value.trim();
  if (!name) return toast("Donnez un nom au repas.", "er");
  const kcal = parseInt(document.getElementById("n-kc").value) || 0;
  const prot = parseInt(document.getElementById("n-pr").value) || 0;
  const carb = parseInt(document.getElementById("n-ca").value) || 0;
  const fat  = parseInt(document.getElementById("n-fa").value) || 0;
  const btn = document.getElementById("btn-meal");
  busy(btn, "Ajout…");
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await SB.from("meals").insert({ user_id: U.id, name, calories: kcal, protein: prot, carbs: carb, fat, date: today });
    if (error) throw error;
    ["n-name","n-kc","n-pr","n-ca","n-fa"].forEach(id => document.getElementById(id).value = "");
    toast("Repas ajouté ✓", "ok"); loadMeals();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
  finally { free(btn, "➕ Ajouter ce repas"); }
}

async function delMeal(id) {
  try {
    const { error } = await SB.from("meals").delete().eq("id", id).eq("user_id", U.id);
    if (error) throw error;
    toast("Repas supprimé", "ok"); loadMeals();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
}

async function loadMeals() {
  const el = document.getElementById("meals-list");
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await SB.from("meals").select("*").eq("user_id", U.id).eq("date", today).order("created_at");
    if (error) throw error;
    // Totaux
    const tot = (data||[]).reduce((a, m) => ({ kc: a.kc+(m.calories||0), pr: a.pr+(m.protein||0), ca: a.ca+(m.carbs||0), fa: a.fa+(m.fat||0) }), { kc:0, pr:0, ca:0, fa:0 });
    document.getElementById("m-kc").textContent = tot.kc;
    document.getElementById("m-pr").textContent = tot.pr + "g";
    document.getElementById("m-ca").textContent = tot.ca + "g";
    document.getElementById("m-fa").textContent = tot.fa + "g";
    if (!data?.length) { el.innerHTML = '<div class="empty"><span class="eic">🍽️</span>Aucun repas aujourd\'hui</div>'; return; }
    el.innerHTML = `<div>${data.map(m => `
      <div class="meal-row">
        <div class="meal-name">${esc(m.name)}</div>
        <div class="meal-info">P:${m.protein||0}g · G:${m.carbs||0}g · L:${m.fat||0}g</div>
        <div class="meal-kcal">${m.calories||0} kcal</div>
        <button class="btn bd bsm" onclick="delMeal('${m.id}')">🗑️</button>
      </div>`).join("")}</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="color:var(--r)">Erreur: ${esc(e.message)}</div>`; }
}

/* ══ COMMUNITY ══ */
async function createPost() {
  const txt = document.getElementById("p-txt").value.trim();
  if (!txt) return toast("Écrivez quelque chose.", "er");
  const btn = document.getElementById("btn-post");
  busy(btn, "Publication…");
  try {
    const { error } = await SB.from("community_posts").insert({ user_id: U.id, content: txt, kudos: 0 });
    if (error) throw error;
    document.getElementById("p-txt").value = "";
    toast("Publié ✓", "ok"); loadFeed();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
  finally { free(btn, "📢 Publier"); }
}
async function giveKudos(pid, cur) {
  if (LIKED.has(pid)) return toast("Déjà liké !", "er");
  try {
    const { error } = await SB.from("community_posts").update({ kudos: cur + 1 }).eq("id", pid);
    if (error) throw error;
    LIKED.add(pid); localStorage.setItem("fp_likes", JSON.stringify([...LIKED]));
    toast("👊 Kudos !", "ok"); loadFeed();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
}
async function delPost(pid) {
  try {
    const { error } = await SB.from("community_posts").delete().eq("id", pid).eq("user_id", U.id);
    if (error) throw error;
    toast("Supprimé", "ok"); loadFeed();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
}
async function loadFeed() {
  const el = document.getElementById("feed");
  try {
    const { data, error } = await SB.from("community_posts")
      .select("id, user_id, content, kudos, created_at")
      .order("created_at", { ascending: false }).limit(25);
    if (error) throw error;
    if (!data?.length) { el.innerHTML = '<div class="empty"><span class="eic">👥</span>Soyez le premier à publier !</div>'; return; }
    el.innerHTML = data.map(p => {
      const d = new Date(p.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
      const me = p.user_id === U.id;
      const lk = LIKED.has(p.id);
      return `<div class="post">
        <div class="post-hd">
          <span class="post-author">${me ? "Vous 👤" : "Membre 💪"}</span>
          <span class="post-date">${d}</span>
        </div>
        <div class="post-body">${esc(p.content)}</div>
        <div class="post-foot">
          <button class="kudos ${lk?"on":""}" onclick="giveKudos('${p.id}',${p.kudos})">👊 ${p.kudos}</button>
          ${me ? `<button class="btn bd bsm" onclick="delPost('${p.id}')">🗑️</button>` : ""}
        </div>
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = `<div class="empty" style="color:var(--r)">Erreur: ${esc(e.message)}</div>`; }
}

/* ══ BODYSCAN ══ */
function handleDrop(e) { const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); }
function handleFile(f) {
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("Image requise (JPG, PNG, WEBP).", "er");
  if (f.size > 6*1024*1024) return toast("Max 6MB.", "er");
  FILE = f;
  const r = new FileReader();
  r.onload = e => { document.getElementById("scan-img").src = e.target.result; };
  r.readAsDataURL(f);
  document.getElementById("scan-preview").style.display = "flex";
  document.getElementById("sc-err").style.display = "none";
}
async function doScan() {
  if (!FILE) return;
  const btn = document.getElementById("btn-sc");
  const errEl = document.getElementById("sc-err");
  errEl.style.display = "none";
  busy(btn, "Upload…");
  try {
    const token = await tok();
    const ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "");
    const path = U.id + "/" + Date.now() + "." + ext;
    const { error: upErr } = await SB.storage.from("user_uploads").upload(path, FILE, { contentType: FILE.type });
    if (upErr) throw new Error("Upload: " + upErr.message);
    const { error: dbErr } = await SB.from("body_scans").insert({ user_id: U.id, image_path: path });
    if (dbErr) throw new Error("DB: " + dbErr.message);
    btn.textContent = "Analyse IA…";
    const r = await fetch("/api/bodyscan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ user_id: U.id, image_path: path })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    FILE = null;
    document.getElementById("scan-preview").style.display = "none";
    document.getElementById("fi").value = "";
    toast("Analyse terminée ✓", "ok"); loadScans();
  } catch (e) {
    errEl.textContent = "Erreur: " + e.message; errEl.style.display = "block";
  } finally { free(btn, "🔬 Analyser avec l'IA"); }
}
async function loadScans() {
  const el = document.getElementById("scans-list");
  try {
    const { data, error } = await SB.from("body_scans")
      .select("*").eq("user_id", U.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    if (!data?.length) { el.innerHTML = '<div class="empty"><span class="eic">🔬</span>Aucune analyse. Uploadez votre première photo !</div>'; return; }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:11px">${data.map(s => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"numeric" });
      const done = !!s.ai_feedback;
      return `<div class="scan-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:800;font-size:.84rem">📸 ${d}</span>
          <span class="bdg ${done?"bgreen":"borange"}">${done?"✓ Analysé":"En attente"}</span>
        </div>
        ${done ? `
        <div class="scores">
          <div class="schip"><div class="scval">${s.symmetry_score ?? "—"}</div><div class="sclbl">Symétrie</div></div>
          <div class="schip"><div class="scval">${s.posture_score ?? "—"}</div><div class="sclbl">Posture</div></div>
          <div class="schip"><div class="scval">${s.bodyfat_proxy ?? "—"}</div><div class="sclbl">% MG</div></div>
        </div>
        <div class="scan-fb">${esc(s.ai_feedback || "")}</div>
        ` : `<div style="font-size:.79rem;color:var(--m);font-style:italic">Analyse en attente de traitement.</div>`}
      </div>`;
    }).join("")}</div>`;
  } catch (e) { el.innerHTML = `<div class="empty" style="color:var(--r)">Erreur: ${esc(e.message)}</div>`; }
}

/* ══ PROFILE ══ */
async function loadProfile() {
  try {
    const { data } = await SB.from("profiles").select("display_name").eq("id", U.id).maybeSingle();
    const name = data?.display_name || U.email?.split("@")[0] || "?";
    document.getElementById("p-nm").textContent = name;
    document.getElementById("p-em2").textContent = U.email || "";
    document.getElementById("p-av").textContent = name.charAt(0).toUpperCase();
    document.getElementById("p-pseudo").value = data?.display_name || "";
  } catch {}
}
async function saveProfile() {
  const name = document.getElementById("p-pseudo").value.trim();
  if (!name) return toast("Entrez un pseudo.", "er");
  const btn = document.getElementById("btn-sp");
  busy(btn, "Enregistrement…");
  try {
    const { error } = await SB.from("profiles").upsert({ id: U.id, display_name: name, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw error;
    toast("Profil mis à jour ✓", "ok"); loadProfile();
  } catch (e) { toast("Erreur: " + e.message, "er"); }
  finally { free(btn, "💾 Enregistrer"); }
}
async function loadStats() {
  try {
    const [a,b,c] = await Promise.all([
      SB.from("workout_sessions").select("id",{count:"exact",head:true}).eq("user_id",U.id),
      SB.from("body_scans").select("id",{count:"exact",head:true}).eq("user_id",U.id),
      SB.from("community_posts").select("id",{count:"exact",head:true}).eq("user_id",U.id),
    ]);
    document.getElementById("st-s").textContent  = a.count ?? "0";
    document.getElementById("st-sc").textContent = b.count ?? "0";
    document.getElementById("st-p").textContent  = c.count ?? "0";
  } catch {}
}

/* ══ HELPERS ══ */
async function tok() {
  const { data } = await SB.auth.getSession();
  return data.session?.access_token || "";
}
function fmtD(s) {
  if (!s) return "—";
  const m = Math.floor(s/60), r = s%60;
  return r ? `${m}min ${r}s` : `${m}min`;
}
function esc(v) {
  return String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
let _tt;
function toast(msg, cls="ok") {
  const el = document.getElementById("toast");
  el.textContent = msg; el.className = "on " + cls;
  if (_tt) clearTimeout(_tt);
  _tt = setTimeout(() => el.className = "", 3000);
}
function busy(btn, lbl) { btn.disabled=true; btn.innerHTML=`<span class="sp" style="width:14px;height:14px;border-width:2px"></span> ${lbl}`; }
function free(btn, lbl) { btn.disabled=false; btn.textContent=lbl; }

boot();
