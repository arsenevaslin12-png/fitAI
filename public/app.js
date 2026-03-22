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
    console.log("[Auth]", event, session?.user?.email || "no user");

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
  if (name === "nutrition") loadMeals();
  if (name === "community") loadFeed();
  if (name === "friends") { loadFriends(); loadFriendRequests(); }
  if (name === "bodyscan") loadScans();
  if (name === "progress") loadProgress();
  if (name === "defis") loadDefis();
  if (name === "profile") {
    loadProfile();
    loadStats();
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
      });
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

    const gType = document.getElementById("g-type");
    const gLevel = document.getElementById("g-level");
    const gText = document.getElementById("g-text");
    const gConstraints = document.getElementById("g-constraints");
    const gEquipment = document.getElementById("g-equipment");
    if (gType) gType.value = data.type || "";
    if (gLevel) gLevel.value = data.level || "";
    if (gText) gText.value = data.text || "";
    if (gConstraints) gConstraints.value = data.constraints || "";
    if (gEquipment) gEquipment.value = data.equipment || "";

    const equipLabels = { halteres:"Haltères", barre:"Barre + disques", salle:"Salle complète", kettlebell:"Kettlebell", elastiques:"Élastiques" };
    const lines = [
      ["Type", GOAL_LABELS[data.type] || data.type || "—"],
      ["Niveau", data.level || "—"],
      ["Équipement", equipLabels[data.equipment] || "Poids du corps"],
      ["Objectif", data.text || "—"],
      ["Contraintes", data.constraints || "Aucune"]
    ];
    const goalViewBody = document.getElementById("goal-view-body");
    if (goalViewBody) {
      goalViewBody.innerHTML = lines
        .map(([k, v]) => `<div class="goal-saved-row"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(v)}</span></div>`)
        .join("");
    }
  } catch (e) {
    console.error("[Goal] Load error:", e);
  }
}

function goalEdit() {
  const goalView = document.getElementById("goal-view");
  const goalForm = document.getElementById("goal-form");
  if (goalView) goalView.style.display = "none";
  if (goalForm) goalForm.style.display = "block";
}

async function saveGoal() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const payload = {
    user_id: U.id,
    type: document.getElementById("g-type")?.value || "",
    level: document.getElementById("g-level")?.value || "",
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
    const userName = U?.email?.split("@")[0] || "toi";
    el.innerHTML = `
      <div class="chat-msg chat-msg-ai">
        <div class="chat-avatar" style="background:linear-gradient(135deg,#1d4ed8,#0891b2)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></div>
        <div class="chat-bubble ai-bubble">
          <div style="font-weight:700;margin-bottom:5px">Salut ${escapeHtml(userName)} — je suis ton coach IA.</div>
          <div style="color:var(--text2);font-size:.84rem;line-height:1.6">Séance du jour, nutrition, recette, liste de courses, récupération — pose ta question et je te réponds en moins de 10 secondes.</div>
          <div style="margin-top:10px;font-size:.8rem;color:var(--muted)">Utilise les suggestions ci-dessous ou écris directement.</div>
        </div>
      </div>`;
    return;
  }

  const aiAvatar = `<div class="chat-avatar" style="background:linear-gradient(135deg,#1d4ed8,#0891b2)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></div>`;

  el.innerHTML = COACH_HISTORY.map(msg => {
    if (msg.role === "user") {
      return `<div class="chat-msg chat-msg-user"><div class="chat-user-avatar">${userInitial}</div><div class="chat-bubble user-bubble">${escapeHtml(msg.content)}<span class="chat-time" style="color:rgba(255,255,255,.5)">${msg.time || ""}</span></div></div>`;
    } else {
      return `<div class="chat-msg chat-msg-ai">${aiAvatar}<div class="chat-bubble ai-bubble">${sanitizeCoachHtml(msg.content)}<span class="chat-time">${msg.time || ""}</span></div></div>`;
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
  if (quickEl && COACH_HISTORY.length > 1) quickEl.style.display = "none";

  const btn = document.getElementById("btn-gen");
  if (btn) btn.disabled = true;

  if (chatEl) {
    chatEl.insertAdjacentHTML("beforeend", '<div class="chat-msg chat-msg-ai" id="coach-thinking"><div class="chat-avatar" style="background:linear-gradient(135deg,#1d4ed8,#0891b2)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div><div class="chat-bubble ai-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div></div>');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  try {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    const today = new Date().toISOString().slice(0, 10);

    const [goalRes, profileRes, streakRes, recentSessionsRes, lastScanRes, todayMealsRes] = await Promise.all([
      SB.from("goals").select("type,level,constraints,equipment").eq("user_id", U.id).maybeSingle(),
      SB.from("profiles").select("display_name,weight,height,age").eq("id", U.id).maybeSingle(),
      SB.from("user_streaks").select("current_streak,total_workouts").eq("user_id", U.id).maybeSingle().catch(() => ({ data: null })),
      SB.from("workout_sessions").select("plan,created_at").eq("user_id", U.id).order("created_at", { ascending: false }).limit(3).catch(() => ({ data: [] })),
      SB.from("body_scans").select("physical_score,created_at").eq("user_id", U.id).order("created_at", { ascending: false }).limit(1).catch(() => ({ data: [] })),
      SB.from("meals").select("name,calories,protein").eq("user_id", U.id).eq("date", today).catch(() => ({ data: [] }))
    ]);

    const goalContext = goalRes?.data || {};
    const dbProfile = profileRes?.data || {};
    const currentStreak = streakRes?.data?.current_streak || 0;
    const totalWorkouts = streakRes?.data?.total_workouts || 0;
    const historyForApi = COACH_HISTORY.slice(-15, -1).map((m) => ({
      role: m.role,
      content: m.role === "ai" ? stripHtml(m.content).slice(0, 400) : m.content
    }));

    // Build recent workout context
    const recentSessions = (recentSessionsRes?.data || []);
    const recentWorkoutNames = recentSessions.map(s => s.plan?.title || "Séance").slice(0, 3);
    const lastScanScore = lastScanRes?.data?.[0]?.physical_score || null;

    // Today nutrition summary
    const todayMeals = todayMealsRes?.data || [];
    const todayKcal = todayMeals.reduce((s, m) => s + (m.calories || 0), 0);
    const todayProtein = todayMeals.reduce((s, m) => s + (m.protein || 0), 0);

    // Update coach stats
    const csEnergy = document.getElementById("cs-energy");
    if (csEnergy) csEnergy.textContent = currentStreak > 0 ? `${currentStreak}j` : "0j";
    const csWeek = document.getElementById("cs-week");
    if (csWeek) csWeek.textContent = totalWorkouts || "0";

    // Read today's mood from localStorage
    let moodLabel = "";
    try {
      const savedMood = localStorage.getItem("fitai_mood");
      const savedMoodDate = localStorage.getItem("fitai_mood_date");
      if (savedMood && savedMoodDate === new Date().toDateString()) {
        moodLabel = MOOD_LABELS[parseInt(savedMood)] || "";
      }
    } catch {}

    // Update coach sub-line
    const coachSubLine = document.getElementById("coach-sub-line");
    if (coachSubLine && goalContext.type) {
      const goalLabel = { prise_de_masse: "Prise de masse", perte_de_poids: "Perte de poids", endurance: "Endurance", force: "Force", remise_en_forme: "Remise en forme", maintien: "Maintien" }[goalContext.type] || goalContext.type;
      const parts = [goalLabel];
      if (moodLabel) parts.push(moodLabel);
      if (currentStreak > 0) parts.push(`${currentStreak}j streak`);
      coachSubLine.textContent = parts.join(" · ");
    }

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
      streak: currentStreak || undefined,
      total_workouts: totalWorkouts || undefined,
      recent_workouts: recentWorkoutNames.length ? recentWorkoutNames : undefined,
      last_scan_score: lastScanScore || undefined,
      today_kcal: todayKcal > 0 ? todayKcal : undefined,
      today_protein: todayProtein > 0 ? todayProtein : undefined
    };

    // Try SSE streaming first; fall back to standard JSON endpoint
    let j = null;
    const streamCtrl = new AbortController();
    const aiTime = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

    const thinkElPre = document.getElementById("coach-thinking");
    let streamBubble = null;

    try {
      // Insert a live-updating bubble for streaming
      if (thinkElPre) {
        thinkElPre.querySelector(".chat-bubble").innerHTML = '<span id="stream-cursor" style="display:inline-block;width:2px;height:1em;background:currentColor;opacity:.7;animation:blink .8s step-end infinite;vertical-align:text-bottom"></span>';
        streamBubble = thinkElPre.querySelector(".chat-bubble");
      }

      const streamedText = await fetchCoachStream({
        url: "/api/coach-stream",
        body: { message: prompt, history: historyForApi, profile: coachProfile, goalContext },
        token,
        signal: streamCtrl.signal,
        onChunk: (accumulated) => {
          if (streamBubble) {
            streamBubble.innerHTML = formatCoachText(accumulated) + '<span id="stream-cursor" style="display:inline-block;width:2px;height:1em;background:currentColor;opacity:.7;animation:blink .8s step-end infinite;vertical-align:text-bottom"></span>';
            if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
          }
        }
      });

      const thinkEl = document.getElementById("coach-thinking");
      if (thinkEl) thinkEl.remove();

      const textHtml = formatCoachText(streamedText || "Je n'ai pas pu formuler une réponse.");
      COACH_HISTORY.push({ role: "ai", content: textHtml, time: aiTime });
      saveCoachHistory();
      renderCoachChat();
      if (chatEl) setTimeout(() => { chatEl.scrollTop = chatEl.scrollHeight; }, 50);

    } catch (streamErr) {
      // Streaming failed — fall back to standard JSON endpoint silently
      const thinkEl = document.getElementById("coach-thinking");
      if (thinkEl) thinkEl.querySelector(".chat-bubble").innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

      const { response: jsonResp } = await fetchJsonWithTimeout("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: prompt, history: historyForApi, profile: coachProfile, goalContext })
      }, 30000);
      j = jsonResp;
    }

    if (!j) {
      // Already handled by streaming path above
      if (btn) btn.disabled = false;
      ASYNC_LOCKS.delete("coach-msg");
      return;
    }

    const thinkEl = document.getElementById("coach-thinking");
    if (thinkEl) thinkEl.remove();

    const fallbackBadge = j.fallback ? '<div style="margin-top:8px;font-size:.78rem;opacity:.72">⚠️ Mode secours intelligent utilisé.</div>' : "";

    if (j.type === "shopping_list" && j.data) {
      const d = j.data;
      let html = `<div style="font-size:.88rem;font-weight:800;color:var(--text);margin-bottom:4px">${escapeHtml(d.title || "Liste de courses")}</div>`;
      if (d.context) html += `<div style="font-size:.82rem;margin:5px 0 8px;color:rgba(238,238,245,.7)">${escapeHtml(d.context)}</div>`;
      (d.categories || []).forEach(cat => {
        if (!cat.items?.length) return;
        html += `<div style="margin-top:10px;font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--teal)">${escapeHtml(cat.name)}</div>`;
        html += '<ul style="margin:4px 0 0 0;list-style:none;display:flex;flex-direction:column;gap:2px">';
        cat.items.forEach(item => {
          html += `<li style="font-size:.82rem;display:flex;gap:6px"><span style="color:var(--muted)">•</span><span><strong>${escapeHtml(item.name)}</strong>${item.qty ? ` <span style="opacity:.6">— ${escapeHtml(item.qty)}</span>` : ""}${item.note ? ` <span style="opacity:.5;font-style:italic">(${escapeHtml(item.note)})</span>` : ""}</span></li>`;
        });
        html += '</ul>';
      });
      if (d.tips) html += `<div style="margin-top:10px;font-size:.78rem;font-style:italic;opacity:.6;border-top:1px solid rgba(255,255,255,.08);padding-top:8px">💡 ${escapeHtml(d.tips)}</div>`;
      html += fallbackBadge;
      COACH_HISTORY.push({ role: "ai", content: html, time: aiTime });
    } else if (j.type === "meal_plan" && j.data) {
      const d = j.data;
      let html = `<div style="font-size:.88rem;font-weight:800;color:var(--text);margin-bottom:4px">${escapeHtml(d.title || "Journée alimentaire")}</div>`;
      if (d.total_calories || d.total_protein) {
        const parts = [];
        if (d.total_calories) parts.push(`🔥 ${d.total_calories} kcal`);
        if (d.total_protein) parts.push(`💪 ${d.total_protein}g protéines`);
        html += `<div style="font-size:.8rem;margin:5px 0 8px;opacity:.7">${parts.join(" · ")}</div>`;
      }
      (d.meals || []).forEach(meal => {
        html += `<div style="margin-top:10px;border-left:2px solid var(--teal);padding-left:12px">`;
        html += `<div style="font-size:.85rem;font-weight:800;color:var(--text)">${escapeHtml(meal.name)}`;
        if (meal.time) html += ` <span style="opacity:.5;font-weight:500;font-size:.78rem">${escapeHtml(meal.time)}</span>`;
        html += `</div>`;
        if (meal.calories || meal.protein) {
          const parts = [];
          if (meal.calories) parts.push(`🔥 ${meal.calories} kcal`);
          if (meal.protein) parts.push(`💪 ${meal.protein}g`);
          html += `<div style="font-size:.74rem;opacity:.6;margin:2px 0 4px">${parts.join(" · ")}</div>`;
        }
        if (meal.items?.length) {
          html += '<ul style="margin:0;list-style:none;font-size:.8rem;color:rgba(238,238,245,.8);display:flex;flex-direction:column;gap:1px">';
          meal.items.forEach(item => { html += `<li>• ${escapeHtml(item)}</li>`; });
          html += '</ul>';
        }
        html += '</div>';
      });
      if (d.notes) html += `<div style="margin-top:10px;font-size:.78rem;font-style:italic;opacity:.6;border-top:1px solid rgba(255,255,255,.08);padding-top:8px">💡 ${escapeHtml(d.notes)}</div>`;
      html += fallbackBadge;
      COACH_HISTORY.push({ role: "ai", content: html, time: aiTime });
    } else if (j.type === "workout" && j.data) {
      PLAN = j.data;
      let aiResponse = `<strong>${escapeHtml(PLAN.title || "Séance générée")}</strong>`;
      // Meta summary line
      const metaParts = [];
      if (PLAN.duration) metaParts.push(`⏱ ${PLAN.duration} min`);
      if (PLAN.calories_estimate) metaParts.push(`🔥 ~${PLAN.calories_estimate} kcal`);
      if (PLAN.exercises?.length) metaParts.push(`💪 ${PLAN.exercises.length} exercices`);
      if (metaParts.length) aiResponse += `<div style="margin-top:5px;font-size:.8rem;opacity:.7">${metaParts.join(" · ")}</div>`;
      // Exercise list preview (first 5)
      if (Array.isArray(PLAN.exercises) && PLAN.exercises.length > 0) {
        aiResponse += '<ul style="margin:8px 0 0 14px;list-style:none;display:flex;flex-direction:column;gap:3px">';
        PLAN.exercises.slice(0, 5).forEach((ex, i) => {
          const badge = ex.sets > 1 ? `${ex.sets}×${ex.reps}` : (ex.duration > 0 ? `${ex.duration}s` : ex.reps);
          aiResponse += `<li style="font-size:.82rem;color:rgba(238,238,245,.8)"><span style="opacity:.5">${i + 1}.</span> <strong>${escapeHtml(ex.name)}</strong> <span style="opacity:.55">${escapeHtml(badge)}</span></li>`;
        });
        if (PLAN.exercises.length > 5) aiResponse += `<li style="font-size:.78rem;opacity:.5">+${PLAN.exercises.length - 5} autres exercices…</li>`;
        aiResponse += '</ul>';
      } else if (PLAN.blocks?.length) {
        aiResponse += '<div style="margin-top:8px">';
        PLAN.blocks.slice(0, 3).forEach((b) => {
          aiResponse += `<div style="margin-top:5px;font-size:.82rem"><strong>${escapeHtml(b.title)}</strong></div>`;
          if (b.items?.length) {
            aiResponse += '<ul style="margin:3px 0 0 14px;list-style:disc;font-size:.8rem;color:rgba(238,238,245,.7)">';
            b.items.slice(0, 3).forEach((it) => { aiResponse += `<li>${escapeHtml(it)}</li>`; });
            aiResponse += '</ul>';
          }
        });
        aiResponse += '</div>';
      }
      if (PLAN.notes) aiResponse += `<div style="margin-top:6px;font-size:.8rem;font-style:italic;opacity:.65">${escapeHtml(PLAN.notes.slice(0, 140))}</div>`;
      aiResponse += '<div style="margin-top:10px;font-size:.78rem;opacity:.6">👇 Séance complète ci-dessous — tu peux la sauvegarder.</div>' + fallbackBadge;
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
    const errorMsg = normalizeCoachError(e.name === "AbortError" ? "timeout" : (e.message || ""));
    const errTime = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    COACH_HISTORY.push({ role: "ai", content: `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:1.1rem">🥵</span><strong>Le coach a eu un coup de chaud.</strong></div><div style="font-size:.83rem;color:var(--muted);line-height:1.5">Réessaie dans un instant — il sera de retour très vite.</div><div style="margin-top:10px"><button class="coach-chip" onclick="retryLastCoachMessage()" style="cursor:pointer;font-size:.8rem">↩ Réessayer</button></div>`, time: errTime });
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

function renderExerciseCard(ex, idx) {
  const badges = [];
  if (ex.sets && ex.sets > 0) badges.push(`<span class="ex-badge sets">${ex.sets} séries</span>`);
  if (ex.reps && ex.reps !== "0") badges.push(`<span class="ex-badge reps">${escapeHtml(String(ex.reps))} reps</span>`);
  if (ex.duration && ex.duration > 0) badges.push(`<span class="ex-badge dur">${ex.duration}s</span>`);
  if (ex.rest && ex.rest > 0) badges.push(`<span class="ex-badge rest">${ex.rest}s repos</span>`);
  if (ex.muscle) badges.push(`<span class="ex-badge muscle">${escapeHtml(ex.muscle)}</span>`);

  const diffClass = ex.difficulty === "facile" ? "facile" : ex.difficulty === "difficile" ? "difficile" : "moyen";

  return `
    <div class="ex-card">
      <div class="ex-num">${idx + 1}</div>
      <div class="ex-body">
        <div class="ex-name">
          <span>${escapeHtml(ex.name || "Exercice")}</span>
          <span class="ex-diff ${diffClass}" title="${escapeHtml(ex.difficulty || 'moyen')}"></span>
        </div>
        <div class="ex-badges">${badges.join("")}</div>
        ${ex.description ? `<div class="ex-desc">${escapeHtml(ex.description)}</div>` : ""}
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
    await loadHistory();
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

async function loadNutritionTargets() {
  if (!U) return;
  try {
    const { data } = await SB.from("nutrition_targets").select("calories,protein,carbs,fats").eq("user_id", U.id).maybeSingle();
    const target = data || { calories: 2200, protein: 140, carbs: 260, fats: 70 };
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
    const { data } = await SB.from("nutrition_targets").select("calories,protein,carbs,fats").eq("user_id", U.id).maybeSingle();
    const targetCalories = data?.calories || 2200;
    const targetProt = data?.protein || 140;
    const targetCarb = data?.carbs || 260;
    const targetFat = data?.fats || 70;

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

    // Macro bars
    const barProt = document.getElementById("bar-prot");
    const barCarb = document.getElementById("bar-carb");
    const barFat = document.getElementById("bar-fat");
    if (barProt) barProt.style.width = `${Math.min(100, Math.round((totals.protein / targetProt) * 100))}%`;
    if (barCarb) barCarb.style.width = `${Math.min(100, Math.round((totals.carbs / targetCarb) * 100))}%`;
    if (barFat) barFat.style.width = `${Math.min(100, Math.round((totals.fat / targetFat) * 100))}%`;
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
  await guarded(`post-${postId}`, async () => {
    const { error } = await SB.from("community_posts").delete().eq("id", postId).eq("user_id", U.id);
    if (error) throw error;
    await loadFeed();
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
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
    if (FEED_FILTER === "friends") {
      query = query.eq("visibility", "friends");
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) {
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

    el.innerHTML = data.map(post => {
      const me = U && post.user_id === U.id;
      const liked = LIKED.has(post.id);
      const date = timeAgo(post.created_at);
      const commentCount = commentCounts[post.id] || 0;
      const visIcon = post.visibility === "friends" ? "🔒" : "🌍";
      const imageSrc = imageUrls[post.id] || "";
      return `
        <div class="post">
          <div class="post-head">
            <div class="post-author">${me ? "Vous 👤" : "Membre 💪"}</div>
            <div class="post-date">${visIcon} ${date}</div>
          </div>
          <div class="post-body">${escapeHtml(post.content)}</div>
          ${imageSrc ? `<img class="feed-img" src="${escapeHtml(imageSrc)}" alt="Photo" loading="lazy"/>` : ""}
          <div class="post-footer">
            <button class="kudos-btn ${liked ? "on" : ""}" onclick="giveKudos('${post.id}', ${post.kudos || 0})">${liked ? "❤️" : "🤍"} ${post.kudos || 0}</button>
            <button class="comment-btn" onclick="toggleComments('${post.id}')">💬 ${commentCount}</button>
            ${me ? `<button class="btn btn-g btn-sm" onclick="deletePost('${post.id}')">🗑️</button>` : ""}
          </div>
          <div class="comments-section" id="comments-${post.id}" style="display:none"></div>
        </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="color:var(--red)">Erreur: ${escapeHtml(e.message)}</div>`;
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

    resultEl.innerHTML = data.map(p => `
      <div class="friend-row">
        <div class="sidebar-avatar" style="width:28px;height:28px;font-size:.65rem">${(p.display_name || p.username || "?").charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.85rem">${escapeHtml(p.display_name || p.username || "Membre")}</div>
          <div class="meal-info">@${escapeHtml(p.username || "")}</div>
        </div>
        <button class="btn btn-p btn-sm" onclick="sendFriendRequest('${p.id}')">Ajouter</button>
      </div>
    `).join("");
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
    // Get accepted friendships where I'm either requester or addressee
    const { data, error } = await SB.from("friendships")
      .select("id,requester_id,addressee_id")
      .eq("status", "accepted")
      .or(`requester_id.eq.${U.id},addressee_id.eq.${U.id}`);
    if (error) throw error;
    if (!data?.length) { el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Aucun ami pour le moment</div>'; return; }

    // Get friend profile IDs
    const friendIds = data.map(f => f.requester_id === U.id ? f.addressee_id : f.requester_id);
    const { data: profiles } = await SB.from("profiles").select("id,username,display_name").in("id", friendIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    el.innerHTML = data.map(f => {
      const friendId = f.requester_id === U.id ? f.addressee_id : f.requester_id;
      const p = profileMap[friendId] || {};
      return `
        <div class="friend-row">
          <div class="sidebar-avatar" style="width:28px;height:28px;font-size:.65rem">${(p.display_name || p.username || "?").charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.85rem">${escapeHtml(p.display_name || "Membre")}</div>
            <div class="meal-info">@${escapeHtml(p.username || "—")}</div>
          </div>
          <button class="btn btn-d btn-sm" onclick="removeFriend('${f.id}')">✕</button>
        </div>`;
    }).join("");

    // Update friend count
    const countEl = document.getElementById("friend-count");
    if (countEl) countEl.textContent = data.length;
  } catch (e) {
    // If table doesn't exist (migration not applied) show a setup hint
    const isTableMissing = e.message?.includes("relation") || e.message?.includes("does not exist") || e.code === "42P01";
    if (isTableMissing) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">⚙️</span>Migration SQL requise — appliquer supabase/migration_v3_social.sql</div>';
    } else {
      el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Aucun ami pour le moment</div>';
    }
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
    if (!data?.length) { el.innerHTML = '<div class="meal-info">Aucune demande en attente</div>'; return; }

    const requesterIds = data.map(f => f.requester_id);
    const { data: profiles } = await SB.from("profiles").select("id,username,display_name").in("id", requesterIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    el.innerHTML = data.map(f => {
      const p = profileMap[f.requester_id] || {};
      return `
        <div class="friend-row">
          <div class="sidebar-avatar" style="width:28px;height:28px;font-size:.65rem">${(p.display_name || p.username || "?").charAt(0).toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.85rem">${escapeHtml(p.display_name || "Membre")}</div>
            <div class="meal-info">@${escapeHtml(p.username || "—")}</div>
          </div>
          <button class="btn btn-p btn-sm" onclick="acceptFriend('${f.id}')" style="margin-right:4px">✓</button>
          <button class="btn btn-d btn-sm" onclick="rejectFriend('${f.id}')">✕</button>
        </div>`;
    }).join("");

    // Update pending badge
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

async function doScan() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  if (!FILE) return toast("Sélectionnez une image.", "err");

  const btn = document.getElementById("btn-scan");
  const errEl = document.getElementById("scan-err");
  if (errEl) errEl.style.display = "none";

  const scanLoading = document.getElementById("scan-loading");
  const scanProgressFill = document.getElementById("scan-progress-fill");

  await withButton(btn, "Analyse…", async () => {
    const ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${U.id}/bodyscans/${Date.now()}.${ext}`;
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    // Show loading
    if (scanLoading) scanLoading.style.display = "block";
    if (scanProgressFill) { scanProgressFill.style.width = "0%"; requestAnimationFrame(() => { scanProgressFill.style.width = "90%"; }); }

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

    if (scanProgressFill) scanProgressFill.style.width = "100%";

    FILE = null;
    const fileInput = document.getElementById("file-input");
    const scanPreview = document.getElementById("scan-preview");
    if (fileInput) fileInput.value = "";
    if (scanPreview) scanPreview.style.display = "none";
    if (scanLoading) scanLoading.style.display = "none";
    toast("Analyse terminée ✓", "ok");
    await loadScans();
  }).catch((e) => {
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

    el.innerHTML = data.map((scan) => {
      const done = Boolean(scan.ai_feedback);
      const physScore = scan.physical_score;
      const date = new Date(scan.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

      if (!done) {
        return `<div class="scan-result-card">
          <div class="scan-result-header">
            <div><div class="scan-result-title">Analyse du ${date}</div><div style="font-size:.75rem;color:var(--muted);margin-top:3px">Upload effectué, analyse en cours…</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="badge bg-orange">En attente</span>
              <button onclick="deleteBodyScan('${scan.id}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:6px;border-radius:8px;line-height:1;transition:color .2s" title="Supprimer" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
              </button>
            </div>
          </div>
          <div style="padding:24px;text-align:center;color:var(--muted);font-size:.84rem">L'analyse IA est en cours de traitement.</div>
        </div>`;
      }

      // Prefer structured extended_analysis from AI, fall back to text parsing
      const ext = scan.extended_analysis || {};
      const extStrengths = Array.isArray(ext.strengths) ? ext.strengths : [];
      const extImprovements = Array.isArray(ext.areas_for_improvement) ? ext.areas_for_improvement : [];
      const extRecos = ext.personalized_recommendations
        ? [].concat(ext.personalized_recommendations.training || [], ext.personalized_recommendations.nutrition || [], ext.personalized_recommendations.frequency_suggestion ? [ext.personalized_recommendations.frequency_suggestion] : [])
        : [];
      const extScores = ext.score_breakdown || {};
      const parsed = extStrengths.length || extImprovements.length
        ? { strengths: extStrengths, improvements: extImprovements, recommendations: extRecos, overview: "" }
        : parseScanFeedback(scan.ai_feedback || "");
      const hasStructure = parsed.strengths.length > 0 || parsed.improvements.length > 0;

      // Zone analysis from extended data
      const zones = ext.posture_analysis || ext.muscle_balance || null;
      const zonesGrid = zones ? Object.entries(zones).slice(0, 3).map(([zone, desc]) => {
        const icons = { upper: "💪", core: "🔥", lower: "🦵" };
        const labels = { upper: "Haut du corps", core: "Core / Abdos", lower: "Bas du corps" };
        const k = Object.keys(icons).find(k => zone.toLowerCase().includes(k)) || "upper";
        return `<div class="scan-v2-zone-card"><div class="scan-v2-zone-ic">${icons[k]}</div><div class="scan-v2-zone-name">${labels[k]}</div><div class="scan-v2-zone-txt">${escapeHtml(String(desc || "").slice(0, 90))}</div></div>`;
      }).join("") : "";

      // Progress rings replacing raw score chips (Apple Watch style)
      function scanRing(pct, color, label, valLabel) {
        const r = 22; const c = +(2 * Math.PI * r).toFixed(1);
        const filled = +((pct / 100) * c).toFixed(1);
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
      const scoreChips = [
        scan.symmetry_score != null ? scanRing(scan.symmetry_score, "#00FFFF", "Sym.", scan.symmetry_score) : "",
        extScores.muscle_definition != null ? scanRing(extScores.muscle_definition, "#22c55e", "Défin.", extScores.muscle_definition) : "",
        extScores.body_composition != null ? scanRing(extScores.body_composition, "#a855f7", "Compo.", extScores.body_composition) : "",
        scan.posture_score != null ? scanRing(scan.posture_score, "#06b6d4", "Post.", scan.posture_score) : "",
        scan.bodyfat_proxy != null ? scanRing(Math.max(0, 100 - scan.bodyfat_proxy), "#f97316", "BF", scan.bodyfat_proxy + "%") : "",
      ].filter(Boolean).join("");

      const reco = ext.personalized_recommendations || {};
      const trainingRecos = (reco.training_focus || reco.training || []).slice(0, 2);
      const nutritionRecos = (reco.nutrition || []).slice(0, 1);
      const exerciseExs = (reco.exercise_examples || []).slice(0, 3).join(", ");
      const freqSugg = reco.frequency_suggestion || "";

      const compRows = [
        ext.body_composition ? `<div class="scan-v2-comp-row"><div class="scan-v2-comp-lbl">Composition</div><div class="scan-v2-comp-val">${escapeHtml(String(ext.body_composition).slice(0,120))}</div></div>` : "",
        ext.muscle_definition_text ? `<div class="scan-v2-comp-row"><div class="scan-v2-comp-lbl">Définition musculaire</div><div class="scan-v2-comp-val">${escapeHtml(String(ext.muscle_definition_text).slice(0,120))}</div></div>` : "",
        ext.estimated_metrics?.bodyfat_range ? `<div class="scan-v2-comp-row"><div class="scan-v2-comp-lbl">Bodyfat estimé</div><div class="scan-v2-comp-val">${escapeHtml(ext.estimated_metrics.bodyfat_range)}</div></div>` : "",
        ext.estimated_metrics?.fitness_category ? `<div class="scan-v2-comp-row"><div class="scan-v2-comp-lbl">Catégorie</div><div class="scan-v2-comp-val" style="text-transform:capitalize">${escapeHtml(ext.estimated_metrics.fitness_category)}</div></div>` : "",
      ].filter(Boolean).join("");

      return `<div class="scan-v2">
        <div class="scan-v2-top">
          <div class="scan-v2-photo">
            ${scan.image_url ? lazyImg(scan.image_url, "Scan", "", "width:100%;height:100%;object-fit:cover;opacity:.9") : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:.8rem;padding:20px;text-align:center">Photo non disponible</div>`}
            <div class="scan-v2-photo-overlay">
              <span class="scan-v2-pill">${date}</span>
              ${physScore ? `<span class="scan-v2-pill" style="font-family:'Georgia',serif;font-size:1rem;font-weight:900">${physScore}/100</span>` : ""}
            </div>
          </div>
          <div class="scan-v2-right">
            ${scoreChips ? `<div class="rings-row" style="justify-content:flex-start;flex-wrap:wrap;margin-bottom:10px">${scoreChips}</div>` : ""}
            <div class="scan-v2-comp">
              <div class="scan-v2-comp-hdr">Composition corporelle</div>
              ${compRows || `<div class="scan-v2-comp-val" style="opacity:.6;font-size:.75rem">Score global: ${physScore || "—"}/100</div>`}
            </div>
            ${hasStructure ? `<div class="scan-v2-2col">
              <div class="scan-v2-strengths">
                <div class="scan-v2-col-hdr scan-v2-str-hdr">Points forts</div>
                ${parsed.strengths.slice(0, 3).map(s => `<div class="scan-v2-pt scan-v2-str-pt">${escapeHtml(s)}</div>`).join("")}
              </div>
              <div class="scan-v2-weaknesses">
                <div class="scan-v2-col-hdr scan-v2-wk-hdr">À travailler</div>
                ${parsed.improvements.slice(0, 3).map(s => `<div class="scan-v2-pt scan-v2-wk-pt">${escapeHtml(s)}</div>`).join("")}
              </div>
            </div>` : ""}
          </div>
        </div>
        ${trainingRecos.length || nutritionRecos.length ? `<div style="padding:14px 16px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border)">
          ${trainingRecos.map((r, i) => `<div class="scan-v2-reco ${i===0?"scan-v2-reco-train":"scan-v2-reco-nutri"}"><div class="scan-v2-reco-top"><span class="scan-v2-reco-tag">${i===0?"Entraînement":"Focus"}</span><span class="scan-v2-reco-priority ${i===0?"scan-v2-pri-high":"scan-v2-pri-med"}">${i===0?"Prioritaire":"Moyen"}</span></div><div class="scan-v2-reco-title">${escapeHtml(String(r).slice(0,80))}</div>${exerciseExs&&i===0?`<div class="scan-v2-reco-desc">${escapeHtml(exerciseExs)}</div>`:""}</div>`).join("")}
          ${nutritionRecos.map(r => `<div class="scan-v2-reco scan-v2-reco-nutri"><div class="scan-v2-reco-top"><span class="scan-v2-reco-tag">Nutrition</span><span class="scan-v2-reco-priority scan-v2-pri-med">Moyen</span></div><div class="scan-v2-reco-title">${escapeHtml(String(r).slice(0,80))}</div></div>`).join("")}
        </div>` : freqSugg ? `<div style="padding:12px 16px;border-top:1px solid var(--border);font-size:.78rem;color:var(--text2)">${escapeHtml(freqSugg)}</div>` : ""}
        ${zonesGrid ? `<div class="scan-v2-zones"><div class="scan-v2-zone-hdr">Analyse par zone</div><div class="scan-v2-zone-grid">${zonesGrid}</div></div>` : ""}
        <div style="display:flex;justify-content:flex-end;padding:8px 14px 10px;border-top:1px solid var(--border)">
          <button onclick="deleteBodyScan('${scan.id}')" style="display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;color:var(--muted);font-size:.74rem;font-weight:600;padding:5px 8px;border-radius:8px;transition:color .2s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            Supprimer
          </button>
        </div>
      </div>`;
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
  const confirmed = window.confirm("Supprimer cette analyse corporelle ? Cette action est irréversible.");
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
    const { data } = await SB.from("profiles").select("display_name,username,age,weight,height").eq("id", U.id).maybeSingle();
    const name = data?.display_name || U.email?.split("@")[0] || "Membre";
    const pName = document.getElementById("p-name");
    const pEmail = document.getElementById("p-email");
    const pAvatar = document.getElementById("p-avatar");
    const pPseudo = document.getElementById("p-pseudo");
    const pUsername = document.getElementById("p-username");
    const tu = document.getElementById("tu");
    if (pName) pName.textContent = name;
    if (pEmail) pEmail.textContent = U.email || "";
    if (pAvatar) pAvatar.textContent = name.charAt(0).toUpperCase();
    if (pPseudo) pPseudo.value = data?.display_name || "";
    if (pUsername) pUsername.value = data?.username || "";
    if (tu) tu.textContent = name;
    const pAge = document.getElementById("p-age");
    const pWeight = document.getElementById("p-weight");
    const pHeight = document.getElementById("p-height");
    if (pAge) pAge.value = data?.age || "";
    if (pWeight) pWeight.value = data?.weight || "";
    if (pHeight) pHeight.value = data?.height || "";
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
  { id: "7days", icon: "🔥", title: "7 jours consécutifs", desc: "Entraîne-toi 7 jours de suite sans interruption", difficulty: "Moyen", xp: 500, color: "#f97316", target: 7, unit: "jours", metric: "streak" },
  { id: "10kcal", icon: "⚡", title: "10 000 calories brûlées", desc: "Cumule 10 000 calories brûlées sur l'ensemble de tes séances", difficulty: "Difficile", xp: 1000, color: "#eab308", target: 10000, unit: "kcal", metric: "calories" },
  { id: "30sess", icon: "🏋️", title: "30 séances d'entraînement", desc: "Complète 30 séances au total pour débloquer ce défi", difficulty: "Difficile", xp: 1500, color: "#ef4444", target: 30, unit: "séances", metric: "sessions" },
  { id: "5h_week", icon: "⏱️", title: "5h d'entraînement en 1 semaine", desc: "Totalise 5 heures de sport sur une même semaine", difficulty: "Moyen", xp: 600, color: "#8b5cf6", target: 300, unit: "minutes", metric: "weekly_time" },
  { id: "variety", icon: "🌈", title: "Polyvalence totale", desc: "Effectue au moins 3 types d'entraînement différents en une semaine", difficulty: "Moyen", xp: 400, color: "#f97316", target: 3, unit: "types", metric: "variety" },
  { id: "early", icon: "🌅", title: "Lève-tôt champion", desc: "Entraîne-toi 5 fois avant 8h du matin", difficulty: "Difficile", xp: 800, color: "#ec4899", target: 5, unit: "matins", metric: "early" },
  { id: "perfect_week", icon: "💎", title: "Semaine parfaite", desc: "Entraîne-toi ET suis ta nutrition toute une semaine (7/7)", difficulty: "Expert", xp: 2000, color: "#3b82f6", target: 7, unit: "jours", metric: "perfect" }
];

async function loadDefis() {
  if (!U) return;
  const el = document.getElementById("defis-list");
  if (!el) return;

  // Load user stats for progress
  let totalSessions = 0, currentStreak = 0;
  try {
    const [sessRes, streakRes] = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("user_streaks").select("current_streak,longest_streak,total_workouts").eq("user_id", U.id).maybeSingle()
    ]);
    totalSessions = sessRes.count || 0;
    currentStreak = streakRes.data?.current_streak || 0;
  } catch (e) { console.error("[Defis] Stats error:", e); }

  // Calculate progress for each defi
  const defisProgress = DEFIS_LIST.map(d => {
    let current = 0;
    if (d.metric === "sessions") current = totalSessions;
    else if (d.metric === "streak") current = currentStreak;
    else current = 0;
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
    <div class="defi-card" style="border-top:3px solid ${d.color}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span style="font-size:1.5rem">${d.icon}</span>
        <div style="flex:1">
          <div style="font-weight:800;font-size:.95rem">${escapeHtml(d.title)}</div>
          <div class="meal-info">${escapeHtml(d.desc)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <span class="badge" style="background:rgba(255,255,255,.06);color:${diffColors[d.difficulty] || "var(--muted)"}">${d.difficulty}</span>
        <span class="badge" style="background:rgba(234,179,8,.1);color:var(--yellow)">+${d.xp} XP</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:.78rem;margin-bottom:6px">
        <span style="color:var(--muted)">Progression</span>
        <span style="font-weight:700">${d.current} / ${d.target} ${d.unit}</span>
      </div>
      <div class="progress-track" style="height:6px"><div class="progress-fill" style="width:${d.pct}%;background:${d.color}"></div></div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:4px">${d.pct}% accompli</div>
    </div>
  `).join("");
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
        if (parseErr.message !== "[object Object]") throw parseErr;
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
  if (quickEl) quickEl.style.display = "";
  const planCard = document.getElementById("plan-card");
  if (planCard) planCard.style.display = "none";
  PLAN = null;
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
    }
  }).catch((e) => {
    if (errEl) {
      errEl.textContent = `Erreur: ${e.message}`;
      errEl.style.display = "block";
    }
  });
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
window.sendCoachMsg = sendCoachMsg;
window.retryLastCoachMessage = retryLastCoachMessage;
window.generateWorkout = generateWorkout;
window.saveSession = saveSession;
window.clearCoachChat = clearCoachChat;
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
// New
window.searchUsers = searchUsers;
window.sendFriendRequest = sendFriendRequest;
window.acceptFriend = acceptFriend;
window.rejectFriend = rejectFriend;
window.removeFriend = removeFriend;
window.setFeedFilter = setFeedFilter;
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
    SB.from("user_streaks").select("current_streak,best_streak").eq("user_id", U.id).maybeSingle(),
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

const DAILY_POOL = [
  { id: "pushups_100", title: "100 pompes", desc: "En autant de séries que nécessaire", icon: "💪", xp: 150, category: "Force" },
  { id: "abs_100", title: "100 abdos", desc: "Crunchs, planche, bicycle — à toi de choisir", icon: "🔥", xp: 100, category: "Core" },
  { id: "steps_10k", title: "10 000 pas", desc: "Marche, course, montées d'escaliers", icon: "🚶", xp: 120, category: "Cardio" },
  { id: "water_2L", title: "2L d'eau aujourd'hui", desc: "Hydrate-toi tout au long de la journée", icon: "💧", xp: 80, category: "Lifestyle" },
  { id: "squat_100", title: "100 squats", desc: "Poids du corps, pause en bas pour la qualité", icon: "🏋️", xp: 150, category: "Force" },
  { id: "plank_5min", title: "5 min de planche cumulative", desc: "Tiens la planche, cumule les séries", icon: "⚡", xp: 130, category: "Core" },
  { id: "run_5k", title: "Run 5km", desc: "En une seule sortie ou en plusieurs segments", icon: "🏃", xp: 200, category: "Cardio" },
  { id: "stretch_15", title: "15 min d'étirements", desc: "Flexibilité et récupération active", icon: "🧘", xp: 90, category: "Récup" },
  { id: "pullups_30", title: "30 tractions", desc: "En autant de séries que nécessaire", icon: "💪", xp: 180, category: "Force" },
  { id: "burpees_50", title: "50 burpees", desc: "Full body, intensité maximale", icon: "🔥", xp: 200, category: "HIIT" },
  { id: "lunges_100", title: "100 fentes", desc: "50 par jambe, alterner", icon: "🦵", xp: 140, category: "Force" },
  { id: "no_sugar", title: "Zéro sucre ajouté", desc: "Pas de soda, bonbons, ou desserts sucrés aujourd'hui", icon: "🥗", xp: 100, category: "Nutrition" },
  { id: "sleep_8h", title: "8h de sommeil", desc: "Couche-toi tôt, récupère vraiment", icon: "😴", xp: 80, category: "Récup" },
  { id: "dips_50", title: "50 dips", desc: "Sur chaise, barre parallèle ou banc", icon: "💪", xp: 140, category: "Force" },
  { id: "jump_200", title: "200 sauts à la corde", desc: "Ou 200 jumping jacks si pas de corde", icon: "⚡", xp: 110, category: "Cardio" },
];

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyChallenges() {
  const today = getTodayKey();
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem("fitai_daily") || "{}"); }
    catch { return {}; }
  })();

  if (stored.date !== today) {
    // New day — pick 3 random challenges
    const shuffled = [...DAILY_POOL].sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, 3).map(c => c.id);
    const fresh = { date: today, picks, done: [] };
    try { localStorage.setItem("fitai_daily", JSON.stringify(fresh)); } catch {}
    return fresh;
  }
  return stored;
}

function completeDailyChallenge(challengeId) {
  const today = getTodayKey();
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
  }

  // Re-render daily section
  renderDailyChallengesSection();
}

function updateDailyStreak() {
  if (!U) return;
  SB.from("user_streaks").upsert({
    user_id: U.id,
    last_active: getTodayKey(),
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" }).catch(() => {});
}

function renderDailyChallengesSection() {
  const el = document.getElementById("daily-challenges-container");
  if (!el) return;

  const data = getDailyChallenges();
  const challenges = data.picks.map(id => DAILY_POOL.find(c => c.id === id)).filter(Boolean);
  const allDone = data.done.length >= challenges.length;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-weight:800;font-size:.92rem;color:var(--text)">Défis du jour</div>
      <div style="font-size:.72rem;color:var(--muted);font-weight:700">${data.done.length}/${challenges.length} accomplis</div>
    </div>
    ${challenges.map(ch => {
      const done = data.done.includes(ch.id);
      return `<div style="display:flex;align-items:center;gap:12px;padding:11px 14px;background:${done ? "rgba(34,197,94,.07)" : "var(--surf2)"};border:1px solid ${done ? "rgba(34,197,94,.22)" : "var(--border)"};border-radius:12px;margin-bottom:8px;transition:all .2s">
        <div style="font-size:1.2rem;min-width:28px;text-align:center">${ch.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.83rem;font-weight:700;color:${done ? "#4ade80" : "var(--text)"};text-decoration:${done ? "line-through" : "none"};opacity:${done ? ".7" : "1"}">${escapeHtml(ch.title)}</div>
          <div style="font-size:.72rem;color:var(--muted);margin-top:1px">${escapeHtml(ch.desc)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
          <span style="font-size:.65rem;font-weight:800;padding:2px 7px;border-radius:999px;background:rgba(245,158,11,.12);color:var(--yellow)">+${ch.xp} XP</span>
          ${done
            ? `<span style="font-size:.7rem;color:#4ade80;font-weight:700">✓ Fait</span>`
            : `<button onclick="completeDailyChallenge('${ch.id}')" style="font-size:.72rem;font-weight:700;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;transition:opacity .2s" onmouseover="this.style.opacity='.8'" onmouseout="this.style.opacity='1'">Marquer</button>`
          }
        </div>
      </div>`;
    }).join("")}
    ${allDone ? `<div style="text-align:center;padding:10px;font-size:.8rem;font-weight:700;color:#4ade80;background:rgba(34,197,94,.06);border-radius:10px;border:1px solid rgba(34,197,94,.2)">🏆 Parfait ! Tous les défis accomplis aujourd'hui.</div>` : ""}
  `;
}

window.completeDailyChallenge = completeDailyChallenge;
window.renderDailyChallengesSection = renderDailyChallengesSection;

document.addEventListener("DOMContentLoaded", boot);
