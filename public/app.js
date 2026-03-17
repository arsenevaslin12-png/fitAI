// FitAI Pro v8.0.0 — app.js — Stabilisation complete
"use strict";

/* ====== STATE ====== */
let SB = null, U = null, MODE = "login", PLAN = null, FILE = null;
let LIKED = new Set();
try { LIKED = new Set(JSON.parse(localStorage.getItem("fp_likes") || "[]")); } catch {}

/* ====== RATE LIMIT PROTECTION ====== */
let _rateLimitUntil = 0; // timestamp until which we block AI calls
const RATE_LIMIT_COOLDOWN = 65000; // 65s cooldown after a 429

function isRateLimited() { return Date.now() < _rateLimitUntil; }

function activateRateLimit(retryAfter) {
  const ms = (retryAfter || 60) * 1000;
  _rateLimitUntil = Date.now() + ms;
  showRateLimitBanner(Math.ceil(ms / 1000));
}

function showRateLimitBanner(seconds) {
  var banner = document.getElementById("rate-limit-banner");
  var timer = document.getElementById("rl-timer");
  if (!banner || !timer) return;
  banner.classList.add("on");
  var remaining = seconds;
  timer.textContent = remaining;
  var iv = setInterval(function() {
    remaining--;
    timer.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(iv);
      banner.classList.remove("on");
      _rateLimitUntil = 0;
    }
  }, 1000);
}

/* ====== DEBOUNCE GUARD ====== */
const _busy = new Set();
function guardBtn(id) { if (_busy.has(id)) return true; _busy.add(id); return false; }
function releaseBtn(id) { _busy.delete(id); }

/* ====== BOOT ====== */
async function boot() {
  bMsg("Chargement du SDK...");
  try {
    await loadJS("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
  } catch {
    return bErr("Impossible de charger le SDK Supabase. Verifiez votre connexion.");
  }

  bMsg("Recuperation de la configuration...");
  let cfg;
  try {
    var r = await fetch("/api/config", { headers: { "Accept": "application/json" } });
    var ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) {
      var preview = (await r.text()).slice(0, 120);
      return bErr("/api/config retourne du HTML (HTTP " + r.status + "), pas du JSON.\nVerifiez que api/config.js est dans votre repo.\nApercu: " + preview);
    }
    cfg = await r.json();
    if (!cfg.ok) return bErr((cfg.error || "Erreur config") + (cfg.fix ? "\n\n" + cfg.fix : ""));
  } catch (e) {
    return bErr("Erreur reseau: " + e.message);
  }

  bMsg("Initialisation Supabase...");
  try {
    SB = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  } catch (e) {
    return bErr("Init Supabase: " + e.message);
  }

  SB.auth.onAuthStateChange(function(_event, sess) {
    if (sess && sess.user) { U = sess.user; showApp(); }
    else { U = null; showAuth(); }
  });

  var result = await SB.auth.getSession();
  hideBoot();
  if (result.data.session && result.data.session.user) { U = result.data.session.user; showApp(); }
  else { showAuth(); }
}

function bMsg(m) { var el = document.getElementById("boot-msg"); if (el) el.textContent = m; }
function bErr(m) {
  var sp = document.getElementById("boot-sp");
  var msg = document.getElementById("boot-msg");
  var err = document.getElementById("boot-err");
  if (sp) sp.style.display = "none";
  if (msg) msg.style.display = "none";
  if (err) { err.style.display = "block"; err.style.whiteSpace = "pre-line"; err.textContent = m; }
}
function hideBoot() {
  var b = document.getElementById("boot");
  if (!b) return;
  b.classList.add("hidden");
  setTimeout(function() { b.style.display = "none"; }, 400);
}
function loadJS(src) {
  return new Promise(function(ok, fail) {
    if (document.querySelector('script[src="' + src + '"]')) return ok();
    var s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = function() { fail(new Error("Echec chargement: " + src)); };
    document.head.appendChild(s);
  });
}

/* ====== AUTH ====== */
function showAuth() {
  document.getElementById("auth").style.display = "flex";
  document.getElementById("app").classList.remove("on");
}
function showApp() {
  document.getElementById("auth").style.display = "none";
  document.getElementById("app").classList.add("on");
  var email = U.email || "";
  setText("tu", email.split("@")[0] || email);
  var initial = (email.charAt(0) || "?").toUpperCase();
  var sbAvatar = document.getElementById("sb-avatar");
  if (sbAvatar) sbAvatar.textContent = initial;

  // Stagger loads to avoid hammering DB
  loadGoal();
  loadDashboard();
  setTimeout(function() { loadMeals(); loadNutritionTargets(); }, 200);
  setTimeout(function() { loadHist(); loadProfile(); }, 400);
  // Don't auto-load feed/scans — loaded on tab switch
}

function authMode(m) {
  MODE = m;
  document.getElementById("atab-login").classList.toggle("on", m === "login");
  document.getElementById("atab-signup").classList.toggle("on", m === "signup");
  document.getElementById("auth-btn").textContent = m === "login" ? "Se connecter" : "S'inscrire";
  setAMsg("", "");
}
function setAMsg(txt, cls) {
  var el = document.getElementById("auth-msg");
  if (el) { el.textContent = txt; el.className = "auth-msg amsg " + cls; }
}
async function doAuth() {
  if (guardBtn("auth")) return;
  var em = document.getElementById("a-email").value.trim();
  var pw = document.getElementById("a-pwd").value;
  if (!em || !pw) { releaseBtn("auth"); return setAMsg("Email et mot de passe requis.", "er"); }
  var btn = document.getElementById("auth-btn");
  busy(btn, "Connexion...");
  setAMsg("", "");
  try {
    var err;
    if (MODE === "login") {
      var res = await SB.auth.signInWithPassword({ email: em, password: pw });
      err = res.error;
    } else {
      var res2 = await SB.auth.signUp({ email: em, password: pw });
      err = res2.error;
      if (!err) { releaseBtn("auth"); free(btn, MODE === "login" ? "Se connecter" : "S'inscrire"); return setAMsg("Compte cree ! Verifiez votre email.", "ok"); }
    }
    if (err) throw err;
  } catch (e) {
    setAMsg(e.message || "Erreur.", "er");
  } finally {
    releaseBtn("auth");
    free(btn, MODE === "login" ? "Se connecter" : "S'inscrire");
  }
}
async function doLogout() {
  if (!SB) return;
  await SB.auth.signOut();
  U = null;
}

/* ====== NAVIGATION ====== */
function go(name) {
  document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("on"); });
  document.querySelectorAll(".bnav-btn").forEach(function(b) { b.classList.remove("on"); });
  var tab = document.getElementById("t-" + name);
  var nav = document.getElementById("n-" + name);
  if (tab) tab.classList.add("on");
  if (nav) nav.classList.add("on");
  var scroll = document.getElementById("scroll");
  if (scroll) scroll.scrollTop = 0;

  // Lazy-load data per tab
  if (name === "nutrition") { loadMeals(); loadNutritionTargets(); }
  if (name === "community") loadFeed();
  if (name === "coach") loadHist();
  if (name === "bodyscan") loadScans();
  if (name === "profile") { loadProfile(); loadStats(); }
  if (name === "dashboard") loadDashboard();
  if (name === "progress") loadProgress();
}

/* ====== DASHBOARD ====== */
var TIPS = [
  "Restez regulier : meme 15 minutes d'exercice par jour font une grande difference.",
  "L'hydratation est cle : buvez au moins 2L d'eau par jour, plus si vous vous entrainez.",
  "Le sommeil est votre meilleur allie : 7-8h de sommeil optimisent la recuperation musculaire.",
  "Variez vos exercices : votre corps s'adapte vite. Changez de stimulus toutes les 4-6 semaines.",
  "N'oubliez pas l'echauffement : 5-10 minutes reduisent les risques de blessure de 50%.",
  "Proteines post-training : consommez 20-30g de proteines dans les 2h suivant l'entrainement.",
  "Le stress impacte vos performances : integrez 5 minutes de respiration profonde par jour.",
  "Tracez vos progres : ce qui se mesure s'ameliore. Notez vos charges et repetitions.",
  "La recuperation fait partie de l'entrainement : prenez au moins 1-2 jours de repos par semaine."
];

async function loadDashboard() {
  if (!SB || !U) return;

  // Set daily tip
  var tipIdx = Math.floor(Date.now() / 86400000) % TIPS.length;
  setText("dash-tip-text", TIPS[tipIdx]);

  try {
    var today = new Date().toISOString().slice(0, 10);
    var results = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("meals").select("calories").eq("user_id", U.id).eq("date", today),
      SB.from("workout_sessions").select("plan, created_at").eq("user_id", U.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    setText("d-sessions", results[0].count || "0");
    setText("d-scans", results[1].count || "0");
    setText("d-posts", results[2].count || "0");

    var mealsData = results[3].data || [];
    var todayKcal = mealsData.reduce(function(s, m) { return s + (m.calories || 0); }, 0);
    setText("d-kcal", todayKcal);
    setText("d-meals", mealsData.length);

    // Streak: count distinct recent days with sessions
    try {
      var recentSess = await SB.from("workout_sessions").select("created_at").eq("user_id", U.id)
        .order("created_at", { ascending: false }).limit(30);
      var days = new Set();
      (recentSess.data || []).forEach(function(s) { days.add(s.created_at.slice(0, 10)); });
      setText("d-streak", days.size);
    } catch(e) { setText("d-streak", "0"); }

    // Last session
    var lastEl = document.getElementById("dash-last-session");
    if (lastEl && results[4].data && results[4].data.plan) {
      var p = results[4].data.plan;
      var d = new Date(results[4].data.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
      lastEl.innerHTML =
        '<div class="hist-row">' +
        '<div><div style="font-weight:800;font-size:.86rem">' + esc(p.title || "Seance") + '</div>' +
        '<div style="font-size:.72rem;color:var(--muted)">' + d + ' - ' + (p.blocks || []).length + ' blocs</div></div>' +
        '<span class="bdg ' + ({ low: "bgreen", medium: "bpurple", high: "borange" }[p.intensity] || "bpurple") + '">' + (p.intensity || "medium") + '</span>' +
        '</div>';
    } else if (lastEl) {
      lastEl.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F4CB;</span>Aucune seance enregistree</div>';
    }

    // Weekly schedule
    loadWeekSchedule();
  } catch(e) { console.warn("[dashboard]", e.message); }
}

async function loadWeekSchedule() {
  if (!SB || !U) return;
  var weekEl = document.getElementById("dash-week");
  if (!weekEl) return;

  var dayNames = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
  var todayDow = new Date().getDay(); // 0=Sun
  var todayIdx = todayDow === 0 ? 6 : todayDow - 1; // 0=Mon

  try {
    // Try loading from training_schedule
    var now = new Date();
    var dow = now.getDay();
    var monday = new Date(now);
    monday.setDate(now.getDate() - dow + (dow === 0 ? -6 : 1));
    var weekStart = monday.toISOString().split("T")[0];

    var result = await SB.from("training_schedule").select("day_of_week, workout_type, intensity")
      .eq("user_id", U.id).eq("week_start_date", weekStart).order("day_of_week");

    var schedule = {};
    (result.data || []).forEach(function(r) { schedule[r.day_of_week] = r; });

    var html = "";
    for (var i = 0; i < 7; i++) {
      var dayNum = i + 1;
      var entry = schedule[dayNum];
      var isToday = i === todayIdx;
      var isRest = entry && /rest|repos|off/i.test(entry.workout_type || "");
      var cls = "week-day" + (isToday ? " today" : "") + (isRest ? " rest" : "");
      html += '<div class="' + cls + '">' +
        '<div class="wd-label">' + dayNames[i] + '</div>' +
        '<div class="wd-type">' + (entry ? esc(entry.workout_type).substring(0, 20) : "--") + '</div>' +
        '</div>';
    }
    weekEl.innerHTML = html;
  } catch(e) {
    // If table doesn't exist, show default
    var html2 = "";
    for (var j = 0; j < 7; j++) {
      var isTodayJ = j === todayIdx;
      html2 += '<div class="week-day' + (isTodayJ ? ' today' : '') + '">' +
        '<div class="wd-label">' + dayNames[j] + '</div>' +
        '<div class="wd-type">--</div></div>';
    }
    weekEl.innerHTML = html2;
  }
}

/* ====== PROGRESS ====== */
async function loadProgress() {
  if (!SB || !U) return;

  // Recent activity
  var actEl = document.getElementById("progress-activity");
  try {
    var sessRes = await SB.from("workout_sessions").select("plan, created_at").eq("user_id", U.id)
      .order("created_at", { ascending: false }).limit(10);
    if (sessRes.data && sessRes.data.length) {
      actEl.innerHTML = sessRes.data.map(function(s) {
        var p = s.plan || {};
        var d = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
        var ib = { low: "bgreen", medium: "bpurple", high: "borange" }[p.intensity] || "bpurple";
        return '<div class="hist-row">' +
          '<div><div style="font-weight:800;font-size:.84rem">' + esc(p.title || "Seance") + '</div>' +
          '<div style="font-size:.7rem;color:var(--muted)">' + d + ' - ' + (p.blocks || []).length + ' blocs</div></div>' +
          '<span class="bdg ' + ib + '">' + (p.intensity || "medium") + '</span></div>';
      }).join("");
    } else {
      actEl.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F4CA;</span>Aucune seance enregistree. Commencez par generer une seance !</div>';
    }
  } catch(e) { actEl.innerHTML = '<div class="empty">Erreur chargement</div>'; }

  // Scan history
  var scanEl = document.getElementById("progress-scans");
  try {
    var scanRes = await SB.from("body_scans").select("created_at, symmetry_score, posture_score, bodyfat_proxy")
      .eq("user_id", U.id).order("created_at", { ascending: false }).limit(5);
    if (scanRes.data && scanRes.data.length) {
      scanEl.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px">' + scanRes.data.map(function(s) {
        var d = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
          '<span style="font-weight:700;font-size:.82rem">' + d + '</span>' +
          '<div style="display:flex;gap:8px">' +
          (s.symmetry_score !== null ? '<span class="bdg bpurple">Sym ' + s.symmetry_score + '</span>' : '') +
          (s.posture_score !== null ? '<span class="bdg bblue">Post ' + s.posture_score + '</span>' : '') +
          (s.bodyfat_proxy !== null ? '<span class="bdg borange">MG ' + s.bodyfat_proxy + '%</span>' : '') +
          '</div></div>';
      }).join("") + '</div>';
    } else {
      scanEl.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F4F8;</span>Aucun scan. Uploadez une photo dans Body Scan !</div>';
    }
  } catch(e) { scanEl.innerHTML = '<div class="empty">Erreur chargement</div>'; }
}

/* ====== GOAL ====== */
var GLBL = {
  prise_de_masse: "Prise de masse", perte_de_poids: "Perte de poids",
  endurance: "Endurance", force: "Force",
  remise_en_forme: "Remise en forme", maintien: "Maintien"
};

async function loadGoal() {
  if (!SB || !U) return;
  try {
    var result = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    var data = result.data;
    if (!data) return;
    document.getElementById("goal-form").style.display = "none";
    document.getElementById("goal-view").style.display = "block";
    document.getElementById("g-type").value = data.type || "";
    document.getElementById("g-level").value = data.level || "";
    document.getElementById("g-text").value = data.text || "";
    document.getElementById("g-constraints").value = data.constraints || "";
    var rows = [
      ["Type", GLBL[data.type] || data.type || "--"],
      ["Niveau", data.level || "--"],
      ["Objectif", data.text || "--"],
      data.constraints ? ["Contraintes", data.constraints] : null
    ].filter(Boolean);
    document.getElementById("goal-view-body").innerHTML = rows.map(function(r) {
      return '<div class="gline"><strong>' + r[0] + '</strong><span>' + esc(r[1]) + '</span></div>';
    }).join("");
  } catch(e) { console.warn("[goal]", e.message); }
}
function goalEdit() {
  document.getElementById("goal-view").style.display = "none";
  document.getElementById("goal-form").style.display = "block";
}
async function saveGoal() {
  if (guardBtn("save-goal")) return;
  var type = document.getElementById("g-type").value;
  var level = document.getElementById("g-level").value;
  var text = document.getElementById("g-text").value.trim();
  var constraints = document.getElementById("g-constraints").value.trim();
  if (!type && !text) { releaseBtn("save-goal"); return toast("Remplissez au moins le type ou la description.", "err"); }
  var btn = document.getElementById("btn-save-goal");
  busy(btn, "Enregistrement...");
  try {
    var result = await SB.from("goals").upsert(
      { user_id: U.id, type: type, level: level, text: text, constraints: constraints },
      { onConflict: "user_id" }
    );
    if (result.error) throw result.error;
    toast("Objectif enregistre", "ok");
    loadGoal();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("save-goal"); free(btn, "Enregistrer l'objectif"); }
}

/* ====== COACH / WORKOUT ====== */
async function genWorkout() {
  if (guardBtn("gen-workout")) return;

  // Rate limit check
  if (isRateLimited()) {
    releaseBtn("gen-workout");
    return toast("Gemini est temporairement limite. Attendez la fin du cooldown.", "warn");
  }

  var prompt = document.getElementById("coach-input").value.trim();
  var errEl = document.getElementById("coach-err");
  errEl.style.display = "none";
  if (!prompt) { releaseBtn("gen-workout"); errEl.textContent = "Decrivez la seance souhaitee."; errEl.style.display = "block"; return; }

  var btn = document.getElementById("btn-gen");
  busy(btn, "Generation IA...");
  document.getElementById("plan-card").style.display = "none";

  var goalContext = null;
  try {
    var gr = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    if (gr.data) goalContext = { type: gr.data.type, level: gr.data.level, text: gr.data.text, constraints: gr.data.constraints };
  } catch(e) {}

  try {
    var token = await tok();
    var r = await fetch("/api/workout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ prompt: prompt, goalContext: goalContext })
    });
    var j = await r.json();

    if (r.status === 429) {
      activateRateLimit(j.retryAfter || 60);
      throw new Error(j.error || "Quota Gemini atteint. Attendez 60 secondes.");
    }
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));

    PLAN = j.data;
    renderPlan(j.data);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  } finally {
    releaseBtn("gen-workout");
    free(btn, "Generer ma seance");
  }
}

function renderPlan(p) {
  var ib = { low: "bgreen", medium: "bpurple", high: "borange" }[p.intensity] || "bpurple";
  var typeLabels = {
    strength: "Force", cardio: "Cardio", hiit: "HIIT",
    flexibility: "Flex", recovery: "Recup", muay_thai: "Muay Thai"
  };
  var tl = typeLabels[p.type] || "";

  document.getElementById("plan-head").innerHTML =
    '<div style="display:flex;flex-direction:column;gap:6px;flex:1">' +
    '<span class="plan-t">' + esc(p.title) + '</span>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
    '<span class="bdg ' + ib + '">' + (p.intensity || "medium") + '</span>' +
    (tl ? '<span class="bdg bpurple">' + tl + '</span>' : '') +
    (p.duration ? '<span class="bdg" style="background:var(--surf2);color:var(--muted)">&#x23F1; ' + p.duration + ' min</span>' : '') +
    (p.calories_burned ? '<span class="bdg borange">&#x1F525; ~' + p.calories_burned + ' kcal</span>' : '') +
    (p.difficulty ? '<span class="bdg" style="background:var(--surf2);color:var(--accent2)">' + stars(p.difficulty) + '</span>' : '') +
    '</div></div>';

  var notesEl = document.getElementById("plan-notes");
  notesEl.textContent = p.notes || "";
  notesEl.style.display = p.notes ? "block" : "none";

  document.getElementById("plan-blocks").innerHTML = (p.blocks || []).map(function(b) {
    return '<div class="bloc">' +
      '<div class="bloc-hd">' +
      '<span class="bloc-name">' + esc(b.title) + '</span>' +
      '<div class="bloc-meta">' +
      (b.rpe ? '<span class="rpe">RPE ' + esc(b.rpe) + '</span>' : '') +
      '<span class="bdur">&#x23F1; ' + fmtD(b.duration_sec) + '</span>' +
      '</div></div>' +
      '<ul class="bloc-items">' + (b.items || []).map(function(i) { return '<li>' + esc(i) + '</li>'; }).join("") + '</ul>' +
      '</div>';
  }).join("");

  document.getElementById("plan-card").style.display = "block";
  document.getElementById("plan-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveSess() {
  if (!PLAN || guardBtn("save-sess")) return;
  try {
    var result = await SB.from("workout_sessions").insert({ user_id: U.id, plan: PLAN });
    if (result.error) throw result.error;
    toast("Seance sauvegardee", "ok");
    loadHist();
    loadDashboard();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("save-sess"); }
}

async function loadHist() {
  if (!SB || !U) return;
  var el = document.getElementById("history-list");
  try {
    var result = await SB.from("workout_sessions")
      .select("id, created_at, plan").eq("user_id", U.id)
      .order("created_at", { ascending: false }).limit(8);
    if (result.error) throw result.error;
    var data = result.data;
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F4CB;</span>Aucune seance sauvegardee</div>';
      return;
    }
    el.innerHTML = data.map(function(s) {
      var d = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
      var p = s.plan || {};
      var ib = { low: "bgreen", medium: "bpurple", high: "borange" }[p.intensity] || "bpurple";
      return '<div class="hist-row">' +
        '<div><div style="font-weight:800;font-size:.86rem">' + esc(p.title || "Seance") + '</div>' +
        '<div style="font-size:.72rem;color:var(--muted)">' + d + ' - ' + (p.blocks || []).length + ' blocs</div></div>' +
        '<span class="bdg ' + ib + '">' + (p.intensity || "medium") + '</span></div>';
    }).join("");
  } catch (e) {
    el.innerHTML = '<div class="empty" style="color:var(--red)">Erreur: ' + esc(e.message) + '</div>';
  }
}

/* ====== NUTRITION ====== */
async function addMeal() {
  if (guardBtn("add-meal")) return;
  var name = document.getElementById("meal-name").value.trim();
  if (!name) { releaseBtn("add-meal"); return toast("Donnez un nom au repas.", "err"); }
  var kcal = parseInt(document.getElementById("meal-kcal").value) || 0;
  var prot = parseInt(document.getElementById("meal-prot").value) || 0;
  var carb = parseInt(document.getElementById("meal-carb").value) || 0;
  var fat  = parseInt(document.getElementById("meal-fat").value) || 0;
  var btn = document.getElementById("btn-meal");
  busy(btn, "Ajout...");
  try {
    var today = new Date().toISOString().slice(0, 10);
    var result = await SB.from("meals").insert({
      user_id: U.id, name: name, calories: kcal, protein: prot, carbs: carb, fat: fat, date: today
    });
    if (result.error) throw result.error;
    ["meal-name", "meal-kcal", "meal-prot", "meal-carb", "meal-fat"].forEach(function(id) {
      document.getElementById(id).value = "";
    });
    toast("Repas ajoute", "ok");
    loadMeals();
    loadDashboard();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("add-meal"); free(btn, "Ajouter ce repas"); }
}

async function delMeal(id) {
  if (guardBtn("del-" + id)) return;
  try {
    var result = await SB.from("meals").delete().eq("id", id).eq("user_id", U.id);
    if (result.error) throw result.error;
    toast("Repas supprime", "ok");
    loadMeals();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("del-" + id); }
}

async function loadMeals() {
  if (!SB || !U) return;
  var el = document.getElementById("meals-list");
  var today = new Date().toISOString().slice(0, 10);
  try {
    var result = await SB.from("meals").select("*").eq("user_id", U.id).eq("date", today).order("created_at");
    if (result.error) throw result.error;
    var data = result.data;

    var tot = (data || []).reduce(function(a, m) {
      return { kc: a.kc + (m.calories || 0), pr: a.pr + (m.protein || 0), ca: a.ca + (m.carbs || 0), fa: a.fa + (m.fat || 0) };
    }, { kc: 0, pr: 0, ca: 0, fa: 0 });

    setText("m-kcal", tot.kc);
    setText("m-prot", tot.pr + "g");
    setText("m-carb", tot.ca + "g");
    setText("m-fat", tot.fa + "g");
    updateMacroProgress(tot.kc);

    if (!data || !data.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F37D;</span>Aucun repas aujourd\'hui</div>';
      return;
    }
    el.innerHTML = '<div>' + data.map(function(m) {
      return '<div class="meal-row">' +
        '<div class="meal-name">' + esc(m.name) + '</div>' +
        '<div class="meal-info">P:' + (m.protein || 0) + 'g G:' + (m.carbs || 0) + 'g L:' + (m.fat || 0) + 'g</div>' +
        '<div class="meal-kcal">' + (m.calories || 0) + ' kcal</div>' +
        '<button class="btn btn-d btn-sm" onclick="delMeal(\'' + m.id + '\')">Suppr.</button>' +
        '</div>';
    }).join("") + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty" style="color:var(--red)">Erreur: ' + esc(e.message) + '</div>';
  }
}

/* ====== NUTRITION TARGETS ====== */
var _nutritionTarget = null;

async function loadNutritionTargets() {
  if (!SB || !U) return;
  try {
    var result = await SB.from("nutrition_targets").select("*").eq("user_id", U.id).maybeSingle();
    var data = result.data;
    if (data && data.calories) {
      _nutritionTarget = data;
      document.getElementById("nutrition-targets").style.display = "block";
      document.getElementById("nutrition-targets-empty").style.display = "none";
      setText("nt-kcal", data.calories);
      setText("nt-prot", data.protein + "g");
      setText("nt-carb", data.carbs + "g");
      setText("nt-fat", data.fats + "g");
      var notesEl = document.getElementById("nt-notes");
      if (notesEl) notesEl.textContent = data.notes || "";
      updateMacroProgress(parseInt(document.getElementById("m-kcal").textContent) || 0);
    } else {
      _nutritionTarget = null;
      document.getElementById("nutrition-targets").style.display = "none";
      document.getElementById("nutrition-targets-empty").style.display = "block";
    }
  } catch(e) {
    _nutritionTarget = null;
  }
}

function updateMacroProgress(currentKcal) {
  var progressDiv = document.getElementById("macro-progress");
  var fillDiv = document.getElementById("kcal-progress");
  var textDiv = document.getElementById("kcal-progress-text");
  if (!progressDiv || !fillDiv || !textDiv) return;
  if (!_nutritionTarget || !_nutritionTarget.calories) { progressDiv.style.display = "none"; return; }
  progressDiv.style.display = "block";
  var pct = Math.min(100, Math.round((currentKcal / _nutritionTarget.calories) * 100));
  fillDiv.style.width = pct + "%";
  fillDiv.style.background = pct > 100 ? "var(--red)" : "var(--grad)";
  textDiv.textContent = currentKcal + " / " + _nutritionTarget.calories + " kcal (" + pct + "%)";
}

async function generateNutrition() {
  if (guardBtn("gen-nutrition")) return;
  if (isRateLimited()) { releaseBtn("gen-nutrition"); return toast("Gemini limite. Attendez le cooldown.", "warn"); }

  var btn = document.getElementById("btn-gen-nutrition");
  busy(btn, "Calcul IA...");
  try {
    var token = await tok();
    var goal = "maintenance";
    try {
      var gr = await SB.from("goals").select("type").eq("user_id", U.id).maybeSingle();
      if (gr.data && gr.data.type) {
        var goalMap = { prise_de_masse: "muscle_gain", perte_de_poids: "weight_loss", maintien: "maintenance", endurance: "maintenance", force: "muscle_gain", remise_en_forme: "weight_loss" };
        goal = goalMap[gr.data.type] || "maintenance";
      }
    } catch(e) {}

    var r = await fetch("/api/generate-nutrition", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ goal: goal, activity_level: "moderate" })
    });
    var j = await r.json();
    if (r.status === 429) { activateRateLimit(j.retryAfter || 60); throw new Error(j.error); }
    if (!r.ok || !j.ok) throw new Error(j.error || j.detail || ("HTTP " + r.status));
    toast("Objectifs nutritionnels calcules", "ok");
    loadNutritionTargets();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("gen-nutrition"); free(btn, "Calculer mes macros IA"); }
}

/* ====== RECIPE AI ====== */
async function generateRecipe() {
  if (guardBtn("gen-recipe")) return;
  if (isRateLimited()) { releaseBtn("gen-recipe"); return toast("Gemini limite. Attendez le cooldown.", "warn"); }

  var ingredients = document.getElementById("recipe-ingredients").value.trim();
  var errEl = document.getElementById("recipe-err");
  errEl.style.display = "none";

  if (!ingredients) { releaseBtn("gen-recipe"); errEl.textContent = "Listez au moins quelques ingredients."; errEl.style.display = "block"; return; }

  var goal = document.getElementById("recipe-goal").value;
  var targetCalories = parseInt(document.getElementById("recipe-calories").value) || 0;
  var btn = document.getElementById("btn-gen-recipe");
  busy(btn, "Generation recette...");

  try {
    var token = await tok();
    var r = await fetch("/api/generate-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ ingredients: ingredients, goal: goal, targetCalories: targetCalories })
    });
    var j = await r.json();
    if (r.status === 429) { activateRateLimit(j.retryAfter || 60); throw new Error(j.error); }
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    renderRecipe(j.recipe);
    toast("Recette generee !", "ok");
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  } finally {
    releaseBtn("gen-recipe");
    free(btn, "\u{1F373} Generer la recette");
  }
}

function renderRecipe(r) {
  var el = document.getElementById("recipe-result-card");
  if (!el) return;

  var macrosHtml = "";
  if (r.macros) {
    macrosHtml = '<div class="recipe-macros">' +
      '<div class="recipe-macro"><div class="rv">' + (r.macros.protein || 0) + 'g</div><div class="rl">Proteines</div></div>' +
      '<div class="recipe-macro"><div class="rv">' + (r.macros.carbs || 0) + 'g</div><div class="rl">Glucides</div></div>' +
      '<div class="recipe-macro"><div class="rv">' + (r.macros.fat || 0) + 'g</div><div class="rl">Lipides</div></div>' +
      '</div>';
  }

  var ingredientsHtml = "";
  if (r.ingredients_list && r.ingredients_list.length) {
    ingredientsHtml = '<div><div style="font-weight:800;font-size:.84rem;margin-bottom:6px">Ingredients :</div>' +
      '<ul style="list-style:disc;padding-left:20px;font-size:.82rem;display:flex;flex-direction:column;gap:3px">' +
      r.ingredients_list.map(function(i) { return '<li>' + esc(i) + '</li>'; }).join("") +
      '</ul></div>';
  }

  var stepsHtml = "";
  if (r.steps && r.steps.length) {
    stepsHtml = '<div><div style="font-weight:800;font-size:.84rem;margin-bottom:6px">Etapes :</div>' +
      '<ol class="recipe-steps">' +
      r.steps.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join("") +
      '</ol></div>';
  }

  el.innerHTML = '<div class="recipe-result">' +
    '<div class="recipe-title">' + esc(r.name || "Recette") + '</div>' +
    '<div class="recipe-meta">' +
    (r.prep_time ? '<span>&#x23F1; Prep: ' + esc(r.prep_time) + '</span>' : '') +
    (r.cook_time ? '<span>&#x1F373; Cuisson: ' + esc(r.cook_time) + '</span>' : '') +
    (r.servings ? '<span>&#x1F37D; ' + r.servings + ' portions</span>' : '') +
    (r.calories_per_serving ? '<span>&#x1F525; ' + r.calories_per_serving + ' kcal/portion</span>' : '') +
    '</div>' +
    macrosHtml +
    ingredientsHtml +
    stepsHtml +
    (r.tips ? '<div class="recipe-tips">&#x1F4A1; ' + esc(r.tips) + '</div>' : '') +
    '</div>';

  el.style.display = "block";
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ====== COMMUNITY ====== */
async function createPost() {
  if (guardBtn("create-post")) return;
  var txt = document.getElementById("post-input").value.trim();
  if (!txt) { releaseBtn("create-post"); return toast("Ecrivez quelque chose.", "err"); }
  var btn = document.getElementById("btn-post");
  busy(btn, "Publication...");
  try {
    var result = await SB.from("community_posts").insert({ user_id: U.id, content: txt, kudos: 0 });
    if (result.error) throw result.error;
    document.getElementById("post-input").value = "";
    toast("Publie !", "ok");
    loadFeed();
    loadDashboard();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("create-post"); free(btn, "Publier"); }
}

async function giveKudos(pid, cur) {
  if (LIKED.has(pid)) return toast("Deja like !", "err");
  if (guardBtn("kudos-" + pid)) return;
  try {
    var result = await SB.from("community_posts").update({ kudos: cur + 1 }).eq("id", pid);
    if (result.error) throw result.error;
    LIKED.add(pid);
    try { localStorage.setItem("fp_likes", JSON.stringify([].concat(Array.from(LIKED)))); } catch(e) {}
    toast("Kudos !", "ok");
    loadFeed();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("kudos-" + pid); }
}

async function delPost(pid) {
  if (guardBtn("delpost-" + pid)) return;
  try {
    var result = await SB.from("community_posts").delete().eq("id", pid).eq("user_id", U.id);
    if (result.error) throw result.error;
    toast("Supprime", "ok");
    loadFeed();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("delpost-" + pid); }
}

async function loadFeed() {
  if (!SB || !U) return;
  var el = document.getElementById("feed");
  try {
    var result = await SB.from("community_posts")
      .select("id, user_id, content, kudos, created_at")
      .order("created_at", { ascending: false }).limit(25);
    if (result.error) throw result.error;
    var data = result.data;
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F465;</span>Soyez le premier a publier !</div>';
      return;
    }

    // Try to get display names
    var userIds = [];
    data.forEach(function(p) { if (userIds.indexOf(p.user_id) === -1) userIds.push(p.user_id); });
    var nameMap = {};
    try {
      var profResult = await SB.from("profiles").select("id, display_name").in("id", userIds);
      (profResult.data || []).forEach(function(pr) { nameMap[pr.id] = pr.display_name; });
    } catch(e) {}

    el.innerHTML = data.map(function(p) {
      var d = new Date(p.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      var me = p.user_id === U.id;
      var lk = LIKED.has(p.id);
      var authorName = me ? "Vous" : (nameMap[p.user_id] || "Membre");
      return '<div class="post">' +
        '<div class="post-hd">' +
        '<span class="post-author">' + esc(authorName) + '</span>' +
        '<span class="post-date">' + d + '</span>' +
        '</div>' +
        '<div class="post-body">' + esc(p.content) + '</div>' +
        '<div class="post-foot">' +
        '<button class="kudos ' + (lk ? "on" : "") + '" onclick="giveKudos(\'' + p.id + '\',' + p.kudos + ')">&#x1F44A; ' + p.kudos + '</button>' +
        (me ? '<button class="btn btn-d btn-sm" onclick="delPost(\'' + p.id + '\')">Suppr.</button>' : '') +
        '</div></div>';
    }).join("");
  } catch (e) {
    el.innerHTML = '<div class="empty" style="color:var(--red)">Erreur: ' + esc(e.message) + '</div>';
  }
}

/* ====== BODYSCAN ====== */
function handleDrop(e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); }
function handleFile(f) {
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("Image requise (JPG, PNG, WEBP).", "err");
  if (f.size > 6 * 1024 * 1024) return toast("Max 6MB.", "err");
  FILE = f;
  var r = new FileReader();
  r.onload = function(e) { document.getElementById("scan-img").src = e.target.result; };
  r.readAsDataURL(f);
  document.getElementById("scan-preview").style.display = "flex";
  document.getElementById("scan-err").style.display = "none";
}

async function doScan() {
  if (!FILE || guardBtn("do-scan")) return;
  if (isRateLimited()) { releaseBtn("do-scan"); return toast("Gemini limite. Attendez le cooldown.", "warn"); }

  var btn = document.getElementById("btn-scan");
  var errEl = document.getElementById("scan-err");
  errEl.style.display = "none";
  busy(btn, "Upload...");
  try {
    var token = await tok();
    var ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    var path = U.id + "/bodyscans/" + Date.now() + "." + ext;
    var upResult = await SB.storage.from("user_uploads").upload(path, FILE, { contentType: FILE.type });
    if (upResult.error) throw new Error("Upload: " + upResult.error.message);
    var dbResult = await SB.from("body_scans").insert({ user_id: U.id, image_path: path });
    if (dbResult.error) throw new Error("DB: " + dbResult.error.message);
    btn.textContent = "Analyse IA...";
    var r = await fetch("/api/bodyscan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ user_id: U.id, image_path: path })
    });
    var j = await r.json();
    if (r.status === 429) { activateRateLimit(j.retryAfter || 60); throw new Error(j.error || "Quota Gemini atteint."); }
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    FILE = null;
    document.getElementById("scan-preview").style.display = "none";
    document.getElementById("file-input").value = "";
    toast(j.fallback ? "Analyse en mode degrade (quota). Rechargez pour voir." : "Analyse terminee !", "ok");
    loadScans();
    loadDashboard();
  } catch (e) {
    errEl.textContent = "Erreur: " + e.message;
    errEl.style.display = "block";
  } finally {
    releaseBtn("do-scan");
    free(btn, "Analyser avec l'IA");
  }
}

async function loadScans() {
  if (!SB || !U) return;
  var el = document.getElementById("scans-list");
  try {
    var result = await SB.from("body_scans")
      .select("*").eq("user_id", U.id).order("created_at", { ascending: false }).limit(10);
    if (result.error) throw result.error;
    var data = result.data;
    if (!data || !data.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">&#x1F52C;</span>Aucune analyse. Uploadez votre premiere photo !</div>';
      return;
    }
    el.innerHTML = '<div style="display:flex;flex-direction:column;gap:11px">' + data.map(function(s) {
      var d = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
      var done = !!s.ai_feedback;
      return '<div class="scan-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-weight:800;font-size:.84rem">&#x1F4F8; ' + d + '</span>' +
        '<span class="bdg ' + (done ? "bgreen" : "borange") + '">' + (done ? "Analyse" : "En attente") + '</span>' +
        '</div>' +
        (done ?
          '<div class="scores">' +
          '<div class="schip"><div class="scval">' + (s.symmetry_score !== null ? s.symmetry_score : "--") + '</div><div class="sclbl">Symetrie</div></div>' +
          '<div class="schip"><div class="scval">' + (s.posture_score !== null ? s.posture_score : "--") + '</div><div class="sclbl">Posture</div></div>' +
          '<div class="schip"><div class="scval">' + (s.bodyfat_proxy !== null ? s.bodyfat_proxy + '%' : "--") + '</div><div class="sclbl">MG</div></div>' +
          '</div>' +
          '<div class="scan-fb">' + esc(s.ai_feedback || "") + '</div>'
          : '<div style="font-size:.79rem;color:var(--muted);font-style:italic">Analyse en attente de traitement.</div>'
        ) + '</div>';
    }).join("") + '</div>';
  } catch (e) {
    el.innerHTML = '<div class="empty" style="color:var(--red)">Erreur: ' + esc(e.message) + '</div>';
  }
}

/* ====== PROFILE ====== */
async function loadProfile() {
  if (!SB || !U) return;
  try {
    var result = await SB.from("profiles").select("display_name, weight, height").eq("id", U.id).maybeSingle();
    var data = result.data;
    var name = (data && data.display_name) || (U.email ? U.email.split("@")[0] : "?");
    setText("p-name", name);
    setText("p-email", U.email || "");
    setText("p-avatar", name.charAt(0).toUpperCase());
    document.getElementById("p-pseudo").value = (data && data.display_name) || "";
    document.getElementById("p-weight").value = (data && data.weight) || "";
    document.getElementById("p-height").value = (data && data.height) || "";
  } catch(e) { console.warn("[profile]", e.message); }
  loadStats();
}

async function saveProfile() {
  if (guardBtn("save-profile")) return;
  var name = document.getElementById("p-pseudo").value.trim();
  if (!name) { releaseBtn("save-profile"); return toast("Entrez un pseudo.", "err"); }
  var weight = parseInt(document.getElementById("p-weight").value) || null;
  var height = parseInt(document.getElementById("p-height").value) || null;
  var btn = document.getElementById("btn-save-profile");
  busy(btn, "Enregistrement...");
  try {
    var row = { id: U.id, display_name: name, updated_at: new Date().toISOString() };
    if (weight) row.weight = weight;
    if (height) row.height = height;
    var result = await SB.from("profiles").upsert(row, { onConflict: "id" });
    if (result.error) throw result.error;
    toast("Profil mis a jour", "ok");
    loadProfile();
  } catch (e) { toast("Erreur: " + e.message, "err"); }
  finally { releaseBtn("save-profile"); free(btn, "Enregistrer"); }
}

async function loadStats() {
  if (!SB || !U) return;
  try {
    var results = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id),
    ]);
    setText("st-sess", results[0].count || "0");
    setText("st-scans", results[1].count || "0");
    setText("st-posts", results[2].count || "0");
  } catch(e) {}
}

/* ====== HELPERS ====== */
async function tok() {
  var result = await SB.auth.getSession();
  return (result.data.session && result.data.session.access_token) || "";
}
function fmtD(s) {
  if (!s) return "--";
  var m = Math.floor(s / 60), r = s % 60;
  return r ? m + "min " + r + "s" : m + "min";
}
function stars(d) {
  var n = Math.round(d || 0);
  var s = "";
  for (var i = 0; i < 5; i++) s += i < n ? "\u2605" : "\u2606";
  return s;
}
function esc(v) {
  return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
var _tt;
function toast(msg, cls) {
  cls = cls || "ok";
  var el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "on " + cls;
  if (_tt) clearTimeout(_tt);
  _tt = setTimeout(function() { el.className = ""; }, 3500);
}
function busy(btn, lbl) {
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block"></span> ' + lbl;
}
function free(btn, lbl) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = lbl;
}

/* ====== INIT ====== */
boot();

/* ====== GLOBAL ALIASES ====== */
window.authTab         = authMode;
window.gotoTab         = go;
window.generateWorkout = genWorkout;
window.saveSession     = saveSess;
window.doAuth          = doAuth;
window.doLogout        = doLogout;
window.saveGoal        = saveGoal;
window.goalEdit        = goalEdit;
window.addMeal         = addMeal;
window.delMeal         = delMeal;
window.createPost      = createPost;
window.giveKudos       = giveKudos;
window.delPost         = delPost;
window.doScan          = doScan;
window.handleDrop      = handleDrop;
window.handleFile      = handleFile;
window.saveProfile     = saveProfile;
window.generateNutrition = generateNutrition;
window.generateRecipe  = generateRecipe;
window.loadFeed        = loadFeed;
