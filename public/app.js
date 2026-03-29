"use strict";

let SB = null;
let U = null;
let MODE = "login";
let PLAN = null;
let FILE = null;
let COACH_HISTORY = [];
const MAX_COACH_HISTORY = 20;
let AUTH_ERROR_COUNT = 0;
const MAX_AUTH_ERRORS = 3;
const LIKED = new Set((() => {
  try { return JSON.parse(localStorage.getItem("fp_likes") || "[]"); }
  catch { return []; }
})());
const ASYNC_LOCKS = new Set();
let POST_PHOTO = null;
let FEED_FILTER = "all";
let LAST_COACH_PROMPT = "";
let USER_WEIGHT = null; // kg, loaded from profile — used to compute water target
let _appReady = false; // guards against double-call of showApp() from onAuthStateChange + getSession()

const GOAL_LABELS = {
  prise_de_masse: "💪 Prise de masse",
  perte_de_poids: "🔥 Perte de poids",
  endurance: "🏃 Endurance",
  force: "🏋️ Force",
  remise_en_forme: "🌟 Remise en forme",
  maintien: "⚖️ Maintien"
};

// ── DataCache — SWR-equivalent (stale-while-revalidate) ──────────────────────
const DataCache = (() => {
  const store = {};
  return {
    get(key) {
      const item = store[key];
      if (!item) return null;
      if (Date.now() > item.expires) { delete store[key]; return null; }
      return item.data;
    },
    set(key, data, ttlMs = 60000) {
      store[key] = { data, expires: Date.now() + ttlMs };
    },
    del(key) { delete store[key]; },
    bust(prefix) {
      Object.keys(store).forEach(k => { if (k.startsWith(prefix)) delete store[k]; });
    }
  };
})();

// ── Lazy image loading via IntersectionObserver ───────────────────────────────
const lazyObserver = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute("data-src");
            lazyObserver.unobserve(img);
          }
        }
      });
    }, { rootMargin: "200px" })
  : null;

function lazyImg(src, alt = "", cls = "", style = "") {
  // Returns img HTML with data-src for lazy loading
  return `<img data-src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""} loading="lazy" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"/>`;
}

function observeLazyImgs(container) {
  if (!lazyObserver || !container) return;
  container.querySelectorAll("img[data-src]").forEach(img => lazyObserver.observe(img));
}

function escapeAttr(str) {
  return String(str || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}


async function sbSafeSingle(query) {
  try {
    const res = await query;
    return res && typeof res === "object" ? res : { data: null, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

async function sbSafeList(query) {
  try {
    const res = await query;
    const data = Array.isArray(res?.data) ? res.data : [];
    return { ...(res || {}), data };
  } catch (e) {
    return { data: [], error: e };
  }
}

function coachGoalLabel(goal) {
  return {
    prise_de_masse: "Prise de masse",
    perte_de_poids: "Perte de poids",
    endurance: "Endurance",
    force: "Force",
    remise_en_forme: "Remise en forme",
    maintien: "Maintien"
  }[String(goal || "")] || "Objectif libre";
}

function buildCoachPriorityLine(ctx = {}) {
  const parts = [];
  if (ctx.lastScanFocus) parts.push(`Focus scan: ${ctx.lastScanFocus}`);
  if (ctx.recentSessions7d > 0) parts.push(`${ctx.recentSessions7d} séance${ctx.recentSessions7d > 1 ? 's' : ''} sur 7 jours`);
  if (ctx.todayProtein > 0) parts.push(`${ctx.todayProtein}g prot. aujourd'hui`);
  if (ctx.currentStreak > 0) parts.push(`streak ${ctx.currentStreak}j`);
  return parts.length ? parts.join(' · ') : 'On réduit la friction et on avance avec une action claire.';
}

function coachMoodPrompt(kind) {
  const prompts = {
    low: "J'ai la flemme aujourd'hui. Recadre-moi sans me culpabiliser et donne-moi l'action minimale la plus intelligente.",
    medium: "Je suis moyen aujourd'hui. Donne-moi une séance courte mais utile et réaliste.",
    high: "Je me sens bien. Donne-moi le meilleur focus du jour pour progresser sans perdre en qualité.",
    recover: "Je suis fatigué ou j'ai mal dormi. Adapte ma journée entre récupération active, mobilité et séance très légère."
  };
  return prompts[kind] || prompts.medium;
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT & INITIALISATION
// ══════════════════════════════════════════════════════════════════════════════

async function boot() {
  bootMsg("Chargement du SDK…");

  // 1. Charger le SDK Supabase
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
  } catch (e) {
    return bootError("Impossible de charger le SDK Supabase. Vérifiez votre connexion internet.");
  }

  // 2. Récupérer la configuration
  bootMsg("Récupération de la configuration…");
  let cfg;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch("/api/config", {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timeout);
    cfg = await r.json();
    if (!r.ok || !cfg.ok) {
      throw new Error(cfg.message || cfg.error || `Erreur serveur (HTTP ${r.status})`);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      return bootError("Timeout: le serveur ne répond pas. Réessayez plus tard.");
    }
    return bootError(`Configuration invalide: ${e.message}`);
  }

  // 3. Valider l'URL Supabase côté client
  if (!cfg.supabaseUrl || !cfg.supabaseUrl.includes(".supabase.co")) {
    return bootError("URL Supabase invalide. Vérifiez la configuration Vercel.");
  }

  // 3b. Health check — vérifier que Supabase est joignable AVANT de créer le client
  bootMsg("Vérification de Supabase…");
  try {
    const hc = new AbortController();
    const hcTimer = setTimeout(() => hc.abort(), 8000);
    const healthRes = await fetch(cfg.supabaseUrl + "/auth/v1/health", {
      signal: hc.signal,
      headers: { "apikey": cfg.supabaseAnonKey }
    });
    clearTimeout(hcTimer);

    if (!healthRes.ok) {
      const st = healthRes.status;
      if (st === 401 || st === 403) {
        return bootError(
          "Clé Supabase invalide ou ne correspond pas au projet.\n" +
          "→ Supabase Dashboard → Settings → API → utilisez soit la clé anon/public legacy, soit la publishable key\n" +
          "→ Vercel Dashboard → Settings → Environment Variables → SUPABASE_ANON_KEY ou SUPABASE_PUBLISHABLE_KEY"
        );
      }
      return bootError(
        "Supabase a répondu avec une erreur (HTTP " + st + ").\n" +
        "Vérifiez que votre projet Supabase est actif:\n" +
        "→ https://supabase.com/dashboard/projects"
      );
    }
  } catch (e) {
    if (e.name === "AbortError") {
      return bootError(
        "Supabase ne répond pas (timeout 8s).\n\n" +
        "Causes probables:\n" +
        "• Projet Supabase pausé (free tier = pause après 7j d'inactivité)\n" +
        "• URL incorrecte dans SUPABASE_URL\n\n" +
        "→ https://supabase.com/dashboard/projects → Restore project\n" +
        "→ Puis redéployez sur Vercel"
      );
    }
    return bootError(
      "Impossible de joindre Supabase.\n\n" +
      "Causes probables:\n" +
      "• Projet Supabase pausé (free tier = pause auto après inactivité)\n" +
      "• URL incorrecte: " + cfg.supabaseUrl + "\n\n" +
      "→ https://supabase.com/dashboard/projects → Restore project\n" +
      "→ Vérifiez SUPABASE_URL dans Vercel"
    );
  }

  // 4. Initialiser le client Supabase
  bootMsg("Connexion à Supabase…");
  try {
    SB = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storageKey: "fitai_auth",
        storage: window.localStorage
      }
    });
  } catch (e) {
    return bootError(`Erreur création client Supabase: ${e.message}`);
  }

  // 5. Écouter les changements d'authentification
  SB.auth.onAuthStateChange((event, session) => {
    if (typeof window !== "undefined" && window.__FITAI_DEBUG__) console.log("[Auth]", event, session?.user?.email || "no user");

    if (event === "TOKEN_REFRESHED") {
      AUTH_ERROR_COUNT = 0;
    }

    if (event === "SIGNED_OUT" || !session) {
      U = null;
      showAuth();
      return;
    }

    if (session?.user) {
      U = session.user;
      AUTH_ERROR_COUNT = 0;
      showApp();
    }
  });

  // 6. Vérifier la session existante
  bootMsg("Vérification de la session…");
  try {
    const { data, error } = await SB.auth.getSession();

    if (error) {
      console.error("[Auth] getSession error:", error);
      // Si erreur de session, nettoyer et afficher login
      await clearLocalSession();
      hideBoot();
      showAuth();
      return;
    }

    hideBoot();

    if (data?.session?.user) {
      U = data.session.user;
      showApp();
    } else {
      showAuth();
    }
  } catch (e) {
    console.error("[Auth] Session check failed:", e);
    // Erreur réseau probable (CORS, offline, etc.)
    if (isCorsOrNetworkError(e)) {
      return bootError(
        "Erreur de connexion à Supabase.\n\n" +
        "• Vérifiez votre connexion internet\n" +
        "• Le projet Supabase est peut-être pausé\n" +
        "→ https://supabase.com/dashboard/projects"
      );
    }
    await clearLocalSession();
    hideBoot();
    showAuth();
  }
}

function isCorsOrNetworkError(error) {
  if (!error) return false;
  const msg = String(error.message || error).toLowerCase();
  return msg.includes("network") ||
         msg.includes("cors") ||
         msg.includes("failed to fetch") ||
         msg.includes("load failed") ||
         msg.includes("fetch");
}

async function clearLocalSession() {
  try {
    localStorage.removeItem("fitai_auth");
    localStorage.removeItem("supabase.auth.token");
    // Nettoyer toutes les clés Supabase
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith("sb-") || key.includes("supabase")) {
        localStorage.removeItem(key);
      }
    });
    if (SB) {
      try { await SB.auth.signOut({ scope: "local" }); } catch (_) {}
    }
  } catch (e) {
    console.error("[Auth] clearLocalSession error:", e);
  }
}

function bootMsg(message) {
  const el = document.getElementById("boot-msg");
  if (el) el.textContent = message;
}

function bootError(message) {
  const sp = document.getElementById("boot-sp");
  const msg = document.getElementById("boot-msg");
  const err = document.getElementById("boot-err");
  if (sp) sp.style.display = "none";
  if (msg) msg.style.display = "none";
  if (err) {
    err.style.display = "block";
    err.innerHTML = message.replace(/\n/g, "<br>");
  }
}

function hideBoot() {
  const bootEl = document.getElementById("boot");
  if (!bootEl) return;
  bootEl.classList.add("hidden");
  setTimeout(() => { bootEl.style.display = "none"; }, 450);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Échec chargement: ${src}`));
    document.head.appendChild(script);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTHENTIFICATION
// ══════════════════════════════════════════════════════════════════════════════

function showAuth() {
  _appReady = false;
  _nutrTargetsCache = null;
  const auth = document.getElementById("auth");
  const app = document.getElementById("app");
  if (auth) auth.style.display = "flex";
  if (app) app.classList.remove("on");
}

function showApp() {
  const auth = document.getElementById("auth");
  const app = document.getElementById("app");
  if (auth) auth.style.display = "none";
  if (app) app.classList.add("on");
  // Guard: only run full initialization once per session to avoid
  // double-invocation from onAuthStateChange + getSession() both firing.
  if (_appReady) return;
  _appReady = true;
  const tu = document.getElementById("tu");
  if (tu) tu.textContent = U?.email || "Membre";
  ensureCriticalUI();
  applyStoredTheme();
  gotoTab("dashboard");
}

function authMode(mode) {
  MODE = mode;
  const tabLogin = document.getElementById("atab-login");
  const tabSignup = document.getElementById("atab-signup");
  const btn = document.getElementById("auth-btn");
  if (tabLogin) tabLogin.classList.toggle("on", mode === "login");
  if (tabSignup) tabSignup.classList.toggle("on", mode === "signup");
  if (btn) btn.textContent = mode === "login" ? "Se connecter" : "S'inscrire";
  setAuthMessage("", "");
}

function setAuthMessage(text, cls) {
  const el = document.getElementById("auth-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `auth-msg ${cls ? `auth-${cls}` : ""}`;
}

async function doAuth() {
  const emailEl = document.getElementById("a-email");
  const pwdEl = document.getElementById("a-pwd");
  const email = emailEl ? emailEl.value.trim() : "";
  const password = pwdEl ? pwdEl.value : "";

  if (!email || !password) {
    return setAuthMessage("Email et mot de passe requis.", "err");
  }

  if (password.length < 6) {
    return setAuthMessage("Mot de passe: 6 caractères minimum.", "err");
  }

  const btn = document.getElementById("auth-btn");
  const label = MODE === "login" ? "Connexion…" : "Inscription…";

  await withButton(btn, label, async () => {
    setAuthMessage("", "");

    try {
      let result;

      if (MODE === "login") {
        result = await SB.auth.signInWithPassword({ email, password });
      } else {
        result = await SB.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin
          }
        });
      }

      if (result.error) {
        throw result.error;
      }

      if (MODE === "signup") {
        // Vérifier si l'email doit être confirmé
        if (result.data?.user && !result.data.session) {
          setAuthMessage("Compte créé ! Vérifiez vos emails pour confirmer.", "ok");
        } else if (result.data?.session) {
          // Auto-confirm activé, l'utilisateur est connecté
          setAuthMessage("Compte créé et connecté !", "ok");
        }
      }

    } catch (e) {
      console.error("[Auth] Error:", e);

      // Traduire les erreurs courantes
      let msg = e.message || "Erreur d'authentification";

      if (isCorsOrNetworkError(e)) {
        msg = "Impossible de joindre Supabase. Votre projet est peut-être pausé → supabase.com/dashboard";
      } else if (msg.includes("Signups not allowed")) {
        msg = "Inscriptions désactivées. Supabase Dashboard → Authentication → Settings → Enable Sign Up";
      } else if (msg.includes("Invalid login")) {
        msg = "Email ou mot de passe incorrect.";
      } else if (msg.includes("Email not confirmed")) {
        msg = "Email non confirmé. Vérifiez votre boîte mail.";
      } else if (msg.includes("User already registered")) {
        msg = "Cet email est déjà utilisé. Connectez-vous ou utilisez un autre email.";
      } else if (msg.includes("Password should be")) {
        msg = "Mot de passe trop faible. Utilisez au moins 6 caractères.";
      } else if (msg.includes("rate limit")) {
        msg = "Trop de tentatives. Attendez quelques minutes.";
      }

      setAuthMessage(msg, "err");
    }
  });
}

async function doLogout() {
  try {
    await SB.auth.signOut();
  } catch (e) {
    console.error("[Auth] Logout error:", e);
  }
  await clearLocalSession();
  U = null;
  showAuth();
}

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

function gotoTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("on"));
  document.querySelectorAll(".bnav-btn").forEach((btn) => btn.classList.remove("on"));
  document.getElementById(`t-${name}`)?.classList.add("on");
  document.getElementById(`n-${name}`)?.classList.add("on");
  const scroll = document.getElementById("scroll");
  if (scroll) scroll.scrollTop = 0;

  if (name === "dashboard") loadDashboard();
  if (name === "goal") loadGoal();
  if (name === "coach") { loadCoachHistory(); loadHistory(); }
  if (name === "nutrition") { loadMeals(); loadRecipeHistory(); loadNutritionWeekChart(); loadCommunityRecipes(); }
  if (name === "community") loadFeed();
  if (name === "friends") { loadFriends(); loadFriendRequests(); }
  if (name === "bodyscan") loadScans();
  if (name === "progress") loadProgress();
  if (name === "defis") loadDefis();
  if (name === "programme") loadProgramme();
  if (name === "profile") {
    loadProfile();
    loadStats();
    loadAchievements();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UI SAFETY
// ══════════════════════════════════════════════════════════════════════════════


function ensureCriticalUI() {
  ["community", "friends", "profile"].forEach((tab) => {
    const nav = document.getElementById(`n-${tab}`);
    const pane = document.getElementById(`t-${tab}`);
    if (nav) nav.style.display = "";
    if (pane) pane.style.display = pane.classList.contains("on") ? "flex" : "";
  });
  const recipeCard = document.getElementById("nutrition-recipe-card");
  if (recipeCard) recipeCard.style.display = "";
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

async function loadDashboard() {
  showGlobalLoader(true, "Chargement du dashboard…");
  try {
    // Dynamic date
    const dateEl = document.getElementById("db-date");
    if (dateEl) {
      const now = new Date();
      dateEl.textContent = "📅 " + now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    }
    // Greet with name
    const greetEl = document.getElementById("db-greet-name");
    const sidebarName = document.getElementById("tu");
    if (greetEl && U) {
      try {
        const { data } = await SB.from("profiles").select("display_name,username,age,weight,height").eq("id", U.id).maybeSingle();
        const name = data?.display_name || data?.username || U.email?.split("@")[0] || "Champion";
        greetEl.textContent = name;
        if (sidebarName) sidebarName.textContent = name;
        // Update goal card
        const goalText = document.getElementById("db-goal-text");
        if (goalText) goalText.textContent = `Objectif de ${name}`;
      } catch {
        const name = U.email?.split("@")[0] || "Champion";
        greetEl.textContent = name;
        if (sidebarName) sidebarName.textContent = name;
      }
    }
    await Promise.all([loadGoal(), loadMeals(), loadStats(), loadNutritionTargets(), loadStreak()]);
    if (typeof renderDailyChallengesSection === "function") renderDailyChallengesSection();
    renderWater();
    loadWeeklyPlan();
    loadScanMiniTile();
    restoreMoodSelection();
  } catch (e) {
    console.error("[Dashboard] Error:", e);
  }
  showGlobalLoader(false);
}

// ── V2 MOOD TRACKER ──────────────────────────────────────────────────────────
const MOOD_LABELS = { 1: "Épuisé", 2: "Fatigué", 3: "Neutre", 4: "Bien", 5: "En forme" };
const MOOD_COACH_MSGS = {
  1: "Je suis épuisé aujourd'hui. Adapte ma séance : propose quelque chose de très léger ou de la récupération active.",
  2: "Je me sens fatigué. Propose une séance courte et modérée, rien d'intense.",
  3: "Je me sens neutre. Lance-moi une séance standard selon mes objectifs.",
  4: "Je me sens bien ! Propose une séance normale à intense selon mon objectif.",
  5: "Je suis en pleine forme aujourd'hui ! Pousse-moi avec une séance intense selon mon objectif."
};

function selectMood(btn, level) {
  document.querySelectorAll(".mood-face").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  const startBtn = document.getElementById("mood-start-btn");
  if (startBtn) startBtn.classList.add("active");
  const label = MOOD_LABELS[level] || "";
  try {
    localStorage.setItem("fitai_mood", String(level));
    localStorage.setItem("fitai_mood_label", label);
    localStorage.setItem("fitai_mood_date", new Date().toDateString());
  } catch {}
  // Persist to Supabase daily_moods table
  if (U) {
    const today = new Date().toISOString().slice(0, 10);
    SB.from("daily_moods")
      .upsert({ user_id: U.id, mood_level: level, mood_label: label, date: today }, { onConflict: "user_id,date" })
      .then(({ error }) => { if (error) console.warn("[mood] save failed:", error.message); })
      .catch((err) => console.warn("[mood] promise rejected:", err));
  }
}

function startWithMood() {
  const level = parseInt(localStorage.getItem("fitai_mood") || "0");
  gotoTab("coach");
  if (level >= 1 && level <= 5 && localStorage.getItem("fitai_mood_date") === new Date().toDateString()) {
    setTimeout(() => sendCoachMsg(MOOD_COACH_MSGS[level]), 300);
  }
}

function restoreMoodSelection() {
  // First restore from localStorage (instant)
  try {
    const saved = localStorage.getItem("fitai_mood");
    const savedDate = localStorage.getItem("fitai_mood_date");
    if (saved && savedDate === new Date().toDateString()) {
      document.querySelectorAll(".mood-face").forEach(b => {
        if (b.dataset.v === saved) b.classList.add("selected");
      });
      const startBtn = document.getElementById("mood-start-btn");
      if (startBtn) startBtn.classList.add("active");
    }
  } catch {}
  // Then sync from Supabase (persistent across devices)
  if (U) {
    const today = new Date().toISOString().slice(0, 10);
    SB.from("daily_moods").select("mood_level,mood_label").eq("user_id", U.id).eq("date", today).maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        document.querySelectorAll(".mood-face").forEach(b => b.classList.remove("selected"));
        document.querySelectorAll(".mood-face").forEach(b => {
          if (b.dataset.v === String(data.mood_level)) b.classList.add("selected");
        });
        const startBtn = document.getElementById("mood-start-btn");
        if (startBtn) startBtn.classList.add("active");
        try {
          localStorage.setItem("fitai_mood", String(data.mood_level));
          localStorage.setItem("fitai_mood_label", data.mood_label || "");
          localStorage.setItem("fitai_mood_date", new Date().toDateString());
        } catch {}
      }).catch((err) => console.warn("[mood] restore failed:", err));
  }
}

// ── V2 SCAN IA MINI TILE ─────────────────────────────────────────────────────
async function loadScanMiniTile() {
  if (!U) return;
  const scoreEl = document.getElementById("scan-mini-score");
  const ringsEl = document.getElementById("scan-mini-rings");
  try {
    const { data } = await SB.from("body_scans")
      .select("physical_score,symmetry_score,posture_score,bodyfat_proxy,ai_feedback,extended_analysis")
      .eq("user_id", U.id)
      .not("ai_feedback", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      if (scoreEl) scoreEl.textContent = "—";
      if (ringsEl) ringsEl.innerHTML = '<div class="scan-no-data">Aucun scan · Tapez pour analyser</div>';
      return;
    }

    const score = data.physical_score || 0;
    if (scoreEl) scoreEl.textContent = score + "%";

    // Progress rings: Symétrie, Posture, Compo (bodyfat proxy inverted → "Définition")
    const sym  = Math.min(100, Math.max(0, data.symmetry_score  || 0));
    const post = Math.min(100, Math.max(0, data.posture_score   || 0));
    // bodyfat_proxy is a % of fat — lower is better; convert to definition score
    const bfRaw = data.extended_analysis?.score_breakdown?.body_composition ?? data.bodyfat_proxy ?? 50;
    const def  = Math.min(100, Math.max(0, Math.round(100 - bfRaw)));

    const ringR = 14;
    const ringC = 2 * Math.PI * ringR;
    function ring(pct, color, label) {
      const filled = ringC * (pct / 100);
      return `<div class="ring-item">
        <svg class="ring-svg" width="36" height="36" viewBox="0 0 36 36">
          <circle class="ring-track" cx="18" cy="18" r="${ringR}"/>
          <circle class="ring-fill" cx="18" cy="18" r="${ringR}" stroke="${color}" stroke-dasharray="${filled.toFixed(1)} ${ringC.toFixed(1)}"/>
        </svg>
        <div class="ring-lbl">${label}</div>
      </div>`;
    }

    if (ringsEl) {
      ringsEl.innerHTML =
        ring(sym,  "#00FFFF", "Sym.") +
        ring(post, "#a855f7", "Post.") +
        ring(def,  "#22c55e", "Déf.");
    }

    // Update hidden compat counter
    const countEl = document.getElementById("db-scans");
    if (countEl) countEl.textContent = "1+";

  } catch (e) {
    console.warn("[ScanMini] load error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// OBJECTIF
// ══════════════════════════════════════════════════════════════════════════════

// ── Goal visual selectors ──────────────────────────────────────────────────────
function selectGoalType(val) {
  const el = document.getElementById("g-type");
  if (el) el.value = val;
  document.querySelectorAll(".goal-type-btn").forEach(b => b.classList.toggle("on", b.dataset.val === val));
}
function selectGoalLevel(val) {
  const el = document.getElementById("g-level");
  if (el) el.value = val;
  document.querySelectorAll(".goal-level-tab").forEach(b => b.classList.toggle("on", b.dataset.val === val));
}
function selectGoalSessions(val) {
  const el = document.getElementById("g-sessions");
  if (el) el.value = val;
  document.querySelectorAll(".goal-session-pill").forEach(b => b.classList.toggle("on", b.dataset.val === val));
}
function selectGoalEquip(val) {
  const el = document.getElementById("g-equipment");
  if (el) el.value = val;
  document.querySelectorAll(".goal-equip-chip").forEach(b => b.classList.toggle("on", b.dataset.val === val));
}

async function loadGoal() {
  if (!U) return;
  try {
    const { data, error } = await SB.from("goals").select("*").eq("user_id", U.id).maybeSingle();
    if (error) throw error;

    const goalForm = document.getElementById("goal-form");
    const goalView = document.getElementById("goal-view");
    if (goalForm) goalForm.style.display = data ? "none" : "block";
    if (goalView) goalView.style.display = data ? "block" : "none";

    if (!data) return;

    // Populate form hidden inputs + visual selectors (for editing)
    if (data.type) selectGoalType(data.type);
    if (data.level) selectGoalLevel(data.level);
    const storedSessions = localStorage.getItem("fitai_goal_sessions") || "";
    if (storedSessions) selectGoalSessions(storedSessions);
    selectGoalEquip(data.equipment || "");
    const gText = document.getElementById("g-text");
    const gConstraints = document.getElementById("g-constraints");
    if (gText) gText.value = data.text || "";
    if (gConstraints) gConstraints.value = data.constraints || "";

    // Hero view card
    const GOAL_ICONS = { prise_de_masse:"💪", perte_de_poids:"🔥", endurance:"🏃", force:"🏋️", remise_en_forme:"🌟", maintien:"⚖️" };
    const EQUIP_LABELS = { "":"Poids du corps", halteres:"Haltères", barre:"Barre", salle:"Salle complète", kettlebell:"Kettlebell", elastiques:"Élastiques" };
    const LEVEL_SHORT = { debutant:"Débutant", intermediaire:"Inter.", avance:"Avancé", elite:"Élite" };
    const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setEl("goal-hero-icon", GOAL_ICONS[data.type] || "🎯");
    setEl("goal-hero-title", GOAL_LABELS[data.type] || data.type || "Mon objectif");
    setEl("goal-hero-sub", data.text ? data.text.slice(0, 80) : "Objectif personnalisé");
    setEl("gs-level", LEVEL_SHORT[data.level] || data.level || "—");
    const storedSess = localStorage.getItem("fitai_goal_sessions") || "";
    setEl("gs-sessions", storedSess ? `${storedSess}×/sem` : "—");
    setEl("gs-equip", EQUIP_LABELS[data.equipment || ""] || "Poids du corps");
  } catch (e) {
    console.error("[Goal] Load error:", e);
  }
}

function goalEdit() {
  const goalView = document.getElementById("goal-view");
  const goalForm = document.getElementById("goal-form");
  if (goalView) goalView.style.display = "none";
  if (goalForm) goalForm.style.display = "block";
  // Scroll to top of form
  if (goalForm) goalForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveGoal() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const type  = document.getElementById("g-type")?.value  || "";
  const level = document.getElementById("g-level")?.value || "";
  if (!type)  return toast("Sélectionne un type d'objectif.", "err");
  if (!level) return toast("Sélectionne ton niveau.", "err");

  // sessions_per_week stored locally (column may not exist in DB)
  const sessionsRaw = document.getElementById("g-sessions")?.value || "";
  if (sessionsRaw) {
    try { localStorage.setItem("fitai_goal_sessions", sessionsRaw); } catch {}
  }

  const payload = {
    user_id: U.id,
    type,
    level,
    text: (document.getElementById("g-text")?.value || "").trim(),
    constraints: (document.getElementById("g-constraints")?.value || "").trim(),
    equipment: document.getElementById("g-equipment")?.value || "",
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

// ══════════════════════════════════════════════════════════════════════════════
// COACH IA
// ══════════════════════════════════════════════════════════════════════════════

// ── Coach Chat Memory ──
function loadCoachHistory() {
  try {
    const stored = localStorage.getItem("fp_coach_history");
    if (stored) COACH_HISTORY = JSON.parse(stored);
  } catch { COACH_HISTORY = []; }
  renderCoachChat();
  loadCoachStats();
}

async function loadCoachStats() {
  if (!U) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekAgoDate = weekAgoIso.slice(0, 10);
    const [streakRes, goalRes, profileRes, weekMealsRes, sessionsRes, scanRes] = await Promise.all([
      sbSafeSingle(SB.from("user_streaks").select("current_streak,total_workouts").eq("user_id", U.id).maybeSingle()),
      sbSafeSingle(SB.from("goals").select("level,type,constraints,equipment").eq("user_id", U.id).maybeSingle()),
      sbSafeSingle(SB.from("profiles").select("display_name,weight,height,age").eq("id", U.id).maybeSingle()),
      sbSafeList(SB.from("meals").select("calories,protein,name,date").eq("user_id", U.id).gte("date", weekAgoDate)),
      sbSafeList(SB.from("workout_sessions").select("created_at,plan").eq("user_id", U.id).gte("created_at", weekAgoIso)),
      sbSafeList(SB.from("body_scans").select("physical_score,created_at,extended_analysis,ai_feedback").eq("user_id", U.id).order("created_at", { ascending: false }).limit(1))
    ]);

    const streak = Number(streakRes?.data?.current_streak || 0);
    const totalWorkouts = Number(streakRes?.data?.total_workouts || 0);
    const level = goalRes?.data?.level || "";
    const goalType = goalRes?.data?.type || "";
    const weekMeals = weekMealsRes?.data || [];
    const weekKcal = weekMeals.reduce((s, m) => s + (Number(m.calories) || 0), 0);
    const avgWeekKcal = weekMeals.length ? Math.round(weekKcal / 7) : 0;
    const todayMeals = weekMeals.filter((m) => String(m.date || "") === today);
    const todayProtein = Math.round(todayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0));
    const sessions7d = (sessionsRes?.data || []).length;
    const lastScan = scanRes?.data?.[0] || null;
    const LEVEL_LABELS = { beginner: "Débutant", intermediate: "Inter.", advanced: "Expert", debutant: "Débutant", intermediaire: "Inter.", avance: "Expert" };

    window._coachDisplayName = profileRes?.data?.display_name || U?.email?.split("@")[0] || "";

    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl("cs-energy", streak > 0 ? `${streak}j` : "0j");
    setEl("cs-week", sessions7d || totalWorkouts || "0");
    setEl("cs-level", LEVEL_LABELS[level] || level || "—");
    setEl("cs-kcal", avgWeekKcal > 0 ? `${avgWeekKcal}` : "—");

    let moodLabel = "";
    try {
      const savedMood = localStorage.getItem("fitai_mood");
      const savedMoodDate = localStorage.getItem("fitai_mood_date");
      if (savedMood && savedMoodDate === new Date().toDateString()) {
        moodLabel = MOOD_LABELS[parseInt(savedMood)] || "";
      }
    } catch {}

    const coachSubLine = document.getElementById("coach-sub-line");
    if (coachSubLine) {
      const parts = [coachGoalLabel(goalType)];
      if (LEVEL_LABELS[level]) parts.push(LEVEL_LABELS[level]);
      if (moodLabel) parts.push(moodLabel);
      coachSubLine.textContent = parts.filter(Boolean).join(" · ");
    }

    const lastScanFocus = lastScan?.extended_analysis?.areas_for_improvement?.[0]
      || lastScan?.extended_analysis?.personalized_recommendations?.training?.[0]
      || String(lastScan?.ai_feedback || "").split(/[.!?]/)[0]
      || "";
    const priorityEl = document.getElementById("coach-priority-line");
    if (priorityEl) {
      priorityEl.textContent = buildCoachPriorityLine({
        lastScanFocus,
        recentSessions7d: sessions7d,
        todayProtein,
        currentStreak: streak
      });
    }

    if (!COACH_HISTORY.length) renderCoachChat();
  } catch {}
}

function saveCoachHistory() {
  try {
    if (COACH_HISTORY.length > MAX_COACH_HISTORY) {
      COACH_HISTORY = COACH_HISTORY.slice(-MAX_COACH_HISTORY);
    }
    localStorage.setItem("fp_coach_history", JSON.stringify(COACH_HISTORY));
  } catch {}
}

function renderCoachChat() {
  const el = document.getElementById("chat-messages");
  if (!el) return;

  const userInitial = (U?.email?.split("@")[0] || "U").slice(0, 1).toUpperCase();

  if (!COACH_HISTORY.length) {
    const userName = window._coachDisplayName || U?.email?.split("@")[0] || "toi";
    // Mood-aware greeting
    let moodLine = "";
    try {
      const savedMood = localStorage.getItem("fitai_mood");
      const savedMoodDate = localStorage.getItem("fitai_mood_date");
      if (savedMood && savedMoodDate === new Date().toDateString()) {
        const m = parseInt(savedMood);
        if (m <= 2) moodLine = `<div style="margin-top:7px;font-size:.8rem;color:#f87171;font-weight:600">Je vois que tu es fatigué aujourd'hui — je vais adapter tes recommandations.</div>`;
        else if (m >= 4) moodLine = `<div style="margin-top:7px;font-size:.8rem;color:#4ade80;font-weight:600">Tu es en forme aujourd'hui — parfait pour pousser un peu plus fort !</div>`;
      }
    } catch {}
    const aiAvat = `<div class="chat-avatar" style="background:linear-gradient(135deg,#1d4ed8,#0891b2)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></div>`;
    el.innerHTML = `
      <div class="chat-msg chat-msg-ai">
        ${aiAvat}
        <div class="chat-bubble ai-bubble">
          <div class="coach-card-head"><span class="coach-card-kicker">Coach personnel</span><strong>Salut ${escapeHtml(userName)}. On fait simple, utile et actionnable.</strong></div>
          <div class="coach-p">Dis-moi ton état du jour et je te donne soit une séance, soit une adaptation récupération, soit un plan nutrition rapide.</div>
          ${moodLine}
          <div class="coach-inline-note">Choisis une action rapide ou écris ton vrai contexte.</div>
        </div>
      </div>`;
    return;
  }

  const aiAvatar = `<div class="chat-avatar" style="background:linear-gradient(135deg,#1d4ed8,#0891b2)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></div>`;

  el.innerHTML = COACH_HISTORY.map(msg => {
    if (msg.role === "user") {
      return `<div class="chat-msg chat-msg-user"><div class="chat-user-avatar">${userInitial}</div><div class="chat-bubble user-bubble"><div class="chat-role-label">Toi</div>${escapeHtml(msg.content)}<span class="chat-time" style="color:rgba(255,255,255,.58)">${msg.time || ""}</span></div></div>`;
    } else {
      return `<div class="chat-msg chat-msg-ai">${aiAvatar}<div class="chat-bubble ai-bubble"><div class="chat-role-label">Coach</div>${sanitizeCoachHtml(msg.content)}<span class="chat-time">${msg.time || ""}</span></div></div>`;
    }
  }).join("");

  el.scrollTop = el.scrollHeight;
}

async function sendCoachMsg(quickMsg) {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  const coachInput = document.getElementById("coach-input");
  const prompt = quickMsg || (coachInput ? coachInput.value.trim() : "");
  const errorEl = document.getElementById("coach-err");
  if (errorEl) { errorEl.style.display = "none"; errorEl.innerHTML = ""; }
  if (!prompt) return;
  LAST_COACH_PROMPT = prompt;
  if (coachInput) coachInput.value = "";

  if (ASYNC_LOCKS.has("coach-msg")) return;
  ASYNC_LOCKS.add("coach-msg");

  const now = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  COACH_HISTORY.push({ role: "user", content: prompt, time: now });
  saveCoachHistory();
  renderCoachChat();

  const chatEl = document.getElementById("chat-messages");
  if (chatEl) setTimeout(() => { chatEl.scrollTop = chatEl.scrollHeight; }, 50);

  const quickEl = document.getElementById("chat-quick");
  if (quickEl && COACH_HISTORY.length > 1) {
    quickEl.classList.add("compact");
    const tog = document.getElementById("chat-suggest-toggle");
    if (tog) tog.style.display = "block";
  }

  const btn = document.getElementById("btn-gen");
  if (btn) btn.disabled = true;

  if (chatEl) {
    chatEl.insertAdjacentHTML("beforeend", '<div class="chat-msg chat-msg-ai" id="coach-thinking"><div class="chat-avatar coach-ai-avatar">⚡</div><div class="chat-bubble ai-bubble coach-thinking-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  try {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    const today = new Date().toISOString().slice(0, 10);
    const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
    const [goalRes, profileRes, streakRes, recentSessionsRes, scanRes, mealsTodayRes, mealsWeekRes] = await Promise.all([
      sbSafeSingle(SB.from("goals").select("type,level,constraints,equipment").eq("user_id", U.id).maybeSingle()),
      sbSafeSingle(SB.from("profiles").select("display_name,weight,height,age").eq("id", U.id).maybeSingle()),
      sbSafeSingle(SB.from("user_streaks").select("current_streak,total_workouts").eq("user_id", U.id).maybeSingle()),
      sbSafeList(SB.from("workout_sessions").select("plan,created_at").eq("user_id", U.id).gte("created_at", weekAgoIso).order("created_at", { ascending: false }).limit(5)),
      sbSafeList(SB.from("body_scans").select("physical_score,created_at,extended_analysis,ai_feedback").eq("user_id", U.id).order("created_at", { ascending: false }).limit(3)),
      sbSafeList(SB.from("meals").select("name,calories,protein").eq("user_id", U.id).eq("date", today)),
      sbSafeList(SB.from("meals").select("name,calories,protein,date").eq("user_id", U.id).gte("date", today.slice(0,8) + "01").limit(12))
    ]);

    const goalContext = goalRes?.data || {};
    const dbProfile = profileRes?.data || {};
    const currentStreak = Number(streakRes?.data?.current_streak || 0);
    const totalWorkouts = Number(streakRes?.data?.total_workouts || 0);
    const historyForApi = COACH_HISTORY.slice(-15, -1).map((m) => ({
      role: m.role,
      content: m.role === "ai" ? stripHtml(m.content).slice(0, 400) : m.content
    }));

    const recentSessions = recentSessionsRes?.data || [];
    const recentWorkoutNames = recentSessions.map(s => s.plan?.title || "Séance").filter(Boolean).slice(0, 4);
    const recentSessions7d = recentSessions.length;
    const scans = scanRes?.data || [];
    const lastScan = scans[0] || null;
    const bestScanScore = scans.reduce((best, s) => Math.max(best, Number(s.physical_score) || 0), 0) || null;
    const lastScanSummary = lastScan?.extended_analysis?.areas_for_improvement?.[0]
      || lastScan?.extended_analysis?.personalized_recommendations?.training?.[0]
      || String(lastScan?.ai_feedback || "").split(/[.!?]/)[0]
      || "";

    const todayMeals = mealsTodayRes?.data || [];
    const todayKcal = Math.round(todayMeals.reduce((s, m) => s + (Number(m.calories) || 0), 0));
    const todayProtein = Math.round(todayMeals.reduce((s, m) => s + (Number(m.protein) || 0), 0));
    const nutritionSummary = todayKcal > 0 ? `${todayKcal} kcal · ${todayProtein}g protéines` : "Suivi nutrition encore léger";
    const recentMealPattern = (mealsWeekRes?.data || []).slice(0, 5).map((m) => `${m.name || 'Repas'} ${m.calories ? `${m.calories}kcal` : ''}`.trim()).join(', ');

    let moodLabel = "";
    try {
      const savedMood = localStorage.getItem("fitai_mood");
      const savedMoodDate = localStorage.getItem("fitai_mood_date");
      if (savedMood && savedMoodDate === new Date().toDateString()) moodLabel = MOOD_LABELS[parseInt(savedMood)] || "";
    } catch {}

    const coachProfile = {
      display_name: dbProfile.display_name || U.email?.split("@")[0] || "",
      weight: dbProfile.weight || null,
      height: dbProfile.height || null,
      age: dbProfile.age || null,
      goal: goalContext.type || "",
      level: goalContext.level || "beginner",
      injuries: goalContext.constraints || "",
      equipment: goalContext.equipment || "poids du corps",
      mood_today: moodLabel || undefined,
      current_streak: currentStreak || undefined,
      total_workouts: totalWorkouts || undefined,
      recent_workouts: recentWorkoutNames.length ? recentWorkoutNames : undefined,
      recent_sessions_7d: recentSessions7d || undefined,
      best_scan_score: bestScanScore || undefined,
      last_scan_summary: lastScanSummary || undefined,
      nutrition_summary: nutritionSummary || undefined,
      recent_meal_pattern: recentMealPattern || undefined,
      today_kcal: todayKcal > 0 ? todayKcal : undefined,
      today_protein: todayProtein > 0 ? todayProtein : undefined
    };

    const { response: j } = await fetchJsonWithTimeout("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: prompt, history: historyForApi, profile: coachProfile, goalContext })
    }, 18000);

    const thinkEl = document.getElementById("coach-thinking");
    if (thinkEl) thinkEl.remove();
    const aiTime = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const fallbackBadge = j.fallback ? '<div class="coach-inline-note">Conseil instantané</div>' : '';

    if (j.type === "shopping_list" && j.data) {
      const d = j.data;
      let html = `<div class="coach-card-head"><span class="coach-card-kicker">Courses coach</span><strong>${escapeHtml(d.title || "Liste de courses")}</strong></div>`;
      if (d.context) html += `<p class="coach-p">${escapeHtml(d.context)}</p>`;
      (d.categories || []).forEach(cat => {
        if (!cat.items?.length) return;
        html += `<div class="coach-h2">${escapeHtml(cat.name)}</div><ul class="coach-list">`;
        cat.items.forEach(item => {
          html += `<li><strong>${escapeHtml(item.name)}</strong>${item.qty ? ` — ${escapeHtml(item.qty)}` : ""}${item.note ? ` <em>(${escapeHtml(item.note)})</em>` : ""}</li>`;
        });
        html += `</ul>`;
      });
      if (d.tips) html += `<div class="coach-inline-tip">💡 ${escapeHtml(d.tips)}</div>`;
      html += fallbackBadge;
      COACH_HISTORY.push({ role: "ai", content: html, time: aiTime });
    } else if (j.type === "meal_plan" && j.data) {
      const d = j.data;
      let html = `<div class="coach-card-head"><span class="coach-card-kicker">Nutrition</span><strong>${escapeHtml(d.title || "Journée alimentaire")}</strong></div>`;
      if (d.total_calories || d.total_protein) {
        const parts = [];
        if (d.total_calories) parts.push(`🔥 ${d.total_calories} kcal`);
        if (d.total_protein) parts.push(`💪 ${d.total_protein}g prot.`);
        html += `<div class="coach-mini-pills">${parts.map(p => `<span class="coach-mini-pill">${escapeHtml(p)}</span>`).join("")}</div>`;
      }
      (d.meals || []).forEach(meal => {
        html += `<div class="coach-meal-row"><div class="coach-meal-top"><strong>${escapeHtml(meal.name)}</strong>${meal.time ? `<span>${escapeHtml(meal.time)}</span>` : ''}</div>`;
        if (meal.items?.length) html += `<div class="coach-meal-items">${meal.items.map(item => `<span>${escapeHtml(item)}</span>`).join(' · ')}</div>`;
        html += `</div>`;
      });
      if (d.notes) html += `<div class="coach-inline-tip">💡 ${escapeHtml(d.notes)}</div>`;
      html += fallbackBadge;
      COACH_HISTORY.push({ role: "ai", content: html, time: aiTime });
    } else if (j.type === "workout" && j.data) {
      PLAN = j.data;
      const plan = j.data;
      let aiResponse = `<div class="coach-card-head"><span class="coach-card-kicker">Séance du jour</span><strong>${escapeHtml(plan.title || "Séance générée")}</strong></div>`;
      const metaParts = [];
      if (plan.duration) metaParts.push(`⏱ ${plan.duration} min`);
      if (plan.calories_estimate || plan.calories) metaParts.push(`🔥 ~${plan.calories_estimate || plan.calories} kcal`);
      if (plan.exercises?.length) metaParts.push(`💪 ${plan.exercises.length} exercices`);
      if (metaParts.length) aiResponse += `<div class="coach-mini-pills">${metaParts.map(p => `<span class="coach-mini-pill">${escapeHtml(p)}</span>`).join("")}</div>`;
      if (Array.isArray(plan.exercises) && plan.exercises.length > 0) {
        aiResponse += '<ul class="coach-list">';
        plan.exercises.slice(0, 4).forEach((ex) => {
          const badge = ex.sets > 1 ? `${ex.sets}×${ex.reps}` : (ex.duration > 0 ? `${ex.duration}s` : ex.reps);
          aiResponse += `<li><strong>${escapeHtml(ex.name)}</strong> — ${escapeHtml(String(badge || ''))}</li>`;
        });
        if (plan.exercises.length > 4) aiResponse += `<li>+${plan.exercises.length - 4} autres exercices dans le plan complet</li>`;
        aiResponse += '</ul>';
      }
      aiResponse += `<div class="coach-inline-note">Plan complet juste en dessous.</div>${fallbackBadge}`;
      COACH_HISTORY.push({ role: "ai", content: aiResponse, time: aiTime });
      renderPlan(PLAN);
    } else {
      const textHtml = formatCoachText(j.message || "Je n'ai pas pu formuler une réponse.") + fallbackBadge;
      COACH_HISTORY.push({ role: "ai", content: textHtml, time: aiTime });
    }

    saveCoachHistory();
    renderCoachChat();
    if (chatEl) setTimeout(() => { chatEl.scrollTop = chatEl.scrollHeight; }, 50);
  } catch (e) {
    const thinkEl = document.getElementById("coach-thinking");
    if (thinkEl) thinkEl.remove();
    const errTime = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const fallbackHtml = `<div class="coach-card-head"><span class="coach-card-kicker">Coach indisponible</span><strong>Je te laisse une action simple plutôt qu'un écran vide.</strong></div><p class="coach-p">Respire, réduis l'objectif et protège ton élan.</p><div class="coach-h2">Action du jour</div><ul class="coach-list"><li>marche active 8 à 12 min</li><li>2 exercices faciles</li><li>1 repas protéiné propre</li></ul><div class="coach-inline-tip"><button class="coach-chip" onclick="retryLastCoachMessage()">↩ Réessayer</button></div>`;
    COACH_HISTORY.push({ role: "ai", content: fallbackHtml, time: errTime });
    saveCoachHistory();
    renderCoachChat();
    if (errorEl) { errorEl.style.display = "none"; errorEl.innerHTML = ""; }
  } finally {
    if (btn) btn.disabled = false;
    ASYNC_LOCKS.delete("coach-msg");
  }
}

// Keep original generateWorkout as alias
async function generateWorkout() {
  return sendCoachMsg();
}


function exerciseCuePack(ex = {}) {
  const name = String(ex.name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const byKeyword = [
    [/squat|fente|split squat|leg press/, { start: "Pieds ancrés et genoux dans l'axe.", move: "Descends contrôlé, remonte en poussant le sol.", focus: "Quadriceps et fessiers.", breathe: "Inspire en bas, expire en remontant." }],
    [/souleve|deadlift|hip thrust|pont/, { start: "Dos neutre, cage verrouillée, appui talons.", move: "Charnière de hanches propre sans arrondir.", focus: "Chaîne postérieure et fessiers.", breathe: "Bloque le tronc avant la poussée, relâche en haut." }],
    [/pompe|developpe|bench|dips|presse/, { start: "Omoplates serrées, poitrine ouverte.", move: "Descente contrôlée puis poussée franche.", focus: "Pectoraux, épaules, triceps.", breathe: "Inspire à la descente, expire à la poussée." }],
    [/traction|rowing|tirage|pull|curl/, { start: "Épaules basses, poitrine sortie.", move: "Tire les coudes sans casser le buste.", focus: "Dos et bras.", breathe: "Expire pendant le tirage." }],
    [/planche|gainage|crunch|abdo|mountain/, { start: "Bassin neutre et ventre gainé.", move: "Reste compact, zéro mouvement parasite.", focus: "Sangle abdominale.", breathe: "Respiration courte mais contrôlée." }],
    [/course|velo|bike|burpee|hiit|jump/, { start: "Trouve ton rythme avant d'accélérer.", move: "Reste léger et régulier.", focus: "Cardio et explosivité.", breathe: "Respiration continue, pas d'apnée." }],
    [/yoga|mobilite|stretch|etirement/, { start: "Place-toi lentement jusqu'à sentir une tension légère.", move: "Cherche l'amplitude sans forcer.", focus: "Ouverture et récupération.", breathe: "Inspire long, expire encore plus long." }]
  ];
  for (const [rx, pack] of byKeyword) if (rx.test(name)) return pack;
  return {
    start: "Place-toi stable avant la première rep.",
    move: "Contrôle la phase descendante puis accélère à la montée.",
    focus: ex.muscle ? `Accent sur ${String(ex.muscle).toLowerCase()}.` : "Cherche une exécution propre avant l'intensité.",
    breathe: "Expire sur l'effort principal."
  };
}

function exerciseVisualHtml(ex = {}) {
  return `<div class="ex-visual-stack"><div class="ex-figure">${_stickFigureSVG(ex.name || "")}</div><div class="ex-muscle-map">${_muscleSVG(ex.muscle || ex.name || "")}</div></div>`;
}

function exerciseHowToHtml(ex = {}) {
  const cue = exerciseCuePack(ex);
  return `<div class="ex-howto"><div class="ex-howto-item"><span>Départ</span><p>${escapeHtml(cue.start)}</p></div><div class="ex-howto-item"><span>Mouvement</span><p>${escapeHtml(cue.move)}</p></div><div class="ex-howto-item"><span>À sentir</span><p>${escapeHtml(cue.focus)}</p></div><div class="ex-howto-item"><span>Respiration</span><p>${escapeHtml(cue.breathe)}</p></div></div>`;
}

function renderExerciseCard(ex, idx) {
  const badges = [];
  if (ex.sets && ex.sets > 0) badges.push(`<span class="ex-badge sets">${ex.sets} séries</span>`);
  if (ex.reps && ex.reps !== "0") badges.push(`<span class="ex-badge reps">${escapeHtml(String(ex.reps))} reps</span>`);
  if (ex.duration && ex.duration > 0) badges.push(`<span class="ex-badge dur">${ex.duration}s</span>`);
  if (ex.rest && ex.rest > 0) badges.push(`<span class="ex-badge rest">${ex.rest}s repos</span>`);
  if (ex.muscle) badges.push(`<span class="ex-badge muscle">${escapeHtml(ex.muscle)}</span>`);
  if (ex.equipment) badges.push(`<span class="ex-badge equip">${escapeHtml(ex.equipment)}</span>`);

  const diffClass = ex.difficulty === "facile" ? "facile" : ex.difficulty === "difficile" ? "difficile" : "moyen";

  return `
    <div class="ex-card ex-card-premium">
      <div class="ex-num">${idx + 1}</div>
      <div class="ex-visual-col">${exerciseVisualHtml(ex)}</div>
      <div class="ex-body">
        <div class="ex-name">
          <span>${escapeHtml(ex.name || "Exercice")}</span>
          <span class="ex-diff ${diffClass}" title="${escapeHtml(ex.difficulty || 'moyen')}"></span>
        </div>
        <div class="ex-badges">${badges.join("")}</div>
        ${ex.description ? `<div class="ex-desc">${escapeHtml(ex.description)}</div>` : ""}
        ${exerciseHowToHtml(ex)}
      </div>
    </div>
  `;
}

function renderPlan(plan) {
  const head = document.getElementById("plan-head");
  const meta = document.getElementById("plan-meta");
  const notes = document.getElementById("plan-notes");
  const blocks = document.getElementById("plan-blocks");

  if (head) {
    head.innerHTML = `<div class="plan-title-text">${escapeHtml(plan.title || "Séance")}</div>`;
  }

  if (meta) {
    const pills = [];
    if (plan.duration) pills.push(`<span class="plan-meta-pill">${plan.duration} min</span>`);
    const kcal = plan.calories_estimate || plan.calories;
    if (kcal) pills.push(`<span class="plan-meta-pill">~${kcal} kcal</span>`);
    const lvlMap = { beginner:"Débutant", debutant:"Débutant", intermediate:"Intermédiaire", intermediaire:"Intermédiaire", advanced:"Avancé", avance:"Avancé" };
    const lvl = lvlMap[plan.level] || plan.level || "";
    if (lvl) pills.push(`<span class="plan-meta-pill">${escapeHtml(lvl)}</span>`);
    if (plan.exercises?.length) pills.push(`<span class="plan-meta-pill">${plan.exercises.length} exercices</span>`);
    meta.innerHTML = pills.join("");
    meta.style.display = pills.length ? "flex" : "none";
  }

  if (notes) {
    notes.textContent = plan.notes || "";
    notes.style.display = plan.notes ? "block" : "none";
  }

  if (blocks) {
    // Priority 1: blocks[] with phase color-coding
    if (Array.isArray(plan.blocks) && plan.blocks.length > 0) {
      const phaseClasses = ["phase-warmup", "phase-main", "phase-cooldown"];
      const phaseIcons = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>`
      ];
      blocks.innerHTML = plan.blocks.map((b, bi) => {
        const phaseClass = phaseClasses[Math.min(bi, phaseClasses.length - 1)];
        const icon = phaseIcons[Math.min(bi, phaseIcons.length - 1)];
        const dur = b.duration_sec ? `${formatDuration(b.duration_sec)}` : "";
        const rpe = b.rpe ? `RPE ${b.rpe}` : "";
        const hasExercises = Array.isArray(b.exercises) && b.exercises.length > 0;
        const hasItems = Array.isArray(b.items) && b.items.length > 0;

        return `
          <div class="block ${phaseClass}" style="margin-bottom:4px">
            <div class="block-head" style="margin-bottom:10px">
              <span class="plan-phase-label">${icon} ${escapeHtml(b.title || "")}</span>
              <div class="block-meta">
                ${rpe ? `<span class="rpe">${escapeHtml(rpe)}</span>` : ""}
                ${dur ? `<span class="bdur">${dur}</span>` : ""}
              </div>
            </div>
            ${hasExercises
              ? b.exercises.map((ex, i) => renderExerciseCard(ex, i)).join("")
              : hasItems
                ? `<ul class="block-items">${b.items.map(it => `<li>${escapeHtml(String(it))}</li>`).join("")}</ul>`
                : ""
            }
          </div>
        `;
      }).join("");
    }
    // Priority 2: exercises[] flat list — split into phases by position
    else if (Array.isArray(plan.exercises) && plan.exercises.length > 0) {
      const exs = plan.exercises;
      const n = exs.length;
      let warmupCount = 0, cooldownCount = 0;
      if (n >= 7) { warmupCount = 2; cooldownCount = 2; }
      else if (n >= 5) { warmupCount = 2; cooldownCount = 1; }
      else if (n >= 3) { warmupCount = 1; cooldownCount = 1; }
      const warmupExs = exs.slice(0, warmupCount);
      const cooldownExs = n > cooldownCount ? exs.slice(n - cooldownCount) : [];
      const mainExs = exs.slice(warmupCount, n - cooldownCount || n);
      const phases = [];
      if (warmupExs.length) phases.push({ title: "Échauffement", cls: "phase-warmup", rpe: "3-4", exs: warmupExs });
      if (mainExs.length)   phases.push({ title: "Séance principale", cls: "phase-main", rpe: "7-8", exs: mainExs });
      if (cooldownExs.length) phases.push({ title: "Récupération", cls: "phase-cooldown", rpe: "2-3", exs: cooldownExs });

      blocks.innerHTML = phases.map((ph) => {
        let idxOffset = ph.cls === "phase-main" ? warmupCount : ph.cls === "phase-cooldown" ? n - cooldownCount : 0;
        return `
          <div class="block ${ph.cls}" style="margin-bottom:4px">
            <div class="block-head" style="margin-bottom:10px">
              <span class="plan-phase-label">${escapeHtml(ph.title)}</span>
              <span class="rpe">RPE ${ph.rpe}</span>
            </div>
            ${ph.exs.map((ex, i) => renderExerciseCard(ex, idxOffset + i)).join("")}
          </div>
        `;
      }).join("");
    } else {
      blocks.innerHTML = '<div class="empty"><span style="font-size:1.5rem;margin-bottom:6px;display:block">—</span>Aucun exercice disponible</div>';
    }
  }

  const planCard = document.getElementById("plan-card");
  if (planCard) planCard.style.display = "block";
  if (planCard) setTimeout(() => planCard.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
}

async function saveSession() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  if (!PLAN) return toast("Générez d'abord une séance.", "err");

  await guarded("save-session", async () => {
    const { error } = await SB.from("workout_sessions").insert({ user_id: U.id, plan: PLAN });
    if (error) throw error;
    toast("Séance sauvegardée ✓", "ok");
    await updateDailyStreak({ incrementWorkouts: true });
    await Promise.all([loadHistory(), loadStreak()]);
    checkAndAwardAchievements().catch(() => {});
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadHistory() {
  if (!U) return;
  const el = document.getElementById("history-list");
  if (!el) return;

  try {
    const { data, error } = await SB.from("workout_sessions")
      .select("id,created_at,plan")
      .eq("user_id", U.id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span style="font-size:1.4rem;display:block;margin-bottom:6px">—</span>Aucune séance sauvegardée</div>';
      return;
    }
    el.innerHTML = `<div class="sessions-list">${data.map((s) => {
      const d = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      const exCount = s.plan?.exercises?.length || 0;
      const dur = s.plan?.duration ? `${s.plan.duration} min` : "";
      const metaParts = [d];
      if (dur) metaParts.push(dur);
      if (exCount) metaParts.push(`${exCount} exerc.`);
      return `
        <div class="sess-row" onclick="replaySession(${JSON.stringify(JSON.stringify(s.plan))})">
          <div class="sess-row-left">
            <div class="sess-row-title">${escapeHtml(s.plan?.title || "Séance")}</div>
            <div class="sess-row-meta">${metaParts.map(p => `<span>${escapeHtml(p)}</span>`).join('<span style="opacity:.3">·</span>')}</div>
          </div>
          <div class="sess-row-right">
            <button class="sess-replay-btn" onclick="event.stopPropagation();replaySession(${JSON.stringify(JSON.stringify(s.plan))})">Revoir</button>
          </div>
        </div>`;
    }).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

function replaySession(planJson) {
  try {
    const plan = typeof planJson === "string" ? JSON.parse(planJson) : planJson;
    if (!plan) return;
    PLAN = plan;
    renderPlan(PLAN);
    toast("Séance rechargée", "ok");
  } catch { toast("Impossible de recharger la séance.", "err"); }
}

// ══════════════════════════════════════════════════════════════════════════════
// NUTRITION
// ══════════════════════════════════════════════════════════════════════════════

async function addMeal() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const nameEl = document.getElementById("n-name");
  const name = nameEl ? nameEl.value.trim() : "";
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
    ["n-name", "n-kcal", "n-prot", "n-carb", "n-fat"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    toast("Repas ajouté ✓", "ok");
    await loadMeals();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function deleteMeal(id) {
  if (!U) return;
  const ok = await confirmModal("Supprimer ce repas ?", "Il sera retiré du journal de la journée.");
  if (!ok) return;
  await guarded(`meal-${id}`, async () => {
    const { error } = await SB.from("meals").delete().eq("id", id).eq("user_id", U.id);
    if (error) throw error;
    await loadMeals();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadMeals() {
  if (!U) return;
  const today = new Date().toISOString().slice(0, 10);
  const el = document.getElementById("meals-list");
  if (!el) return;

  try {
    const { data, error } = await SB.from("meals").select("*").eq("user_id", U.id).eq("date", today).order("created_at");
    if (error) throw error;

    const totals = (data || []).reduce((acc, m) => ({
      kcal: acc.kcal + (m.calories || 0),
      protein: acc.protein + (m.protein || 0),
      carbs: acc.carbs + (m.carbs || 0),
      fat: acc.fat + (m.fat || 0)
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

    const mKcal = document.getElementById("m-kcal");
    if (mKcal) mKcal.textContent = String(totals.kcal);
    const dbKcal = document.getElementById("db-kcal");
    if (dbKcal) dbKcal.textContent = String(totals.kcal);
    const mProt = document.getElementById("m-prot");
    if (mProt) mProt.textContent = `${totals.protein}g`;
    const mCarb = document.getElementById("m-carb");
    if (mCarb) mCarb.textContent = `${totals.carbs}g`;
    const mFat = document.getElementById("m-fat");
    if (mFat) mFat.textContent = `${totals.fat}g`;

    await renderNutritionProgress(totals);

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 8px"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 002-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 00-5 5v6c0 1.1.9 2 2 2h3v7"/></svg>Aucun repas aujourd\'hui</div>';
      return;
    }

    const MEAL_TYPE_LABELS = { petit_dej: "Petit-déj", collation: "Collation", midi: "Déjeuner", soir: "Dîner" };
    el.innerHTML = data.map((meal) => {
      const typeLabel = MEAL_TYPE_LABELS[meal.meal_type] || "";
      const kcal = meal.calories || 0;
      const prot = meal.protein || 0;
      const carb = meal.carbs || 0;
      const fat = meal.fat || 0;
      return `
      <div class="meal-card">
        <div class="meal-card-top">
          <div class="meal-card-name">${escapeHtml(meal.name)}${typeLabel ? ` <span class="meal-type-tag">${typeLabel}</span>` : ""}</div>
          <div class="meal-card-kcal">${kcal} <span class="meal-card-kcal-unit">kcal</span></div>
          <button class="meal-card-del" onclick="deleteMeal('${meal.id}')" title="Supprimer">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
        <div class="meal-card-macros">
          <span class="meal-macro-pill" style="border-color:rgba(74,222,128,.3);color:#4ade80">${prot}g prot.</span>
          <span class="meal-macro-pill" style="border-color:rgba(251,191,36,.3);color:#fbbf24">${carb}g gluc.</span>
          <span class="meal-macro-pill" style="border-color:rgba(248,113,113,.3);color:#f87171">${fat}g lip.</span>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

let _nutrTargetsCache = null;

async function _fetchNutritionTargets() {
  if (_nutrTargetsCache) return _nutrTargetsCache;
  const { data } = await SB.from("nutrition_targets").select("calories,protein,carbs,fats").eq("user_id", U.id).maybeSingle();
  _nutrTargetsCache = data || { calories: 2200, protein: 140, carbs: 260, fats: 70 };
  return _nutrTargetsCache;
}

async function loadNutritionTargets() {
  if (!U) return;
  try {
    _nutrTargetsCache = null; // force refresh when explicitly called
    const target = await _fetchNutritionTargets();
    const targetKcal = document.getElementById("target-kcal");
    const targetProt = document.getElementById("target-prot");
    const targetCarb = document.getElementById("target-carb");
    const targetFat = document.getElementById("target-fat");
    if (targetKcal) targetKcal.innerHTML = `${target.calories} <span style="font-size:.7rem;font-weight:600;color:var(--muted)">kcal</span>`;
    if (targetProt) targetProt.textContent = `${target.protein}g`;
    if (targetCarb) targetCarb.textContent = `${target.carbs}g`;
    if (targetFat) targetFat.textContent = `${target.fats}g`;
  } catch (e) {
    console.error("[Nutrition] loadTargets error:", e);
  }
}

async function renderNutritionProgress(totals) {
  if (!U) return;
  try {
    const t = await _fetchNutritionTargets();
    const targetCalories = t.calories || 2200;
    const targetProt = t.protein || 140;
    const targetCarb = t.carbs || 260;
    const targetFat = t.fats || 70;

    // Calorie ring (SVG arc — circumference of r=46 is ≈ 289)
    const pct = Math.max(0, Math.min(1, totals.kcal / targetCalories));
    const arc = document.getElementById("kcal-ring-arc");
    if (arc) {
      const circ = 289;
      arc.setAttribute("stroke-dasharray", `${(pct * circ).toFixed(1)} ${circ}`);
      arc.setAttribute("stroke", pct > 0.95 ? "#f87171" : pct > 0.7 ? "#fbbf24" : "#4ade80");
    }

    // Linear bar compat (if still exists)
    const calFill = document.getElementById("cal-progress-fill");
    const calText = document.getElementById("cal-progress-text");
    if (calFill) calFill.style.width = `${Math.round(pct * 100)}%`;
    if (calText) calText.textContent = `${totals.kcal} / ${targetCalories} kcal`;

    // Macro bars + targets labels
    const barProt = document.getElementById("bar-prot");
    const barCarb = document.getElementById("bar-carb");
    const barFat = document.getElementById("bar-fat");
    if (barProt) barProt.style.width = `${Math.min(100, Math.round((totals.protein / targetProt) * 100))}%`;
    if (barCarb) barCarb.style.width = `${Math.min(100, Math.round((totals.carbs / targetCarb) * 100))}%`;
    if (barFat) barFat.style.width = `${Math.min(100, Math.round((totals.fat / targetFat) * 100))}%`;

    const tProt = document.getElementById("macro-target-prot");
    const tCarb = document.getElementById("macro-target-carb");
    const tFat = document.getElementById("macro-target-fat");
    if (tProt) tProt.textContent = `/ ${targetProt}g`;
    if (tCarb) tCarb.textContent = `/ ${targetCarb}g`;
    if (tFat) tFat.textContent = `/ ${targetFat}g`;

    // Remaining calories indicator
    const remaining = targetCalories - totals.kcal;
    const remainingRow = document.getElementById("nutr-remaining-row");
    const remainingVal = document.getElementById("nutr-remaining-kcal");
    if (remainingRow && remainingVal) {
      remainingRow.style.display = "";
      if (remaining > 0) {
        remainingVal.textContent = `${remaining} kcal`;
        remainingVal.style.color = "#4ade80";
      } else {
        remainingVal.textContent = `+${Math.abs(remaining)} kcal dépassé`;
        remainingVal.style.color = "#f87171";
      }
    }
  } catch (e) {
    console.error("[Nutrition] renderProgress error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNAUTÉ
// ══════════════════════════════════════════════════════════════════════════════

function previewPostPhoto(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Format image requis.", "err");
  if (file.size > 4 * 1024 * 1024) return toast("Photo trop volumineuse (max 4MB).", "err");
  POST_PHOTO = file;
  const nameEl = document.getElementById("post-photo-name");
  if (nameEl) nameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    const img = document.getElementById("post-photo-img");
    const preview = document.getElementById("post-photo-preview");
    if (img) img.src = reader.result;
    if (preview) preview.style.display = "block";
  };
  reader.readAsDataURL(file);
}

async function createPost() {
  if (!U) return toast("Session expirée.", "err");
  const postInput = document.getElementById("post-input");
  const content = postInput ? postInput.value.trim() : "";
  if (!content && !POST_PHOTO) return toast("Écrivez un message ou ajoutez une photo.", "err");

  const visibilityEl = document.getElementById("post-visibility");
  const visibility = visibilityEl ? visibilityEl.value : "public";

  const btn = document.getElementById("btn-post");
  await withButton(btn, "Publication…", async () => {
    let image_url = null;
    if (POST_PHOTO) {
      const ext = (POST_PHOTO.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const path = `${U.id}/posts/${Date.now()}.${ext}`;
      const upload = await SB.storage.from("user_uploads").upload(path, POST_PHOTO, { contentType: POST_PHOTO.type });
      if (upload.error) {
        console.warn("[Post] Photo upload failed:", upload.error);
        toast("Échec upload photo, publication sans image.", "err");
      } else {
        image_url = path; // bucket is private: store the storage path, not a public URL
      }
    }
    const payload = { user_id: U.id, content: content || "📸", kudos: 0, visibility };
    if (image_url) payload.image_url = image_url;
    const { error } = await SB.from("community_posts").insert(payload);
    if (error) throw error;
    checkAndAwardAchievements().catch(() => {});
    if (postInput) postInput.value = "";
    POST_PHOTO = null;
    const nameEl = document.getElementById("post-photo-name");
    const preview = document.getElementById("post-photo-preview");
    const fileInput = document.getElementById("post-photo-input");
    if (nameEl) nameEl.textContent = "";
    if (preview) preview.style.display = "none";
    if (fileInput) fileInput.value = "";
    await loadFeed();
    toast("Publié ✓", "ok");
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function giveKudos(postId, count) {
  if (!U) return;
  if (LIKED.has(postId)) return toast("Déjà kudosé.", "err");

  await guarded(`kudos-${postId}`, async () => {
    // Utiliser la fonction RPC sécurisée
    const { data, error } = await SB.rpc("give_kudos", { target_post_id: postId });
    if (error) throw error;
    if (data && !data.ok) {
      if (data.error === "already_kudosed") return toast("Déjà kudosé.", "err");
      throw new Error(data.error);
    }
    LIKED.add(postId);
    try { localStorage.setItem("fp_likes", JSON.stringify([...LIKED])); } catch {}
    await loadFeed();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function deletePost(postId) {
  if (!U) return;
  const ok = await confirmModal("Supprimer ce post ?", "Il sera retiré définitivement du fil communautaire.");
  if (!ok) return;
  await guarded(`post-${postId}`, async () => {
    const { error } = await SB.from("community_posts").delete().eq("id", postId).eq("user_id", U.id);
    if (error) throw error;
    await loadFeed();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

function setPostTemplate(type) {
  // Switch back to regular post mode if in recipe mode
  const regularForm = document.getElementById("regular-post-form");
  const recipeForm = document.getElementById("recipe-share-form");
  if (regularForm) regularForm.style.display = "block";
  if (recipeForm) recipeForm.style.display = "none";

  const input = document.getElementById("post-input");
  if (!input) return;
  const tpl = {
    seance: "Séance terminée — ",
    pr: "Nouveau record personnel — ",
    nutrition: "Repas du jour : ",
    motivation: "Ma motivation du jour :\n\n",
    progress: "Mes progrès cette semaine :\n\n"
  };
  input.value = tpl[type] || "";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function toggleRecipeMode() {
  const regularForm = document.getElementById("regular-post-form");
  const recipeForm = document.getElementById("recipe-share-form");
  if (!regularForm || !recipeForm) return;
  const isRecipe = recipeForm.style.display !== "none";
  regularForm.style.display = isRecipe ? "block" : "none";
  recipeForm.style.display = isRecipe ? "none" : "block";
  const btn = document.querySelector(".post-cat-chip-recipe");
  if (btn) btn.style.background = isRecipe ? "" : "rgba(99,102,241,.25)";
}

async function shareRecipe() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  const name = document.getElementById("recipe-share-name")?.value.trim() || "";
  const ingredients = document.getElementById("recipe-share-ingredients")?.value.trim() || "";
  const servings = parseInt(document.getElementById("recipe-share-servings")?.value || "2");
  const desc = document.getElementById("recipe-share-desc")?.value.trim() || "";
  const visibility = document.getElementById("recipe-share-visibility")?.value || "public";

  if (!name) return toast("Donne un nom à ta recette.", "err");
  if (!ingredients) return toast("Liste au moins quelques ingrédients.", "err");

  const btn = document.getElementById("btn-share-recipe");
  await withButton(btn, "Analyse en cours…", async () => {
    const token = await getToken();
    if (!token) throw new Error("Session expirée.");

    // Call Gemini nutrition check
    let nutrition = null;
    try {
      const resp = await fetchJsonWithTimeout("/api/check-recipe-nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, ingredients, servings })
      }, 20000);
      nutrition = resp?.data || null;
    } catch {
      // Proceed without nutrition data
    }

    // Build recipe content (prefixed JSON for special rendering in feed)
    const recipePayload = {
      _t: "recipe",
      name,
      desc,
      ingredients,
      servings,
      n: nutrition || { score: null }
    };
    const content = "__r__" + JSON.stringify(recipePayload);

    const { error } = await SB.from("community_posts").insert({
      user_id: U.id,
      content,
      visibility,
      image_url: null,
      created_at: new Date().toISOString(),
      kudos: 0
    });
    if (error) throw error;

    // Reset form
    ["recipe-share-name","recipe-share-ingredients","recipe-share-desc"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    toggleRecipeMode();
    await loadFeed();
    toast(nutrition ? `Recette partagée — score nutritionnel : ${nutrition.score}/100` : "Recette partagée ✓", "ok");
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

function setFeedFilter(filter) {
  FEED_FILTER = filter;
  document.querySelectorAll(".feed-filter-btn").forEach(b => b.classList.toggle("on", b.dataset.filter === filter));
  loadFeed();
}

const FEED_IMAGE_CACHE = new Map();

async function resolveFeedImageUrls(posts) {
  const out = {};
  const now = Date.now();
  const toSign = [];

  for (const post of posts || []) {
    const ref = String(post.image_url || "").trim();
    if (!ref) continue;
    if (/^https?:\/\//i.test(ref)) {
      out[post.id] = ref;
      continue;
    }
    const cached = FEED_IMAGE_CACHE.get(ref);
    if (cached && cached.expiresAt > now) {
      out[post.id] = cached.url;
      continue;
    }
    toSign.push({ postId: post.id, path: ref });
  }

  await Promise.all(toSign.map(async ({ postId, path }) => {
    try {
      const { data, error } = await SB.storage.from("user_uploads").createSignedUrl(path, 60 * 60);
      if (error) throw error;
      if (data?.signedUrl) {
        FEED_IMAGE_CACHE.set(path, { url: data.signedUrl, expiresAt: now + 55 * 60 * 1000 });
        out[postId] = data.signedUrl;
      }
    } catch (e) {
      console.warn("[Feed] Signed URL failed:", path, e?.message || e);
    }
  }));

  return out;
}

async function loadFeed() {
  const el = document.getElementById("feed");
  if (!el) return;
  try {
    let query = SB.from("community_posts")
      .select("id,user_id,content,kudos,image_url,visibility,created_at")
      .order("created_at", { ascending: false })
      .limit(25);

    if (FEED_FILTER === "mine") {
      query = query.eq("user_id", U.id);
    }
    if (FEED_FILTER === "friends" && U) {
      // Fetch friend user_ids (accepted friendships)
      const { data: fships } = await SB.from("friendships")
        .select("requester_id,addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${U.id},addressee_id.eq.${U.id}`);
      const friendIds = (fships || []).map(f => f.requester_id === U.id ? f.addressee_id : f.requester_id);
      if (!friendIds.length) {
        el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Ajoutez des amis pour voir leur fil.</div>';
        return;
      }
      // Show friends' posts (public or friends-visible)
      query = query.in("user_id", friendIds).neq("visibility", "private");
    }

    const { data: allData, error } = await query;
    if (error) throw error;
    // Client-side filter for recipes tab
    const data = FEED_FILTER === "recipes"
      ? (allData || []).filter(p => String(p.content || "").startsWith("__r__"))
      : (allData || []);
    if (!data.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Aucun post dans ce fil.</div>';
      return;
    }

    const postIds = data.map(post => post.id);
    const commentCounts = {};
    try {
      const { data: commentRows, error: commentError } = await SB.from("comments")
        .select("post_id")
        .in("post_id", postIds)
        .limit(1000);
      if (commentError) throw commentError;
      for (const row of commentRows || []) commentCounts[row.post_id] = (commentCounts[row.post_id] || 0) + 1;
    } catch (e) {
      console.warn("[Feed] Comment counts unavailable:", e?.message || e);
    }

    const imageUrls = await resolveFeedImageUrls(data);

    // Batch-fetch author display names
    const authorIds = [...new Set(data.map(p => p.user_id))];
    const authorMap = {};
    try {
      const { data: profiles } = await SB.from("profiles").select("id,display_name,username").in("id", authorIds);
      (profiles || []).forEach(p => { authorMap[p.id] = p; });
    } catch { /* fallback to "Membre" */ }

    const AVATAR_COLORS = ["#2563eb","#7c3aed","#0891b2","#059669","#dc2626","#d97706","#db2777","#0d9488"];

    el.innerHTML = data.map(post => {
      const me = U && post.user_id === U.id;
      const liked = LIKED.has(post.id);
      const date = timeAgo(post.created_at);
      const commentCount = commentCounts[post.id] || 0;
      const visIcon = post.visibility === "friends" ? "🔒" : "🌍";
      const imageSrc = imageUrls[post.id] || "";
      const author = authorMap[post.user_id];
      const authorName = me ? "Vous" : (author?.display_name || author?.username || "Membre");
      const authorHandle = !me && author?.username ? `@${escapeHtml(author.username)}` : "";
      const initial = authorName.charAt(0).toUpperCase();
      const avatarColor = AVATAR_COLORS[(post.user_id || "").charCodeAt(0) % AVATAR_COLORS.length];
      const rawContent = String(post.content || "");

      // Recipe post rendering
      if (rawContent.startsWith("__r__")) {
        let recipe = null;
        try { recipe = JSON.parse(rawContent.slice(5)); } catch {}
        if (recipe) {
          const n = recipe.n || {};
          const score = typeof n.score === "number" ? n.score : null;
          const scoreBadgeClass = score === null ? "neutral" : score >= 75 ? "good" : score >= 50 ? "medium" : "low";
          const scoreLabel = score === null ? "N/A" : `${score}/100`;
          const macrosHtml = (n.kcal || n.protein || n.carbs || n.fat) ? `
            <div class="recipe-macros-row">
              ${n.kcal ? `<span class="recipe-macro-pill">${n.kcal} kcal</span>` : ""}
              ${n.protein ? `<span class="recipe-macro-pill">${n.protein}g prot.</span>` : ""}
              ${n.carbs ? `<span class="recipe-macro-pill">${n.carbs}g gluc.</span>` : ""}
              ${n.fat ? `<span class="recipe-macro-pill">${n.fat}g lip.</span>` : ""}
            </div>` : "";
          const analysisHtml = n.analysis ? `<div class="recipe-analysis-text">${escapeHtml(n.analysis)}</div>` : "";
          const ingredientsHtml = recipe.ingredients ? `<div class="recipe-ingredients-text"><strong>Ingrédients :</strong> ${escapeHtml(String(recipe.ingredients).slice(0, 200))}${recipe.ingredients.length > 200 ? "…" : ""}</div>` : "";
          const descHtml = recipe.desc ? `<div class="recipe-desc-text">${escapeHtml(recipe.desc)}</div>` : "";
          return `
            <div class="post-card recipe-post-card">
              <div class="post-card-header recipe-post-header">
                <div class="recipe-post-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z"/><line x1="6" y1="17" x2="18" y2="17"/><line x1="6" y1="21" x2="18" y2="21"/></svg>
                </div>
                <div class="post-card-info">
                  <div class="post-card-name">${escapeHtml(recipe.name || "Recette")} ${score !== null ? `<span class="recipe-score-badge ${scoreBadgeClass}">${scoreLabel}</span>` : ""}</div>
                  <div class="post-card-meta">${authorHandle ? `<span class="post-card-handle">${authorHandle}</span> · ` : ""}${escapeHtml(authorName)} · ${visIcon} ${date}</div>
                </div>
                ${me ? `<button class="post-card-del" onclick="deletePost('${post.id}')" title="Supprimer">✕</button>` : ""}
              </div>
              <div class="recipe-post-body">
                ${macrosHtml}
                ${ingredientsHtml}
                ${descHtml}
                ${analysisHtml}
                ${n.strengths?.length ? `<div class="recipe-strengths">${n.strengths.map(s => `<span class="recipe-strength-tag">${escapeHtml(s)}</span>`).join("")}</div>` : ""}
              </div>
              <div class="post-card-actions">
                <button class="kudos-btn ${liked ? "on" : ""}" onclick="giveKudos('${post.id}', ${post.kudos || 0})">${liked ? "❤️" : "🤍"} <span>${post.kudos || 0}</span></button>
                <button class="comment-btn" onclick="toggleComments('${post.id}')">💬 <span>${commentCount}</span></button>
              </div>
              <div class="comments-section" id="comments-${post.id}" style="display:none"></div>
            </div>`;
        }
      }

      return `
        <div class="post-card">
          <div class="post-card-header">
            <div class="post-card-avatar" style="background:${avatarColor}">${initial}</div>
            <div class="post-card-info">
              <div class="post-card-name">${escapeHtml(authorName)}${me ? " <span class='post-me-badge'>Vous</span>" : ""}</div>
              <div class="post-card-meta">${authorHandle ? `<span class="post-card-handle">${authorHandle}</span> · ` : ""}${visIcon} ${date}</div>
            </div>
            ${me ? `<button class="post-card-del" onclick="deletePost('${post.id}')" title="Supprimer">✕</button>` : ""}
          </div>
          <div class="post-card-body">${escapeHtml(post.content)}</div>
          ${imageSrc ? `<img class="feed-img" src="${escapeHtml(imageSrc)}" alt="Photo" loading="lazy"/>` : ""}
          <div class="post-card-actions">
            <button class="kudos-btn ${liked ? "on" : ""}" onclick="giveKudos('${post.id}', ${post.kudos || 0})">${liked ? "❤️" : "🤍"} <span>${post.kudos || 0}</span></button>
            <button class="comment-btn" onclick="toggleComments('${post.id}')">💬 <span>${commentCount}</span></button>
          </div>
          <div class="comments-section" id="comments-${post.id}" style="display:none"></div>
        </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadCommunityRecipes() {
  const el = document.getElementById("community-recipes-list");
  if (!el) return;
  try {
    const { data, error } = await SB.from("community_posts")
      .select("id,user_id,content,kudos,created_at")
      .like("content", "__r__%")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = '<div class="meal-info" style="text-align:center;padding:16px 0">Aucune recette partagée pour l\'instant.<br><span style="font-size:.75rem;opacity:.6">Partage ta recette dans la communauté !</span></div>';
      return;
    }
    const authorIds = [...new Set(data.map(p => p.user_id))];
    const authorMap = {};
    try {
      const { data: profiles } = await SB.from("profiles").select("id,display_name,username").in("id", authorIds);
      (profiles || []).forEach(p => { authorMap[p.id] = p; });
    } catch {}
    el.innerHTML = data.map(post => {
      let recipe = null;
      try { recipe = JSON.parse(String(post.content).slice(5)); } catch {}
      if (!recipe) return "";
      const n = recipe.n || {};
      const score = typeof n.score === "number" ? n.score : null;
      const scoreBadgeClass = score === null ? "neutral" : score >= 75 ? "good" : score >= 50 ? "medium" : "low";
      const author = authorMap[post.user_id];
      const isMe = U && post.user_id === U.id;
      const authorName = isMe ? "Vous" : (author?.display_name || author?.username || "Membre");
      return `
        <div class="community-recipe-card">
          <div class="community-recipe-top">
            <div class="community-recipe-name">${escapeHtml(recipe.name || "Recette")}</div>
            ${score !== null ? `<span class="recipe-score-badge ${scoreBadgeClass}">${score}/100</span>` : ""}
          </div>
          ${(n.kcal || n.protein) ? `<div class="recipe-macros-row">
            ${n.kcal ? `<span class="recipe-macro-pill">${n.kcal} kcal</span>` : ""}
            ${n.protein ? `<span class="recipe-macro-pill">${n.protein}g prot.</span>` : ""}
            ${n.carbs ? `<span class="recipe-macro-pill">${n.carbs}g gluc.</span>` : ""}
          </div>` : ""}
          ${n.analysis ? `<div class="recipe-analysis-text">${escapeHtml(n.analysis)}</div>` : ""}
          <div class="community-recipe-footer">
            <span class="community-recipe-author">Par ${escapeHtml(authorName)}</span>
            <span class="community-recipe-date">${timeAgo(post.created_at)}</span>
          </div>
        </div>`;
    }).filter(Boolean).join("");
  } catch (e) {
    el.innerHTML = `<div class="meal-info" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FRIENDS SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

async function searchUsers() {
  const input = document.getElementById("friend-search-input");
  const query = input ? input.value.trim() : "";
  const resultEl = document.getElementById("friend-search-results");
  if (!resultEl) return;
  if (!query || query.length < 2) { resultEl.innerHTML = '<div class="meal-info">Tapez au moins 2 caractères</div>'; return; }

  try {
    // Search by username OR display_name (OR filter via PostgREST)
    const { data, error } = await SB.from("profiles")
      .select("id,username,display_name")
      .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
      .neq("id", U.id)
      .limit(10);
    if (error) throw error;
    if (!data?.length) { resultEl.innerHTML = '<div class="meal-info">Aucun résultat</div>'; return; }

    resultEl.innerHTML = data.map(p => {
      const name = p.display_name || p.username || "Membre";
      const avatarColor = AVATAR_COLORS[(p.id || "").charCodeAt(0) % AVATAR_COLORS.length];
      return `
        <div class="friend-card">
          <div class="friend-card-avatar" style="background:${avatarColor}">${name.charAt(0).toUpperCase()}</div>
          <div class="friend-card-info">
            <div class="friend-card-name">${escapeHtml(name)}</div>
            <div class="friend-card-meta">${p.username ? `@${escapeHtml(p.username)}` : ""}</div>
          </div>
          <button class="btn btn-p btn-sm" onclick="sendFriendRequest('${p.id}')">+ Ajouter</button>
        </div>`;
    }).join("");
  } catch (e) {
    resultEl.innerHTML = `<div class="meal-info" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function sendFriendRequest(addresseeId) {
  if (!U) return toast("Connectez-vous.", "err");
  await guarded(`friend-req-${addresseeId}`, async () => {
    const { error } = await SB.from("friendships").insert({
      requester_id: U.id,
      addressee_id: addresseeId,
      status: "pending"
    });
    if (error) {
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        return toast("Demande déjà envoyée.", "err");
      }
      if (error.message?.includes("relation") || error.message?.includes("does not exist")) {
        return toast("Migration SQL requise (migration_v3_social.sql)", "err");
      }
      throw error;
    }
    toast("Demande envoyée ✓", "ok");
    await loadFriendRequests();
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function acceptFriend(friendshipId) {
  await guarded(`accept-${friendshipId}`, async () => {
    const { error } = await SB.from("friendships").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", friendshipId).eq("addressee_id", U.id);
    if (error) throw error;
    toast("Ami accepté ✓", "ok");
    await Promise.all([loadFriendRequests(), loadFriends()]);
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function rejectFriend(friendshipId) {
  await guarded(`reject-${friendshipId}`, async () => {
    const { error } = await SB.from("friendships").delete().eq("id", friendshipId).eq("addressee_id", U.id);
    if (error) throw error;
    toast("Demande refusée", "ok");
    await loadFriendRequests();
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function removeFriend(friendshipId) {
  await guarded(`remove-${friendshipId}`, async () => {
    const { error } = await SB.from("friendships").delete().eq("id", friendshipId);
    if (error) throw error;
    toast("Ami retiré", "ok");
    await loadFriends();
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function loadFriends() {
  const el = document.getElementById("friends-list");
  if (!el) return;
  try {
    const { data, error } = await SB.from("friendships")
      .select("id,requester_id,addressee_id")
      .eq("status", "accepted")
      .or(`requester_id.eq.${U.id},addressee_id.eq.${U.id}`);
    if (error) throw error;
    if (!data?.length) {
      el.innerHTML = `<div class="friends-empty-state"><div style="font-size:2.4rem;margin-bottom:8px">👥</div><div style="font-weight:700;margin-bottom:4px">Aucun ami pour le moment</div><div style="font-size:.8rem;color:var(--muted)">Recherchez des profils ci-dessus pour commencer</div></div>`;
      return;
    }

    const friendIds = data.map(f => f.requester_id === U.id ? f.addressee_id : f.requester_id);
    const [profilesRes, streaksRes] = await Promise.all([
      SB.from("profiles").select("id,username,display_name").in("id", friendIds),
      SB.from("user_streaks").select("user_id,current_streak,total_workouts").in("user_id", friendIds).catch(() => ({ data: [] }))
    ]);
    const profileMap = {};
    (profilesRes?.data || []).forEach(p => { profileMap[p.id] = p; });
    const streakMap = {};
    (streaksRes?.data || []).forEach(s => { streakMap[s.user_id] = s; });

    el.innerHTML = data.map(f => {
      const friendId = f.requester_id === U.id ? f.addressee_id : f.requester_id;
      const p = profileMap[friendId] || {};
      const s = streakMap[friendId] || {};
      const name = p.display_name || p.username || "Membre";
      const handle = p.username ? `@${p.username}` : "";
      const streak = s.current_streak || 0;
      const totalW = s.total_workouts || 0;
      const avatarColor = AVATAR_COLORS[(friendId || "").charCodeAt(0) % AVATAR_COLORS.length];
      const streakBadge = streak > 0 ? `<span class="friend-streak-badge">🔥 ${streak}j</span>` : "";
      const metaLine = [handle, totalW > 0 ? `${totalW} séances` : ""].filter(Boolean).join(" · ");
      return `
        <div class="friend-card">
          <div class="friend-card-avatar" style="background:${avatarColor}">${name.charAt(0).toUpperCase()}</div>
          <div class="friend-card-info">
            <div class="friend-card-name">${escapeHtml(name)}</div>
            <div class="friend-card-meta">${escapeHtml(metaLine)}${streakBadge}</div>
          </div>
          <button class="btn btn-d btn-sm" onclick="removeFriend('${f.id}')" title="Retirer">✕</button>
        </div>`;
    }).join("");

    const countEl = document.getElementById("friend-count");
    if (countEl) countEl.textContent = data.length;
  } catch (e) {
    const isTableMissing = e.message?.includes("relation") || e.message?.includes("does not exist") || e.code === "42P01";
    el.innerHTML = isTableMissing
      ? '<div class="friends-empty-state"><div style="font-size:2rem">⚙️</div><div>Migration SQL requise</div></div>'
      : `<div class="friends-empty-state"><div style="font-size:2.4rem">👥</div><div>Aucun ami pour le moment</div></div>`;
  }
}

async function loadFriendRequests() {
  const el = document.getElementById("friend-requests");
  if (!el) return;
  try {
    const { data, error } = await SB.from("friendships")
      .select("id,requester_id")
      .eq("addressee_id", U.id)
      .eq("status", "pending");
    if (error) throw error;
    const reqCard = document.getElementById("friend-requests-card");
    if (!data?.length) {
      el.innerHTML = '<div style="font-size:.82rem;color:var(--muted);padding:4px 0">Aucune demande en attente</div>';
      if (reqCard) reqCard.style.display = "none";
      return;
    }
    if (reqCard) reqCard.style.display = "block";

    const requesterIds = data.map(f => f.requester_id);
    const { data: profiles } = await SB.from("profiles").select("id,username,display_name").in("id", requesterIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    el.innerHTML = data.map(f => {
      const p = profileMap[f.requester_id] || {};
      const name = p.display_name || p.username || "Membre";
      const avatarColor = AVATAR_COLORS[(f.requester_id || "").charCodeAt(0) % AVATAR_COLORS.length];
      return `
        <div class="friend-card">
          <div class="friend-card-avatar" style="background:${avatarColor}">${name.charAt(0).toUpperCase()}</div>
          <div class="friend-card-info">
            <div class="friend-card-name">${escapeHtml(name)}</div>
            <div class="friend-card-meta">${p.username ? `@${escapeHtml(p.username)}` : ""}</div>
          </div>
          <button class="btn btn-p btn-sm" onclick="acceptFriend('${f.id}')" style="margin-right:4px">Accepter</button>
          <button class="btn btn-d btn-sm" onclick="rejectFriend('${f.id}')">✕</button>
        </div>`;
    }).join("");

    const badge = document.getElementById("friend-pending-badge");
    if (badge) { badge.textContent = data.length; badge.style.display = data.length > 0 ? "inline-flex" : "none"; }
  } catch (e) {
    const isTableMissing = e.message?.includes("relation") || e.message?.includes("does not exist") || e.code === "42P01";
    if (!isTableMissing) {
      el.innerHTML = '<div class="meal-info">Aucune demande en attente</div>';
    }
    // Silently ignore missing table — loadFriends shows the setup hint
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BODY SCAN
// ══════════════════════════════════════════════════════════════════════════════

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
    const scanImg = document.getElementById("scan-img");
    const scanPreview = document.getElementById("scan-preview");
    if (scanImg) scanImg.src = reader.result;
    if (scanPreview) scanPreview.style.display = "flex";
  };
  reader.readAsDataURL(file);
}

function bodyScanLevelMeta(score) {
  const s = Number(score || 0);
  if (s >= 92) return { label: "Exceptionnel", hint: "niveau rarissime", tone: "elite" };
  if (s >= 86) return { label: "Très athlétique", hint: "sec et dense", tone: "athletic" };
  if (s >= 78) return { label: "Athlétique", hint: "niveau sportif net", tone: "strong" };
  if (s >= 70) return { label: "Bon niveau", hint: "bonne base visible", tone: "good" };
  if (s >= 62) return { label: "Actif régulier", hint: "correct mais perfectible", tone: "mid" };
  if (s >= 52) return { label: "Base correcte", hint: "encore peu marquée", tone: "base" };
  return { label: "Début de base", hint: "potentiel à construire", tone: "early" };
}

function bodyScanConfidenceMeta(ext) {
  const quality = String(ext?.analysis_quality || "acceptable");
  const count = Array.isArray(ext?.quality_issues) ? ext.quality_issues.length : 0;
  if (quality === "good" && count === 0) return { label: "Lecture fiable", tone: "good" };
  if (quality === "poor" || count >= 2) return { label: "Lecture prudente", tone: "warn" };
  return { label: "Lecture correcte", tone: "mid" };
}

function bodyScanVerdict(ext, score) {
  const level = bodyScanLevelMeta(score);
  if (ext?.body_composition) return String(ext.body_composition);
  if (level.tone === "athletic" || level.tone === "strong") return "Physique visiblement sportif avec des points encore perfectibles.";
  if (level.tone === "good") return "Base sérieuse, mais il manque encore de la netteté ou du relief pour monter plus haut.";
  if (level.tone === "mid") return "Tu es dans une zone active correcte, mais pas encore dans un rendu athlétique marqué.";
  return "Base en construction. Le score peut grimper vite avec plus de régularité et une meilleure exécution.";
}

function bodyScanTrendMeta(ext) {
  const cmp = ext?.comparison || null;
  const delta = Number(cmp?.delta_score || 0);
  if (!cmp || !Number.isFinite(delta) || cmp.previous_score == null) return null;
  if (delta >= 6) return { label: `+${delta} nette progression`, tone: "up" };
  if (delta >= 2) return { label: `+${delta} progression`, tone: "up" };
  if (delta <= -6) return { label: `${delta} recul net`, tone: "down" };
  if (delta <= -2) return { label: `${delta} léger recul`, tone: "down" };
  return { label: "stable", tone: "flat" };
}

function bodyScanScoreRail(score) {
  const s = Math.max(0, Math.min(100, Number(score || 0)));
  const segments = [
    { label: 'Base', limit: 52 },
    { label: 'Actif', limit: 62 },
    { label: 'Bon', limit: 70 },
    { label: 'Athl.', limit: 78 },
    { label: 'Très athl.', limit: 86 },
    { label: 'Elite', limit: 100 }
  ];
  let left = 0;
  return `<div class="scan-score-rail">${segments.map(seg => {
    const width = seg.limit - left;
    const active = s >= seg.limit;
    const html = `<div class="scan-score-seg${active ? ' active' : ''}" style="width:${width}%"><span>${seg.label}</span></div>`;
    left = seg.limit;
    return html;
  }).join('')}<div class="scan-score-marker" style="left:calc(${s}% - 8px)"></div></div>`;
}

function bodyScanLoadingCopy(progress) {
  if (progress < 18) return { title: "Préparation du scan", sub: "On aligne la photo et on vérifie le cadrage." };
  if (progress < 42) return { title: "Lecture de la posture", sub: "Symétrie, posture et appuis sont en cours d'estimation." };
  if (progress < 68) return { title: "Analyse corporelle", sub: "On évalue la définition, la composition et le niveau perçu." };
  if (progress < 90) return { title: "Synthèse coach", sub: "On prépare les axes prioritaires et les recommandations utiles." };
  return { title: "Finalisation", sub: "Le score calibré et les conseils arrivent." };
}

function setBodyScanLoading(progress) {
  const pct = Math.max(0, Math.min(100, Math.round(progress || 0)));
  const fill = document.getElementById("scan-progress-fill");
  const pctEl = document.getElementById("scan-progress-percent");
  const titleEl = document.getElementById("scan-progress-title");
  const subEl = document.getElementById("scan-progress-sub");
  const copy = bodyScanLoadingCopy(pct);
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (titleEl) titleEl.textContent = copy.title;
  if (subEl) subEl.textContent = copy.sub;
}

async function doScan() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  if (!FILE) return toast("Sélectionnez une image.", "err");

  const btn = document.getElementById("btn-scan");
  const errEl = document.getElementById("scan-err");
  if (errEl) {
    errEl.textContent = "";
    errEl.style.display = "none";
  }

  const scanLoading = document.getElementById("scan-loading");
  const scanPreview = document.getElementById("scan-preview");
  let progressTimer = null;

  await withButton(btn, "Analyse…", async () => {
    const ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${U.id}/bodyscans/${Date.now()}.${ext}`;
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    if (scanLoading) scanLoading.style.display = "block";
    if (scanPreview) scanPreview.classList.add("scan-preview-loading");
    let visualProgress = 6;
    setBodyScanLoading(visualProgress);
    progressTimer = setInterval(() => {
      visualProgress = Math.min(92, visualProgress + (visualProgress < 40 ? 7 : visualProgress < 70 ? 4 : 2));
      setBodyScanLoading(visualProgress);
    }, 650);

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
    if (!r.ok || !j.ok) throw new Error(j.error || `Erreur serveur (HTTP ${r.status})`);

    clearInterval(progressTimer);
    setBodyScanLoading(100);

    FILE = null;
    const fileInput = document.getElementById("file-input");
    const scanImg = document.getElementById("scan-img");
    if (fileInput) fileInput.value = "";
    if (scanImg) scanImg.src = "";
    setTimeout(() => {
      if (scanPreview) {
        scanPreview.style.display = "none";
        scanPreview.classList.remove("scan-preview-loading");
      }
      if (scanLoading) scanLoading.style.display = "none";
    }, 420);
    toast("Analyse terminée ✓", "ok");
    await loadScans();
    checkAndAwardAchievements().catch(() => {});
  }).catch((e) => {
    clearInterval(progressTimer);
    if (scanPreview) scanPreview.classList.remove("scan-preview-loading");
    if (scanLoading) scanLoading.style.display = "none";
    if (errEl) {
      errEl.textContent = `Erreur: ${e.message}`;
      errEl.style.display = "block";
    }
  });
}

function parseScanFeedback(text) {
  if (!text) return { overview: "", strengths: [], improvements: [], recommendations: [] };
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 3);
  const strengths = [], improvements = [], recommendations = [];
  let currentSection = "overview";
  const overviewLines = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (/point[s]?\s*(fort[s]?|positif[s]?|bien|atout)/i.test(line) || low.includes("✓") || low.includes("forces")) { currentSection = "strengths"; continue; }
    if (/point[s]?\s*(à\s*trav|faible|améliorer|amélioration|progress|axe)/i.test(line) || low.includes("à améliorer") || low.includes("objectif")) { currentSection = "improvements"; continue; }
    if (/recommand|conseil[s]?|plan|prochaine étape|priorité/i.test(line)) { currentSection = "recommendations"; continue; }
    const clean = line.replace(/^[-•*→✦✗✓\d).\s]+/, "").trim();
    if (!clean) continue;
    if (currentSection === "strengths") strengths.push(clean);
    else if (currentSection === "improvements") improvements.push(clean);
    else if (currentSection === "recommendations") recommendations.push(clean);
    else overviewLines.push(clean);
  }
  return { overview: overviewLines.join(" "), strengths, improvements, recommendations };
}

function scanRing(pct, color, label, valLabel) {
  const r = 22;
  const c = +(2 * Math.PI * r).toFixed(1);
  const filled = +((Math.max(0, Math.min(100, pct || 0)) / 100) * c).toFixed(1);
  return `<div class="ring-item">
    <div style="position:relative;width:52px;height:52px">
      <svg class="ring-svg" width="52" height="52" viewBox="0 0 52 52">
        <circle class="ring-track" cx="26" cy="26" r="${r}"/>
        <circle class="ring-fill" cx="26" cy="26" r="${r}" stroke="${color}" stroke-dasharray="${filled} ${c}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:900;color:${color}">${valLabel}</div>
    </div>
    <div class="ring-lbl">${label}</div>
  </div>`;
}

function renderPendingScan(scan, date) {
  return `<div class="scan-v2 scan-v2-pending">
    <div class="scan-pending-shell">
      <div class="scan-pending-figure">
        <div class="scan-pending-grid scan-pending-grid-h"></div>
        <div class="scan-pending-grid scan-pending-grid-v"></div>
        <div class="scan-pending-avatar">
          <span class="scan-pending-eye left"></span>
          <span class="scan-pending-eye right"></span>
        </div>
        <div class="scan-pending-body"></div>
        <div class="scan-pending-arm left"></div>
        <div class="scan-pending-arm right"></div>
        <div class="scan-pending-leg left"></div>
        <div class="scan-pending-leg right"></div>
      </div>
      <div class="scan-pending-copy">
        <div class="scan-pending-date">${date}</div>
        <div class="scan-pending-title">Scan en cours d'analyse</div>
        <div class="scan-pending-sub">La photo est bien reçue. L'IA prépare le score calibré, les points forts et les axes prioritaires.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;max-width:420px">
          <div class="scan-v3-line">① Vérification cadrage</div>
          <div class="scan-v3-line">② Lecture posture</div>
          <div class="scan-v3-line">③ Composition / définition</div>
          <div class="scan-v3-line">④ Synthèse coach</div>
        </div>
        <div class="scan-pending-chip">Analyse en cours</div>
      </div>
    </div>
  </div>`;
}

function renderBodyScanCard(scan, imageUrl) {
  const ext = scan.extended_analysis || {};
  const extStrengths = Array.isArray(ext.strengths) ? ext.strengths : [];
  const extImprovements = Array.isArray(ext.areas_for_improvement) ? ext.areas_for_improvement : [];
  const extScores = ext.score_breakdown || {};
  const parsed = extStrengths.length || extImprovements.length
    ? { strengths: extStrengths, improvements: extImprovements, recommendations: [], overview: "" }
    : parseScanFeedback(scan.ai_feedback || "");
  const physScore = Number(scan.physical_score || 0);
  const date = new Date(scan.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const level = bodyScanLevelMeta(physScore);
  const confidence = bodyScanConfidenceMeta(ext);
  const verdict = bodyScanVerdict(ext, physScore);
  const trend = bodyScanTrendMeta(ext);
  const reco = ext.personalized_recommendations || {};
  const scoreChips = [
    scan.symmetry_score != null ? scanRing(scan.symmetry_score, "#60a5fa", "Sym.", scan.symmetry_score) : "",
    extScores.muscle_definition != null ? scanRing(extScores.muscle_definition, "#22c55e", "Défin.", extScores.muscle_definition) : "",
    extScores.body_composition != null ? scanRing(extScores.body_composition, "#a855f7", "Compo.", extScores.body_composition) : "",
    scan.posture_score != null ? scanRing(scan.posture_score, "#06b6d4", "Post.", scan.posture_score) : ""
  ].filter(Boolean).join("");
  const bodyfat = ext?.estimated_metrics?.bodyfat_range || (scan.bodyfat_proxy != null ? `${scan.bodyfat_proxy}%` : null);
  const trainingFocus = (reco.training_focus || reco.training || []).slice(0, 3);
  const nutritionFocus = (reco.nutrition || []).slice(0, 2);
  const exercises = (reco.exercise_examples || []).slice(0, 4);
  const improvements = parsed.improvements.slice(0, 3);
  const strengths = parsed.strengths.slice(0, 3);
  const previousScore = ext?.comparison?.previous_score;

  return `<div class="scan-v2">
    <div class="scan-v2-top scan-v3-top">
      <div class="scan-v2-photo scan-v3-photo">
        ${imageUrl ? lazyImg(imageUrl, "Scan", "", "width:100%;height:100%;object-fit:cover;opacity:.96") : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:.8rem;padding:20px;text-align:center">📷 Photo non disponible</div>`}
        <div class="scan-v3-cross scan-v3-cross-h"></div>
        <div class="scan-v3-cross scan-v3-cross-v"></div>
        <div class="scan-v2-photo-overlay">
          <span class="scan-v2-pill">${date}</span>
          <span class="scan-v2-pill">${confidence.label}</span>
          ${trend ? `<span class="scan-v2-pill" style="background:${trend.tone === 'up' ? 'rgba(34,197,94,.12)' : trend.tone === 'down' ? 'rgba(239,68,68,.12)' : 'rgba(255,255,255,.07)'};color:${trend.tone === 'up' ? '#4ade80' : trend.tone === 'down' ? '#fda4af' : 'var(--text2)'}">${trend.label}</span>` : ''}
        </div>
      </div>
      <div class="scan-v2-right scan-v3-right">
        <div class="scan-v3-scorecard">
          <div>
            <div class="scan-v3-label">Score calibré</div>
            <div class="scan-v3-score">${physScore}<span>/100</span></div>
            <div class="scan-v3-level">${level.label} · ${level.hint}</div>
            ${bodyScanScoreRail(physScore)}
          </div>
          <div class="scan-v3-mini">
            <div class="scan-v3-mini-row"><span>Bodyfat estimé</span><strong>${bodyfat || "—"}</strong></div>
            <div class="scan-v3-mini-row"><span>Catégorie</span><strong>${ext?.estimated_metrics?.fitness_category ? escapeHtml(String(ext.estimated_metrics.fitness_category)) : "—"}</strong></div>
            <div class="scan-v3-mini-row"><span>Scan précédent</span><strong>${previousScore != null ? `${previousScore}/100` : '—'}</strong></div>
            <div class="scan-v3-mini-row"><span>Fiabilité</span><strong>${confidence.label}</strong></div>
          </div>
        </div>
        ${scoreChips ? `<div class="rings-row scan-v3-rings">${scoreChips}</div>` : ""}
        <div class="scan-v3-verdict">${escapeHtml(verdict)}</div>
        <div class="scan-v2-2col scan-v3-columns">
          <div class="scan-v2-strengths">
            <div class="scan-v2-col-hdr scan-v2-str-hdr">Ce qui soutient la note</div>
            ${strengths.length ? strengths.map(s => `<div class="scan-v2-pt scan-v2-str-pt">${escapeHtml(s)}</div>`).join("") : `<div class="scan-v2-pt scan-v2-str-pt">Base exploitable pour progresser si tu restes régulier.</div>`}
          </div>
          <div class="scan-v2-weaknesses">
            <div class="scan-v2-col-hdr scan-v2-wk-hdr">Ce qui freine vraiment</div>
            ${improvements.length ? improvements.map(s => `<div class="scan-v2-pt scan-v2-wk-pt">${escapeHtml(s)}</div>`).join("") : `<div class="scan-v2-pt scan-v2-wk-pt">Photo ou lecture trop moyenne pour aller plus haut.</div>`}
          </div>
        </div>
      </div>
    </div>
    <div class="scan-v3-bottom">
      <div class="scan-v3-block">
        <div class="scan-v3-block-hdr">Priorité entraînement</div>
        ${trainingFocus.length ? trainingFocus.map(item => `<div class="scan-v3-line">${escapeHtml(item)}</div>`).join("") : `<div class="scan-v3-line">Travail full body propre, posture et régularité.</div>`}
      </div>
      <div class="scan-v3-block">
        <div class="scan-v3-block-hdr">Exercices utiles</div>
        ${exercises.length ? exercises.map(item => `<div class="scan-v3-pill">${escapeHtml(item)}</div>`).join("") : `<div class="scan-v3-line">Pompes inclinées, rowing, hip hinge, gainage.</div>`}
      </div>
      <div class="scan-v3-block">
        <div class="scan-v3-block-hdr">Nutrition / prochain scan</div>
        ${nutritionFocus.length ? nutritionFocus.map(item => `<div class="scan-v3-line">${escapeHtml(item)}</div>`).join("") : ""}
        <div class="scan-v3-line">${escapeHtml(String(reco.frequency_suggestion || "Refais un scan sous 4 à 6 semaines avec le même angle pour comparer proprement."))}</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;padding:8px 14px 10px;border-top:1px solid var(--border)">
      <button onclick="deleteBodyScan('${scan.id}')" style="display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;color:var(--muted);font-size:.74rem;font-weight:600;padding:5px 8px;border-radius:8px;transition:color .2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        Supprimer
      </button>
    </div>
  </div>`;
}

async function loadScans() {

  if (!U) return;
  const el = document.getElementById("scans-list");
  if (!el) return;

  try {
    const { data, error } = await SB.from("body_scans").select("*").eq("user_id", U.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;

    if (!data?.length) {
      el.innerHTML = '<div class="empty" style="padding:40px 16px"><span class="empty-ic">🔬</span>Aucune analyse — uploadez une photo ci-dessus</div>';
      return;
    }

    const scanImageUrls = {};
    await Promise.all((data || []).map(async (scan) => {
      const path = scan.image_url || scan.image_path;
      if (!path) return;
      if (/^https?:\/\//i.test(path)) { scanImageUrls[scan.id] = path; return; }
      try {
        const { data: signed } = await SB.storage.from("user_uploads").createSignedUrl(path, 3600);
        if (signed?.signedUrl) scanImageUrls[scan.id] = signed.signedUrl;
      } catch {}
    }));

    el.innerHTML = data.map((scan) => {
      const date = new Date(scan.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
      if (!scan.ai_feedback) return renderPendingScan(scan, date);
      return renderBodyScanCard(scan, scanImageUrls[scan.id]);
    }).join('<div style="height:16px"></div>');
    observeLazyImgs(el);
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

function formatFeedback(text) {
  // Convert newlines to <br> and escape HTML
  return escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>");
}

// ══════════════════════════════════════════════════════════════════════════════
// PROFIL
// ══════════════════════════════════════════════════════════════════════════════

async function deleteBodyScan(id) {
  if (!id || !U) return;
  const confirmed = await confirmModal("Supprimer cette analyse corporelle ?", "Le scan et ses résultats seront supprimés définitivement.");
  if (!confirmed) return;
  try {
    const { error } = await SB.from("body_scans").delete().eq("id", id).eq("user_id", U.id);
    if (error) throw error;
    toast("Analyse supprimée", "ok");
    await loadScans();
  } catch (e) {
    toast(`Erreur: ${e.message}`, "err");
  }
}

async function loadProfile() {
  if (!U) return;
  try {
    const [profileRes, streakRes] = await Promise.all([
      SB.from("profiles").select("display_name,username,age,weight,height").eq("id", U.id).maybeSingle(),
      SB.from("user_streaks").select("current_streak").eq("user_id", U.id).maybeSingle()
    ]);
    const data = profileRes?.data;
    const name = data?.display_name || U.email?.split("@")[0] || "Membre";
    const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setEl("p-name", name);
    setEl("p-email", U.email || "");
    setEl("p-handle", data?.username ? `@${data.username}` : "");
    const pAvatar = document.getElementById("p-avatar");
    if (pAvatar) pAvatar.textContent = name.charAt(0).toUpperCase();
    setVal("p-pseudo", data?.display_name || "");
    setVal("p-username", data?.username || "");
    setVal("p-age", data?.age || "");
    setVal("p-weight", data?.weight || "");
    setVal("p-height", data?.height || "");
    const tu = document.getElementById("tu");
    if (tu) tu.textContent = name;
    // Streak pill
    const streak = streakRes?.data?.current_streak || 0;
    setEl("p-streak", streak > 0 ? `${streak}🔥` : "0");
    // BMI
    const w = parseFloat(data?.weight), h = parseFloat(data?.height);
    if (w > 0 && h > 0) {
      const bmi = (w / ((h/100) ** 2)).toFixed(1);
      setEl("p-bmi", bmi);
      const bmiEl = document.getElementById("p-bmi");
      if (bmiEl) bmiEl.style.color = bmi < 18.5 ? "#38bdf8" : bmi < 25 ? "#22c55e" : bmi < 30 ? "#f97316" : "#ef4444";
    } else {
      setEl("p-bmi", "—");
    }
    if (data?.weight) { USER_WEIGHT = parseFloat(data.weight); renderWater(); }
  } catch (e) { console.error("[Profile] Load error:", e); }
}

async function saveProfile() {
  if (!U) return toast("Session expirée.", "err");
  const pPseudo = document.getElementById("p-pseudo");
  const pUsername = document.getElementById("p-username");
  const display_name = pPseudo ? pPseudo.value.trim() : "";
  const username = pUsername ? pUsername.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "") : "";
  const age = parseInt(document.getElementById("p-age")?.value || "0", 10) || null;
  const weight = parseFloat(document.getElementById("p-weight")?.value || "0") || null;
  const height = parseFloat(document.getElementById("p-height")?.value || "0") || null;
  if (!display_name) return toast("Pseudo requis.", "err");
  if (username && username.length < 3) return toast("Username: 3 caractères minimum.", "err");

  const btn = document.getElementById("btn-save-profile");
  await withButton(btn, "Enregistrement…", async () => {
    const payload = { id: U.id, display_name, updated_at: new Date().toISOString() };
    if (username) payload.username = username;
    if (age) payload.age = age;
    if (weight) payload.weight = weight;
    if (height) payload.height = height;
    const { error } = await SB.from("profiles").upsert(payload, { onConflict: "id" });
    if (error) {
      // username column might not exist (migration v4 not applied)
      if (error.code === "42703" || (error.message?.includes("column") && error.message?.includes("username"))) {
        delete payload.username;
        const { error: e2 } = await SB.from("profiles").upsert(payload, { onConflict: "id" });
        if (e2) throw e2;
        toast("Pseudo mis à jour. Appliquez migration_v4 pour activer le username.", "ok");
        await loadProfile();
        return;
      }
      if (error.message?.includes("idx_profiles_username") || error.message?.includes("duplicate")) {
        return toast("Ce username est déjà pris.", "err");
      }
      throw error;
    }
    toast("Profil mis à jour ✓", "ok");
    await loadProfile();
  }).catch(e => toast(`Erreur: ${e.message}`, "err"));
}

async function loadStats() {
  if (!U) return;
  // Show stale data instantly while revalidating
  const cached = DataCache.get(`stats:${U.id}`);
  if (cached) applyStats(cached);
  try {
    const [sessions, scans, posts] = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id)
    ]);
    const data = { sessCount: sessions.count ?? 0, scansCount: scans.count ?? 0, postsCount: posts.count ?? 0 };
    DataCache.set(`stats:${U.id}`, data, 90000); // 90s TTL
    applyStats(data);
  } catch (e) {
    console.error("[Stats] Load error:", e);
  }
}

function applyStats({ sessCount = 0, scansCount = 0, postsCount = 0 } = {}) {
  const ids = { "st-sess": sessCount, "st-scans": scansCount, "st-posts": postsCount, "db-sess": sessCount, "cs-week": sessCount };
  Object.entries(ids).forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.textContent = val; });
  const totalSess = document.getElementById("db-total-sessions");
  if (totalSess) totalSess.textContent = sessCount;
}

// ══════════════════════════════════════════════════════════════════════════════
// DÉFIS & SUCCÈS
// ══════════════════════════════════════════════════════════════════════════════

const DEFIS_LIST = [
  { id: "sessions_5",   icon: "🏃", title: "5 séances complétées",      desc: "Sauvegarde 5 séances d'entraînement",                      difficulty: "Facile",    xp: 250,  color: "#22c55e", target: 5,     unit: "séances",   metric: "sessions" },
  { id: "sessions_10",  icon: "💪", title: "10 séances complétées",     desc: "Sauvegarde 10 séances — une vraie routine se forme",       difficulty: "Moyen",     xp: 500,  color: "#f97316", target: 10,    unit: "séances",   metric: "sessions" },
  { id: "sessions_30",  icon: "🏋️", title: "30 séances d'entraînement", desc: "Complète 30 séances au total — athlète confirmé",          difficulty: "Difficile", xp: 1500, color: "#ef4444", target: 30,    unit: "séances",   metric: "sessions" },
  { id: "streak_3",     icon: "⚡", title: "Streak 3 jours",            desc: "3 jours consécutifs d'entraînement",                       difficulty: "Facile",    xp: 150,  color: "#38bdf8", target: 3,     unit: "jours",     metric: "streak" },
  { id: "streak_7",     icon: "🔥", title: "Streak 7 jours",            desc: "Entraîne-toi 7 jours de suite sans interruption",          difficulty: "Moyen",     xp: 500,  color: "#f97316", target: 7,     unit: "jours",     metric: "streak" },
  { id: "streak_14",    icon: "🌟", title: "Streak 14 jours",           desc: "Deux semaines sans manquer un seul jour",                  difficulty: "Difficile", xp: 900,  color: "#a855f7", target: 14,    unit: "jours",     metric: "streak" },
  { id: "streak_30",    icon: "👑", title: "Streak 30 jours",           desc: "Un mois entier de régularité absolue",                     difficulty: "Expert",    xp: 2500, color: "#eab308", target: 30,    unit: "jours",     metric: "streak" },
  { id: "scans_1",      icon: "📸", title: "Premier body scan IA",      desc: "Réalise ton premier scan corporel avec l'IA",              difficulty: "Facile",    xp: 200,  color: "#0ea5e9", target: 1,     unit: "scans",     metric: "scans" },
  { id: "scans_5",      icon: "🔬", title: "5 body scans réalisés",     desc: "Suis l'évolution de ton physique sur la durée",            difficulty: "Moyen",     xp: 600,  color: "#06b6d4", target: 5,     unit: "scans",     metric: "scans" },
  { id: "scans_10",     icon: "🧬", title: "10 scans comparables",      desc: "Construis un vrai historique de transformation",           difficulty: "Difficile", xp: 1200, color: "#0891b2", target: 10,    unit: "scans",     metric: "scans" },
  { id: "daily_7",      icon: "🎯", title: "7 journées de défis",       desc: "Accomplis tous les défis du jour à 7 reprises",            difficulty: "Moyen",     xp: 700,  color: "#84cc16", target: 7,     unit: "journées",  metric: "daily_completions" },
  { id: "daily_30",     icon: "🏅", title: "30 journées de défis",      desc: "Maîtrise quotidienne pendant un mois entier",             difficulty: "Expert",    xp: 2000, color: "#65a30d", target: 30,    unit: "journées",  metric: "daily_completions" },
  { id: "recipes_3",    icon: "🍳", title: "3 recettes IA",             desc: "Crée 3 recettes détaillées pour muscler ta cuisine",       difficulty: "Facile",    xp: 220,  color: "#f59e0b", target: 3,     unit: "recettes",  metric: "recipes" },
  { id: "recipes_10",   icon: "🍽️", title: "10 recettes IA",            desc: "Constitue une vraie base de repas utiles",                difficulty: "Moyen",     xp: 650,  color: "#f97316", target: 10,    unit: "recettes",  metric: "recipes" },
  { id: "nutrition_5",  icon: "🥗", title: "5 plans nutrition",         desc: "Teste et affine tes journées nutrition",                  difficulty: "Facile",    xp: 250,  color: "#84cc16", target: 5,     unit: "plans",     metric: "nutrition_plans" },
  { id: "nutrition_20", icon: "📋", title: "20 plans nutrition",        desc: "Construis une vraie routine alimentaire",                 difficulty: "Difficile", xp: 1000, color: "#65a30d", target: 20,    unit: "plans",     metric: "nutrition_plans" },
  { id: "water_7",      icon: "💧", title: "7 jours d'hydratation",      desc: "Atteins ton objectif eau 7 jours distincts",             difficulty: "Moyen",     xp: 320,  color: "#38bdf8", target: 7,     unit: "jours",     metric: "water_days" },
  { id: "water_21",     icon: "🌊", title: "21 jours bien hydratés",     desc: "Reste propre sur l'hydratation pendant 3 semaines",       difficulty: "Difficile", xp: 900,  color: "#0ea5e9", target: 21,    unit: "jours",     metric: "water_days" },
  { id: "social_1",     icon: "📣", title: "Premier post communautaire", desc: "Partage ta première photo ou message",                   difficulty: "Facile",    xp: 150,  color: "#ec4899", target: 1,     unit: "posts",     metric: "posts" },
  { id: "social_5",     icon: "🤝", title: "5 posts publiés",           desc: "Inspire la communauté avec 5 publications",               difficulty: "Moyen",     xp: 400,  color: "#f43f5e", target: 5,     unit: "posts",     metric: "posts" },
  { id: "10kcal",       icon: "🔥", title: "10 000 calories brûlées",   desc: "Cumule 10 000 kcal sur des séances sauvegardées",         difficulty: "Difficile", xp: 1000, color: "#eab308", target: 10000, unit: "kcal",      metric: "calories" },
  { id: "5h_week",      icon: "⏱️", title: "5h d'entraînement/semaine", desc: "Totalise 5 heures de sport sur une même semaine",         difficulty: "Moyen",     xp: 600,  color: "#8b5cf6", target: 300,   unit: "minutes",   metric: "weekly_time" },
  { id: "variety",      icon: "🌈", title: "Polyvalence totale",        desc: "3 types d'entraînement différents en une semaine",        difficulty: "Moyen",     xp: 400,  color: "#f97316", target: 3,     unit: "types",     metric: "variety" },
  { id: "perfect_week", icon: "💎", title: "Semaine propre",            desc: "Entraînement + nutrition suivis 7/7 sur une semaine",     difficulty: "Expert",    xp: 2000, color: "#3b82f6", target: 7,     unit: "jours",     metric: "perfect" }
];

function getDailyCompletionCount() {
  try { return Number(localStorage.getItem("fitai_daily_completions") || "0"); }
  catch { return 0; }
}

async function loadDefis() {
  if (!U) return;
  const el = document.getElementById("defis-list");
  if (!el) return;

  // Render daily challenges in the défis tab immediately
  renderDailyChallengesSection();

  // Live countdown: refresh every minute while on this tab
  if (window._defiCountdownTimer) clearInterval(window._defiCountdownTimer);
  window._defiCountdownTimer = setInterval(() => {
    const cdEl = document.getElementById("daily-defi-countdown");
    if (cdEl) cdEl.textContent = _getMidnightCountdown();
    else { clearInterval(window._defiCountdownTimer); window._defiCountdownTimer = null; }
  }, 60000);

  // Load all trackable metrics
  let totalSessions = 0, currentStreak = 0, longestStreak = 0, totalScans = 0, totalPosts = 0, totalRecipes = 0;
  try {
    const [sessRes, streakRes, scansRes, postsRes, recipesRes] = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("user_streaks").select("current_streak,longest_streak,total_workouts").eq("user_id", U.id).maybeSingle(),
      SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("saved_recipes").select("id", { count: "exact", head: true }).eq("user_id", U.id)
    ]);
    totalSessions   = sessRes.count   || 0;
    currentStreak   = streakRes.data?.current_streak  || 0;
    longestStreak   = streakRes.data?.longest_streak  || 0;
    totalScans      = scansRes.count  || 0;
    totalPosts      = postsRes.count  || 0;
    totalRecipes    = recipesRes.count || 0;
  } catch (e) { console.error("[Defis] Stats error:", e); }

  const dailyCompletions = getDailyCompletionCount();
  const nutritionPlans = getLocalMetric('fitai_nutrition_plans');
  const waterGoalDays = getLocalMetric('fitai_water_goal_days');
  const recipeCount = Math.max(totalRecipes, getLocalMetric('fitai_recipes_saved'));

  // Calculate progress for each defi
  const defisProgress = DEFIS_LIST.map(d => {
    let current = 0;
    if      (d.metric === "sessions")          current = totalSessions;
    else if (d.metric === "streak")            current = Math.max(currentStreak, longestStreak);
    else if (d.metric === "scans")             current = totalScans;
    else if (d.metric === "posts")             current = totalPosts;
    else if (d.metric === "daily_completions") current = dailyCompletions;
    else if (d.metric === "recipes")           current = recipeCount;
    else if (d.metric === "nutrition_plans")   current = nutritionPlans;
    else if (d.metric === "water_days")        current = waterGoalDays;
    else current = 0; // calories, weekly_time, variety, perfect — non encore tracké
    const pct = Math.min(100, Math.round((current / d.target) * 100));
    const completed = current >= d.target;
    return { ...d, current, pct, completed };
  });

  // Save XP locally
  const completedCount = defisProgress.filter(d => d.completed).length;
  const totalXP = defisProgress.filter(d => d.completed).reduce((a, d) => a + d.xp, 0);
  const level = Math.floor(totalXP / 1000) + 1;
  const xpInLevel = totalXP % 1000;

  // Update header stats
  const elLevel = document.getElementById("defi-level");
  const elXP = document.getElementById("defi-xp");
  const elCompleted = document.getElementById("defi-completed");
  const elProgress = document.getElementById("defi-progress-fill");
  const elProgressText = document.getElementById("defi-progress-text");
  if (elLevel) elLevel.textContent = level;
  const elLevelText = document.getElementById("defi-level-text");
  if (elLevelText) elLevelText.textContent = level;
  if (elXP) elXP.textContent = totalXP;
  if (elCompleted) elCompleted.textContent = `${completedCount}/${DEFIS_LIST.length}`;
  if (elProgress) elProgress.style.width = `${(xpInLevel / 1000) * 100}%`;
  if (elProgressText) elProgressText.textContent = `${xpInLevel} / 1000 XP pour atteindre le niveau ${level + 1}`;

  const diffColors = { "Moyen": "var(--yellow)", "Difficile": "var(--red)", "Expert": "var(--accent)" };

  el.innerHTML = defisProgress.map(d => `
    <div class="defi-card" style="border-top:3px solid ${d.color};${d.completed ? "opacity:.92;box-shadow:0 0 0 1px " + d.color + "44" : ""}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span style="font-size:1.5rem">${d.icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800;font-size:.92rem;display:flex;align-items:center;gap:6px">
            ${escapeHtml(d.title)}
            ${d.completed ? `<span style="font-size:.7rem;background:rgba(34,197,94,.15);color:#4ade80;border:1px solid rgba(34,197,94,.3);border-radius:999px;padding:1px 7px;font-weight:700">✓ Complété</span>` : ""}
          </div>
          <div class="meal-info" style="margin-top:2px">${escapeHtml(d.desc)}</div>
        </div>
      </div>
      <div style="display:flex;gap:7px;margin-bottom:10px;flex-wrap:wrap">
        <span class="badge" style="background:rgba(255,255,255,.06);color:${diffColors[d.difficulty] || "var(--muted)"}">${d.difficulty}</span>
        <span class="badge" style="background:rgba(234,179,8,.1);color:var(--yellow)">+${d.xp} XP</span>
        ${d.metric === "calories" || d.metric === "weekly_time" || d.metric === "variety" || d.metric === "perfect"
          ? `<span class="badge" style="background:rgba(255,255,255,.04);color:var(--muted);font-size:.65rem" title="Suivi manuel">📋 Manuel</span>` : ""}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:.78rem;margin-bottom:6px">
        <span style="color:var(--muted)">Progression</span>
        <span style="font-weight:700;color:${d.completed ? "#4ade80" : "var(--text)"}">${d.current} / ${d.target} ${d.unit}</span>
      </div>
      <div class="progress-track" style="height:6px">
        <div class="progress-fill" style="width:${d.pct}%;background:${d.completed ? "#22c55e" : d.color}"></div>
      </div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:4px">${d.completed ? "🏆 Défi accompli !" : d.pct + "% accompli"}</div>
    </div>
  `).join("");
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════════════════

let _confirmResolve = null;

function confirmModal(title, sub = "Cette action est irréversible.", okLabel = "Supprimer") {
  return new Promise((resolve) => {
    const overlay  = document.getElementById("confirm-overlay");
    const titleEl  = document.getElementById("confirm-title");
    const subEl    = document.getElementById("confirm-sub");
    const okBtn    = document.getElementById("confirm-ok-btn");
    if (!overlay) { resolve(window.confirm(title)); return; }
    if (titleEl) titleEl.textContent  = title;
    if (subEl)   { subEl.textContent = sub; subEl.style.display = sub ? "block" : "none"; }
    if (okBtn)   okBtn.textContent   = okLabel;
    overlay.classList.add("open");
    _confirmResolve = resolve;
  });
}

function confirmOk() {
  document.getElementById("confirm-overlay")?.classList.remove("open");
  if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
}

function confirmCancel() {
  document.getElementById("confirm-overlay")?.classList.remove("open");
  if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITAIRES
// ══════════════════════════════════════════════════════════════════════════════

function showGlobalLoader(show, text = "Chargement…") {
  const loader = document.getElementById("global-loader");
  if (!loader) return;
  loader.style.display = show ? "flex" : "none";
  const msg = loader.querySelector(".boot-msg");
  if (msg) msg.textContent = text;
}

async function getToken() {
  if (!SB) return "";
  try {
    const { data, error } = await SB.auth.getSession();
    if (error) {
      console.error("[Auth] getToken error:", error);
      AUTH_ERROR_COUNT++;
      if (AUTH_ERROR_COUNT >= MAX_AUTH_ERRORS) {
        await clearLocalSession();
        showAuth();
      }
      return "";
    }
    return data.session?.access_token || "";
  } catch (e) {
    console.error("[Auth] getToken exception:", e);
    return "";
  }
}

function toInt(id) {
  const el = document.getElementById(id);
  return parseInt(el?.value || "0", 10) || 0;
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
  if (!el) return;
  el.textContent = message;
  el.className = `on ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "";
  }, 3000);
}

async function withButton(button, label, fn) {
  if (!button) return fn();
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


function normalizeCoachError(msg, code) {
  const m = String(msg || "").toLowerCase();
  // Vercel/infra errors — never leak raw infrastructure details to users
  if (m.includes("function_invocation_failed") || m.includes("a server error has occurred") ||
      /[a-z]{2,4}1::[a-z0-9]+-\d+-[a-f0-9]+/.test(String(msg || ""))) {
    return "Le coach a eu un coup de chaud. Ré-essaie dans un instant.";
  }
  if (code === "QUOTA" || m.includes("quota") || m.includes("429") || m.includes("rate limit") || m.includes("resource exhausted")) {
    return "Le coach est momentanément surchargé. Réessayez dans 30 secondes.";
  }
  if (m.includes("timeout") || m.includes("abort") || m.includes("trop de temps")) {
    return "Le coach n'a pas répondu à temps. Réessayez dans quelques secondes.";
  }
  if (m.includes("401") || m.includes("403") || m.includes("api key") || m.includes("auth")) {
    return "Problème de configuration du coach. Contactez le support.";
  }
  if (m.includes("503") || m.includes("502") || m.includes("500") || m.includes("unavailable")) {
    return "Le service coach est momentanément indisponible. Réessaie dans un instant.";
  }
  if (m.includes("error") || m.includes("exception") || m.includes("failed") || m.includes("crash")) {
    return "Le coach a rencontré une erreur. Réessaie dans un instant.";
  }
  const clean = String(msg || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 80 ? "Le coach est momentanément indisponible. Réessaie dans un instant." : (clean || "Le coach est momentanément indisponible.");
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Auto-retry once on 5xx
    let response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status >= 500) {
      await new Promise(r => setTimeout(r, 1200));
      response = await fetch(url, { ...options, signal: controller.signal });
    }
    const json = await safeResponseJson(response);
    if (!response.ok || !json.ok) {
      const rawErr = json.error || `Erreur serveur (HTTP ${response.status})`;
      const cleanErr = normalizeCoachError(rawErr, json.error_code);
      throw new Error(cleanErr);
    }
    return { response: json, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

// SSE streaming fetch for coach chat responses
async function fetchCoachStream({ url, body, token, onChunk, signal }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`Erreur serveur (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return fullText;
      try {
        const evt = JSON.parse(payload);
        if (evt.error) throw new Error(evt.error);
        if (evt.text) {
          fullText += evt.text;
          if (typeof onChunk === "function") onChunk(fullText);
        }
      } catch (parseErr) {
        // Only re-throw real errors (not JSON parse failures from non-data lines)
        if (parseErr instanceof SyntaxError) continue;
        throw parseErr;
      }
    }
  }
  return fullText;
}

function timeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `il y a ${Math.floor(seconds / 86400)}j`;
  return date.toLocaleDateString("fr-FR");
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function formatCoachText(raw) {
  if (!raw) return "";

  // Split into lines for processing
  const lines = String(raw).split("\n");
  const out = [];
  let inUl = false, inOl = false;

  const closeList = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  const inlineFormat = (str) => {
    return escapeHtml(str)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/_(.+?)_/g, "<em>$1</em>");
  };

  for (const raw_line of lines) {
    const line = raw_line.trimEnd();

    // H3
    if (/^###\s+/.test(line)) {
      closeList();
      out.push(`<div class="coach-h3">${inlineFormat(line.replace(/^###\s+/, ""))}</div>`);
      continue;
    }
    // H2
    if (/^##\s+/.test(line)) {
      closeList();
      out.push(`<div class="coach-h2">${inlineFormat(line.replace(/^##\s+/, ""))}</div>`);
      continue;
    }
    // H1 (━━ style separators too)
    if (/^#\s+/.test(line) || /^━{2,}/.test(line)) {
      closeList();
      const t = line.replace(/^#\s+/, "").replace(/^━+\s*/, "").replace(/\s*━+$/, "").trim();
      if (t) out.push(`<div class="coach-h2">${inlineFormat(t)}</div>`);
      continue;
    }
    // Unordered list item: starts with - or • or –
    if (/^[-•–]\s+/.test(line)) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push('<ul class="coach-list">'); inUl = true; }
      out.push(`<li>${inlineFormat(line.replace(/^[-•–]\s+/, ""))}</li>`);
      continue;
    }
    // Ordered list item: starts with digit.
    if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push('<ol class="coach-list">'); inOl = true; }
      out.push(`<li>${inlineFormat(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === "") {
      closeList();
      out.push('<div class="coach-gap"></div>');
      continue;
    }

    if (/^(Réponse directe|Pourquoi|Action du jour|Focus du jour)\s*:/i.test(line)) {
      closeList();
      const parts = line.split(/:\s+/);
      const head = parts.shift();
      const rest = parts.join(": ");
      out.push(`<div class="coach-h2">${inlineFormat(head || "")}</div>`);
      if (rest) out.push(`<p class="coach-p">${inlineFormat(rest)}</p>`);
      continue;
    }

    // Normal text
    closeList();
    out.push(`<p class="coach-p">${inlineFormat(line)}</p>`);
  }

  closeList();
  return out.join("");
}

async function retryLastCoachMessage() {
  if (!LAST_COACH_PROMPT) return toast("Aucune demande récente à relancer.", "err");
  return sendCoachMsg(LAST_COACH_PROMPT);
}

function clearCoachChat() {
  COACH_HISTORY = [];
  LAST_COACH_PROMPT = "";
  try { localStorage.removeItem("fp_coach_history"); } catch {}
  renderCoachChat();
  const quickEl = document.getElementById("chat-quick");
  if (quickEl) quickEl.classList.remove("compact");
  const tog = document.getElementById("chat-suggest-toggle");
  if (tog) tog.style.display = "none";
  const planCard = document.getElementById("plan-card");
  if (planCard) planCard.style.display = "none";
  PLAN = null;
}

function useCoachMood(kind) {
  return sendCoachMsg(coachMoodPrompt(kind));
}
window.useCoachMood = useCoachMood;

function toggleCoachSuggestions() {
  const el = document.getElementById("chat-quick");
  if (!el) return;
  const isCompact = el.classList.contains("compact");
  el.classList.toggle("compact", !isCompact);
  const tog = document.getElementById("chat-suggest-toggle");
  if (tog) {
    const btn = tog.querySelector("button");
    if (btn) btn.textContent = isCompact ? "Masquer les actions" : "Afficher les actions rapides";
  }
}

async function toggleComments(postId) {
  const section = document.getElementById(`comments-${postId}`);
  if (!section) return;

  if (section.style.display === "none") {
    section.style.display = "block";
    await loadComments(postId);
  } else {
    section.style.display = "none";
  }
}

async function loadComments(postId) {
  const section = document.getElementById(`comments-${postId}`);
  if (!section) return;

  section.innerHTML = '<div class="loading-small">Chargement…</div>';

  try {
    const { data, error } = await SB.from("comments")
      .select("id,user_id,content,created_at")
      .eq("post_id", postId)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;

    let html = (data || []).map(c => {
      const me = U && c.user_id === U.id;
      return `
        <div class="comment">
          <span class="comment-author">${me ? "Vous" : "Membre"}</span>
          <span class="comment-text">${escapeHtml(c.content)}</span>
          <span class="comment-time">${timeAgo(c.created_at)}</span>
          ${me ? `<button class="btn-mini" onclick="deleteComment('${c.id}', '${postId}')">×</button>` : ""}
        </div>
      `;
    }).join("");

    html += `
      <div class="comment-input">
        <input type="text" id="ci-${postId}" placeholder="Ajouter un commentaire…"
               onkeydown="if(event.key==='Enter')addComment('${postId}')">
        <button class="btn btn-sm btn-p" onclick="addComment('${postId}')">→</button>
      </div>
    `;

    section.innerHTML = html;
  } catch (e) {
    section.innerHTML = `<div class="error-small">Erreur: ${escapeHtml(e.message)}</div>`;
  }
}

async function addComment(postId) {
  if (!U) return toast("Connectez-vous pour commenter.", "err");

  const input = document.getElementById(`ci-${postId}`);
  const content = input ? input.value.trim() : "";
  if (!content) return;
  if (content.length > 500) return toast("Commentaire trop long (max 500).", "err");

  await guarded(`comment-${postId}`, async () => {
    const { error } = await SB.from("comments").insert({
      post_id: postId,
      user_id: U.id,
      content
    });
    if (error) throw error;
    if (input) input.value = "";
    await loadComments(postId);
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function deleteComment(commentId, postId) {
  if (!U) return;
  const ok = await confirmModal("Supprimer ce commentaire ?", "");
  if (!ok) return;
  await guarded(`delcomment-${commentId}`, async () => {
    const { error } = await SB.from("comments").delete().eq("id", commentId).eq("user_id", U.id);
    if (error) throw error;
    await loadComments(postId);
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
}

async function loadStreak() {
  if (!U) return;
  try {
    const { data, error } = await SB.from("user_streaks").select("current_streak,longest_streak,total_workouts").eq("user_id", U.id).maybeSingle();
    if (error) { console.warn("[Streak] Table may not exist:", error.message); return; }
    const streak = data || { current_streak: 0, longest_streak: 0, total_workouts: 0 };

    const dbStreak = document.getElementById("db-streak");
    if (dbStreak) dbStreak.textContent = streak.current_streak;

    const longestEl = document.getElementById("st-longest");
    if (longestEl) longestEl.textContent = streak.longest_streak;

    // Coach stats
    const csLevel = document.getElementById("cs-level");
    if (csLevel) {
      if (streak.total_workouts >= 50) csLevel.textContent = "Expert";
      else if (streak.total_workouts >= 20) csLevel.textContent = "Avancé";
      else if (streak.total_workouts >= 5) csLevel.textContent = "Inter.";
      else csLevel.textContent = "Début.";
    }

    // Update coach suggestion card
    updateCoachCard(streak.current_streak, streak.total_workouts);
  } catch (e) {
    console.warn("[Streak] Load error (table may not exist):", e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ACHIEVEMENTS
// ══════════════════════════════════════════════════════════════════════════════

const ACHIEVEMENT_DEFS = [
  { code: "first_workout", icon: "🏋️", title: "Première séance",   condition: (s) => s.total_workouts >= 1 },
  { code: "workout_5",     icon: "🔥", title: "5 séances",          condition: (s) => s.total_workouts >= 5 },
  { code: "workout_20",    icon: "💪", title: "20 séances",         condition: (s) => s.total_workouts >= 20 },
  { code: "workout_50",    icon: "🏆", title: "50 séances",         condition: (s) => s.total_workouts >= 50 },
  { code: "streak_3",      icon: "⚡", title: "Streak 3 jours",     condition: (s) => s.current_streak >= 3 },
  { code: "streak_7",      icon: "🌟", title: "Streak 7 jours",     condition: (s) => s.current_streak >= 7 },
  { code: "streak_30",     icon: "👑", title: "Streak 30 jours",    condition: (s) => s.current_streak >= 30 },
  { code: "first_scan",    icon: "📸", title: "Premier bodyscan",   condition: (s) => s.scans >= 1 },
  { code: "first_post",    icon: "📣", title: "Premier post",       condition: (s) => s.posts >= 1 },
  { code: "first_recipe",  icon: "🍽️", title: "Première recette",   condition: (s) => s.recipes >= 1 },
];

async function checkAndAwardAchievements(context = {}) {
  if (!U) return;
  try {
    // Build stats snapshot
    const { data: streakData } = await SB.from("user_streaks")
      .select("current_streak,longest_streak,total_workouts")
      .eq("user_id", U.id).maybeSingle();
    const { count: scansCount } = await SB.from("body_scans")
      .select("id", { count: "exact", head: true }).eq("user_id", U.id);
    const { count: postsCount } = await SB.from("community_posts")
      .select("id", { count: "exact", head: true }).eq("user_id", U.id);

    const stats = {
      total_workouts: streakData?.total_workouts || 0,
      current_streak: streakData?.current_streak || 0,
      scans: scansCount || 0,
      posts: postsCount || 0,
      recipes: context.recipes || 0,
      ...context
    };

    // Load already-earned codes
    const { data: earned } = await SB.from("achievements")
      .select("code").eq("user_id", U.id);
    const earnedCodes = new Set((earned || []).map((r) => r.code));

    // Award newly unlocked achievements
    const toInsert = ACHIEVEMENT_DEFS
      .filter((def) => !earnedCodes.has(def.code) && def.condition(stats))
      .map((def) => ({ user_id: U.id, code: def.code, title: def.title }));

    if (toInsert.length > 0) {
      await SB.from("achievements").insert(toInsert);
      toInsert.forEach((a) => {
        const def = ACHIEVEMENT_DEFS.find((d) => d.code === a.code);
        toast(`${def?.icon || "🏅"} Succès débloqué : ${a.title}`, "ok");
      });
      await loadAchievements();
    }
  } catch (err) {
    console.warn("[achievements] check failed:", err);
  }
}

async function loadAchievements() {
  if (!U) return;
  const el = document.getElementById("achievements-list");
  if (!el) return;
  try {
    const { data, error } = await SB.from("achievements")
      .select("code,title").eq("user_id", U.id);
    if (error) throw error;
    renderAchievements(data || []);
  } catch (err) {
    console.warn("[achievements] load failed:", err);
  }
}

function renderAchievements(earned) {
  const el = document.getElementById("achievements-list");
  if (!el) return;
  const earnedCodes = new Set(earned.map((r) => r.code));
  el.innerHTML = ACHIEVEMENT_DEFS.map((def) => {
    const unlocked = earnedCodes.has(def.code);
    return `<span class="badge${unlocked ? "" : " locked"}" title="${def.title}">
      <span class="badge-icon">${def.icon}</span>${def.title}
    </span>`;
  }).join("");
}

function updateCoachCard(streak, totalWorkouts) {
  const titleEl = document.getElementById("db-coach-title");
  const subEl   = document.getElementById("db-coach-sub");
  const btnEl   = document.getElementById("db-coach-btn");
  if (!titleEl || !subEl) return;

  let title, sub, btnLabel;

  if (streak >= 7) {
    title = `${streak} jours de streak`;
    sub   = "Impressionnant ! Maintenez le rythme — demandez au coach votre séance du jour.";
    btnLabel = "Continuer le streak";
  } else if (streak >= 3) {
    title = `Streak de ${streak} jours`;
    sub   = "Vous êtes lancé — ne cassez pas la dynamique maintenant.";
    btnLabel = "Séance du jour";
  } else if (streak === 2) {
    title = "2 jours d'affilée";
    sub   = "Bonne lancée ! Une séance de plus et le streak commence à compter.";
    btnLabel = "Continuer";
  } else if (totalWorkouts === 0) {
    title = "Première séance ?";
    sub   = "Le coach IA génère un programme sur-mesure en quelques secondes.";
    btnLabel = "Démarrer maintenant";
  } else if (streak === 0 && totalWorkouts > 0) {
    title = "Reprenez l'entraînement";
    sub   = `${totalWorkouts} séance${totalWorkouts > 1 ? "s" : ""} au compteur — il est temps de reprendre.`;
    btnLabel = "Relancer une séance";
  } else {
    title = "Séance du jour";
    sub   = "Demandez au coach une séance adaptée à votre humeur et vos objectifs.";
    btnLabel = "Démarrer";
  }

  titleEl.textContent = title;
  subEl.textContent   = sub;
  if (btnEl) btnEl.textContent = "▶ " + btnLabel;
}

// ══════════════════════════════════════════════════════════════════════════════
// SANITIZE COACH HTML (DOMParser-based, allow safe tags only)
// ══════════════════════════════════════════════════════════════════════════════

function sanitizeCoachHtml(html) {
  if (!html) return "";
  const ALLOWED_TAGS = new Set(["STRONG","EM","DIV","SPAN","UL","OL","LI","BR","P","B","I"]);
  const ALLOWED_ATTRS = new Set(["style","class"]);
  // Only allow safe class names (coach-* prefix only)
  const SAFE_CLASS = /^[\w\s-]*$/;
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  function clean(node) {
    const children = Array.from(node.childNodes);
    children.forEach(child => {
      if (child.nodeType === 3) return; // text node OK
      if (child.nodeType === 1) {
        if (!ALLOWED_TAGS.has(child.tagName)) {
          // Replace with text content
          const text = document.createTextNode(child.textContent);
          node.replaceChild(text, child);
          return;
        }
        // Remove disallowed attributes
        Array.from(child.attributes).forEach(attr => {
          if (!ALLOWED_ATTRS.has(attr.name)) { child.removeAttribute(attr.name); return; }
          if (attr.name === "style" && /expression|javascript|url\s*\(/i.test(attr.value)) {
            child.removeAttribute("style");
          }
          if (attr.name === "class" && !SAFE_CLASS.test(attr.value)) {
            child.removeAttribute("class");
          }
        });
        clean(child);
      } else {
        node.removeChild(child);
      }
    });
  }
  const root = doc.body.firstChild;
  clean(root);
  return root.innerHTML;
}

// ══════════════════════════════════════════════════════════════════════════════
// GÉNÉRATION PLAN NUTRITION IA
// ══════════════════════════════════════════════════════════════════════════════

async function generateNutrition() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const goalEl     = document.getElementById("nutr-gen-goal");
  const actEl      = document.getElementById("nutr-gen-activity");
  const btn        = document.getElementById("btn-gen-nutrition");
  const errEl      = document.getElementById("nutrition-gen-err");
  if (errEl) { errEl.textContent = ""; errEl.style.display = "none"; }

  // Grey out current values so user knows it's not the new plan yet
  const nutrTargetsEl = document.getElementById("nutr-targets-card");
  if (nutrTargetsEl) nutrTargetsEl.style.opacity = "0.35";

  await withButton(btn, "Génération en cours…", async () => {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    const r = await fetch("/api/generate-nutrition", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        goal:           goalEl?.value || "maintenance",
        activity_level: actEl?.value  || "moderate"
      })
    });

    const j = await safeResponseJson(r);

    if (!r.ok || !j.ok) {
      throw new Error(j.message || j.error || `Erreur serveur (HTTP ${r.status})`);
    }

    await loadNutritionTargets();
    incrementLocalMetric('fitai_nutrition_plans', 1);
    if (j.fallback) {
      toast("Plan de secours appliqué (Gemini indisponible)", "warn");
    } else {
      toast("Plan nutrition généré ✓", "ok");
    }
  }).catch((e) => {
    const msg = e.message || "Erreur génération";
    if (errEl) { errEl.textContent = `Erreur: ${msg}`; errEl.style.display = "block"; }
    toast(`Erreur: ${msg}`, "err");
  }).finally(() => {
    if (nutrTargetsEl) nutrTargetsEl.style.opacity = "";
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// RECETTE IA (Nutrition)
// ══════════════════════════════════════════════════════════════════════════════

async function generateRecipe() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const ingredientsEl = document.getElementById("recipe-ingredients");
  const ingredients = ingredientsEl ? ingredientsEl.value.trim() : "";
  if (!ingredients) return toast("Listez vos ingrédients disponibles.", "err");

  const goal = document.getElementById("recipe-goal")?.value || "equilibre";
  const targetKcal = parseInt(document.getElementById("recipe-kcal")?.value || "500") || 500;
  const resultEl = document.getElementById("recipe-result");
  const errEl = document.getElementById("recipe-err");
  if (errEl) errEl.style.display = "none";

  const goalLabels = {
    equilibre: "repas équilibré",
    hyperproteine: "repas hyperprotéiné (max de protéines)",
    low_carb: "repas low carb (très peu de glucides)",
    prise_de_masse: "repas prise de masse (calorique et protéiné)",
    seche: "repas de sèche (peu calorique, riche en protéines)"
  };

  const btn = document.getElementById("btn-recipe");
  // Clear previous result immediately so there's no ambiguous stale state during generation
  if (resultEl) {
    resultEl.style.display = "none";
    resultEl.innerHTML = "";
  }
  if (errEl) errEl.style.display = "none";
  await withButton(btn, "Génération…", async () => {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    const { response: j } = await fetchJsonWithTimeout("/api/generate-recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ingredients, goal, targetKcal })
    }, 28000);

    // Normalize response: /api/generate-recipe returns { recipe, data }
    let recipe = null;
    if (j.recipe && typeof j.recipe === "object" && j.recipe.name) recipe = j.recipe;
    else if (j.data && typeof j.data === "object" && j.data.name) recipe = j.data;
    else if (j.type === "recipe" && j.data) recipe = j.data;

    checkAndAwardAchievements({ recipes: 1 }).catch(() => {});

    if (!recipe) {
      // Fallback: show raw response
      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div class="card" style="border-left:3px solid var(--green)"><div style="font-weight:700;margin-bottom:8px">Recette générée</div><div style="font-size:.84rem;line-height:1.6;white-space:pre-wrap">${escapeHtml(JSON.stringify(j, null, 2).slice(0, 1000))}</div></div>`;
      }
      return;
    }

    if (resultEl) {
      resultEl.style.display = "block";
      const name = recipe.name || "Recette";
      const foodArt = recipeFoodArt(name);
      const stepsHtml = Array.isArray(recipe.steps)
        ? recipe.steps.map((s, i) => `<li class="recipe-v2-step"><div class="recipe-v2-step-n">${i + 1}</div><span>${escapeHtml(s)}</span></li>`).join("")
        : "";
      resultEl.innerHTML = `
        <div class="recipe-v2">
          <div class="recipe-v2-art">${foodArt}</div>
          <div class="recipe-v2-tag">✦ Recette IA${recipe.prep_time ? ` · ⏱ ${escapeHtml(recipe.prep_time)}` : ""}</div>
          <div class="recipe-v2-name">${escapeHtml(name)}</div>
          <div class="recipe-pills">
            ${recipe.calories ? `<span class="macro-pill mp-kcal">🔥 ${recipe.calories} kcal</span>` : ""}
            ${recipe.protein ? `<span class="macro-pill mp-prot">💪 ${recipe.protein}g prot.</span>` : ""}
            ${recipe.carbs ? `<span class="macro-pill mp-carb">🌾 ${recipe.carbs}g gluc.</span>` : ""}
            ${recipe.fat ? `<span class="macro-pill mp-fat">🥑 ${recipe.fat}g lip.</span>` : ""}
          </div>
          ${stepsHtml ? `<ul class="recipe-v2-steps">${stepsHtml}</ul>` : ""}
          ${recipe.tips ? `<div class="recipe-v2-tip">💡 ${escapeHtml(recipe.tips)}</div>` : ""}
          <button class="btn btn-p btn-sm btn-full" onclick="addRecipeAsMeal()">➕ Ajouter comme repas</button>
        </div>`;
      // Store recipe for "add as meal"
      window._lastRecipe = recipe;
      // Save to DB history (fire-and-forget)
      saveRecipeToHistory(recipe).catch(() => {});
    }
  }).catch((e) => {
    if (errEl) {
      errEl.textContent = `Erreur: ${e.message}`;
      errEl.style.display = "block";
    }
  });
}

async function saveRecipeToHistory(recipe) {
  if (!U || !recipe?.name) return;
  try {
    await SB.from("saved_recipes").upsert({
      user_id:   U.id,
      name:      recipe.name,
      calories:  recipe.calories  || null,
      protein:   recipe.protein   || null,
      carbs:     recipe.carbs     || null,
      fat:       recipe.fat       || null,
      prep_time: recipe.prep_time || null,
      steps:     Array.isArray(recipe.steps) ? recipe.steps : [],
      tips:      recipe.tips      || null,
      saved_at:  new Date().toISOString()
    }, { onConflict: "user_id,name" });
    incrementLocalMetric('fitai_recipes_saved', 1);
    await loadRecipeHistory();
  } catch (err) { console.warn("[recipe-history] save failed:", err); }
}

async function loadRecipeHistory() {
  if (!U) return;
  const el = document.getElementById("recipe-history-list");
  if (!el) return;
  try {
    const { data, error } = await SB.from("saved_recipes")
      .select("id,name,calories,protein,carbs,fat,prep_time,saved_at")
      .eq("user_id", U.id)
      .order("saved_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    renderRecipeHistory(data || []);
  } catch (err) { console.warn("[recipe-history] load failed:", err); }
}

function renderRecipeHistory(items) {
  const el = document.getElementById("recipe-history-list");
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="empty" style="font-size:.82rem;padding:8px 0">Aucune recette générée pour l\'instant.</div>';
    return;
  }
  el.innerHTML = items.map(r => `
    <div class="recipe-hist-item">
      <div class="recipe-hist-icon">${recipeFoodArt(r.name)}</div>
      <div style="flex:1;min-width:0">
        <div class="recipe-hist-name">${escapeHtml(r.name)}</div>
        <div class="recipe-hist-macros">
          ${r.calories ? `🔥 ${r.calories} kcal` : ""}
          ${r.protein  ? ` · 💪 ${r.protein}g prot.` : ""}
          ${r.prep_time ? ` · ⏱ ${escapeHtml(r.prep_time)}` : ""}
        </div>
      </div>
    </div>`).join("");
}

function recipeFoodArt(name) {
  const n = (name || "").toLowerCase();
  if (/poulet|chicken|dinde|turkey/.test(n)) return "🍗";
  if (/boeuf|steak|beef|viande/.test(n)) return "🥩";
  if (/saumon|thon|poisson|fish|crevette|shrimp/.test(n)) return "🐟";
  if (/oeuf|egg|omelette/.test(n)) return "🍳";
  if (/pâtes|pasta|spaghetti|tagliatelle/.test(n)) return "🍝";
  if (/riz|bowl|buddha/.test(n)) return "🥣";
  if (/salade|salad/.test(n)) return "🥗";
  if (/burger|sandwich/.test(n)) return "🍔";
  if (/pizza/.test(n)) return "🍕";
  if (/soupe|soup|bouillon/.test(n)) return "🍲";
  if (/wrap|burrito|tacos/.test(n)) return "🌯";
  if (/smoothie|shake|protein/.test(n)) return "🥤";
  return "🍽️";
}

function addRecipeAsMeal() {
  const r = window._lastRecipe;
  if (!r) return toast("Aucune recette à ajouter.", "err");
  const nameEl = document.getElementById("n-name");
  const kcalEl = document.getElementById("n-kcal");
  const protEl = document.getElementById("n-prot");
  const carbEl = document.getElementById("n-carb");
  const fatEl = document.getElementById("n-fat");
  if (nameEl) nameEl.value = r.name || "Recette IA";
  if (kcalEl) kcalEl.value = r.calories || "";
  if (protEl) protEl.value = r.protein || "";
  if (carbEl) carbEl.value = r.carbs || "";
  if (fatEl) fatEl.value = r.fat || "";
  toast("Recette ajoutée au formulaire. Cliquez sur 'Ajouter ce repas'.", "ok");
}

// ══════════════════════════════════════════════════════════════════════════════
// PLANNING SEMAINE
// ══════════════════════════════════════════════════════════════════════════════

const DAY_NAMES = ["L", "M", "M", "J", "V", "S", "D"];
const INTENSITY_ICONS = { low: "🟢", easy: "🟢", medium: "🟡", high: "🔴", hard: "🔴", repos: "😴" };
const WORKOUT_ICONS = {
  push: "🏋️", pull: "💪", legs: "🦵", upper: "🏋️", lower: "🦵", full: "🔥",
  cardio: "🏃", force: "🏋️", hiit: "⚡", yoga: "🧘", natation: "🏊",
  vélo: "🚴", repos: "😴", récupération: "🛁", mobilité: "🤸", sport: "⚽"
};

function getWeekStart() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0) ? -6 : 1 - day; // go back to Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

function getTodayDayOfWeek() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d; // 1=Mon … 7=Sun
}

function workoutIcon(type) {
  const t = (type || "").toLowerCase();
  return Object.entries(WORKOUT_ICONS).find(([k]) => t.includes(k))?.[1] || "💪";
}

async function generateWeeklyPlan() {
  if (!U) return toast("Connectez-vous d'abord.", "err");
  const btn = document.getElementById("btn-gen-plan");
  if (btn) { btn.disabled = true; btn.textContent = "Génération…"; }
  try {
    const token = await getToken();
    const r = await fetch("/api/generate-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_id: U.id })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `Erreur (HTTP ${r.status})`);
    const phaseLabel = j.phase ? ` — Phase ${j.phase}` : "";
    toast(`Semaine ${j.week_number || "?"}/8 générée${phaseLabel} ✓`, "ok");
    renderWeeklyPlan(j.plan || [], j.week_number, j.phase);
  } catch (e) {
    toast(`Erreur planning : ${e.message}`, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Générer"; }
  }
}

async function loadWeeklyPlan() {
  if (!U) return;
  try {
    const weekStart = getWeekStart();
    const { data, error } = await SB.from("training_schedule")
      .select("day_of_week,workout_type,intensity,notes")
      .eq("user_id", U.id)
      .eq("week_start_date", weekStart)
      .order("day_of_week", { ascending: true });
    if (error) { console.warn("[plan] load error:", error.message); return; }
    renderWeeklyPlan(data || []);
  } catch (e) { console.warn("[plan] load exception:", e); }
}

function renderWeeklyPlan(plan, weekNum, phase) {
  const grid     = document.getElementById("plan-day-grid");
  const emptyEl  = document.getElementById("plan-empty");
  const labelEl  = document.getElementById("plan-week-label");
  if (!grid) return;

  if (!plan.length) {
    grid.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    if (labelEl) labelEl.textContent = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  const weekStart = getWeekStart();
  if (labelEl) {
    const d = new Date(weekStart + "T00:00:00");
    const end = new Date(d); end.setDate(d.getDate() + 6);
    const fmt = (dt) => dt.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    let label = `Semaine du ${fmt(d)} au ${fmt(end)}`;
    if (weekNum) label += ` · S${weekNum}/8`;
    if (phase) label += ` ${phase}`;
    labelEl.textContent = label;
  }

  const today = getTodayDayOfWeek();
  const byDay = Object.fromEntries(plan.map(p => [p.day_of_week, p]));

  grid.innerHTML = Array.from({ length: 7 }, (_, i) => {
    const day  = i + 1;
    const item = byDay[day];
    const isToday = day === today;
    const isRest  = !item || /repos|rest/i.test(item.workout_type || "");
    const ico     = item ? workoutIcon(item.workout_type) : "😴";
    const intIco  = item ? (INTENSITY_ICONS[item.intensity] || "") : "";
    const label   = item ? escapeHtml(item.workout_type.slice(0, 8)) : "Repos";
    return `<div class="plan-day${isToday ? " today" : ""}${isRest ? " rest" : ""}" title="${item?.notes || ""}">
      <div class="plan-day-lbl">${DAY_NAMES[i]}</div>
      <div class="plan-day-ico">${ico}</div>
      ${intIco ? `<div style="font-size:.5rem">${intIco}</div>` : ""}
      <div class="plan-day-txt">${label}</div>
    </div>`;
  }).join("");
}

// ══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ══════════════════════════════════════════════════════════════════════════════

// Exports globaux pour les événements HTML onclick
window.boot = boot;
window.authTab = authMode;
window.doAuth = doAuth;
window.doLogout = doLogout;
window.gotoTab = gotoTab;
window.goalEdit = goalEdit;
window.saveGoal = saveGoal;
window.selectGoalType = selectGoalType;
window.selectGoalLevel = selectGoalLevel;
window.selectGoalSessions = selectGoalSessions;
window.selectGoalEquip = selectGoalEquip;
window.setPostTemplate = setPostTemplate;
window.sendCoachMsg = sendCoachMsg;
window.retryLastCoachMessage = retryLastCoachMessage;
window.generateWorkout = generateWorkout;
window.saveSession = saveSession;
window.clearCoachChat = clearCoachChat;
window.toggleCoachSuggestions = toggleCoachSuggestions;
window.replaySession = replaySession;
window.addMeal = addMeal;
window.deleteMeal = deleteMeal;
window.createPost = createPost;
window.giveKudos = giveKudos;
window.deletePost = deletePost;
window.previewPostPhoto = previewPostPhoto;
window.handleFile = handleFile;
window.handleDrop = handleDrop;
window.doScan = doScan;
window.selectMood = selectMood;
window.startWithMood = startWithMood;
window.saveProfile = saveProfile;
window.deleteBodyScan = deleteBodyScan;
window.generateRecipe    = generateRecipe;
window.generateNutrition = generateNutrition;
window.addRecipeAsMeal = addRecipeAsMeal;
window.toggleComments = toggleComments;
window.addComment = addComment;
window.deleteComment = deleteComment;
window.loadDefis = loadDefis;
window.loadFeed = loadFeed;
window.generateWeeklyPlan = generateWeeklyPlan;
window.confirmOk     = confirmOk;
window.confirmCancel = confirmCancel;
// New
window.searchUsers = searchUsers;
window.sendFriendRequest = sendFriendRequest;
window.acceptFriend = acceptFriend;
window.rejectFriend = rejectFriend;
window.removeFriend = removeFriend;
window.setFeedFilter = setFeedFilter;
window.toggleRecipeMode = toggleRecipeMode;
window.shareRecipe = shareRecipe;
window.loadCommunityRecipes = loadCommunityRecipes;
window.startWorkoutSession = startWorkoutSession;
window.closeWorkoutSession = closeWorkoutSession;
window.woNav = woNav;
window.woToggle = woToggle;

// ══════════════════════════════════════════════════════════════════════════════
// WORKOUT SESSION TIMER
// ══════════════════════════════════════════════════════════════════════════════

let WO_STATE = null; // { exercises[], currentIdx, timerInterval, secondsLeft, phase:"work"|"rest", running }

function startWorkoutSession() {
  if (!PLAN || !Array.isArray(PLAN.exercises) || !PLAN.exercises.length) {
    return toast("Aucune séance à démarrer.", "err");
  }
  WO_STATE = {
    exercises: PLAN.exercises,
    currentIdx: 0,
    timerInterval: null,
    secondsLeft: 0,
    phase: "work",
    running: false
  };
  const overlay = document.getElementById("workout-overlay");
  if (overlay) overlay.classList.add("on");
  const planTitleEl = document.getElementById("wo-plan-title");
  if (planTitleEl) planTitleEl.textContent = PLAN.title || "Séance";
  woRenderExercise();
  document.body.style.overflow = "hidden";
}

function closeWorkoutSession() {
  if (WO_STATE?.timerInterval) clearInterval(WO_STATE.timerInterval);
  WO_STATE = null;
  const overlay = document.getElementById("workout-overlay");
  if (overlay) overlay.classList.remove("on");
  document.body.style.overflow = "";
}

function woRenderExercise() {
  if (!WO_STATE) return;
  const ex = WO_STATE.exercises[WO_STATE.currentIdx];
  const total = WO_STATE.exercises.length;
  const idx = WO_STATE.currentIdx;

  // Progress
  const progFill = document.getElementById("wo-progress-fill");
  const progText = document.getElementById("wo-progress-text");
  if (progFill) progFill.style.width = `${Math.round(((idx + 1) / total) * 100)}%`;
  if (progText) progText.textContent = `Exercice ${idx + 1} / ${total}`;

  // Exercise info
  const labelEl = document.getElementById("wo-ex-label");
  const nameEl = document.getElementById("wo-ex-name");
  const metaEl = document.getElementById("wo-ex-meta");
  const descEl = document.getElementById("wo-desc");
  if (labelEl) labelEl.textContent = `EXERCICE ${idx + 1}`;
  if (nameEl) nameEl.textContent = ex.name || "Exercice";

  // Badges
  const badges = [];
  if (ex.sets > 0) badges.push(`🔁 ${ex.sets} séries`);
  if (ex.reps && ex.reps !== "0") badges.push(`✕ ${ex.reps} reps`);
  if (ex.duration > 0) badges.push(`⏱ ${ex.duration}s`);
  if (ex.rest > 0) badges.push(`💤 ${ex.rest}s repos`);
  if (ex.muscle) badges.push(`💪 ${ex.muscle}`);
  if (metaEl) metaEl.innerHTML = badges.map(b => `<span class="workout-ex-badge">${escapeHtml(b)}</span>`).join("");

  // Description
  if (descEl) {
    if (ex.description) { descEl.textContent = ex.description; descEl.style.display = "block"; }
    else descEl.style.display = "none";
  }

  // Timer setup
  woStopTimer();
  WO_STATE.phase = "work";
  WO_STATE.running = false;
  // Default: use duration if set, otherwise just show sets/reps (no countdown)
  WO_STATE.secondsLeft = ex.duration > 0 ? ex.duration : 0;
  woUpdateTimerDisplay();

  // Reset start button
  const btn = document.getElementById("wo-start-btn");
  if (btn) btn.textContent = WO_STATE.secondsLeft > 0 ? "▶ Démarrer" : "✓ Suivant";
}

function woUpdateTimerDisplay() {
  if (!WO_STATE) return;
  const timerEl = document.getElementById("wo-timer");
  const labelEl = document.getElementById("wo-timer-label");
  if (!timerEl || !labelEl) return;

  if (WO_STATE.phase === "rest") {
    const m = Math.floor(WO_STATE.secondsLeft / 60);
    const s = WO_STATE.secondsLeft % 60;
    timerEl.textContent = WO_STATE.secondsLeft > 0 ? `${m}:${String(s).padStart(2, "0")}` : "Prêt";
    timerEl.style.color = "var(--teal)";
    labelEl.textContent = "REPOS";
    labelEl.className = "workout-timer-label workout-timer-rest";
  } else if (WO_STATE.secondsLeft > 0) {
    const m = Math.floor(WO_STATE.secondsLeft / 60);
    const s = WO_STATE.secondsLeft % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
    timerEl.style.color = "var(--orange)";
    labelEl.textContent = WO_STATE.running ? "EN COURS" : "PRÊT";
    labelEl.className = "workout-timer-label workout-timer-work";
  } else {
    // No duration — sets/reps based
    const ex = WO_STATE.exercises[WO_STATE.currentIdx];
    timerEl.textContent = ex.sets > 1 ? `${ex.sets}×${ex.reps}` : (ex.reps || "—");
    timerEl.style.color = "var(--text)";
    labelEl.textContent = "SÉRIES / REPS";
    labelEl.className = "workout-timer-label";
  }
}

function woToggle() {
  if (!WO_STATE) return;
  const ex = WO_STATE.exercises[WO_STATE.currentIdx];

  // No duration — just advance to next
  if (WO_STATE.secondsLeft === 0 && WO_STATE.phase === "work") {
    return woStartRest();
  }

  if (WO_STATE.running) {
    woStopTimer();
    WO_STATE.running = false;
    const btn = document.getElementById("wo-start-btn");
    if (btn) btn.textContent = "▶ Reprendre";
    return;
  }

  WO_STATE.running = true;
  const btn = document.getElementById("wo-start-btn");
  if (btn) btn.textContent = "⏸ Pause";

  WO_STATE.timerInterval = setInterval(() => {
    if (!WO_STATE) return;
    WO_STATE.secondsLeft = Math.max(0, WO_STATE.secondsLeft - 1);
    woUpdateTimerDisplay();
    if (WO_STATE.secondsLeft === 0) {
      woStopTimer();
      WO_STATE.running = false;
      if (WO_STATE.phase === "work") {
        woStartRest();
      } else {
        // Rest done — go to next
        woNav(1);
      }
    }
  }, 1000);
}

function woStartRest() {
  if (!WO_STATE) return;
  const ex = WO_STATE.exercises[WO_STATE.currentIdx];
  const restSec = ex.rest > 0 ? ex.rest : 0;
  if (restSec === 0) {
    return woNav(1);
  }
  WO_STATE.phase = "rest";
  WO_STATE.secondsLeft = restSec;
  WO_STATE.running = false;
  woUpdateTimerDisplay();
  const btn = document.getElementById("wo-start-btn");
  if (btn) btn.textContent = "▶ Démarrer repos";
  toast(`Repos ${restSec}s ⏸`, "ok");
}

function woStopTimer() {
  if (WO_STATE?.timerInterval) {
    clearInterval(WO_STATE.timerInterval);
    WO_STATE.timerInterval = null;
  }
}

function woNav(dir) {
  if (!WO_STATE) return;
  woStopTimer();
  const next = WO_STATE.currentIdx + dir;
  if (next < 0) return;
  if (next >= WO_STATE.exercises.length) {
    // Session complete
    closeWorkoutSession();
    toast("🎉 Séance terminée ! N'oubliez pas de sauvegarder.", "ok");
    return;
  }
  WO_STATE.currentIdx = next;
  WO_STATE.phase = "work";
  WO_STATE.running = false;
  woRenderExercise();
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG CHART ENGINE — pure SVG, no library
// ══════════════════════════════════════════════════════════════════════════════

function renderSvgChart(data, opts) {
  opts = opts || {};
  var color    = opts.color    || "#2563eb";
  var unit     = opts.unit     || "";
  var H        = opts.H        || 130;
  var zeroBase = !!opts.zeroBase; // force baseline at 0
  if (!data || data.length < 2) {
    return "<div class=\"chart-empty\">Continuez a utiliser l'app pour voir votre evolution ici.</div>";
  }
  var vals  = data.map(function(d) { return d.value; });
  var minV  = zeroBase ? 0 : Math.max(0, Math.min.apply(null, vals) * 0.85);
  var maxV  = Math.max.apply(null, vals);
  if (maxV === minV) maxV = minV + 1;
  var range = maxV - minV;
  var W = 340, padT = 22, padR = 16, padB = 30, padL = 40;
  var cw = W - padL - padR, ch = H - padT - padB;
  var pts = data.map(function(d, i) {
    return {
      x: padL + (i / (data.length - 1)) * cw,
      y: padT + ch - ((d.value - minV) / range) * ch,
      d: d
    };
  });
  var linePath = pts.reduce(function(acc, p, i) {
    if (i === 0) return "M" + p.x.toFixed(1) + "," + p.y.toFixed(1);
    var prev = pts[i - 1];
    var cpx  = (prev.x + p.x) / 2;
    return acc + " C" + cpx.toFixed(1) + "," + prev.y.toFixed(1) + " " + cpx.toFixed(1) + "," + p.y.toFixed(1) + " " + p.x.toFixed(1) + "," + p.y.toFixed(1);
  }, "");
  var baseline = padT + ch;
  var firstSeg = linePath.indexOf(" ");
  var areaPath = "M" + padL + "," + baseline + " L" + pts[0].x.toFixed(1) + "," + pts[0].y.toFixed(1)
    + (firstSeg >= 0 ? linePath.slice(firstSeg) : "") + " L" + pts[pts.length - 1].x.toFixed(1) + "," + baseline + " Z";
  // Y axis: 3 ticks
  var yTickVals = [minV, (minV + maxV) / 2, maxV];
  var yTicks = yTickVals.map(function(v) {
    var y = padT + ch - ((v - minV) / range) * ch;
    var label = v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v) + unit;
    return "<text x=\"" + (padL - 7) + "\" y=\"" + y.toFixed(1) + "\" text-anchor=\"end\" dominant-baseline=\"middle\" fill=\"currentColor\" opacity=\".38\" font-size=\"8.5\">" + label + "</text>"
      + "<line x1=\"" + padL + "\" y1=\"" + y.toFixed(1) + "\" x2=\"" + (padL + cw).toFixed(1) + "\" y2=\"" + y.toFixed(1) + "\" stroke=\"currentColor\" opacity=\".07\" stroke-width=\"1\"/>";
  }).join("");
  // X axis: up to 5 evenly-spaced labels
  var xCount  = Math.min(5, data.length);
  var xIdxs   = Array.from({ length: xCount }, function(_, k) { return Math.round(k * (data.length - 1) / (xCount - 1 || 1)); });
  xIdxs = xIdxs.filter(function(v, i, a) { return a.indexOf(v) === i; });
  var xTicks = xIdxs.map(function(i) {
    var p = pts[i];
    return "<text x=\"" + p.x.toFixed(1) + "\" y=\"" + (baseline + 14).toFixed(1) + "\" text-anchor=\"middle\" fill=\"currentColor\" opacity=\".38\" font-size=\"8.5\">" + escapeHtml(String(data[i].label || "")) + "</text>";
  }).join("");
  var last    = pts[pts.length - 1];
  var lastVal = data[data.length - 1].value;
  var lastLabel = lastVal >= 1000 ? (lastVal / 1000).toFixed(1) + "k" + unit : lastVal + unit;
  var gradId  = "cg" + Math.random().toString(36).slice(2, 8);
  return "<svg viewBox=\"0 0 " + W + " " + H + "\" xmlns=\"http://www.w3.org/2000/svg\" style=\"width:100%;display:block;color:var(--muted);overflow:visible\">"
    + "<defs><linearGradient id=\"" + gradId + "\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"" + color + "\" stop-opacity=\"0.28\"/><stop offset=\"80%\" stop-color=\"" + color + "\" stop-opacity=\"0.04\"/><stop offset=\"100%\" stop-color=\"" + color + "\" stop-opacity=\"0\"/></linearGradient></defs>"
    + "<path d=\"" + areaPath + "\" fill=\"url(#" + gradId + ")\"/>"
    + "<path d=\"" + linePath + "\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>"
    + yTicks + xTicks
    + "<circle cx=\"" + last.x.toFixed(1) + "\" cy=\"" + last.y.toFixed(1) + "\" r=\"5\" fill=\"" + color + "\" stroke=\"var(--surf)\" stroke-width=\"2.5\"/>"
    + "<text x=\"" + last.x.toFixed(1) + "\" y=\"" + (last.y - 12).toFixed(1) + "\" text-anchor=\"middle\" fill=\"" + color + "\" font-size=\"11\" font-weight=\"800\">" + lastLabel + "</text>"
    + "</svg>";
}

// ══════════════════════════════════════════════════════════════════════════════
// PROGRESS TAB
// ══════════════════════════════════════════════════════════════════════════════

async function loadProgress() {
  if (!U) return;

  // Build 30-day date range for mood
  var moodSince = new Date();
  moodSince.setDate(moodSince.getDate() - 29);

  var results = await Promise.allSettled([
    SB.from("workout_sessions").select("id,created_at,duration").eq("user_id", U.id).order("created_at", { ascending: true }).limit(80),
    SB.from("body_scans").select("created_at,physical_score").eq("user_id", U.id).order("created_at", { ascending: true }).limit(20),
    SB.from("meals").select("created_at,calories").eq("user_id", U.id).order("created_at", { ascending: true }).limit(100),
    SB.from("user_streaks").select("current_streak,longest_streak,total_workouts").eq("user_id", U.id).maybeSingle(),
    SB.from("daily_moods").select("mood_level,mood_label,date").eq("user_id", U.id)
      .gte("date", moodSince.toISOString().slice(0, 10)).order("date", { ascending: true }).limit(30)
  ]);

  var sessions = results[0].status === "fulfilled" ? (results[0].value.data || []) : [];
  var scans    = results[1].status === "fulfilled" ? (results[1].value.data || []) : [];
  var meals    = results[2].status === "fulfilled" ? (results[2].value.data || []) : [];
  var streak   = results[3].status === "fulfilled" ? (results[3].value.data || {}) : {};
  var moods    = results[4].status === "fulfilled" ? (results[4].value.data || []) : [];

  var elStreak = document.getElementById("prog-streak");
  var elSub    = document.getElementById("prog-streak-sub");
  var elTotal  = document.getElementById("prog-sessions-total");
  var elBest   = document.getElementById("prog-best-score");
  if (elStreak) elStreak.textContent = streak.current_streak != null ? streak.current_streak : sessions.length;
  if (elSub)    elSub.textContent    = streak.current_streak != null ? "jours consecutifs" : "seances total";
  if (elTotal)  elTotal.textContent  = sessions.length;
  var bestScore = scans.reduce(function(m, s) { return s.physical_score > m ? s.physical_score : m; }, 0);
  if (elBest)   elBest.textContent   = bestScore > 0 ? bestScore : "—";

  // Mood stat in progress header
  var elMoodStat = document.getElementById("prog-mood-stat");
  if (elMoodStat && moods.length) {
    var last = moods[moods.length - 1];
    elMoodStat.textContent = last.mood_label || "—";
  }

  var sessChart = buildWeeklySessionData(sessions, 8);
  var sessEl    = document.getElementById("chart-sessions-svg");
  var sessHead  = document.getElementById("chart-sessions-headline");
  if (sessEl)   sessEl.innerHTML   = renderSvgChart(sessChart, { color: "#2563eb" });
  if (sessHead) sessHead.textContent = sessions.length + " seances total";

  var scanData = scans.filter(function(s) { return s.physical_score > 0; }).map(function(s) {
    return { value: s.physical_score, label: new Date(s.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) };
  });
  var scanEl   = document.getElementById("chart-scan-svg");
  var scanHead = document.getElementById("chart-scan-headline");
  if (scanEl)  scanEl.innerHTML  = renderSvgChart(scanData, { color: "#9333ea", unit: "/100" });
  if (scanHead) {
    var ls = scans[scans.length - 1];
    scanHead.textContent = ls && ls.physical_score ? "Dernier score: " + ls.physical_score + "/100" : scans.length + " scan(s) effectue(s)";
  }

  var calData  = buildDailyCalData(meals, 14);
  var calEl    = document.getElementById("chart-calories-svg");
  var calHead  = document.getElementById("chart-calories-headline");
  if (calEl)   calEl.innerHTML = renderSvgChart(calData, { color: "#f97316", unit: " kcal", H: 110 });
  if (calHead) {
    var avg = calData.length ? Math.round(calData.reduce(function(s, d) { return s + d.value; }, 0) / calData.length) : 0;
    calHead.textContent = avg > 0 ? "Moyenne: " + avg + " kcal / jour" : "Enregistrez vos repas pour voir l'evolution";
  }

  // Mood history dots
  renderMoodDots(moods);
}

// ── Mood colours matching SVG faces ──────────────────────────────────────────
var MOOD_COLORS = { 1: "#f87171", 2: "#fb923c", 3: "#fbbf24", 4: "#4ade80", 5: "#60a5fa" };

function renderMoodDots(moods) {
  var el = document.getElementById("chart-mood-dots");
  var head = document.getElementById("chart-mood-headline");
  if (!el) return;

  if (!moods.length) {
    el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:.82rem">Sélectionnez votre humeur chaque jour pour voir l\'évolution ici.</div>';
    if (head) head.textContent = "Pas encore de données";
    return;
  }

  // Build 14-day grid (today = rightmost)
  var today = new Date();
  var days = 14;
  var grid = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today);
    d.setDate(today.getDate() - i);
    var dateStr = d.toISOString().slice(0, 10);
    var entry = moods.find(function(m) { return m.date === dateStr; });
    grid.push({ date: d, dateStr: dateStr, entry: entry || null });
  }

  // Render as dot matrix row
  var html = '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">';
  grid.forEach(function(cell) {
    var lvl = cell.entry ? cell.entry.mood_level : 0;
    var color = lvl ? MOOD_COLORS[lvl] : "rgba(255,255,255,.07)";
    var label = cell.entry ? cell.entry.mood_label : "Pas de donnée";
    var dayLabel = cell.date.toLocaleDateString("fr-FR", { weekday: "short" }).slice(0, 1).toUpperCase();
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:5px">';
    html += '<div title="' + cell.dateStr + ' — ' + label + '" style="width:32px;height:32px;border-radius:50%;background:' + color + ';' + (lvl ? 'box-shadow:0 0 8px ' + color + '55' : 'border:2px solid rgba(255,255,255,.1)') + ';transition:transform .2s;cursor:default" onmouseenter="this.style.transform=\'scale(1.2)\'" onmouseleave="this.style.transform=\'scale(1)\'"></div>';
    html += '<div style="font-size:.55rem;color:rgba(255,255,255,.3);font-weight:700">' + dayLabel + '</div>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;

  // Compute average mood
  var filled = moods.filter(function(m) { return m.mood_level >= 1; });
  if (head && filled.length) {
    var avg = (filled.reduce(function(s, m) { return s + m.mood_level; }, 0) / filled.length).toFixed(1);
    var avgLabel = MOOD_LABELS[Math.round(avg)] || avg + "/5";
    head.textContent = filled.length + " jour(s) suivi(s) — humeur moy.: " + avgLabel;
  }
}

function buildWeeklySessionData(sessions, weeks) {
  var now = new Date(), result = [];
  for (var w = weeks - 1; w >= 0; w--) {
    var ws = new Date(now);
    ws.setDate(now.getDate() - w * 7 - now.getDay());
    ws.setHours(0, 0, 0, 0);
    var we = new Date(ws);
    we.setDate(ws.getDate() + 7);
    var count = sessions.filter(function(s) { var d = new Date(s.created_at); return d >= ws && d < we; }).length;
    result.push({ value: count, label: ws.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) });
  }
  return result;
}

function buildDailyCalData(meals, days) {
  var now = new Date(), result = [];
  for (var d = days - 1; d >= 0; d--) {
    var day = new Date(now);
    day.setDate(now.getDate() - d);
    day.setHours(0, 0, 0, 0);
    var de = new Date(day);
    de.setDate(day.getDate() + 1);
    var total = meals.filter(function(m) { var md = new Date(m.created_at); return md >= day && md < de; })
                     .reduce(function(s, m) { return s + (Number(m.calories) || 0); }, 0);
    result.push({ value: total, label: day.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) });
  }
  var start = 0;
  while (start < result.length - 2 && result[start].value === 0) start++;
  return result.slice(start);
}

window.loadProgress = loadProgress;
window.toggleCoachSuggestions = toggleCoachSuggestions;

// ══════════════════════════════════════════════════════════════════════════════
// THEME TOGGLE — Light / Dark
// ══════════════════════════════════════════════════════════════════════════════

function applyStoredTheme() {
  var saved = localStorage.getItem("fitai_theme") || "dark";
  applyTheme(saved);
}

function applyTheme(mode) {
  var isLight = mode === "light";
  document.body.classList.toggle("light", isLight);
  var icon  = document.getElementById("theme-icon");
  var label = document.getElementById("theme-label");
  if (icon)  icon.textContent  = isLight ? "☀️" : "🌙";
  if (label) label.textContent = isLight ? "Mode clair" : "Mode sombre";
  localStorage.setItem("fitai_theme", mode);
}

function toggleTheme() {
  var isLight = document.body.classList.contains("light");
  applyTheme(isLight ? "dark" : "light");
}

window.toggleTheme = toggleTheme;


// ══════════════════════════════════════════════════════════════════════════════
// DAILY CHALLENGES — reset each day, stored in localStorage
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// EAU — COMPTEUR JOURNALIER
// ══════════════════════════════════════════════════════════════════════════════

const WATER_KEY = "fitai_water";

function getWaterTarget() {
  // 0.033L per kg bodyweight, rounded to nearest glass (250ml), min 6, max 16
  if (USER_WEIGHT && USER_WEIGHT > 0) {
    return Math.max(6, Math.min(16, Math.round((USER_WEIGHT * 0.033) / 0.25)));
  }
  return 8; // default = 2L
}

function getWaterData() {
  const today = getTodayKey();
  try {
    const d = JSON.parse(localStorage.getItem(WATER_KEY) || "{}");
    if (d.date === today) return d;
  } catch {}
  const fresh = { date: getTodayKey(), count: 0 };
  try { localStorage.setItem(WATER_KEY, JSON.stringify(fresh)); } catch {}
  return fresh;
}

function glassesToL(n) {
  return (n * 0.25).toFixed(1).replace(/\.0$/, "");
}

function _applyWaterCount(newCount, animIdx = -1) {
  const target = getWaterTarget();
  const d      = getWaterData();
  d.count = Math.max(0, Math.min(target, newCount));
  try { localStorage.setItem(WATER_KEY, JSON.stringify(d)); } catch {}
  renderWater(animIdx);
  if (d.count === target) {
    bumpDailyMetricOnce('fitai_water_goal_days');
    toast(`💧 Objectif atteint ! ${glassesToL(target)}L bu.`, "ok");
  }
}

function adjustWater(delta) {
  const oldCount = getWaterData().count;
  _applyWaterCount(oldCount + delta, delta > 0 ? oldCount : -1);
  // Sync programme tab water if visible
  if (typeof syncProgWater === "function") syncProgWater();
}

function setWaterCount(n) {
  const oldCount = getWaterData().count;
  const newCount = (oldCount === n) ? n - 1 : n;
  _applyWaterCount(newCount, newCount > oldCount ? newCount - 1 : -1);
}

function renderWater(newlyFilledIdx = -1) {
  const d      = getWaterData();
  const count  = d.count;
  const target = getWaterTarget();

  const glassesEl   = document.getElementById("water-glasses");
  const barEl       = document.getElementById("water-bar");
  const summEl      = document.getElementById("water-summary");
  const litersEl    = document.getElementById("water-liters");
  const pctEl       = document.getElementById("water-pct-label");
  const countEl     = document.getElementById("water-count");
  const targetLblEl = document.getElementById("water-target-lbl");

  if (!glassesEl) return;

  glassesEl.innerHTML = Array.from({ length: target }, (_, i) => {
    const filled = i < count;
    const isNew  = i === newlyFilledIdx;
    return `<div class="water-glass${filled ? " filled" : ""}${isNew ? " done-pop" : ""}"
      onclick="setWaterCount(${i + 1})" title="${filled ? "Retirer" : "Marquer bu"}">${filled ? "💧" : ""}</div>`;
  }).join("");

  const pct = Math.round((count / target) * 100);
  if (barEl)       barEl.style.width       = `${pct}%`;
  if (countEl)     countEl.textContent     = count;
  if (targetLblEl) targetLblEl.textContent = `/ ${target} verres`;
  if (litersEl)    litersEl.textContent    = `${glassesToL(count)} L / ${glassesToL(target)} L`;
  if (summEl)      summEl.textContent      = `${count} / ${target} verres`;
  if (pctEl)       pctEl.textContent       = `${pct}%`;
}

window.adjustWater  = adjustWater;
window.setWaterCount = setWaterCount;

const DAILY_POOL = [
  { id: "pushups_100", title: "100 pompes", desc: "En autant de séries que nécessaire", icon: "💪", xp: 150, category: "Force" },
  { id: "abs_100", title: "100 abdos", desc: "Crunchs, planche, bicycle — à toi de choisir", icon: "🔥", xp: 100, category: "Core" },
  { id: "steps_10k", title: "10 000 pas", desc: "Marche, course, montées d'escaliers", icon: "🚶", xp: 120, category: "Cardio" },
  { id: "water_2L", title: "2L d'eau aujourd'hui", desc: "Hydrate-toi tout au long de la journée", icon: "💧", xp: 80, category: "Lifestyle" },
  { id: "squat_100", title: "100 squats", desc: "Poids du corps, pause en bas pour la qualité", icon: "🏋️", xp: 150, category: "Force" },
  { id: "plank_5min", title: "5 min de planche cumulative", desc: "Tiens la planche, cumule les séries", icon: "⚡", xp: 130, category: "Core" },
  { id: "run_5k", title: "Run 5km", desc: "En une seule sortie ou en plusieurs segments", icon: "🏃", xp: 200, category: "Cardio" },
  { id: "stretch_15", title: "15 min d'étirements", desc: "Flexibilité et récupération active", icon: "🧘", xp: 90, category: "Récup" },
  { id: "pullups_30", title: "30 tractions", desc: "En autant de séries que nécessaire", icon: "🧗", xp: 180, category: "Force" },
  { id: "burpees_50", title: "50 burpees", desc: "Full body, intensité maximale", icon: "🔥", xp: 200, category: "HIIT" },
  { id: "lunges_100", title: "100 fentes", desc: "50 par jambe, alterner", icon: "🦵", xp: 140, category: "Force" },
  { id: "no_sugar", title: "Zéro sucre ajouté", desc: "Pas de soda, bonbons, ou desserts sucrés aujourd'hui", icon: "🥗", xp: 100, category: "Nutrition" },
  { id: "sleep_8h", title: "8h de sommeil", desc: "Couche-toi tôt, récupère vraiment", icon: "😴", xp: 80, category: "Récup" },
  { id: "dips_50", title: "50 dips", desc: "Sur chaise, barre parallèle ou banc", icon: "💪", xp: 140, category: "Force" },
  { id: "jump_200", title: "200 sauts à la corde", desc: "Ou 200 jumping jacks si pas de corde", icon: "🪢", xp: 110, category: "Cardio" },
  { id: "gainage_10", title: "10 min de gainage", desc: "Planches, gainage latéral, bird-dog — core béton", icon: "🧱", xp: 120, category: "Core" },
  { id: "walk_1h", title: "1h de marche active", desc: "Allure soutenue, posture droite, respiration calme", icon: "🚶‍♂️", xp: 130, category: "Cardio" },
  { id: "meditation", title: "10 min de respiration calme", desc: "Ralentis le mental et récupère mieux", icon: "🫁", xp: 90, category: "Mental" },
  { id: "veggies_day", title: "Légumes à chaque repas", desc: "Ajoute du volume et des fibres à tes repas du jour", icon: "🥦", xp: 95, category: "Nutrition" },
  { id: "no_screen", title: "Pas d'écran 1h avant de dormir", desc: "Favorise un meilleur sommeil et une meilleure récup", icon: "📵", xp: 80, category: "Lifestyle" },
  { id: "mountain_3x50", title: "3 × 50 mountain climbers", desc: "Gainage + cardio combinés, enchaîner sans pause", icon: "🌋", xp: 165, category: "HIIT" },
  { id: "mobility_20", title: "20 min de mobilité", desc: "Hanches, épaules, chevilles — travail articulaire", icon: "🤸", xp: 100, category: "Récup" },
  { id: "stairs_sprint", title: "10 min d'escaliers", desc: "Escaliers ou step-ups, rythme franc mais propre", icon: "🪜", xp: 130, category: "Cardio" },
  { id: "meal_prep", title: "Prépare ton repas de demain", desc: "Gagne une journée de discipline d'avance", icon: "🥡", xp: 110, category: "Nutrition" },
  { id: "sunlight_15", title: "15 min dehors sans téléphone", desc: "Marche légère, lumière naturelle, tête vide", icon: "☀️", xp: 85, category: "Mental" },
  { id: "protein_each_meal", title: "Protéines à chaque repas", desc: "Sécurise ta satiété et ta récupération sur toute la journée", icon: "🍳", xp: 115, category: "Nutrition" },
  { id: "cold_finish", title: "30 sec d'eau fraîche en fin de douche", desc: "Petit défi mental, grand effet réveil", icon: "🧊", xp: 70, category: "Lifestyle" },
  { id: "mobility_desk", title: "3 pauses mobilité de 3 min", desc: "Débloque dos, hanches et nuque dans la journée", icon: "🪑", xp: 90, category: "Récup" },
  { id: "walk_call", title: "Passe un appel en marchant", desc: "Transforme une habitude passive en activité", icon: "📞", xp: 75, category: "Lifestyle" },
  { id: "silent_meal", title: "Un repas sans écran", desc: "Mange lentement, pose les couverts, respire", icon: "🍽️", xp: 75, category: "Mental" },
  { id: "farmer_carry", title: "4 x 40m de farmer carry", desc: "Sacs lourds ou haltères, gainage et grip", icon: "🛍️", xp: 140, category: "Force" },
  { id: "dance_15", title: "15 min de cardio fun", desc: "Danse, shadow boxing ou corde — mais tu bouges", icon: "🕺", xp: 110, category: "HIIT" },
  { id: "perfect_plate", title: "Une assiette propre et complète", desc: "Protéines + légumes + glucides utiles à au moins un repas", icon: "🍱", xp: 90, category: "Nutrition" },
  { id: "recovery_walk", title: "20 min de marche récup", desc: "Après séance ou après repas, sans te cramer", icon: "🌿", xp: 85, category: "Récup" },
  { id: "journal_3wins", title: "Écris 3 petites victoires", desc: "Même minuscules — on construit l'élan", icon: "✍️", xp: 70, category: "Mental" },
  { id: "wall_sit", title: "3 min de chaise cumulée", desc: "Brûlure propre, posture stable, dos au mur", icon: "🪑", xp: 105, category: "Force" },
  { id: "scan_posture", title: "Refais ta posture 2 fois", desc: "2 mini checks : épaules basses, nuque longue, bassin neutre", icon: "🪞", xp: 75, category: "Lifestyle" },
  { id: "social_support", title: "Envoie ton objectif du jour à quelqu'un", desc: "La discipline aime la responsabilité", icon: "🤝", xp: 65, category: "Mental" },
  { id: "hiit_7", title: "7 min de HIIT express", desc: "Court, propre, sans négociation", icon: "⏳", xp: 115, category: "HIIT" },
  { id: "glutes_activation", title: "5 min d'activation fessiers", desc: "Ponts, abductions, bird-dogs avant ta séance", icon: "🍑", xp: 85, category: "Récup" },
  { id: "fruit_instead", title: "Dessert fruit au lieu d'un snack", desc: "Swap simple qui compte vraiment", icon: "🍎", xp: 70, category: "Nutrition" }
];

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getLocalMetric(key) {
  try { return Number(localStorage.getItem(key) || '0') || 0; } catch { return 0; }
}

function incrementLocalMetric(key, delta = 1) {
  try {
    const next = Math.max(0, getLocalMetric(key) + Number(delta || 0));
    localStorage.setItem(key, String(next));
    return next;
  } catch { return 0; }
}

function bumpDailyMetricOnce(key) {
  const today = getTodayKey();
  const markerKey = `${key}:last`;
  try {
    if (localStorage.getItem(markerKey) === today) return false;
    localStorage.setItem(markerKey, today);
    incrementLocalMetric(key, 1);
    return true;
  } catch { return false; }
}

function pickDailyChallengeMix(pool, count = 4) {
  const buckets = [
    ["Force", "Cardio", "HIIT", "Core"],
    ["Nutrition"],
    ["Récup", "Mental", "Lifestyle"],
    []
  ];
  const source = Array.isArray(pool) ? pool.slice() : [];
  const used = new Set();
  const picks = [];
  for (const bucket of buckets) {
    const options = source.filter(ch => !used.has(ch.id) && (!bucket.length || bucket.includes(ch.category)));
    if (!options.length) continue;
    const picked = options[Math.floor(Math.random() * options.length)];
    used.add(picked.id);
    picks.push(picked.id);
  }
  while (picks.length < count) {
    const remaining = source.filter(ch => !used.has(ch.id));
    if (!remaining.length) break;
    const picked = remaining[Math.floor(Math.random() * remaining.length)];
    used.add(picked.id);
    picks.push(picked.id);
  }
  return picks.slice(0, count);
}

function getDailyChallenges() {
  const today = getTodayKey();
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem("fitai_daily") || "{}"); }
    catch { return {}; }
  })();

  if (stored.date !== today) {
    const picks = pickDailyChallengeMix(DAILY_POOL, 4);
    const fresh = { date: today, picks, done: [] };
    try { localStorage.setItem("fitai_daily", JSON.stringify(fresh)); } catch {}
    return fresh;
  }
  return stored;
}

function completeDailyChallenge(challengeId, _ctx) {
  const data = getDailyChallenges();
  if (data.done.includes(challengeId)) return;
  data.done.push(challengeId);
  try { localStorage.setItem("fitai_daily", JSON.stringify(data)); } catch {}

  // XP feedback
  const ch = DAILY_POOL.find(c => c.id === challengeId);
  if (ch) toast(`+${ch.xp} XP — Défi accompli !`, "ok");

  // Update streak bonus if all 3 done
  if (data.done.length >= data.picks.length) {
    toast("🔥 Tous les défis du jour accomplis ! Streak maintenu.", "ok");
    updateDailyStreak();
    // Increment global daily completion counter (for "daily_completions" défi)
    try {
      const prev = Number(localStorage.getItem("fitai_daily_completions") || "0");
      localStorage.setItem("fitai_daily_completions", String(prev + 1));
    } catch {}
    checkAndAwardAchievements().catch(() => {});
  }

  // Re-render daily section
  renderDailyChallengesSection();
}

async function updateDailyStreak({ incrementWorkouts = false } = {}) {
  if (!U) return;
  try {
    const today = getTodayKey();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const { data } = await SB.from("user_streaks")
      .select("current_streak,longest_streak,last_active,total_workouts")
      .eq("user_id", U.id)
      .maybeSingle();

    const prev = data || { current_streak: 0, longest_streak: 0, last_active: null, total_workouts: 0 };

    let newStreak = Number(prev.current_streak) || 0;
    if (prev.last_active === today) {
      // Déjà actif aujourd'hui — pas de changement de streak
    } else if (prev.last_active === yesterday) {
      // Jour consécutif
      newStreak += 1;
    } else {
      // Rupture ou premier jour
      newStreak = 1;
    }

    const newLongest = Math.max(newStreak, Number(prev.longest_streak) || 0);
    const newTotal = incrementWorkouts ? (Number(prev.total_workouts) || 0) + 1 : (Number(prev.total_workouts) || 0);

    await SB.from("user_streaks").upsert({
      user_id: U.id,
      current_streak: newStreak,
      longest_streak: newLongest,
      total_workouts: newTotal,
      last_active: today,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
  } catch (err) {
    console.warn("[streak] update failed:", err);
  }
}

// Category color map for daily challenges
const CAT_COLORS = {
  "Force":     { bg: "rgba(239,68,68,.12)",   fg: "#f87171" },
  "Core":      { bg: "rgba(168,85,247,.12)",  fg: "#c084fc" },
  "Cardio":    { bg: "rgba(59,130,246,.12)",  fg: "#60a5fa" },
  "HIIT":      { bg: "rgba(251,146,60,.12)",  fg: "#fb923c" },
  "Récup":     { bg: "rgba(34,197,94,.12)",   fg: "#4ade80" },
  "Nutrition": { bg: "rgba(250,204,21,.12)",  fg: "#fbbf24" },
  "Lifestyle": { bg: "rgba(20,184,166,.12)",  fg: "#2dd4bf" },
  "Mental":    { bg: "rgba(99,102,241,.12)",  fg: "#818cf8" },
};

function _getMidnightCountdown() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diff = Math.max(0, midnight - now);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `Nouveau défi dans ${h}h${m.toString().padStart(2, "0")}`;
  return `Nouveau défi dans ${m} min`;
}

function _buildChallengeRowHtml(ch, done, context) {
  const cat = CAT_COLORS[ch.category] || { bg: "rgba(255,255,255,.08)", fg: "var(--muted)" };
  const btnOrDone = done
    ? `<span style="font-size:.75rem;color:#4ade80;font-weight:800">✓ Fait</span>`
    : `<button class="daily-ch-btn" onclick="completeDailyChallenge('${ch.id}','${context}')">Marquer ✓</button>`;
  return `<div class="daily-ch-row${done ? " done" : ""}">
    <div class="daily-ch-icon">${ch.icon}</div>
    <div class="daily-ch-body">
      <div class="daily-ch-name">${escapeHtml(ch.title)}</div>
      <div class="daily-ch-desc">${escapeHtml(ch.desc)}</div>
    </div>
    <div class="daily-ch-right">
      <span class="daily-ch-xp">+${ch.xp} XP</span>
      <span class="daily-ch-cat" style="background:${cat.bg};color:${cat.fg}">${ch.category}</span>
      ${btnOrDone}
    </div>
  </div>`;
}

function renderDailyChallengesSection() {
  const data = getDailyChallenges();
  const challenges = data.picks.map(id => DAILY_POOL.find(c => c.id === id)).filter(Boolean);
  const doneCount = data.done.length;
  const allDone = doneCount >= challenges.length;

  // ── Dashboard widget ────────────────────────────────────────────────────────
  const dashEl = document.getElementById("daily-challenges-container");
  if (dashEl) {
    dashEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-weight:800;font-size:.92rem;color:var(--text)">⚡ Défis du jour</div>
        <div style="font-size:.72rem;color:var(--muted);font-weight:700">${doneCount}/${challenges.length} accomplis</div>
      </div>
      ${challenges.map(ch => _buildChallengeRowHtml(ch, data.done.includes(ch.id), "dash")).join("")}
      ${allDone ? `<div style="text-align:center;padding:10px;font-size:.8rem;font-weight:700;color:#4ade80;background:rgba(34,197,94,.06);border-radius:10px;border:1px solid rgba(34,197,94,.2)">🏆 Parfait ! Tous les défis accomplis aujourd'hui.</div>` : ""}
    `;
  }

  // ── Défis tab full panel ────────────────────────────────────────────────────
  const defisCards = document.getElementById("daily-defi-cards");
  const defisCount = document.getElementById("daily-defi-done-count");
  const defisCountdown = document.getElementById("daily-defi-countdown");
  if (defisCards) {
    defisCards.innerHTML = challenges.map(ch => _buildChallengeRowHtml(ch, data.done.includes(ch.id), "defis")).join("") +
      (allDone ? `<div style="text-align:center;padding:10px;font-size:.8rem;font-weight:700;color:#4ade80;background:rgba(34,197,94,.06);border-radius:10px;border:1px solid rgba(34,197,94,.2);margin-top:4px">🏆 Tous accomplis — streak maintenu !</div>` : "");
  }
  if (defisCount) defisCount.textContent = `${doneCount} / ${challenges.length}`;
  if (defisCountdown) defisCountdown.textContent = _getMidnightCountdown();
}

window.completeDailyChallenge = completeDailyChallenge;
window.renderDailyChallengesSection = renderDailyChallengesSection;

// ══════════════════════════════════════════════════════════════════════════════
// FOOD JOURNAL AI
// ══════════════════════════════════════════════════════════════════════════════

// Offline food database — 120+ French aliments (per 100g or per unit noted)
const FOOD_OFFLINE_DB = {
  // ── Proteins ──
  "oeuf":           { cal:78,  p:6,    c:0.6, f:5,   u:"unité" },
  "oeufs":          { cal:78,  p:6,    c:0.6, f:5,   u:"unité" },
  "blanc oeuf":     { cal:17,  p:3.6,  c:0.2, f:0,   u:"unité" },
  "oeuf dur":       { cal:78,  p:6,    c:0.6, f:5,   u:"unité" },
  "poulet":         { cal:165, p:31,   c:0,   f:3.6, u:"100g" },
  "poulet grille":  { cal:165, p:31,   c:0,   f:3.6, u:"100g" },
  "filet poulet":   { cal:110, p:24,   c:0,   f:1.2, u:"100g" },
  "blanc poulet":   { cal:110, p:24,   c:0,   f:1.2, u:"100g" },
  "thon":           { cal:132, p:29,   c:0,   f:1,   u:"100g" },
  "thon boite":     { cal:132, p:29,   c:0,   f:1,   u:"100g" },
  "saumon":         { cal:208, p:20,   c:0,   f:13,  u:"100g" },
  "saumon fume":    { cal:170, p:18,   c:0,   f:10,  u:"100g" },
  "boeuf":          { cal:250, p:26,   c:0,   f:15,  u:"100g" },
  "steak":          { cal:250, p:26,   c:0,   f:15,  u:"100g" },
  "viande hachee":  { cal:230, p:22,   c:0,   f:15,  u:"100g" },
  "steack haché":   { cal:230, p:22,   c:0,   f:15,  u:"100g" },
  "dinde":          { cal:135, p:29,   c:0,   f:1,   u:"100g" },
  "jambon":         { cal:105, p:17,   c:1.5, f:3.5, u:"100g" },
  "jambon blanc":   { cal:105, p:17,   c:1.5, f:3.5, u:"100g" },
  "jambon serrano": { cal:143, p:27,   c:0.3, f:4,   u:"100g" },
  "saucisse":       { cal:301, p:12,   c:1,   f:27,  u:"100g" },
  "crevettes":      { cal:99,  p:21,   c:0,   f:1.1, u:"100g" },
  "cabillaud":      { cal:82,  p:18,   c:0,   f:0.7, u:"100g" },
  "thon rouge":     { cal:144, p:23,   c:0,   f:5,   u:"100g" },
  "sardines":       { cal:208, p:25,   c:0,   f:11,  u:"100g" },
  "maquereau":      { cal:205, p:19,   c:0,   f:14,  u:"100g" },
  "tofu":           { cal:76,  p:8,    c:1.9, f:4.2, u:"100g" },
  "tempeh":         { cal:193, p:19,   c:9,   f:11,  u:"100g" },
  "seitan":         { cal:370, p:75,   c:14,  f:1.9, u:"100g" },
  "lentilles":      { cal:116, p:9,    c:20,  f:0.4, u:"100g cuit" },
  "pois chiche":    { cal:164, p:9,    c:27,  f:2.6, u:"100g cuit" },
  "haricots rouges":{ cal:127, p:8.7,  c:22,  f:0.5, u:"100g cuit" },
  "haricots blancs":{ cal:139, p:9,    c:25,  f:0.5, u:"100g cuit" },
  "edamame":        { cal:122, p:11,   c:10,  f:5,   u:"100g" },
  "whey":           { cal:120, p:24,   c:3,   f:2,   u:"scoop 30g" },
  "proteine":       { cal:120, p:24,   c:3,   f:2,   u:"scoop 30g" },
  "barre proteinee":{ cal:210, p:20,   c:20,  f:7,   u:"barre 60g" },
  // ── Dairy ──
  "fromage":        { cal:350, p:25,   c:1,   f:28,  u:"100g" },
  "emmental":       { cal:382, p:29,   c:0.5, f:30,  u:"100g" },
  "comté":          { cal:415, p:27,   c:0.2, f:34,  u:"100g" },
  "camembert":      { cal:300, p:20,   c:0.5, f:24,  u:"100g" },
  "brie":           { cal:334, p:21,   c:0.5, f:27,  u:"100g" },
  "mozzarella":     { cal:280, p:18,   c:2,   f:22,  u:"100g" },
  "parmesan":       { cal:431, p:38,   c:3,   f:29,  u:"100g" },
  "feta":           { cal:264, p:14,   c:4,   f:21,  u:"100g" },
  "fromage blanc":  { cal:80,  p:8,    c:4,   f:3,   u:"100g" },
  "yaourt":         { cal:59,  p:3.5,  c:4.7, f:3.2, u:"100g" },
  "yaourt grec":    { cal:97,  p:9,    c:3.6, f:5,   u:"100g" },
  "skyr":           { cal:65,  p:11,   c:4,   f:0.2, u:"100g" },
  "cottage":        { cal:98,  p:11,   c:3.4, f:4.3, u:"100g" },
  "lait":           { cal:61,  p:3.2,  c:4.8, f:3.3, u:"100ml" },
  "lait entier":    { cal:61,  p:3.2,  c:4.8, f:3.3, u:"100ml" },
  "lait ecreme":    { cal:35,  p:3.5,  c:5,   f:0.1, u:"100ml" },
  "lait vegetal":   { cal:40,  p:1.5,  c:5.5, f:1.5, u:"100ml" },
  "lait amande":    { cal:24,  p:1,    c:3,   f:1.1, u:"100ml" },
  "lait avoine":    { cal:47,  p:1.5,  c:7,   f:1.5, u:"100ml" },
  "creme fraiche":  { cal:292, p:2.5,  c:3,   f:30,  u:"100g" },
  "beurre":         { cal:717, p:0.9,  c:0.1, f:81,  u:"100g" },
  // ── Carbs & Grains ──
  "pâtes":          { cal:158, p:5.8,  c:31,  f:0.9, u:"100g cuit" },
  "pates":          { cal:158, p:5.8,  c:31,  f:0.9, u:"100g cuit" },
  "pates completes":{ cal:150, p:6,    c:29,  f:1,   u:"100g cuit" },
  "riz":            { cal:130, p:2.7,  c:28,  f:0.3, u:"100g cuit" },
  "riz complet":    { cal:123, p:2.9,  c:25,  f:1,   u:"100g cuit" },
  "riz basmati":    { cal:130, p:2.7,  c:28,  f:0.3, u:"100g cuit" },
  "quinoa":         { cal:120, p:4.4,  c:22,  f:1.9, u:"100g cuit" },
  "boulgour":       { cal:112, p:3.8,  c:23,  f:0.7, u:"100g cuit" },
  "couscous":       { cal:112, p:3.8,  c:23,  f:0.7, u:"100g cuit" },
  "avoine":         { cal:389, p:17,   c:66,  f:7,   u:"100g sec" },
  "flocons avoine": { cal:389, p:17,   c:66,  f:7,   u:"100g sec" },
  "pain":           { cal:265, p:9,    c:49,  f:3.2, u:"100g" },
  "pain complet":   { cal:247, p:9,    c:45,  f:3.5, u:"100g" },
  "baguette":       { cal:265, p:9,    c:49,  f:3.2, u:"100g" },
  "pain de mie":    { cal:278, p:8,    c:50,  f:4,   u:"100g" },
  "pain grille":    { cal:312, p:11,   c:59,  f:3.8, u:"100g" },
  "biscottes":      { cal:406, p:12,   c:74,  f:7,   u:"100g" },
  "granola":        { cal:460, p:10,   c:65,  f:18,  u:"100g" },
  "muesli":         { cal:380, p:10,   c:62,  f:7,   u:"100g" },
  "croissant":      { cal:406, p:8,    c:45,  f:21,  u:"100g" },
  "crepe":          { cal:202, p:6,    c:27,  f:8,   u:"100g" },
  "pomme de terre": { cal:77,  p:2,    c:17,  f:0.1, u:"100g" },
  "patate douce":   { cal:86,  p:1.6,  c:20,  f:0.1, u:"100g" },
  "patates douces": { cal:86,  p:1.6,  c:20,  f:0.1, u:"100g" },
  "frites":         { cal:312, p:3.4,  c:41,  f:15,  u:"100g" },
  "chips":          { cal:530, p:7,    c:53,  f:33,  u:"100g" },
  // ── Fats & Nuts ──
  "avocat":         { cal:160, p:2,    c:9,   f:15,  u:"100g" },
  "amandes":        { cal:579, p:21,   c:22,  f:50,  u:"100g" },
  "noix":           { cal:654, p:15,   c:14,  f:65,  u:"100g" },
  "noix cajou":     { cal:553, p:18,   c:30,  f:44,  u:"100g" },
  "cacahuetes":     { cal:567, p:26,   c:16,  f:49,  u:"100g" },
  "beurre cacahu":  { cal:588, p:25,   c:20,  f:50,  u:"100g" },
  "beurre amande":  { cal:614, p:21,   c:19,  f:56,  u:"100g" },
  "huile olive":    { cal:884, p:0,    c:0,   f:100, u:"100ml" },
  "graines chia":   { cal:486, p:17,   c:42,  f:31,  u:"100g" },
  "graines lin":    { cal:534, p:18,   c:29,  f:42,  u:"100g" },
  "huile coco":     { cal:862, p:0,    c:0,   f:100, u:"100ml" },
  // ── Fruits ──
  "banane":         { cal:89,  p:1.1,  c:23,  f:0.3, u:"unité" },
  "pomme":          { cal:52,  p:0.3,  c:14,  f:0.2, u:"unité" },
  "poire":          { cal:57,  p:0.4,  c:15,  f:0.1, u:"unité" },
  "orange":         { cal:47,  p:0.9,  c:12,  f:0.1, u:"unité" },
  "clémentine":     { cal:47,  p:0.9,  c:12,  f:0.1, u:"unité" },
  "fraises":        { cal:32,  p:0.7,  c:7.7, f:0.3, u:"100g" },
  "myrtilles":      { cal:57,  p:0.7,  c:14,  f:0.3, u:"100g" },
  "framboises":     { cal:52,  p:1.2,  c:12,  f:0.7, u:"100g" },
  "kiwi":           { cal:61,  p:1.1,  c:15,  f:0.5, u:"unité" },
  "mangue":         { cal:65,  p:0.5,  c:17,  f:0.3, u:"100g" },
  "ananas":         { cal:50,  p:0.5,  c:13,  f:0.1, u:"100g" },
  "raisins":        { cal:69,  p:0.7,  c:18,  f:0.2, u:"100g" },
  "pastèque":       { cal:30,  p:0.6,  c:7.6, f:0.2, u:"100g" },
  "cerise":         { cal:63,  p:1,    c:16,  f:0.2, u:"100g" },
  "peche":          { cal:39,  p:0.9,  c:9.5, f:0.3, u:"unité" },
  "abricot":        { cal:48,  p:1.4,  c:11,  f:0.4, u:"unité" },
  // ── Vegetables ──
  "brocoli":        { cal:34,  p:2.8,  c:7,   f:0.4, u:"100g" },
  "epinards":       { cal:23,  p:2.9,  c:3.6, f:0.4, u:"100g" },
  "épinards":       { cal:23,  p:2.9,  c:3.6, f:0.4, u:"100g" },
  "tomate":         { cal:18,  p:0.9,  c:3.9, f:0.2, u:"100g" },
  "tomates":        { cal:18,  p:0.9,  c:3.9, f:0.2, u:"100g" },
  "courgette":      { cal:17,  p:1.2,  c:3.1, f:0.3, u:"100g" },
  "salade":         { cal:15,  p:1.4,  c:2.9, f:0.2, u:"100g" },
  "laitue":         { cal:15,  p:1.4,  c:2.9, f:0.2, u:"100g" },
  "carotte":        { cal:41,  p:0.9,  c:10,  f:0.2, u:"100g" },
  "carottes":       { cal:41,  p:0.9,  c:10,  f:0.2, u:"100g" },
  "poivron":        { cal:31,  p:1,    c:6,   f:0.3, u:"100g" },
  "concombre":      { cal:16,  p:0.6,  c:3.6, f:0.1, u:"100g" },
  "celeri":         { cal:16,  p:0.7,  c:3,   f:0.2, u:"100g" },
  "champignon":     { cal:22,  p:3.1,  c:3.3, f:0.3, u:"100g" },
  "champignons":    { cal:22,  p:3.1,  c:3.3, f:0.3, u:"100g" },
  "haricots verts": { cal:35,  p:1.9,  c:7,   f:0.1, u:"100g" },
  "petits pois":    { cal:81,  p:5.4,  c:14,  f:0.4, u:"100g" },
  "mais":           { cal:86,  p:3.3,  c:19,  f:1.4, u:"100g" },
  "aubergine":      { cal:25,  p:1,    c:5.7, f:0.2, u:"100g" },
  "ail":            { cal:149, p:6,    c:33,  f:0.5, u:"100g" },
  "oignon":         { cal:40,  p:1.1,  c:9,   f:0.1, u:"100g" },
  // ── Drinks ──
  "eau":            { cal:0,   p:0,    c:0,   f:0,   u:"verre" },
  "café":           { cal:5,   p:0.3,  c:0,   f:0,   u:"tasse" },
  "cafe":           { cal:5,   p:0.3,  c:0,   f:0,   u:"tasse" },
  "lait cafe":      { cal:35,  p:2,    c:3.5, f:1.5, u:"tasse" },
  "the":            { cal:2,   p:0,    c:0.5, f:0,   u:"tasse" },
  "thé":            { cal:2,   p:0,    c:0.5, f:0,   u:"tasse" },
  "jus orange":     { cal:45,  p:0.7,  c:10,  f:0.2, u:"100ml" },
  "jus pomme":      { cal:46,  p:0.1,  c:11,  f:0.1, u:"100ml" },
  "smoothie":       { cal:70,  p:1.5,  c:16,  f:0.5, u:"100ml" },
  "coca":           { cal:42,  p:0,    c:10.6,f:0,   u:"100ml" },
  "coca zero":      { cal:1,   p:0,    c:0,   f:0,   u:"100ml" },
  "biere":          { cal:43,  p:0.5,  c:3.6, f:0,   u:"100ml" },
  "vin":            { cal:85,  p:0.1,  c:2.6, f:0,   u:"100ml" },
  // ── Misc & Meals ──
  "chocolat noir":  { cal:598, p:7.8,  c:46,  f:43,  u:"100g" },
  "chocolat":       { cal:535, p:7.7,  c:60,  f:30,  u:"100g" },
  "chocolat lait":  { cal:535, p:7.7,  c:60,  f:30,  u:"100g" },
  "pizza":          { cal:266, p:11,   c:33,  f:10,  u:"100g" },
  "burger":         { cal:295, p:17,   c:24,  f:14,  u:"100g" },
  "quiche":         { cal:298, p:11,   c:19,  f:20,  u:"100g" },
  "omelette":       { cal:154, p:11,   c:0.5, f:12,  u:"100g" },
  "soupe":          { cal:55,  p:2,    c:9,   f:1.5, u:"100ml" },
  "soupe legumes":  { cal:55,  p:2,    c:9,   f:1.5, u:"100ml" },
  "vinaigrette":    { cal:450, p:0,    c:5,   f:48,  u:"100ml" },
  "mayonnaise":     { cal:680, p:1.5,  c:1.5, f:75,  u:"100g" },
  "confiture":      { cal:250, p:0.5,  c:65,  f:0.1, u:"100g" },
  "miel":           { cal:304, p:0.3,  c:82,  f:0,   u:"100g" },
  "sucre":          { cal:400, p:0,    c:100, f:0,   u:"100g" },
  "nutella":        { cal:539, p:6,    c:57,  f:31,  u:"100g" },
};

function _offlineAnalyzeFood(description) {
  const normalize = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const text = normalize(description);
  const items = [];
  let totCal = 0, totP = 0, totC = 0, totF = 0;
  const keys = Object.keys(FOOD_OFFLINE_DB).sort((a, b) => b.length - a.length);
  const matched = new Set();
  for (const key of keys) {
    const normKey = normalize(key);
    if (text.includes(normKey) && !matched.has(key)) {
      matched.add(key);
      const d = FOOD_OFFLINE_DB[key];
      const idx = text.indexOf(normKey);
      const around = text.slice(Math.max(0, idx - 10), idx + normKey.length + 8);
      const nm = around.match(/(\d+(?:[,.]\d+)?)/);
      const qty = nm ? Math.min(20, Math.max(1, Math.round(parseFloat(nm[1].replace(",", "."))))) : 1;
      const unit = d.u || "100g";
      items.push({
        name:     key.charAt(0).toUpperCase() + key.slice(1),
        quantity: qty > 1 ? `${qty}× ${unit}` : `1 ${unit}`,
        calories: Math.round(d.cal * qty),
        protein:  Math.round(d.p   * qty * 10) / 10,
        carbs:    Math.round(d.c   * qty * 10) / 10,
        fat:      Math.round(d.f   * qty * 10) / 10
      });
      totCal += d.cal * qty; totP += d.p * qty; totC += d.c * qty; totF += d.f * qty;
    }
  }
  if (!items.length) {
    items.push({ name: "Repas estimé", quantity: "1 portion", calories: 450, protein: 22, carbs: 50, fat: 16 });
    totCal = 450; totP = 22; totC = 50; totF = 16;
  }
  const protRatio = (totP * 4) / (totCal || 1);
  let score = 60;
  if (protRatio > 0.25) score += 20; else if (protRatio < 0.1) score -= 15;
  if (totCal > 1200) score -= 20; else if (totCal > 800) score -= 8;
  if (/brocoli|epinard|tomate|courgette|salade|carotte/.test(text)) score += 10;
  if (/pizza|burger|frites|chips/.test(text)) score -= 20;
  score = Math.max(10, Math.min(100, Math.round(score)));
  const comment = score >= 75 ? "Excellent équilibre nutritionnel !" : score >= 55 ? "Repas correct, enrichis en protéines/légumes." : "Repas calorique — pense à équilibrer.";
  return { items, total: { calories: Math.round(totCal), protein: Math.round(totP * 10) / 10, carbs: Math.round(totC * 10) / 10, fat: Math.round(totF * 10) / 10 }, quality_score: score, comment, source: "offline" };
}

async function analyzeFood() {
  const inputEl = document.getElementById("food-journal-input");
  const errEl = document.getElementById("food-analysis-err");
  const loadEl = document.getElementById("food-analysis-loading");
  const resultEl = document.getElementById("food-analysis-result");
  const btnEl = document.getElementById("btn-analyze-food");
  if (errEl) errEl.textContent = "";
  if (resultEl) resultEl.style.display = "none";

  const description = (inputEl?.value || "").trim();
  if (!description) {
    if (errEl) errEl.textContent = "Décris ce que tu as mangé.";
    return;
  }

  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "⏳ Analyse…"; }
  if (loadEl) loadEl.style.display = "block";

  let result = null;
  try {
    const authHeader = U ? `Bearer ${(await SB.auth.getSession()).data.session?.access_token}` : "";
    const resp = await fetch("/api/analyze-food", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify({ description, date: new Date().toISOString().slice(0, 10) }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
    });
    if (!resp.ok) throw new Error("API error " + resp.status);
    result = await resp.json();
  } catch (e) {
    // Offline fallback
    result = _offlineAnalyzeFood(description);
    result.source = "offline";
  }

  if (loadEl) loadEl.style.display = "none";
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = "🔍 Analyser mes repas"; }

  if (!result || !result.items) {
    if (errEl) errEl.textContent = "Impossible d'analyser. Réessaie.";
    return;
  }

  // Store last result for save action
  window._lastFoodAnalysis = result;

  // Render quality badge
  const score = result.quality_score || 60;
  const qBadge = document.getElementById("food-quality-badge");
  const qLabel = document.getElementById("food-quality-label");
  const qScore = document.getElementById("food-quality-score");
  const qComment = document.getElementById("food-quality-comment");
  const cls = score >= 75 ? "good" : score >= 50 ? "ok" : "bad";
  const lbl = score >= 75 ? "Excellent" : score >= 50 ? "Correct" : "À améliorer";
  if (qBadge) { qBadge.className = `quality-badge-wrap ${cls}`; }
  if (qLabel) { qLabel.className = `quality-label ${cls}`; qLabel.textContent = lbl; }
  if (qScore) qScore.textContent = score;
  if (qComment) qComment.textContent = result.comment || "";

  // Render totals
  const t = result.total || {};
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt("food-total-cal", (t.calories || 0) + " kcal");
  setTxt("food-total-prot", (t.protein || 0) + "g");
  setTxt("food-total-carbs", (t.carbs || 0) + "g");
  setTxt("food-total-fat", (t.fat || 0) + "g");

  // Render items list with per-item macro bars
  const listEl = document.getElementById("food-items-list");
  const maxCalItem = Math.max(...(result.items || []).map(i => i.calories || 0), 1);
  if (listEl) {
    listEl.innerHTML = (result.items || []).map(item => {
      const calPct  = Math.round(((item.calories || 0) / maxCalItem) * 100);
      const protPct = Math.min(100, Math.round(((item.protein || 0) * 4 / (item.calories || 1)) * 100));
      return `<div class="food-item-row">
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
            <div class="food-item-name">${escapeHtml(item.name || "")}</div>
            <span class="food-macro-chip food-macro-cal" style="flex-shrink:0">${item.calories || 0} kcal</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:3px">
            <span class="food-item-qty" style="flex-shrink:0">${escapeHtml(item.quantity || "")}</span>
            <span style="font-size:.68rem;color:#4ade80;font-weight:700">P ${item.protein || 0}g</span>
            <span style="font-size:.68rem;color:#fbbf24;font-weight:700">G ${item.carbs || 0}g</span>
            <span style="font-size:.68rem;color:#f87171;font-weight:700">L ${item.fat || 0}g</span>
          </div>
          <div style="display:flex;gap:2px;margin-top:5px;height:4px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.06)">
            <div style="width:${calPct}%;background:rgba(99,102,241,.5);transition:width .6s ease;border-radius:99px"></div>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  if (resultEl) { resultEl.style.display = "block"; resultEl.style.animation = "fadeIn .3s ease"; }
}

// ── Meal type selection ───────────────────────────────────────────────────────
// Calorie budget per meal type (rough target split from 2200 kcal default)
const MEAL_CAL_BUDGETS = { petit_dej: 450, collation: 220, midi: 680, soir: 580 };
const MEAL_TYPE_LABELS = { petit_dej: "Petit-déjeuner", collation: "Collation", midi: "Déjeuner", soir: "Dîner" };
let _selectedMealType = "midi";

function selectMealType(type) {
  _selectedMealType = type;
  document.querySelectorAll(".meal-type-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.type === type);
  });
  const budget = MEAL_CAL_BUDGETS[type] || 600;
  const budgetEl = document.getElementById("meal-cal-budget");
  if (budgetEl) budgetEl.textContent = budget;
  // Update placeholder
  const placeholders = {
    petit_dej: "Ex: 2 œufs brouillés, fromage blanc, une tranche de pain complet, café…",
    collation: "Ex: une pomme, 30g d'amandes, un yaourt grec…",
    midi: "Ex: riz complet, poulet grillé 150g, brocoli vapeur, huile d'olive…",
    soir: "Ex: saumon rôti, patate douce, salade verte, vinaigrette…"
  };
  const ta = document.getElementById("food-journal-input");
  if (ta) ta.placeholder = placeholders[type] || ta.placeholder;
}

async function saveFoodAnalysis() {
  if (!U) return toast("Connecte-toi pour sauvegarder.", "err");
  const res = window._lastFoodAnalysis;
  if (!res) return;
  const today = new Date().toISOString().slice(0, 10);

  const t = res.total || {};
  const typeLabel = MEAL_TYPE_LABELS[_selectedMealType] || "Repas";
  const rawDesc = (document.getElementById("food-journal-input")?.value || "").slice(0, 40);
  const name = rawDesc ? `${typeLabel}: ${rawDesc}` : typeLabel;

  try {
    const { error } = await SB.from("meals").insert({
      user_id: U.id,
      name: name.slice(0, 80),
      calories: t.calories || 0,
      protein: t.protein || 0,
      carbs: t.carbs || 0,
      fat: t.fat || 0,
      date: today,
      source: "ai_journal"
    });
    if (error) throw error;
    toast(`${typeLabel} ajouté ! ${t.calories || 0} kcal`, "ok");
    loadMeals();
    loadNutritionWeekChart();
    // Clear
    const ta = document.getElementById("food-journal-input");
    if (ta) ta.value = "";
    const resultEl = document.getElementById("food-analysis-result");
    if (resultEl) resultEl.style.display = "none";
  } catch (e) {
    toast("Erreur: " + e.message, "err");
  }
}

async function loadNutritionWeekChart() {
  const svg = document.getElementById("nutr-week-svg");
  if (!svg) return;

  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  let mealsData = [];
  let targetCal = 2200;
  let targetProt = 140;

  if (U) {
    try {
      const [mealsRes, targetRes] = await Promise.all([
        SB.from("meals").select("date,calories,protein").eq("user_id", U.id).gte("date", days[0]).lte("date", days[6]),
        SB.from("nutrition_targets").select("calories,protein").eq("user_id", U.id).maybeSingle()
      ]);
      mealsData = mealsRes.data || [];
      if (targetRes.data) { targetCal = targetRes.data.calories || 2200; targetProt = targetRes.data.protein || 140; }
    } catch { /* offline */ }
  }

  // Group by day
  const dayTotals = days.map(date => {
    const dayMeals = mealsData.filter(m => m.date === date);
    return {
      date,
      cal: dayMeals.reduce((s, m) => s + (m.calories || 0), 0),
      prot: dayMeals.reduce((s, m) => s + (m.protein || 0), 0)
    };
  });

  _renderNutritionWeekChart(svg, dayTotals, targetCal, targetProt);
}

function _renderNutritionWeekChart(svg, dayTotals, targetCal, targetProt) {
  const W = 340, H = 160, PAD_L = 28, PAD_R = 10, PAD_T = 12, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n = dayTotals.length;
  const barW = Math.floor(chartW / n) - 4;
  const maxCal = Math.max(targetCal * 1.2, ...dayTotals.map(d => d.cal), 100);
  const maxProt = Math.max(targetProt * 1.3, ...dayTotals.map(d => d.prot), 10);
  const dayLabels = ["D-6","D-5","D-4","D-3","D-2","Hier","Auj"];

  const calToY = v => PAD_T + chartH - (v / maxCal) * chartH;
  const protToY = v => PAD_T + chartH - (v / maxProt) * chartH;

  let html = "";

  // Grid line at target
  const targetY = calToY(targetCal);
  html += `<line x1="${PAD_L}" y1="${targetY}" x2="${W - PAD_R}" y2="${targetY}" stroke="rgba(255,255,255,.2)" stroke-width="1" stroke-dasharray="4,3"/>`;

  // Calorie bars
  dayTotals.forEach((d, i) => {
    const x = PAD_L + i * (chartW / n) + 2;
    const barH = Math.max(2, (d.cal / maxCal) * chartH);
    const y = PAD_T + chartH - barH;
    const overTarget = d.cal > targetCal;
    const hasData = d.cal > 0;
    const fill = hasData ? (overTarget ? "rgba(248,113,113,.7)" : "rgba(99,102,241,.7)") : "rgba(255,255,255,.06)";
    html += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${fill}" class="nutr-chart-cal-bar"/>`;
    // Day label
    html += `<text x="${x + barW / 2}" y="${H - PAD_B + 12}" text-anchor="middle" class="nutr-chart-day-lbl">${dayLabels[i]}</text>`;
  });

  // Protein line
  const protPoints = dayTotals.map((d, i) => {
    const x = PAD_L + i * (chartW / n) + barW / 2 + 2;
    const y = protToY(d.prot);
    return `${x},${y}`;
  });
  if (dayTotals.some(d => d.prot > 0)) {
    html += `<polyline points="${protPoints.join(" ")}" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    // Dots
    dayTotals.forEach((d, i) => {
      if (d.prot > 0) {
        const x = PAD_L + i * (chartW / n) + barW / 2 + 2;
        const y = protToY(d.prot);
        html += `<circle cx="${x}" cy="${y}" r="3" fill="#4ade80" stroke="#0f172a" stroke-width="1.5"/>`;
      }
    });
  }

  // Y axis label
  html += `<text x="${PAD_L - 4}" y="${PAD_T + chartH / 2}" text-anchor="middle" fill="rgba(255,255,255,.25)" font-size="8" font-family="inherit" transform="rotate(-90 ${PAD_L - 4} ${PAD_T + chartH / 2})">kcal</text>`;

  svg.innerHTML = html;
}

window.analyzeFood = analyzeFood;
window.saveFoodAnalysis = saveFoodAnalysis;
window.loadNutritionWeekChart = loadNutritionWeekChart;
window.selectMealType = selectMealType;

// ── Sync water counter in programme tab ──────────────────────────────────────
function syncProgWater() {
  const today = new Date().toDateString();
  const dateKey = localStorage.getItem("fitai_water_date");
  const count = dateKey === today ? parseInt(localStorage.getItem("fitai_water_count") || "0", 10) : 0;
  const target = parseInt(localStorage.getItem("fitai_water_target") || "8", 10);

  const countEl = document.getElementById("prog-water-count");
  const targetEl = document.getElementById("prog-water-target");
  const barEl = document.getElementById("prog-water-bar");
  const glassesEl = document.getElementById("prog-water-glasses");

  if (countEl) countEl.textContent = count;
  if (targetEl) targetEl.textContent = `/ ${target} verres`;
  if (barEl) barEl.style.width = Math.min(100, Math.round((count / target) * 100)) + "%";
  if (glassesEl) {
    glassesEl.innerHTML = Array.from({ length: target }, (_, i) =>
      `<span class="prog-water-mini-glass" style="opacity:${i < count ? 1 : 0.2}">💧</span>`
    ).join("");
  }
}
window.syncProgWater = syncProgWater;

// ══════════════════════════════════════════════════════════════════════════════
// WORKOUT TIMER — Interactive séance player
// ══════════════════════════════════════════════════════════════════════════════

let _wtExercises = [];  // [{n, m, sets, reps, rest}]
let _wtExIdx = 0;       // current exercise index
let _wtSetsDone = 0;    // sets done for current exercise
let _wtSetsTotal = 0;   // total sets for current exercise
let _wtRestTimer = null; // interval id
let _wtRestLeft = 0;

function startWorkout(dayLabel, exercises, params) {
  _wtExercises = exercises;
  _wtExIdx = 0;
  _wtSetsDone = 0;
  _wtSetsTotal = params.sets || 3;

  const overlay = document.getElementById("wt-overlay");
  const titleEl = document.getElementById("wt-title");
  const phaseEl = document.getElementById("wt-phase-label");
  if (titleEl) titleEl.textContent = dayLabel;
  if (phaseEl) {
    const phase = PROG_PHASES[(_progWeek || 1) - 1];
    phaseEl.textContent = phase ? `${phase.name} · RPE ${phase.rpe}` : "";
  }
  if (overlay) overlay.classList.add("open");
  _wtRenderExercise();
}

// ── Muscle body diagram SVG ───────────────────────────────────────────────────
function _muscleSVG(muscle) {
  const m = (muscle || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const dim  = "rgba(255,255,255,.07)";
  const hi   = "#6366f1";
  const hiM  = "rgba(99,102,241,.55)";
  const hi2  = "#4ade80";

  const chest    = /pec|poitrine/.test(m);
  const shoulder = /epaule|delt/.test(m) && !/arriere/.test(m);
  const rearDelt = /arriere|oiseau|face.pull/.test(m);
  const back     = /dos|dorsal|lat|trap|romb/.test(m);
  const bicep    = /bicep/.test(m);
  const tricep   = /tricep|dips/.test(m);
  const core     = /core|abdo|obliqu|gainage|crunch|hollow|planche/.test(m);
  const glute    = /fess|glute|hip|hanche/.test(m);
  const quad     = /quad|jamb|squat/.test(m) && !glute;
  const hamstr   = /ischio|hamilton/.test(m);
  const calf     = /mollet/.test(m);
  const cardio   = /cardio|full|hiit/.test(m);
  const arms     = bicep || tricep || /bras/.test(m);

  // Assign colors per segment
  const C = (test, full, mid) => test ? (full || hi) : mid ? hiM : dim;

  const shl = C(shoulder, hi);
  const cht = C(chest, hi);
  const arm = C(arms);
  const fab = C(core, hi);
  const glU = C(glute, hi);
  const qd  = C(quad || (cardio && !glute), hi, cardio);
  const cl  = C(calf, hi, quad || cardio);
  const bck = C(back || rearDelt, hi);
  const frm = C(arms, null, true); // forearms dim when arms highlighted

  const glow = (c) => c !== dim ? `filter:drop-shadow(0 0 5px ${c})` : "";

  return `<svg viewBox="0 0 88 138" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;overflow:visible">
    <circle cx="44" cy="12" r="10" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.18)" stroke-width="1.3"/>
    <rect x="40" y="21" width="8" height="8" rx="3" fill="rgba(255,255,255,.06)"/>
    <ellipse cx="23" cy="33" rx="11" ry="7" fill="${shl}" style="${glow(shl)}"/>
    <ellipse cx="65" cy="33" rx="11" ry="7" fill="${shl}" style="${glow(shl)}"/>
    <path d="M31 28 L57 28 L61 54 L27 54 Z" fill="${cht}" rx="4" style="${glow(cht)}"/>
    <rect x="30" y="54" width="28" height="27" rx="5" fill="${fab}" style="${glow(fab)}"/>
    <path d="M29 81 Q44 94 59 81 L59 93 Q44 104 29 93 Z" fill="${glU}" style="${glow(glU)}"/>
    <rect x="11" y="28" width="11" height="30" rx="5" fill="${arm}" style="${glow(arm)}"/>
    <rect x="66" y="28" width="11" height="30" rx="5" fill="${arm}" style="${glow(arm)}"/>
    <rect x="10" y="59" width="10" height="26" rx="4" fill="${frm}"/>
    <rect x="68" y="59" width="10" height="26" rx="4" fill="${frm}"/>
    <rect x="28" y="84" width="14" height="31" rx="6" fill="${qd}" style="${glow(qd)}"/>
    <rect x="46" y="84" width="14" height="31" rx="6" fill="${qd}" style="${glow(qd)}"/>
    <rect x="29" y="117" width="12" height="20" rx="5" fill="${cl}" style="${glow(cl)}"/>
    <rect x="47" y="117" width="12" height="20" rx="5" fill="${cl}" style="${glow(cl)}"/>
    ${(back||rearDelt) ? `<rect x="30" y="29" width="28" height="26" rx="4" fill="rgba(99,102,241,.25)" stroke="rgba(99,102,241,.4)" stroke-width="1" stroke-dasharray="3,2"/>` : ""}
  </svg>`;
}

// ── Animated stick figure for exercise movements ──────────────────────────────
function _stickFigureSVG(name) {
  const nm = (name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Near (right/front) limb — bright, thick
  const st  = 'stroke="rgba(255,255,255,.92)" stroke-width="2.6" stroke-linecap="round" fill="none"';
  // Far (left/back) limb — dim, thin
  const stF = 'stroke="rgba(255,255,255,.38)" stroke-width="1.9" stroke-linecap="round" fill="none"';
  // Mid (torso structural lines)
  const stM = 'stroke="rgba(255,255,255,.65)" stroke-width="2.1" stroke-linecap="round" fill="none"';

  // Ground shadow ellipse + floor line
  const FLR = '<ellipse cx="41" cy="77" rx="22" ry="3.5" fill="rgba(0,0,0,.3)"/>' +
    '<line x1="6" y1="76" x2="76" y2="76" stroke="rgba(255,255,255,.1)" stroke-width="1"/>';

  // SVG defs: drop shadow filter + head radial gradient
  const DEFS = `<defs>
    <filter id="sf" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="2" dy="4" stdDeviation="3" flood-color="rgba(0,0,40,.55)"/>
    </filter>
    <radialGradient id="hg" cx="36%" cy="34%" r="58%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="60%" stop-color="#c8d4ff" stop-opacity=".93"/>
      <stop offset="100%" stop-color="#5a6ab0" stop-opacity=".88"/>
    </radialGradient>
  </defs>`;

  const open  = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;overflow:visible">${DEFS}<g filter="url(#sf)">`;
  const close = `</g></svg>`;

  // ── Equipment SVG shapes ───────────────────────────────────────────────────
  const DB = (x=62,y=72,op=".5") =>
    `<g opacity="${op}">` +
    `<rect x="${x-5}" y="${y-1.5}" width="10" height="3" rx="1" fill="rgba(255,255,255,.7)"/>` +
    `<rect x="${x-7}" y="${y-3.5}" width="2.5" height="7" rx=".8" fill="white"/>` +
    `<rect x="${x+4.5}" y="${y-3.5}" width="2.5" height="7" rx=".8" fill="white"/>` +
    `</g>`;
  const BB = (x=40,y=72,op=".5") =>
    `<g opacity="${op}">` +
    `<line x1="${x-16}" y1="${y}" x2="${x+16}" y2="${y}" stroke="rgba(255,255,255,.7)" stroke-width="2.4" stroke-linecap="round"/>` +
    `<rect x="${x-19}" y="${y-4}" width="3" height="8" rx="1" fill="rgba(255,255,255,.8)"/>` +
    `<rect x="${x-16}" y="${y-5.5}" width="3" height="11" rx="1" fill="rgba(255,255,255,.9)"/>` +
    `<rect x="${x+13}" y="${y-5.5}" width="3" height="11" rx="1" fill="rgba(255,255,255,.9)"/>` +
    `<rect x="${x+16}" y="${y-4}" width="3" height="8" rx="1" fill="rgba(255,255,255,.8)"/>` +
    `</g>`;

  // MUSCLE(cx,cy,col): pulsing muscle group indicator dot
  const MUSCLE = (cx,cy,col="#f97316") =>
    `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${col}" opacity=".22" stroke="${col}" stroke-width="1">` +
    `<animate attributeName="r" values="4.5;8;4.5" dur="1.8s" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" repeatCount="indefinite"/>` +
    `<animate attributeName="opacity" values=".22;.04;.22" dur="1.8s" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" repeatCount="indefinite"/>` +
    `</circle>`;

  const ARC = (d,col="rgba(99,102,241,.28)") =>
    `<path d="${d}" stroke="${col}" stroke-width="1.5" fill="none" stroke-dasharray="3,2.5" stroke-linecap="round"/>`;
  const ARRUP = (x,y) => `<g stroke="rgba(255,255,255,.32)" stroke-width="1.3" stroke-linecap="round"><line x1="${x}" y1="${y+7}" x2="${x}" y2="${y}"/><line x1="${x-3.5}" y1="${y+3.5}" x2="${x}" y2="${y}"/><line x1="${x+3.5}" y1="${y+3.5}" x2="${x}" y2="${y}"/></g>`;
  const ARRDN = (x,y) => `<g stroke="rgba(255,255,255,.32)" stroke-width="1.3" stroke-linecap="round"><line x1="${x}" y1="${y}" x2="${x}" y2="${y+7}"/><line x1="${x-3.5}" y1="${y+3.5}" x2="${x}" y2="${y+7}"/><line x1="${x+3.5}" y1="${y+3.5}" x2="${x}" y2="${y+7}"/></g>`;

  // ── 3D head: filled gradient circle + specular highlight ──
  const HEAD = (cx, cy, r=7) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#hg)" stroke="rgba(255,255,255,.65)" stroke-width="1.1"/>` +
    `<circle cx="${cx-r*.3}" cy="${cy-r*.28}" r="${r*.18}" fill="rgba(255,255,255,.42)"/>`;

  // ── Joint dot (shoulder, hip, elbow, knee) ────────────────
  const J = (cx, cy, r=2.4) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(200,215,255,.65)" stroke="rgba(255,255,255,.25)" stroke-width=".8"/>`;

  // ── 3D Torso (static parallelogram) ──────────────────────
  // sfx,sfy = far(left) shoulder; snx,sny = near(right) shoulder
  // hfx,hfy = far(left) hip;      hnx,hny = near(right) hip
  const TORSO = (sfx=32,sfy=21,snx=50,sny=21,hfx=34,hfy=46,hnx=48,hny=46) =>
    `<polygon points="${sfx},${sfy} ${snx},${sny} ${hnx},${hny} ${hfx},${hfy}" fill="rgba(255,255,255,.07)" stroke="none"/>` +
    `<line x1="${sfx}" y1="${sfy}" x2="${hfx}" y2="${hfy}" ${stF}/>` +
    `<line x1="${snx}" y1="${sny}" x2="${hnx}" y2="${hny}" ${st}/>` +
    `<line x1="${sfx}" y1="${sfy}" x2="${snx}" y2="${sny}" ${stM}/>` +
    `<line x1="${hfx}" y1="${hfy}" x2="${hnx}" y2="${hny}" ${stM}/>`;

  // ── Animated 3D Torso: sYs=shoulder Ys/frame, hYs=hip Ys/frame ──────────
  // X positions fixed: far shoulder x=32, near shoulder x=50, far hip x=34, near hip x=48
  const TORSOA = (sYs, hYs, d="1.8s") => {
    const N = sYs.length;
    const sYL = [...sYs, sYs[0]], hYL = [...hYs, hYs[0]];
    const kt = sYL.map((_,i) => (i/(sYL.length-1)).toFixed(4)).join(";");
    const ks = Array(N).fill("0.42 0 0.58 1").join("; ");
    const A = (attr, vals) =>
      `<animate attributeName="${attr}" values="${vals.join(";")}" dur="${d}" calcMode="spline" keyTimes="${kt}" keySplines="${ks}" repeatCount="indefinite"/>`;
    const fs = `<line x1="32" y1="${sYs[0]}" x2="34" y2="${hYs[0]}" ${stF}>${A("y1",sYL)}${A("y2",hYL)}</line>`;
    const ns = `<line x1="50" y1="${sYs[0]}" x2="48" y2="${hYs[0]}" ${st}>${A("y1",sYL)}${A("y2",hYL)}</line>`;
    const sl = `<line x1="32" y1="${sYs[0]}" x2="50" y2="${sYs[0]}" ${stM}>${A("y1",sYL)}${A("y2",sYL)}</line>`;
    const hl = `<line x1="34" y1="${hYs[0]}" x2="48" y2="${hYs[0]}" ${stM}>${A("y1",hYL)}${A("y2",hYL)}</line>`;
    return fs + sl + ns + hl;
  };

  // ── 2-frame helpers (A→B→A) ───────────────────────────────
  const KS2 = 'calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1" repeatCount="indefinite"';

  // L: near-limb 2-frame line
  const L = (x1,y1,x2,y2, x1b,y1b,x2b,y2b, d="1.5s") => {
    let el = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${st}>`;
    if(x1!==x1b) el+=`<animate attributeName="x1" values="${x1};${x1b};${x1}" dur="${d}" ${KS2}/>`;
    if(y1!==y1b) el+=`<animate attributeName="y1" values="${y1};${y1b};${y1}" dur="${d}" ${KS2}/>`;
    if(x2!==x2b) el+=`<animate attributeName="x2" values="${x2};${x2b};${x2}" dur="${d}" ${KS2}/>`;
    if(y2!==y2b) el+=`<animate attributeName="y2" values="${y2};${y2b};${y2}" dur="${d}" ${KS2}/>`;
    return el + `</line>`;
  };
  // LF: same but far-limb style
  const LF = (x1,y1,x2,y2, x1b,y1b,x2b,y2b, d="1.5s") => {
    let el = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stF}>`;
    if(x1!==x1b) el+=`<animate attributeName="x1" values="${x1};${x1b};${x1}" dur="${d}" ${KS2}/>`;
    if(y1!==y1b) el+=`<animate attributeName="y1" values="${y1};${y1b};${y1}" dur="${d}" ${KS2}/>`;
    if(x2!==x2b) el+=`<animate attributeName="x2" values="${x2};${x2b};${x2}" dur="${d}" ${KS2}/>`;
    if(y2!==y2b) el+=`<animate attributeName="y2" values="${y2};${y2b};${y2}" dur="${d}" ${KS2}/>`;
    return el + `</line>`;
  };

  // C: animated circle (head/joint) — now uses HEAD for r>=6
  const C = (cx,cy,r,cyB,d="1.5s") => {
    if (r >= 6) {
      // 3D head with vertical animation
      const KS2h = 'calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1" repeatCount="indefinite"';
      const headAnim = cy !== cyB
        ? `<animate attributeName="cy" values="${cy};${cyB};${cy}" dur="${d}" ${KS2h}/>`
        : "";
      const hilAnim = cy !== cyB
        ? `<animate attributeName="cy" values="${cy-r*.28};${cyB-r*.28};${cy-r*.28}" dur="${d}" ${KS2h}/>`
        : "";
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#hg)" stroke="rgba(255,255,255,.65)" stroke-width="1.1">${headAnim}</circle>` +
        `<circle cx="${cx-r*.3}" cy="${cy-r*.28}" r="${r*.18}" fill="rgba(255,255,255,.42)">${hilAnim}</circle>`;
    }
    const anim = cy!==cyB ? `<animate attributeName="cy" values="${cy};${cyB};${cy}" dur="${d}" ${KS2}/>` : "";
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(200,215,255,.58)" stroke="rgba(255,255,255,.5)" stroke-width=".9">${anim}</circle>`;
  };

  // ── N-frame helpers — smooth multi-keyframe SMIL ──────────
  const _LM_build = (frames, d, style) => {
    const N = frames.length;
    const loop = [...frames, frames[0]];
    const kt = loop.map((_,i) => (i/(loop.length-1)).toFixed(4)).join(";");
    const ks = Array(N).fill("0.42 0 0.58 1").join("; ");
    const SM = `calcMode="spline" keyTimes="${kt}" keySplines="${ks}" repeatCount="indefinite"`;
    const a = (attr, idx) => {
      const vals = loop.map(f => f[idx]).join(";");
      if (loop.every(f => f[idx] === loop[0][idx])) return "";
      return `<animate attributeName="${attr}" values="${vals}" dur="${d}" ${SM}/>`;
    };
    const f0 = frames[0];
    return `<line x1="${f0[0]}" y1="${f0[1]}" x2="${f0[2]}" y2="${f0[3]}" ${style}>${a("x1",0)}${a("y1",1)}${a("x2",2)}${a("y2",3)}</line>`;
  };
  // LM: near-limb N-frame
  const LM  = (frames, d="1.6s") => _LM_build(frames, d, st);
  // LMF: far-limb N-frame (dimmer)
  const LMF = (frames, d="1.6s") => _LM_build(frames, d, stF);

  // CM: animated circle (joint/head) N-frame
  const CM = (cxs, cys, r, d="1.6s") => {
    const N = cxs.length;
    const cxL = [...cxs, cxs[0]], cyL = [...cys, cys[0]];
    const kt = cxL.map((_,i) => (i/(cxL.length-1)).toFixed(4)).join(";");
    const ks = Array(N).fill("0.42 0 0.58 1").join("; ");
    const SM = `calcMode="spline" keyTimes="${kt}" keySplines="${ks}" repeatCount="indefinite"`;
    const acx = cxs.every(v=>v===cxs[0]) ? "" : `<animate attributeName="cx" values="${cxL.join(";")}" dur="${d}" ${SM}/>`;
    const acy = cys.every(v=>v===cys[0]) ? "" : `<animate attributeName="cy" values="${cyL.join(";")}" dur="${d}" ${SM}/>`;
    if (r >= 6) {
      const hilX = cxs[0] - r*.3, hilY0 = cys[0] - r*.28;
      const acxH = cxs.every(v=>v===cxs[0]) ? "" : `<animate attributeName="cx" values="${cxL.map(v=>v-r*.3).join(";")}" dur="${d}" ${SM}/>`;
      const acyH = cys.every(v=>v===cys[0]) ? "" : `<animate attributeName="cy" values="${cyL.map(v=>v-r*.28).join(";")}" dur="${d}" ${SM}/>`;
      return `<circle cx="${cxs[0]}" cy="${cys[0]}" r="${r}" fill="url(#hg)" stroke="rgba(255,255,255,.65)" stroke-width="1.1">${acx}${acy}</circle>` +
        `<circle cx="${hilX}" cy="${hilY0}" r="${r*.18}" fill="rgba(255,255,255,.42)">${acxH}${acyH}</circle>`;
    }
    return `<circle cx="${cxs[0]}" cy="${cys[0]}" r="${r}" fill="rgba(200,215,255,.58)" stroke="rgba(255,255,255,.5)" stroke-width=".9">${acx}${acy}</circle>`;
  };

  // ── Crossfade (2 full-body poses, CSS opacity) ─────────────
  const XF = (d="1.6s") => `<style>.sfa{animation:sfa ${d} ease-in-out infinite}.sfb{animation:sfb ${d} ease-in-out infinite}@keyframes sfa{0%,35%{opacity:1}48%,85%{opacity:0}100%{opacity:1}}@keyframes sfb{0%,35%{opacity:0}48%,85%{opacity:1}100%{opacity:0}}</style>`;

  // ── Push-up — side view, 3D near/far arms ────────────────────────────────
  if (/pompe|push.?up|pike.?push/.test(nm)) {
    const PU_KT = 'keyTimes="0;0.35;0.65;1;1"';
    const PU_KSP = 'calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1" repeatCount="indefinite" dur="1.6s"';
    const puAnim = (attr, vals) => `<animate attributeName="${attr}" values="${vals}" ${PU_KT} ${PU_KSP}/>`;
    const sYv = "40;51;59;64;40";
    const headCY = "32;43;51;56;32";
    const floor = `<line x1="4" y1="66" x2="76" y2="66" stroke="rgba(255,255,255,.18)" stroke-width="1.2"/>`;
    const handL = `<circle cx="22" cy="66" r="3" fill="rgba(255,255,255,.5)"/>`;
    const handR = `<circle cx="46" cy="66" r="2.2" fill="rgba(255,255,255,.28)"/>`;
    const body = `<line x1="22" y1="40" x2="58" y2="40" ${st}>${puAnim("y1",sYv)}${puAnim("y2",sYv)}</line>`;
    const head = `<circle cx="10" cy="32" r="6" fill="url(#hg)" stroke="rgba(255,255,255,.65)" stroke-width="1.1">${puAnim("cy",headCY)}</circle>` +
      `<circle cx="8" cy="30" r="1.1" fill="rgba(255,255,255,.42)">${puAnim("cy","28;39;47;52;28")}</circle>`;
    const neck = `<line x1="14" y1="34" x2="22" y2="40" ${st}>${puAnim("y1","26;37;45;50;26")}${puAnim("y2",sYv)}</line>`;
    // Far arm (back, dimmer)
    const armFar = `<line x1="46" y1="40" x2="46" y2="66" ${stF}>${puAnim("y1",sYv)}</line>`;
    // Near arm (front, bright)
    const armNear = `<line x1="22" y1="40" x2="22" y2="66" ${st}>${puAnim("y1",sYv)}</line>`;
    const leg  = `<line x1="58" y1="40" x2="64" y2="66" ${st}>${puAnim("y1",sYv)}</line>`;
    const arrows = ARRUP(70,38) + ARRDN(70,50);
    const mus = MUSCLE(34,52,"#60a5fa");
    return open + floor + mus + armFar + handR + head + neck + body + armNear + leg + handL + arrows + close;
  }

  // ── Squat — 3/4 view, 4 frames ───────────────────────────────────────────
  if (/squat/.test(nm)) {
    const sYs=[21,26,31,36], hYs=[46,51,55,58];
    return open + FLR + MUSCLE(41,50,"#f97316") +
      CM([42,42,42,42],[11,15,19,23],7,"1.8s") +
      LM([[41,14,41,21],[41,18,41,26],[41,22,41,31],[41,26,41,36]],"1.8s") +
      TORSOA(sYs, hYs, "1.8s") +
      LMF([[32,21,28,34],[32,26,28,38],[32,31,28,42],[32,36,28,46]],"1.8s") +
      LM([[50,21,54,34],[50,26,54,38],[50,31,54,42],[50,36,54,46]],"1.8s") +
      LMF([[34,46,28,63],[34,51,26,63],[34,55,22,63],[34,58,18,62]],"1.8s") +
      LMF([[28,63,24,76],[26,63,22,76],[22,63,18,76],[18,62,16,76]],"1.8s") +
      LM([[48,46,52,63],[48,51,56,63],[48,55,60,63],[48,58,62,62]],"1.8s") +
      LM([[52,63,56,76],[56,63,60,76],[60,63,64,76],[62,62,66,76]],"1.8s") +
      J(34,46) + J(48,46) + ARRDN(40,5) + close;
  }

  // ── Planche — 3D side profile ─────────────────────────────────────────────
  if (/planche|plank/.test(nm)) {
    return open +
      `<line x1="4" y1="54" x2="76" y2="54" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
      HEAD(10,36) +
      `<line x1="16" y1="38" x2="62" y2="38" ${stM}/>` +
      `<line x1="24" y1="38" x2="24" y2="41" ${stM}/>` +
      `<line x1="40" y1="38" x2="40" y2="41" ${stM}/>` +
      `<line x1="55" y1="38" x2="55" y2="41" ${stM}/>` +
      `<line x1="30" y1="38" x2="30" y2="54" ${stF}/>` +
      `<line x1="46" y1="38" x2="46" y2="54" ${st}/>` +
      `<line x1="62" y1="38" x2="68" y2="30" ${stF}/>` +
      `<line x1="62" y1="38" x2="68" y2="46" ${st}/>` +
      J(62,38) + J(30,54) + J(46,54) + MUSCLE(40,38,"#60a5fa") +
      `<circle cx="40" cy="38" r="4" stroke="rgba(99,102,241,.55)" fill="rgba(99,102,241,.1)" stroke-width="1.5">` +
      `<animate attributeName="r" values="4;7;4" dur="2.2s" ${KS2}/>` +
      `<animate attributeName="opacity" values=".9;.2;.9" dur="2.2s" ${KS2}/></circle>` + close;
  }

  // ── Tractions — 3/4 view, 4 frames ───────────────────────────────────────
  if (/traction|pull.?up|chin.?up/.test(nm)) {
    const sYs=[36,28,20,16], hYs=[61,53,45,41];
    return open +
      `<line x1="8" y1="8" x2="72" y2="8" stroke="rgba(255,255,255,.45)" stroke-width="3" stroke-linecap="round"/>` +
      `<circle cx="28" cy="8" r="3.5" fill="rgba(255,255,255,.28)"/>` +
      `<circle cx="52" cy="8" r="3.5" fill="rgba(255,255,255,.55)"/>` +
      MUSCLE(41,42,"#818cf8") + ARRUP(40,2) +
      CM([42,42,42,42],[26,18,10,6],7,"1.4s") +
      LM([[41,29,41,36],[41,21,41,28],[41,13,41,20],[41,9,41,16]],"1.4s") +
      TORSOA(sYs, hYs, "1.4s") +
      LMF([[32,36,28,8],[32,28,28,8],[32,20,28,8],[32,16,28,8]],"1.4s") +
      LM([[50,36,52,8],[50,28,52,8],[50,20,52,8],[50,16,52,8]],"1.4s") +
      LMF([[34,61,30,72],[34,53,30,65],[34,45,32,58],[34,41,34,56]],"1.4s") +
      LMF([[30,72,28,76],[30,65,28,70],[32,58,30,64],[34,56,34,60]],"1.4s") +
      LM([[48,61,52,72],[48,53,52,65],[48,45,50,58],[48,41,48,56]],"1.4s") +
      LM([[52,72,54,76],[52,65,54,70],[50,58,52,64],[48,56,50,60]],"1.4s") +
      J(32,36) + J(50,36) + close;
  }

  // ── Fentes — 3/4 view, 4 frames ──────────────────────────────────────────
  if (/fente|lunge/.test(nm)) {
    return open + FLR + MUSCLE(41,50,"#f97316") +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      LMF([[32,21,26,36],[32,21,26,32],[32,21,28,36],[32,21,28,32]],"1.8s") +
      LMF([[26,36,22,48],[26,32,22,44],[28,36,24,48],[28,32,24,44]],"1.8s") +
      LM([[50,21,56,36],[50,21,56,32],[50,21,54,36],[50,21,54,32]],"1.8s") +
      LM([[56,36,62,48],[56,32,62,44],[54,36,60,48],[54,32,60,44]],"1.8s") +
      LMF([[34,46,26,62],[34,46,20,62],[34,46,44,60],[34,46,38,62]],"1.8s") +
      LMF([[26,62,20,76],[20,62,14,76],[44,60,52,76],[38,62,40,76]],"1.8s") +
      LM([[48,46,54,62],[48,46,60,56],[48,46,34,56],[48,46,42,60]],"1.8s") +
      LM([[54,62,60,76],[60,56,68,72],[34,56,26,70],[42,60,44,76]],"1.8s") +
      J(34,46) + J(48,46) + close;
  }

  // ── Hip thrust — 3/4 view, 4 frames ──────────────────────────────────────
  if (/hip.?thrust|thrust/.test(nm)) {
    const sYs=[46,41,37,33], hYs=[52,47,42,38];
    return open + FLR +
      `<rect x="4" y="42" width="16" height="6" rx="2" stroke="rgba(255,255,255,.3)" stroke-width="1.5" fill="rgba(255,255,255,.05)"/>` +
      MUSCLE(41,38,"#f97316") + ARRUP(72,28) +
      CM([42,42,42,42],[36,31,27,23],7,"1.4s") +
      LM([[41,32,41,36],[41,27,41,31],[41,23,41,27],[41,19,41,23]],"1.4s") +
      TORSOA(sYs, hYs, "1.4s") +
      LMF([[32,46,28,58],[32,41,28,53],[32,37,28,50],[32,33,28,46]],"1.4s") +
      LM([[50,46,54,58],[50,41,54,53],[50,37,54,50],[50,33,54,46]],"1.4s") +
      LMF([[34,52,28,62],[34,47,28,58],[34,42,28,54],[34,38,28,50]],"1.4s") +
      LMF([[28,62,22,76],[28,58,22,76],[28,54,22,76],[28,50,22,76]],"1.4s") +
      LM([[48,52,54,62],[48,47,54,58],[48,42,54,54],[48,38,54,50]],"1.4s") +
      LM([[54,62,60,76],[54,58,60,76],[54,54,60,76],[54,50,60,76]],"1.4s") +
      J(34,52) + J(48,52) + close;
  }

  // ── Crunch — 4 frames: flat → quarter → half → full ──────
  if (/crunch|abdo|sit.?up|hollow/.test(nm)) {
    return open +
      `<line x1="4" y1="66" x2="76" y2="66" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
      MUSCLE(36,46,"#f97316") +
      CM([14,18,22,26],[54,48,42,38],6,"1.4s") +
      LM([[20,54,62,54],[26,48,60,55],[30,44,58,56],[34,41,58,57]],"1.4s") +
      LMF([[62,54,70,46],[60,55,66,47],[58,56,64,47],[58,57,64,47]],"1.4s") +
      LM([[62,54,70,62],[60,55,66,63],[58,56,64,63],[58,57,64,63]],"1.4s") +
      LMF([[30,54,26,66],[34,52,28,64],[38,50,30,63],[40,54,28,64]],"1.4s") +
      LM([[46,54,50,66],[48,54,52,66],[50,54,52,66],[50,57,52,66]],"1.4s") +
      close;
  }

  // ── Mountain climbers — 3D side profile ──────────────────────────────────
  if (/mountain|climber/.test(nm)) {
    return open +
      `<line x1="0" y1="50" x2="80" y2="50" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
      HEAD(10,32) +
      `<line x1="16" y1="34" x2="58" y2="34" ${stM}/>` +
      `<line x1="24" y1="34" x2="24" y2="38" ${stM}/>` +
      `<line x1="40" y1="34" x2="40" y2="38" ${stM}/>` +
      `<line x1="58" y1="34" x2="64" y2="26" ${stF}/>` +
      `<line x1="58" y1="34" x2="64" y2="42" ${st}/>` +
      `<line x1="30" y1="34" x2="30" y2="50" ${stF}/>` +
      `<line x1="46" y1="34" x2="46" y2="50" ${st}/>` +
      J(58,34) + J(30,50) + J(46,50) +
      LMF([[30,50,20,44],[30,50,28,50],[30,50,40,50],[30,50,32,46]],"0.8s") +
      LM([[46,50,56,44],[46,50,50,50],[46,50,36,44],[46,50,42,46]],"0.8s") +
      close;
  }

  // ── Burpees — 3D jump ↔ plank crossfade ─────────────────────────────────
  if (/burpee/.test(nm)) {
    return open + XF("1.8s") +
      `<g class="sfa">${HEAD(42,8)}` +
        `<line x1="41" y1="15" x2="41" y2="21" ${stM}/>` +
        `<polygon points="32,21 50,21 48,38 34,38" fill="rgba(255,255,255,.07)" stroke="none"/>` +
        `<line x1="32" y1="21" x2="50" y2="21" ${stM}/>` +
        `<line x1="34" y1="38" x2="48" y2="38" ${stM}/>` +
        `<line x1="32" y1="21" x2="34" y2="38" ${stF}/>` +
        `<line x1="50" y1="21" x2="48" y2="38" ${st}/>` +
        `<line x1="32" y1="21" x2="24" y2="14" ${stF}/>` +
        `<line x1="50" y1="21" x2="58" y2="14" ${st}/>` +
        `<line x1="34" y1="38" x2="28" y2="54" ${stF}/>` +
        `<line x1="48" y1="38" x2="54" y2="54" ${st}/>` +
      `</g>` +
      `<g class="sfb">${HEAD(10,40)}` +
        `<line x1="16" y1="42" x2="58" y2="42" ${stM}/>` +
        `<line x1="24" y1="42" x2="24" y2="46" ${stM}/>` +
        `<line x1="40" y1="42" x2="40" y2="46" ${stM}/>` +
        `<line x1="30" y1="42" x2="30" y2="58" ${stF}/>` +
        `<line x1="46" y1="42" x2="46" y2="58" ${st}/>` +
        `<line x1="58" y1="42" x2="64" y2="35" ${stF}/>` +
        `<line x1="58" y1="42" x2="64" y2="49" ${st}/>` +
      `</g>` +
      `<line x1="0" y1="58" x2="80" y2="58" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` + close;
  }

  // ── Dips — 3/4 view, 4 frames ────────────────────────────────────────────
  if (/dips?/.test(nm)) {
    const sYs=[16,20,25,30], hYs=[41,45,50,55];
    return open +
      `<line x1="14" y1="10" x2="14" y2="64" stroke="rgba(255,255,255,.18)" stroke-width="2.5" stroke-linecap="round"/>` +
      `<line x1="66" y1="10" x2="66" y2="64" stroke="rgba(255,255,255,.3)" stroke-width="2.5" stroke-linecap="round"/>` +
      `<line x1="8" y1="14" x2="20" y2="14" stroke="rgba(255,255,255,.22)" stroke-width="2"/>` +
      `<line x1="60" y1="14" x2="72" y2="14" stroke="rgba(255,255,255,.38)" stroke-width="2"/>` +
      MUSCLE(41,32,"#f59e0b") + ARRDN(41,72) +
      CM([42,42,42,42],[6,10,15,20],7,"1.3s") +
      LM([[41,9,41,16],[41,13,41,20],[41,18,41,25],[41,23,41,30]],"1.3s") +
      TORSOA(sYs, hYs, "1.3s") +
      LMF([[32,16,14,16],[32,20,14,20],[32,25,14,26],[32,30,14,30]],"1.3s") +
      LM([[50,16,66,16],[50,20,66,20],[50,25,66,26],[50,30,66,30]],"1.3s") +
      LMF([[34,41,32,58],[34,45,32,62],[34,50,32,66],[34,55,32,70]],"1.3s") +
      LM([[48,41,50,58],[48,45,50,62],[48,50,50,66],[48,55,50,70]],"1.3s") +
      J(32,16) + J(50,16) + close;
  }

  // ── Curl — 4 frames: bicep curl, 3/4 view, no dumbbell ──────
  if (/curl/.test(nm)) {
    return open + FLR +
      MUSCLE(50,28,"#818cf8") +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      // Far arm static hanging
      LF(32,21,28,38, 32,21,28,38) + LF(28,38,26,48, 28,38,26,48) +
      // Near arm: upper arm static, forearm curls up
      LM([[50,21,56,34],[50,21,56,34],[50,21,56,34],[50,21,56,34]],"1.4s") +
      LM([[56,34,60,48],[56,34,58,38],[56,34,54,26],[56,34,58,38]],"1.4s") +
      // Legs static
      L(34,46,30,68, 34,46,30,68) + L(48,46,52,68, 48,46,52,68) +
      L(30,68,26,76, 30,68,26,76) + L(52,68,56,76, 52,68,56,76) +
      J(50,21) + J(56,34) + J(34,46) + J(48,46) + close;
  }

  // ── Rowing — bent-over pull, 3/4 view, no dumbbell ─────────
  if (/rowing|tirage|row|pull.?over|oiseau/.test(nm)) {
    // Bent-over: torso ~45° forward, shoulders at (28,26)/(46,26), hips at (30,46)/(48,46)
    return open + FLR +
      MUSCLE(38,30,"#818cf8") +
      HEAD(20,20) +
      `<line x1="24" y1="24" x2="28" y2="26" ${stM}/>` +
      TORSO(28,26,46,26,30,46,48,46) +
      // Far arm pulls back: elbow (22,36) → (30,30) → (36,24)
      LMF([[28,26,20,36],[28,26,24,30],[28,26,32,22],[28,26,24,30]],"1.3s") +
      LMF([[20,36,16,46],[24,30,20,40],[32,22,34,32],[24,30,20,40]],"1.3s") +
      // Near arm pulls back
      LM([[46,26,54,36],[46,26,56,28],[46,26,58,20],[46,26,56,28]],"1.3s") +
      LM([[54,36,58,46],[56,28,60,36],[58,20,62,30],[56,28,60,36]],"1.3s") +
      // Legs bent stance
      LMF([[30,46,24,66],[30,46,24,66],[30,46,24,66],[30,46,24,66]],"1.3s") +
      LM([[48,46,54,66],[48,46,54,66],[48,46,54,66],[48,46,54,66]],"1.3s") +
      J(28,26) + J(46,26) + J(30,46) + J(48,46) + close;
  }

  // ── Deadlift — 4 frames: deep bend → mid → almost up → upright, 3/4 view
  if (/souleve|deadlift|terre|sumo|roumain/.test(nm)) {
    // Torso hinges from bent (sY=36,hY=46) to upright (sY=21,hY=46)
    const sYs=[36,30,24,21], hYs=[46,46,46,46];
    return open + FLR +
      MUSCLE(40,35,"#22c55e") +
      ARRUP(72,30) +
      CM([30,35,38,42],[36,26,18,11],7,"1.8s") +
      `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` +
      TORSOA(sYs, hYs, "1.8s") +
      // Far arm hangs down toward floor
      LMF([[32,36,28,56],[32,30,28,50],[32,24,28,44],[32,21,28,40]],"1.8s") +
      LMF([[28,56,26,70],[28,50,26,64],[28,44,26,60],[28,40,26,56]],"1.8s") +
      // Near arm hangs down toward floor
      LM([[50,36,54,56],[50,30,54,50],[50,24,54,44],[50,21,54,40]],"1.8s") +
      LM([[54,56,56,70],[54,50,56,64],[54,44,56,60],[54,40,56,56]],"1.8s") +
      // Legs (knee bend at bottom, straight at top)
      LMF([[34,46,26,62],[34,46,27,64],[34,46,28,66],[34,46,30,68]],"1.8s") +
      LM([[48,46,56,62],[48,46,55,64],[48,46,54,66],[48,46,52,68]],"1.8s") +
      J(34,46) + J(48,46) + close;
  }

  // ── Press — 4 frames: start → quarter → half → lockout, 3/4 view ───
  if (/develop|bench|militaire|overhead|press|presse|ecarté|ecarte/.test(nm)) {
    return open + FLR +
      MUSCLE(41,22,"#60a5fa") +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      ARRUP(42,6) +
      // Far arm presses overhead: shoulder(32,21) → elbow → hand
      LMF([[32,21,24,34],[32,21,22,26],[32,21,20,18],[32,21,22,10]],"1.4s") +
      LMF([[24,34,20,46],[22,26,18,36],[20,18,18,26],[22,10,20,14]],"1.4s") +
      // Near arm presses overhead
      LM([[50,21,58,34],[50,21,60,26],[50,21,62,18],[50,21,60,10]],"1.4s") +
      LM([[58,34,62,46],[60,26,64,36],[62,18,66,26],[60,10,62,14]],"1.4s") +
      // Legs static
      L(34,46,30,68, 34,46,30,68) + L(48,46,52,68, 48,46,52,68) +
      L(30,68,26,76, 30,68,26,76) + L(52,68,56,76, 52,68,56,76) +
      J(32,21) + J(50,21) + J(34,46) + J(48,46) + close;
  }

  // ── Jump squat — 3/4 view, 4 frames ─────────────────────────────────────
  if (/jump|saut/.test(nm)) {
    const sYs=[26,19,9,17], hYs=[50,42,30,40];
    return open + FLR +
      CM([42,42,42,42],[16,9,0,8],7,"1.2s") +
      LM([[41,19,41,26],[41,12,41,19],[41,3,41,9],[41,11,41,17]],"1.2s") +
      TORSOA(sYs, hYs, "1.2s") +
      LMF([[32,26,24,38],[32,19,24,28],[32,9,22,12],[32,17,24,24]],"1.2s") +
      LM([[50,26,58,38],[50,19,56,28],[50,9,58,10],[50,17,56,24]],"1.2s") +
      LMF([[34,50,28,66],[34,42,28,58],[34,30,32,44],[34,40,28,58]],"1.2s") +
      LMF([[28,66,24,76],[28,58,24,72],[32,44,30,54],[28,58,24,70]],"1.2s") +
      LM([[48,50,54,66],[48,42,54,58],[48,30,50,44],[48,40,54,58]],"1.2s") +
      LM([[54,66,58,76],[54,58,60,72],[50,44,54,54],[54,58,58,70]],"1.2s") +
      J(34,50) + J(48,50) + close;
  }

  // ── Running — 4-frame stride cycle (3D near/far limbs) ──
  if (/course|run|sprint|jog/.test(nm)) {
    return open +
      `<line x1="6" y1="68" x2="74" y2="68" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
      CM([42,42,42,42],[11,11,11,11],7,"0.7s") +
      `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      LMF([[32,21,22,32],[32,21,28,30],[32,21,38,26],[32,21,34,24]],"0.7s") +
      LM([[50,21,60,28],[50,21,56,30],[50,21,46,34],[50,21,50,32]],"0.7s") +
      LMF([[34,46,28,62],[34,46,32,62],[34,46,40,60],[34,46,36,62]],"0.7s") +
      LMF([[28,62,22,68],[32,62,26,68],[40,60,50,68],[36,62,32,68]],"0.7s") +
      LM([[48,46,54,60],[48,46,50,62],[48,46,40,64],[48,46,44,62]],"0.7s") +
      LM([[54,60,60,68],[50,62,52,68],[40,64,34,68],[44,62,46,68]],"0.7s") +
      J(34,46) + J(48,46) + close;
  }

  // ── Élévations latérales — 3/4 view ──────────────────────────────────────
  if (/elevation|raise|oiseau.invers|face.pull|shrug/.test(nm)) {
    return open + FLR + MUSCLE(41,24,"#60a5fa") +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      LMF([[32,21,24,36],[32,21,18,28],[32,21,14,22],[32,21,18,28]],"1.4s") +
      LM([[50,21,58,36],[50,21,64,28],[50,21,68,22],[50,21,64,28]],"1.4s") +
      L(34,46,30,68, 34,46,30,68) + L(48,46,52,68, 48,46,52,68) +
      L(30,68,26,76, 30,68,26,76) + L(52,68,56,76, 52,68,56,76) +
      close;
  }

  // ── Extension triceps — 3/4 view ─────────────────────────────────────────
  if (/extension.tricep|tricep.push|skull/.test(nm)) {
    return open + FLR + MUSCLE(38,26,"#f59e0b") +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      LF(32,21,26,14, 32,21,26,14) +
      LM([[26,14,20,24],[26,14,26,18],[26,14,36,12],[26,14,40,10]],"1.3s") +
      LMF([[50,21,56,14],[50,21,56,14],[50,21,58,14],[50,21,58,14]],"1.3s") +
      L(34,46,30,68, 34,46,30,68) + L(48,46,52,68, 48,46,52,68) +
      L(30,68,26,76, 30,68,26,76) + L(52,68,56,76, 52,68,56,76) + close;
  }

  // ── Jumping jacks — 3/4 view ─────────────────────────────────────────────
  if (/jumping.?jack|ecart|jumping/.test(nm)) {
    return open + FLR +
      HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
      LMF([[32,21,28,38],[32,21,14,18],[32,21,28,38],[32,21,14,18]],"0.8s") +
      LMF([[28,38,24,48],[14,18,8,26],[28,38,24,48],[14,18,8,26]],"0.8s") +
      LM([[50,21,54,38],[50,21,68,18],[50,21,54,38],[50,21,68,18]],"0.8s") +
      LM([[54,38,58,48],[68,18,74,26],[54,38,58,48],[68,18,74,26]],"0.8s") +
      LMF([[34,46,28,68],[34,46,16,62],[34,46,28,68],[34,46,16,62]],"0.8s") +
      LM([[48,46,54,68],[48,46,66,62],[48,46,54,68],[48,46,66,62]],"0.8s") +
      J(32,21) + J(50,21) + J(34,46) + J(48,46) + close;
  }

  // ── Gainage latéral — side plank hold with hip pulse ──────
  if (/gainage.lat|side.?plank|lateral/.test(nm)) {
    const slKS = 'calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1" repeatCount="indefinite"';
    const hipY = `<animate attributeName="cy" values="42;38;42" dur="2.2s" ${slKS}/>`;
    const hipYl = `<animate attributeName="y1" values="42;38;42" dur="2.2s" ${slKS}/>`;
    const hipYl2 = `<animate attributeName="y2" values="42;38;42" dur="2.2s" ${slKS}/>`;
    return open +
      `<line x1="4" y1="62" x2="76" y2="62" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
      MUSCLE(50,38,"#f97316") +
      // Head
      `<circle cx="10" cy="36" r="6" fill="url(#hg)" stroke="rgba(255,255,255,.65)" stroke-width="1.1"/>` +
      `<circle cx="8.2" cy="34.3" r="1.1" fill="rgba(255,255,255,.42)"/>` +
      // Neck + torso (horizontal)
      `<line x1="16" y1="38" x2="68" y2="38" ${st}>` +
      `<animate attributeName="y1" values="38;34;38" dur="2.2s" ${slKS}/>` +
      `<animate attributeName="y2" values="38;34;38" dur="2.2s" ${slKS}/></line>` +
      // Top arm straight up (near)
      `<line x1="38" y1="38" x2="38" y2="22" ${st}>` +
      `<animate attributeName="y1" values="38;34;38" dur="2.2s" ${slKS}/></line>` +
      // Bottom arm (far, supporting)
      `<line x1="16" y1="38" x2="16" y2="62" ${stF}>` +
      `<animate attributeName="y1" values="38;34;38" dur="2.2s" ${slKS}/></line>` +
      // Hip pulse circle
      `<circle cx="68" cy="42" r="3" fill="rgba(200,215,255,.55)" stroke="rgba(255,255,255,.22)" stroke-width=".7">${hipY}</circle>` +
      // Legs
      `<line x1="68" y1="42" x2="68" y2="62" ${stF}>${hipYl}</line>` +
      `<line x1="68" y1="42" x2="76" y2="62" ${st}>${hipYl}</line>` +
      ARRUP(72,14) +
      close;
  }

  // ── Étirement / Stretch — slow arm reach + torso tilt, 3/4 view ─────
  if (/etir|stretch|mobilit|yoga|souplesse/.test(nm)) {
    const sYs=[21,21,21,21], hYs=[46,46,46,46];
    return open + FLR +
      CM([42,42,42,42],[10,10,10,8],7,"2.4s") +
      `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` +
      TORSOA(sYs, hYs, "2.4s") +
      // Far arm: reaches across and down
      LMF([[32,21,22,32],[32,21,20,28],[32,21,18,26],[32,21,22,32]],"2.4s") +
      // Near arm: sweeps up overhead
      LM([[50,21,58,30],[50,21,62,20],[50,21,66,12],[50,21,58,30]],"2.4s") +
      // Far leg: slight step back
      LMF([[34,46,28,68],[34,46,26,68],[34,46,24,68],[34,46,28,68]],"2.4s") +
      // Near leg: static
      LM([[48,46,54,68],[48,46,54,68],[48,46,54,68],[48,46,54,68]],"2.4s") +
      J(32,21) + J(50,21) + J(34,46) + J(48,46) + close;
  }

  // ── Generic — 4-frame arm swing, 3/4 view ───────────────────────────
  return open + FLR +
    HEAD(42,11) + `<line x1="41" y1="18" x2="41" y2="21" ${stM}/>` + TORSO() +
    LMF([[32,21,22,30],[32,21,26,34],[32,21,38,32],[32,21,28,36]],"1.5s") +
    LM([[50,21,60,30],[50,21,56,34],[50,21,44,32],[50,21,54,36]],"1.5s") +
    L(34,46,30,68, 34,46,30,68) + L(48,46,52,68, 48,46,52,68) +
    L(30,68,26,76, 30,68,26,76) + L(52,68,56,76, 52,68,56,76) +
    J(32,21) + J(50,21) + J(34,46) + J(48,46) +
    close;
}

// ── Drinking stick figure (shown during rest periods) ─────────────────────────
function _stickFigureDrinking() {
  const st = 'stroke="rgba(255,255,255,.88)" stroke-width="2.2" stroke-linecap="round" fill="none"';
  // 5-keyframe timeline: idle → raise → drink → lower → idle  (dur=2.8s)
  const KT = 'keyTimes="0;0.12;0.42;0.72;0.88;1"';
  const KSP = 'calcMode="spline" keySplines="0.4 0 0.6 1; 0.4 0 0.6 1; 0.2 0.8 0.3 1; 0.4 0 0.6 1; 0.4 0 0.6 1"';
  const dur = 'dur="2.8s" repeatCount="indefinite"';
  const a = (attr, vals) => `<animate attributeName="${attr}" values="${vals}" ${KT} ${KSP} ${dur}/>`;

  // Bottle follows right arm tip: idle(58,44) → raise(48,20) → drink(46,16) → lower back
  const bottleX = a("x", "54;54;42;40;54;54");
  const bottleY = a("y", "40;40;14;10;40;40");

  // Water drops appear only during drink phase (keyTimes 0.42-0.72)
  const dropA = (cx, cy, delay) => `<circle cx="${cx}" fill="rgba(64,196,255,.9)" r="2">
    <animate attributeName="cy" values="${cy};${cy};${cy};${cy+12};${cy+18};${cy+20}" ${KT} ${KSP} ${dur}/>
    <animate attributeName="opacity" values="0;0;0;1;0.4;0" ${KT} ${KSP} ${dur}/>
    <animate attributeName="r" values="2;2;2;1.8;1.2;0" ${KT} ${KSP} ${dur}/>
  </circle>`;

  return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;overflow:visible">
    <!-- Standing figure -->
    <circle cx="40" r="7" ${st}>${a("cy","10;10;14;14;10;10")}</circle>
    <line x1="40" y1="17" x2="40" y2="44" ${st}/>
    <!-- Left arm static -->
    <line x1="40" y1="28" x2="22" y2="44" ${st}/>
    <!-- Right arm raises bottle to mouth -->
    <line x1="40" y1="28" ${st}>
      ${a("x2","58;58;48;46;58;58")}${a("y2","44;44;22;18;44;44")}
    </line>
    <!-- Legs -->
    <line x1="40" y1="44" x2="32" y2="68" ${st}/>
    <line x1="40" y1="44" x2="48" y2="68" ${st}/>
    <line x1="32" y1="68" x2="28" y2="76" ${st}/>
    <line x1="48" y1="68" x2="52" y2="76" ${st}/>
    <!-- Water bottle/glass following arm -->
    <rect width="8" height="11" rx="2" stroke="rgba(64,196,255,.7)" stroke-width="1.5" fill="rgba(64,196,255,.18)">${bottleX}${bottleY}</rect>
    <!-- Water drops (only during drinking phase) -->
    ${dropA(46,18,0)} ${dropA(44,20,0)} ${dropA(48,19,0)}
    <!-- Floor -->
    <line x1="4" y1="76" x2="76" y2="76" stroke="rgba(255,255,255,.12)" stroke-width="1"/>
  </svg>`;
}

// ── Exercise technique tips ───────────────────────────────────────────────────
const EXERCISE_TIPS = {
  "développé couché":    "Pieds à plat. Omoplate serrées. Descends à 3s, explose à la montée.",
  "développé militaire": "Gainage solide. Pousse vers le haut et légèrement en arrière. Coudes ni trop écartés ni trop fermés.",
  "développé incliné":  "Banc à 30-45°. Focus sur le haut des pecs. Contrôle la descente.",
  "pompes":             "Corps gainé comme une planche. Mains sous les épaules. Coudes à 45°.",
  "pike push":          "Hanches hautes. Tête entre les bras à la descente. Force épaules.",
  "dips":               "Coudes arrière. Penche légèrement le buste pour cibler les pecs.",
  "élévations lat":     "Légère flexion des coudes. Lève jusqu'à l'horizontal. Pas d'élan.",
  "tractions":          "Prise pronation. Initie avec les dorsaux. Montée explosive, descente contrôlée.",
  "tirage poitrine":    "Dos légèrement arqué. Amène la barre vers le haut de la poitrine.",
  "rowing barre":       "Dos parallèle au sol. Tire vers le nombril. Coudes proches du corps.",
  "rowing haltère":     "Appui sur un banc. Tire le coude vers le plafond. Rotation épaule.",
  "curl haltères":      "Coudes fixes. Tourne le poignet en montant (supination). Descente lente.",
  "extension triceps":  "Coudes immobiles. Étend les bras complètement. Contraction en bas.",
  "squat barre":        "Pieds largeur épaules. Genoux dans l'axe des pieds. Descend sous la parallèle.",
  "squat poids":        "Même chose. Bras devant pour l'équilibre. Descends lentement (3s).",
  "soulevé de terre":   "Dos neutre. Pousse le sol avec les pieds. Barre proche du corps.",
  "fentes":             "Genou avant à 90°. Genou arrière effleure le sol. Buste droit.",
  "hip thrust":         "Appui sur un banc. Pousse avec les talons. Contraction fessiers en haut.",
  "planche":            "Corps droit. Fesses ni trop hautes ni trop basses. Contracte le ventre.",
  "crunch":             "Mains sur les tempes. Exhale en montant. Dos bas au sol. Lent et contrôlé.",
  "burpees":            "Saute-pompe-saut. Rythme régulier. Explose à chaque saut.",
  "mountain climbers":  "Planche stable. Genoux alternatifs vers la poitrine. Rythme soutenu.",
  "jump squats":        "Atterris en souplesse (avant-pied d'abord). Amortis la réception.",
  "course":             "Zone 2 : tu peux parler. FC 60-70% max. Respiration nasale si possible.",
  "vélo":               "Selle à hauteur de hanche. Cadence 80-90 RPM. Dos droit, léger.",
  "pigeon yoga":        "Hanche avant fléchie à 90°. Descends progressivement. Respiration profonde.",
  "cat-cow":            "En quadrupédie. Expire en arrondissant (cat). Inspire en creusant (cow).",
};

function _getExerciseTip(exName) {
  if (!exName) return "";
  const key = exName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [k, tip] of Object.entries(EXERCISE_TIPS)) {
    if (key.includes(k)) return tip;
  }
  return "";
}

function _wtRenderExercise() {
  const ex = _wtExercises[_wtExIdx];
  if (!ex) { closeWorkoutTimer(); return; }

  const params = PROG_PHASE_PARAMS[(_progWeek || 1) - 1] || PROG_PHASE_PARAMS[0];
  _wtSetsTotal = ex.sets || params.sets || 3;

  const total = _wtExercises.length;
  const pct = Math.round((_wtExIdx / total) * 100);

  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setEl("wt-ex-num", `Exercice ${_wtExIdx + 1} / ${total}`);
  setEl("wt-ex-name", ex.n || "—");
  setEl("wt-ex-muscle", ex.m || "");
  const detail = ex.r || `${params.sets}×${params.reps}${params.rest ? " · " + params.rest + "s repos" : ""}`;
  setEl("wt-ex-detail", detail);

  // Premium visual: animated figure + target map
  const imgWrap = document.getElementById("wt-ex-img-wrap");
  if (imgWrap) imgWrap.innerHTML = `<div class="wt-visual-main">${_stickFigureSVG(ex.n || "")}</div><div class="wt-visual-muscle">${_muscleSVG(ex.m || ex.n || "")}</div>`;

  // Technique guide
  const tipEl = document.getElementById("wt-ex-tip");
  const tip = _getExerciseTip(ex.n || "");
  const cue = exerciseCuePack({ name: ex.n || "", muscle: ex.m || "" });
  if (tipEl) {
    tipEl.innerHTML = `<div class="wt-tip-grid"><div><span>Départ</span><p>${escapeHtml(cue.start)}</p></div><div><span>Mouvement</span><p>${escapeHtml(cue.move)}</p></div><div><span>À sentir</span><p>${escapeHtml(cue.focus)}</p></div><div><span>Repère</span><p>${escapeHtml(tip || cue.breathe)}</p></div></div>`;
    tipEl.style.display = "";
  }

  const fillEl = document.getElementById("wt-progress-fill");
  if (fillEl) fillEl.style.width = pct + "%";

  // Set bubbles
  const row = document.getElementById("wt-sets-row");
  if (row) {
    row.innerHTML = Array.from({ length: _wtSetsTotal }, (_, i) => {
      const cls = i < _wtSetsDone ? "done" : i === _wtSetsDone ? "current" : "";
      return `<div class="wt-set-bubble ${cls}" onclick="wtClickSet(${i})">${i + 1}</div>`;
    }).join("");
  }

  // Prev/next buttons
  const prevBtn = document.getElementById("wt-prev-btn");
  const nextBtn = document.getElementById("wt-next-btn");
  if (prevBtn) prevBtn.disabled = _wtExIdx === 0;
  if (nextBtn) nextBtn.disabled = _wtExIdx >= total - 1;

  // Hide rest area
  const restArea = document.getElementById("wt-rest-area");
  if (restArea) restArea.style.display = "none";
  const setBtn = document.getElementById("wt-set-btn");
  if (setBtn) { setBtn.style.display = ""; setBtn.disabled = false; }
}

function wtDoneSet() {
  _wtSetsDone++;
  const params = PROG_PHASE_PARAMS[(_progWeek || 1) - 1] || PROG_PHASE_PARAMS[0];
  const restSec = params.rest || 90;

  // Update bubbles
  const row = document.getElementById("wt-sets-row");
  if (row) {
    row.innerHTML = Array.from({ length: _wtSetsTotal }, (_, i) => {
      const cls = i < _wtSetsDone ? "done" : i === _wtSetsDone ? "current" : "";
      return `<div class="wt-set-bubble ${cls}" onclick="wtClickSet(${i})">${i + 1}</div>`;
    }).join("");
  }

  if (_wtSetsDone >= _wtSetsTotal) {
    // All sets done for this exercise — auto-advance after rest
    _startRestTimer(restSec, () => {
      _wtSetsDone = 0;
      _wtExIdx = Math.min(_wtExIdx + 1, _wtExercises.length - 1);
      if (_wtExIdx >= _wtExercises.length - 1 && _wtSetsDone >= _wtSetsTotal) {
        closeWorkoutTimer();
        toast("🎉 Séance terminée ! Bravo !", "ok");
        return;
      }
      _wtRenderExercise();
    });
  } else {
    // Start rest timer between sets
    _startRestTimer(restSec, () => {
      _wtRenderExercise();
    });
  }
}

function wtClickSet(idx) {
  // Allow clicking a bubble to mark sets done up to that index
  if (idx >= _wtSetsDone) { _wtSetsDone = idx + 1; _wtRenderExercise(); }
}

function _startRestTimer(seconds, onDone) {
  _wtRestLeft = seconds;
  if (_wtRestTimer) clearInterval(_wtRestTimer);

  const restArea  = document.getElementById("wt-rest-area");
  const countdown = document.getElementById("wt-rest-countdown");
  const restMsg   = document.getElementById("wt-rest-msg");
  const setBtn    = document.getElementById("wt-set-btn");
  const imgWrap   = document.getElementById("wt-ex-img-wrap");

  if (restArea) restArea.style.display = "block";
  if (setBtn) setBtn.style.display = "none";

  // Show drinking figure in the small imgWrap (supplementary)
  if (imgWrap) imgWrap.innerHTML = _stickFigureDrinking();

  // Rotating hydration messages
  const msgs = ["💧 Hydrate-toi !", "😮‍💨 Récupère…", "💧 Bois de l'eau", "🌬️ Respire bien", "💪 Tu assures !"];
  if (restMsg) restMsg.textContent = msgs[Math.floor(Math.random() * msgs.length)];

  // Animate "Inspire / Expire" label in sync with the 4s breathing ring
  const breathLabel = document.getElementById("wt-breath-label");
  let _breathPhase = false;
  if (breathLabel) {
    breathLabel.textContent = "Expire…";
    if (window._breathLabelTimer) clearInterval(window._breathLabelTimer);
    window._breathLabelTimer = setInterval(() => {
      _breathPhase = !_breathPhase;
      if (breathLabel) breathLabel.textContent = _breathPhase ? "Inspire…" : "Expire…";
    }, 2000);
  }

  const updateCountdown = (t) => {
    if (!countdown) return;
    countdown.textContent = t;
    countdown.style.color = t <= 5 ? "#f87171" : t <= 10 ? "#fb923c" : "#38bdf8";
  };
  updateCountdown(seconds);

  _wtRestTimer = setInterval(() => {
    _wtRestLeft--;
    updateCountdown(_wtRestLeft);
    if (_wtRestLeft <= 0) {
      clearInterval(_wtRestTimer);
      _wtRestTimer = null;
      if (window._breathLabelTimer) { clearInterval(window._breathLabelTimer); window._breathLabelTimer = null; }
      if (restArea) restArea.style.display = "none";
      if (setBtn) setBtn.style.display = "";
      if (countdown) countdown.style.color = "";
      if (onDone) onDone();
    }
  }, 1000);
}

function skipRestTimer() {
  if (_wtRestTimer) { clearInterval(_wtRestTimer); _wtRestTimer = null; }
  if (window._breathLabelTimer) { clearInterval(window._breathLabelTimer); window._breathLabelTimer = null; }
  const restArea = document.getElementById("wt-rest-area");
  const setBtn = document.getElementById("wt-set-btn");
  if (restArea) restArea.style.display = "none";
  if (setBtn) setBtn.style.display = "";
  // If all sets done, advance to next exercise
  if (_wtSetsDone >= _wtSetsTotal) {
    _wtSetsDone = 0;
    _wtExIdx = Math.min(_wtExIdx + 1, _wtExercises.length);
    if (_wtExIdx >= _wtExercises.length) { closeWorkoutTimer(); toast("🎉 Séance terminée !", "ok"); return; }
  }
  _wtRenderExercise();
}

function prevWtExercise() {
  if (_wtRestTimer) { clearInterval(_wtRestTimer); _wtRestTimer = null; }
  _wtSetsDone = 0;
  _wtExIdx = Math.max(0, _wtExIdx - 1);
  _wtRenderExercise();
}

function nextWtExercise() {
  if (_wtRestTimer) { clearInterval(_wtRestTimer); _wtRestTimer = null; }
  _wtSetsDone = 0;
  _wtExIdx = Math.min(_wtExercises.length - 1, _wtExIdx + 1);
  _wtRenderExercise();
}

function closeWorkoutTimer() {
  if (_wtRestTimer) { clearInterval(_wtRestTimer); _wtRestTimer = null; }
  const overlay = document.getElementById("wt-overlay");
  if (overlay) overlay.classList.remove("open");
}

function wtOverlayClick(e) {
  if (e.target === document.getElementById("wt-overlay")) closeWorkoutTimer();
}

window.startWorkout = startWorkout;
window.wtDoneSet = wtDoneSet;
window.wtClickSet = wtClickSet;
window.skipRestTimer = skipRestTimer;
window.prevWtExercise = prevWtExercise;
window.nextWtExercise = nextWtExercise;
window.closeWorkoutTimer = closeWorkoutTimer;
window.wtOverlayClick = wtOverlayClick;

// ══════════════════════════════════════════════════════════════════════════════

const PROG_PHASES = [
  { w:1, name:"Adaptation",    short:"S1", color:"#6366f1", volume:35, intensity:40, rpe:"5-6",  desc:"Volume léger, 12-15 reps. Apprentissage des mouvements, focus technique. RPE 5-6." },
  { w:2, name:"Hypertrophie",  short:"S2", color:"#2563eb", volume:55, intensity:62, rpe:"6-7",  desc:"Volume modéré, 10-12 reps. Surcharge progressive légère, +1 rep ou +2% vs S1. RPE 6-7." },
  { w:3, name:"Hypertrophie+", short:"S3", color:"#1d4ed8", volume:78, intensity:72, rpe:"7-8",  desc:"Volume élevé, pic du cycle. +1 set ou +5% poids vs S2. Fatigue musculaire élevée. RPE 7-8." },
  { w:4, name:"Deload",        short:"S4", color:"#10b981", volume:28, intensity:38, rpe:"5",    desc:"Décharge obligatoire: volume -40%, maintien de la technique, récupération active. RPE 5." },
  { w:5, name:"Force",         short:"S5", color:"#f97316", volume:62, intensity:78, rpe:"7-8",  desc:"Force: charges lourdes, 5-7 reps, repos 2-3 min. Composés prioritaires. RPE 7-8." },
  { w:6, name:"Force+",        short:"S6", color:"#ea580c", volume:65, intensity:88, rpe:"8-9",  desc:"Force max: +3-5% charge vs S5, 4-6 reps. Même structure, progression stricte. RPE 8-9." },
  { w:7, name:"Puissance",     short:"S7", color:"#ef4444", volume:48, intensity:92, rpe:"9",    desc:"Intensité max, 3-5 reps sur composés. Travail explosif. Peu d'accessoires. RPE 9." },
  { w:8, name:"Test Final",    short:"S8", color:"#8b5cf6", volume:32, intensity:96, rpe:"10",   desc:"Test de force: tente ton max sur les composés principaux. Bilan et récupération du cycle." }
];

const PROG_PHASE_PARAMS = [
  { sets:3, reps:"12-15", rest:60  },
  { sets:4, reps:"10-12", rest:90  },
  { sets:5, reps:"8-10",  rest:90  },
  { sets:2, reps:"12-15", rest:60  },
  { sets:4, reps:"5-7",   rest:180 },
  { sets:4, reps:"4-6",   rest:180 },
  { sets:4, reps:"3-5",   rest:240 },
  { sets:3, reps:"1-3",   rest:300 }
];

// Each type has TWO pools (A/B) of exercises — A for first occurrence in week, B for second.
// _renderProgDays picks A or B based on how many times the type has appeared in the week so far.
const PROG_EXERCISES = {
  push: [
    // Pool A (pecs focus)
    { n:"Développé couché barre",      m:"Pecs",       pool:"A" },
    { n:"Développé incliné haltères",  m:"Pecs haut",  pool:"A" },
    { n:"Écarté haltères couché",      m:"Pecs",       pool:"A" },
    { n:"Développé militaire barre",   m:"Épaules",    pool:"A" },
    { n:"Élévations latérales",        m:"Deltoïdes",  pool:"A" },
    { n:"Extension triceps poulie",    m:"Triceps",    pool:"A" },
    { n:"Dips lestés",                 m:"Triceps",    pool:"A" },
    // Pool B (épaules / triceps focus)
    { n:"Développé militaire haltères",m:"Épaules",    pool:"B" },
    { n:"Développé incliné barre",     m:"Pecs haut",  pool:"B" },
    { n:"Oiseau inversé haltères",     m:"Épaules arrière", pool:"B" },
    { n:"Élévations frontales",        m:"Deltoïdes",  pool:"B" },
    { n:"Extension triceps 1 bras",    m:"Triceps",    pool:"B" },
    { n:"Pompes lestées",              m:"Pecs/Triceps",pool:"B" },
    { n:"Cable crossover pec deck",    m:"Pecs",       pool:"B" },
  ],
  push_home: [
    { n:"Pompes mains larges",         m:"Pecs",       pool:"A" },
    { n:"Pompes inclinées (pieds hauts)", m:"Pecs haut",pool:"A" },
    { n:"Pike push-ups",               m:"Épaules",    pool:"A" },
    { n:"Dips sur chaise",             m:"Triceps",    pool:"A" },
    { n:"Pompes diamant",              m:"Triceps",    pool:"A" },
    { n:"Pompes archer",               m:"Pecs",       pool:"A" },
    { n:"Élévations lat haltères",     m:"Deltoïdes",  pool:"A" },
    { n:"Pompes décoés (asymétrique)", m:"Pecs/Épaules",pool:"B" },
    { n:"Pike push-up explosif",       m:"Épaules",    pool:"B" },
    { n:"Pompes pieds surélevés",      m:"Pecs haut",  pool:"B" },
    { n:"Dips entre 2 chaises",        m:"Triceps",    pool:"B" },
    { n:"Shoulder tap pompe",          m:"Core/Épaules",pool:"B" },
    { n:"Pompes lentes (4-0-4)",       m:"Pecs",       pool:"B" },
  ],
  pull: [
    { n:"Tractions prise large",       m:"Grand dorsal",pool:"A" },
    { n:"Rowing barre penché",         m:"Dos",        pool:"A" },
    { n:"Tirage poulie haute",         m:"Grand dorsal",pool:"A" },
    { n:"Curl barre EZ",               m:"Biceps",     pool:"A" },
    { n:"Face pull câble",             m:"Épaules arrière",pool:"A" },
    { n:"Rowing machine assise",       m:"Dos moyen",  pool:"A" },
    { n:"Shrugs barre",                m:"Trapèzes",   pool:"A" },
    { n:"Tractions prise serrée",      m:"Dos/Biceps", pool:"B" },
    { n:"Rowing haltère 1 bras",       m:"Grand dorsal",pool:"B" },
    { n:"Tirage poitrine câble",       m:"Dos",        pool:"B" },
    { n:"Curl haltères alterné",       m:"Biceps",     pool:"B" },
    { n:"Oiseau haltères penché",      m:"Épaules arrière",pool:"B" },
    { n:"Pull-over haltère",           m:"Grand dorsal",pool:"B" },
    { n:"Curl marteau",                m:"Biceps brachial",pool:"B" },
  ],
  pull_home: [
    { n:"Rowing haltères 1 bras",      m:"Dos",        pool:"A" },
    { n:"Rowing élastique debout",     m:"Dos",        pool:"A" },
    { n:"Curl haltères alterné",       m:"Biceps",     pool:"A" },
    { n:"Oiseau haltères",             m:"Épaules arrière",pool:"A" },
    { n:"Superman dos au sol",         m:"Bas du dos", pool:"A" },
    { n:"Rowing haltères bilatéral",   m:"Dos",        pool:"A" },
    { n:"Tractions porte (TRX maison)",m:"Grand dorsal",pool:"A" },
    { n:"Rowing élastique assis",      m:"Dos moyen",  pool:"B" },
    { n:"Curl marteau haltères",       m:"Biceps",     pool:"B" },
    { n:"Good morning haltères",       m:"Bas du dos/Ischios",pool:"B" },
    { n:"Élastique face pull",         m:"Épaules arrière",pool:"B" },
    { n:"Deadbug",                     m:"Core/Dos",   pool:"B" },
  ],
  legs: [
    { n:"Squat barre",                 m:"Quadriceps", pool:"A" },
    { n:"Soulevé de terre roumain",    m:"Ischios/Fessiers",pool:"A" },
    { n:"Presse à cuisses",            m:"Quadriceps", pool:"A" },
    { n:"Fentes marchées haltères",    m:"Fessiers",   pool:"A" },
    { n:"Leg curl couché",             m:"Ischios",    pool:"A" },
    { n:"Extensions mollets presse",   m:"Mollets",    pool:"A" },
    { n:"Hip thrust barre",            m:"Fessiers",   pool:"A" },
    { n:"Front squat barre",           m:"Quadriceps", pool:"B" },
    { n:"Soulevé de terre sumo",       m:"Fessiers/Dos",pool:"B" },
    { n:"Hack squat machine",          m:"Quadriceps", pool:"B" },
    { n:"Fentes bulgares haltères",    m:"Quadriceps/Fessiers",pool:"B" },
    { n:"Leg extension machine",       m:"Quadriceps", pool:"B" },
    { n:"Relevés de mollets debout",   m:"Mollets",    pool:"B" },
    { n:"Abducteur machine",           m:"Fessiers/Abducteurs",pool:"B" },
  ],
  legs_home: [
    { n:"Squat poids de corps",        m:"Quadriceps", pool:"A" },
    { n:"Pont fessier unilatéral",     m:"Fessiers",   pool:"A" },
    { n:"Fentes avant haltères",       m:"Quadriceps/Fessiers",pool:"A" },
    { n:"Step-ups dynamiques",         m:"Fessiers",   pool:"A" },
    { n:"Relevés de mollets",          m:"Mollets",    pool:"A" },
    { n:"Nordic curl (serviette)",      m:"Ischios",    pool:"A" },
    { n:"Squat sauté",                 m:"Jambes/Cardio",pool:"A" },
    { n:"Squat bulgare chaise",        m:"Quadriceps/Fessiers",pool:"B" },
    { n:"Hip thrust au sol",           m:"Fessiers",   pool:"B" },
    { n:"Fentes latérales",            m:"Adducteurs/Fessiers",pool:"B" },
    { n:"Wall sit (isométrique)",      m:"Quadriceps", pool:"B" },
    { n:"Pont fessier marchant",       m:"Fessiers",   pool:"B" },
    { n:"Single leg deadlift",         m:"Ischios/Fessiers",pool:"B" },
  ],
  fullbody: [
    { n:"Squat haltères",              m:"Jambes" },
    { n:"Pompes",                      m:"Pecs/Triceps" },
    { n:"Rowing haltères",             m:"Dos/Biceps" },
    { n:"Fentes avant haltères",       m:"Jambes/Fessiers" },
    { n:"Planche",                     m:"Core", r:"30-45s" },
    { n:"Développé militaire haltères",m:"Épaules" },
    { n:"Soulevé de terre haltères",   m:"Dos/Jambes" },
    { n:"Curl haltères",               m:"Biceps" },
    { n:"Dips sur chaise",             m:"Triceps" },
  ],
  hiit: [
    { n:"Burpees",                     m:"Full body",   r:"20s ×8 (Tabata)" },
    { n:"Mountain climbers",           m:"Core/Cardio", r:"30s effort / 10s récup" },
    { n:"Jump squats",                 m:"Jambes",      r:"30s / 15s repos" },
    { n:"Planche dynamique",           m:"Core",        r:"40s / 20s repos" },
    { n:"Montées de genoux",           m:"Cardio",      r:"30s sprint" },
    { n:"Corde à sauter (simulation)", m:"Cardio",      r:"1 min" },
    { n:"Sprint en place",             m:"Cardio",      r:"20s max / 10s" },
    { n:"Box jumps (squat sauté)",     m:"Jambes/Cardio",r:"8 reps explosif" },
    { n:"Pompes explosives",           m:"Pecs/Cardio", r:"15s max" },
  ],
  cardio: [
    { n:"Course / marche rapide",      m:"Cardio",      r:"35 min zone 2 (FC 130-150)" },
    { n:"Vélo / elliptique",           m:"Cardio",      r:"30 min cadence stable" },
    { n:"Natation",                    m:"Cardio",      r:"20-30 min" },
    { n:"Rameur",                      m:"Cardio/Dos",  r:"20 min intervalles" },
    { n:"Marche nordique",             m:"Cardio",      r:"45 min" },
  ],
  core: [
    { n:"Planche avant",               m:"Core",        r:"3× 30-60s" },
    { n:"Crunchs bicycle",             m:"Obliques",    r:"3× 20 reps" },
    { n:"Hollow body hold",            m:"Core",        r:"3× 30s" },
    { n:"Bird dog",                    m:"Core/Stabilisateurs", r:"3× 10/côté" },
    { n:"Gainage latéral",             m:"Obliques",    r:"3× 30s/côté" },
    { n:"Russian twist haltère",       m:"Obliques",    r:"3× 15/côté" },
    { n:"Dead bug",                    m:"Core",        r:"3× 10/côté" },
    { n:"Ab wheel rollout",            m:"Core",        r:"3× 8-12 reps" },
  ],
  mobilite: [
    { n:"Pigeon yoga (hanche)",        m:"Hanches",     r:"90s/côté" },
    { n:"Étirement quadriceps debout", m:"Quadriceps",  r:"60s/côté" },
    { n:"Cat-cow rachis",              m:"Dos",         r:"10 cycles lents" },
    { n:"Foam roller thoracique",      m:"Haut du dos", r:"2 min" },
    { n:"Hip flexors — fente basse",   m:"Hanches/Psoas",r:"90s/côté" },
    { n:"Étirement pectoraux porte",   m:"Pecs/Épaules",r:"60s" },
    { n:"Thread the needle rotation",  m:"Dos/Épaules", r:"8/côté" },
    { n:"Squat profond 90-90",         m:"Hanches/Mollets",r:"2 min" },
  ],
  rest: []
};

const PROG_WEEKLY = {
  prise_de_masse: [
    { d:1, label:"Push — Pecs / Épaules / Triceps", type:"push",     icon:"🏋️" },
    { d:2, label:"Pull — Dos / Biceps",              type:"pull",     icon:"💪" },
    { d:3, label:"Jambes + Fessiers",                type:"legs",     icon:"🦵" },
    { d:4, label:"Repos actif / Mobilité",           type:"mobilite", icon:"🧘" },
    { d:5, label:"Push — Épaules / Triceps focus",  type:"push",     icon:"🏋️" },
    { d:6, label:"Pull — Dos accessoires",           type:"pull",     icon:"💪" },
    { d:7, label:"Repos complet",                    type:"rest",     icon:"😴" }
  ],
  perte_de_poids: [
    { d:1, label:"HIIT Full Body",                   type:"hiit",     icon:"⚡" },
    { d:2, label:"Cardio LISS",                      type:"cardio",   icon:"🏃" },
    { d:3, label:"Full Body Circuit",                type:"fullbody", icon:"🔥" },
    { d:4, label:"Repos actif / Marche",             type:"mobilite", icon:"🧘" },
    { d:5, label:"HIIT Tabata",                      type:"hiit",     icon:"⚡" },
    { d:6, label:"Cardio + Core",                    type:"core",     icon:"🏊" },
    { d:7, label:"Repos complet",                    type:"rest",     icon:"😴" }
  ],
  remise_en_forme: [
    { d:1, label:"Full Body A",                      type:"fullbody", icon:"🏋️" },
    { d:2, label:"Cardio modéré",                    type:"cardio",   icon:"🏃" },
    { d:3, label:"Full Body B",                      type:"fullbody", icon:"🏋️" },
    { d:4, label:"Repos",                            type:"rest",     icon:"😴" },
    { d:5, label:"Full Body A (variante)",           type:"fullbody", icon:"🏋️" },
    { d:6, label:"Mobilité + Étirements",            type:"mobilite", icon:"🧘" },
    { d:7, label:"Repos complet",                    type:"rest",     icon:"😴" }
  ],
  force: [
    { d:1, label:"Squat + Accessoires jambes",       type:"legs",     icon:"🏋️" },
    { d:2, label:"Repos",                            type:"rest",     icon:"😴" },
    { d:3, label:"Développé couché + Push",         type:"push",     icon:"💪" },
    { d:4, label:"Repos",                            type:"rest",     icon:"😴" },
    { d:5, label:"Soulevé de terre + Pull",          type:"pull",     icon:"🏋️" },
    { d:6, label:"Accessoires + Core",               type:"core",     icon:"🔥" },
    { d:7, label:"Repos complet",                    type:"rest",     icon:"😴" }
  ],
  endurance: [
    { d:1, label:"Course — endurance",               type:"cardio",   icon:"🏃" },
    { d:2, label:"Full Body léger",                  type:"fullbody", icon:"💪" },
    { d:3, label:"Intervalles HIIT",                 type:"hiit",     icon:"⚡" },
    { d:4, label:"Repos actif",                      type:"mobilite", icon:"🧘" },
    { d:5, label:"Course longue",                    type:"cardio",   icon:"🏃" },
    { d:6, label:"Force fonctionnelle",              type:"fullbody", icon:"🏋️" },
    { d:7, label:"Repos complet",                    type:"rest",     icon:"😴" }
  ]
};

function _progExType(type, equipment) {
  const eq = String(equipment || "").toLowerCase();
  const gym = eq.includes("salle") || eq.includes("gym") || eq.includes("barre") || eq.includes("complet");
  if (!gym) {
    if (type === "push") return "push_home";
    if (type === "pull") return "pull_home";
    if (type === "legs") return "legs_home";
  }
  return type;
}

function _progGetWeekly(goal) {
  return PROG_WEEKLY[String(goal || "").toLowerCase()] || PROG_WEEKLY.remise_en_forme;
}

// Build / reload program from profile (offline)
function buildOfflineProgram() {
  let goal = "remise_en_forme", level = "beginner", equipment = "", name = "";
  try {
    const gc = localStorage.getItem("fitai_goal_ctx");
    if (gc) { const o = JSON.parse(gc); goal = o.type || o.goal || goal; level = o.level || level; equipment = o.equipment || o.text || equipment; }
    const pp = localStorage.getItem("fitai_profile");
    if (pp) { const o = JSON.parse(pp); name = o.display_name || ""; }
  } catch {}
  return { goal, level, equipment, name, generatedAt: Date.now() };
}

let _progWeek = 1;
let _prog = null;

function loadProgramme() {
  try { const c = localStorage.getItem("fitai_prog_v2"); if (c) _prog = JSON.parse(c); } catch {}
  if (!_prog) { _prog = buildOfflineProgram(); _saveProg(); }
  try { _progWeek = Math.min(8, Math.max(1, parseInt(localStorage.getItem("fitai_prog_week")) || 1)); } catch {}
  renderProgramme(_progWeek);
  syncProgWater();
}

function _saveProg() {
  try { localStorage.setItem("fitai_prog_v2", JSON.stringify(_prog)); localStorage.setItem("fitai_prog_week", String(_progWeek)); } catch {}
}

function progPrevWeek() { if (_progWeek > 1) { _progWeek--; _saveProg(); renderProgramme(_progWeek); } }
function progNextWeek() { if (_progWeek < 8) { _progWeek++; _saveProg(); renderProgramme(_progWeek); } }
function progSetWeek(w)  { _progWeek = w; _saveProg(); renderProgramme(w); }
function progRegenerate() { _prog = buildOfflineProgram(); _progWeek = 1; _saveProg(); renderProgramme(1); toast("Programme régénéré ✓", "ok"); }

function renderProgramme(weekNum) {
  if (!_prog) { _prog = buildOfflineProgram(); _saveProg(); }
  const phase = PROG_PHASES[weekNum - 1];
  const params = PROG_PHASE_PARAMS[weekNum - 1];

  // Subtitle
  const sub = document.getElementById("prog-subtitle");
  if (sub) sub.textContent = (_prog.name ? _prog.name + " · " : "") + phase.name + " · RPE " + phase.rpe;

  // Phase strip chips
  const strip = document.getElementById("prog-phases-strip");
  if (strip) {
    strip.innerHTML = PROG_PHASES.map(p => {
      const active = p.w === weekNum;
      return `<button class="prog-phase-chip${active ? " active" : ""}"
        style="border-color:${p.color};${active ? "background:" + p.color + ";" : "color:" + p.color + ";"}"
        onclick="progSetWeek(${p.w})" title="${p.name}">${p.short}</button>`;
    }).join("");
  }

  // Cycle progress bar
  const bar = document.getElementById("prog-cycle-bar");
  const lbl = document.getElementById("prog-cycle-label");
  if (bar) bar.style.width = ((weekNum / 8) * 100) + "%";
  if (lbl) lbl.textContent = "Semaine " + weekNum + " / 8 — " + phase.name;

  // SVG Chart
  _renderProgChart(weekNum);

  // Week info
  const sw = document.getElementById("prog-sel-week");
  const sp = document.getElementById("prog-sel-phase");
  const wd = document.getElementById("prog-week-desc");
  if (sw) sw.textContent = weekNum;
  if (sp) { sp.textContent = phase.name; sp.style.color = phase.color; }
  if (wd) wd.textContent = phase.desc;

  // Days
  _renderProgDays(weekNum, params);
}

function _renderProgChart(currentWeek) {
  const svg = document.getElementById("prog-svg-chart");
  if (!svg) return;
  const W = 300, H = 90, pL = 22, pR = 10, pT = 8, pB = 18;
  const cW = W - pL - pR, cH = H - pT - pB;
  const toX = i => pL + (i / 7) * cW;
  const toY = v => pT + cH - (v / 100) * cH;

  const vols = PROG_PHASES.map(p => p.volume);
  const ints = PROG_PHASES.map(p => p.intensity);

  function line(vals, color, id) {
    const pts = vals.map((v, i) => toX(i).toFixed(1) + "," + toY(v).toFixed(1)).join(" ");
    const area = toX(0).toFixed(1) + "," + toY(0).toFixed(1) + " " + pts + " " + toX(7).toFixed(1) + "," + toY(0).toFixed(1);
    const dots = vals.map((v, i) => {
      const isCur = i + 1 === currentWeek;
      return `<circle cx="${toX(i).toFixed(1)}" cy="${toY(v).toFixed(1)}" r="${isCur ? 4 : 2.5}" fill="${color}" ${isCur ? 'stroke="#fff" stroke-width="1.5"' : ""}/>`;
    }).join("");
    return `<polygon points="${area}" fill="${color}" opacity="0.08"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}`;
  }

  // Grid lines
  const grid = [0, 25, 50, 75, 100].map(v => {
    const y = toY(v).toFixed(1);
    return `<line x1="${pL}" y1="${y}" x2="${W - pR}" y2="${y}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
      <text x="${(pL - 2)}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,.25)" font-size="6">${v}</text>`;
  }).join("");

  // Current week marker
  const cx = toX(currentWeek - 1).toFixed(1);
  const marker = `<line x1="${cx}" y1="${pT}" x2="${cx}" y2="${pT + cH}" stroke="${PROG_PHASES[currentWeek - 1].color}" stroke-width="1.5" stroke-dasharray="3,2" opacity="0.6"/>`;

  // X labels
  const xlabels = PROG_PHASES.map((p, i) =>
    `<text x="${toX(i).toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="rgba(255,255,255,.35)" font-size="7">${p.short}</text>`
  ).join("");

  svg.innerHTML = grid + marker + line(vols, "#2563eb") + line(ints, "#f97316") + xlabels;
}

function _renderProgDays(weekNum, params) {
  const cont = document.getElementById("prog-days-list");
  if (!cont || !_prog) return;
  const weekly = _progGetWeekly(_prog.goal);
  const eq = _prog.equipment || "";
  const todayDow = (() => { const d = new Date().getDay(); return d === 0 ? 7 : d; })();
  const dayNames = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const doneKey = `fitai_prog_done_${new Date().toISOString().slice(0, 10)}`;
  let doneSets = {};
  try { doneSets = JSON.parse(localStorage.getItem(doneKey) || "{}"); } catch {}

  // Count how many times each exercise type has appeared so far in the week (for A/B pool rotation)
  const typeCount = {};

  cont.innerHTML = weekly.map((item, dayIdx) => {
    const isToday = item.d === todayDow;
    const isRest  = item.type === "rest";
    const exType  = _progExType(item.type, eq);
    typeCount[exType] = (typeCount[exType] || 0);
    const pool = typeCount[exType] % 2 === 0 ? "A" : "B";
    typeCount[exType]++;
    const allEx = PROG_EXERCISES[exType] || [];
    // Prefer pool-matched exercises, fall back to non-pool items (fullbody, hiit, etc.)
    const pooled = allEx.filter(e => !e.pool || e.pool === pool);
    const exList  = (pooled.length >= 5 ? pooled : allEx).slice(0, 7);

    let exHtml = "";
    if (isRest) {
      exHtml = `<div style="font-size:.76rem;color:var(--muted);padding:8px 0">😴 Repos complet — récupération musculaire et mentale. Hydratation, sommeil, étirements légers.</div>`;
    } else {
      const needSets = !["hiit","cardio","mobilite","core"].includes(item.type);
      exHtml = exList.map((ex, exIdx) => {
        const detail = ex.r ? ex.r : (needSets ? params.sets + "×" + params.reps + (params.rest ? " · " + params.rest + "s repos" : "") : params.reps);
        const isDone = doneSets[`${dayIdx}_${exIdx}`];
        return `<div class="prog-ex-row" style="${isDone ? "opacity:.5;" : ""}">
          <div class="prog-ex-check${isDone ? " checked" : ""}" onclick="progToggleExDone(event,${dayIdx},${exIdx})">${isDone ? "✓" : ""}</div>
          <div class="prog-ex-name" style="${isDone ? "text-decoration:line-through;" : ""}">${ex.n}</div>
          <div class="prog-ex-detail">${detail}</div>
          <div class="prog-ex-muscle">${ex.m}</div>
        </div>`;
      }).join("");
    }

    // Build JS array for timer
    const exForTimer = JSON.stringify(exList.map(ex => ({ n: ex.n, m: ex.m, r: ex.r || null })));
    const startBtn = (!isRest && isToday)
      ? `<button class="prog-start-btn" onclick="event.stopPropagation();progStartWorkout(${dayIdx})" data-exlist='${exForTimer}'>▶ Commencer la séance</button>`
      : (!isRest ? `<button class="prog-start-btn" style="opacity:.5;background:rgba(99,102,241,.25)" onclick="event.stopPropagation();progStartWorkout(${dayIdx})" data-exlist='${exForTimer}'>▶ Lancer</button>` : "");

    return `<div class="prog-day-card${isToday ? " prog-day-today" : ""}${isRest ? " prog-day-rest" : ""}"${isRest ? "" : ` onclick="progToggleDay(this)"`}>
      <div class="prog-day-header">
        <span class="prog-day-num">${dayNames[item.d - 1]}</span>
        <span class="prog-day-icon" style="margin-left:4px">${item.icon}</span>
        <span class="prog-day-label">${item.label}</span>
        ${isToday ? '<span class="prog-today-badge">Aujourd\'hui</span>' : ""}
        ${!isRest ? '<span class="prog-expand-arrow" style="margin-left:auto;font-size:.6rem;color:var(--muted)">▼</span>' : ""}
      </div>
      ${!isRest
        ? `<div class="prog-day-exercises" style="display:none">${exHtml}${startBtn}</div>`
        : `<div class="prog-day-exercises" style="margin-top:8px">${exHtml}</div>`}
    </div>`;
  }).join("");
}

function progToggleDay(el) {
  const ex = el.querySelector(".prog-day-exercises");
  const arrow = el.querySelector(".prog-expand-arrow");
  if (!ex) return;
  const open = ex.style.display !== "none";
  ex.style.display = open ? "none" : "block";
  if (arrow) arrow.textContent = open ? "▼" : "▲";
}

function progToggleExDone(event, dayIdx, exIdx) {
  event.stopPropagation();
  const doneKey = `fitai_prog_done_${new Date().toISOString().slice(0, 10)}`;
  let doneSets = {};
  try { doneSets = JSON.parse(localStorage.getItem(doneKey) || "{}"); } catch {}
  const k = `${dayIdx}_${exIdx}`;
  doneSets[k] = !doneSets[k];
  localStorage.setItem(doneKey, JSON.stringify(doneSets));
  // Re-render just the days
  const params = PROG_PHASE_PARAMS[(_progWeek || 1) - 1];
  _renderProgDays(_progWeek || 1, params);
}

function progStartWorkout(dayIdx) {
  const weekly = _progGetWeekly(_prog?.goal || "");
  const item = weekly[dayIdx];
  if (!item || item.type === "rest") return;
  const eq = _prog?.equipment || "";
  const exType = _progExType(item.type, eq);
  // Count occurrences of this type before dayIdx to determine pool
  const priorCount = weekly.slice(0, dayIdx).filter(d => _progExType(d.type, eq) === exType).length;
  const pool = priorCount % 2 === 0 ? "A" : "B";
  const allEx = PROG_EXERCISES[exType] || [];
  const pooled = allEx.filter(e => !e.pool || e.pool === pool);
  const exList = (pooled.length >= 5 ? pooled : allEx).slice(0, 7);
  const params = PROG_PHASE_PARAMS[(_progWeek || 1) - 1] || PROG_PHASE_PARAMS[0];
  const dayNames = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const label = `${item.icon} ${item.label} · ${dayNames[item.d - 1]}`;
  startWorkout(label, exList, params);
}

window.loadProgramme    = loadProgramme;
window.progPrevWeek     = progPrevWeek;
window.progNextWeek     = progNextWeek;
window.progSetWeek      = progSetWeek;
window.progRegenerate   = progRegenerate;
window.progToggleDay    = progToggleDay;
window.progToggleExDone = progToggleExDone;
window.progStartWorkout = progStartWorkout;

document.addEventListener("DOMContentLoaded", boot);
