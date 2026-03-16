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

const GOAL_LABELS = {
  prise_de_masse: "💪 Prise de masse",
  perte_de_poids: "🔥 Perte de poids",
  endurance: "🏃 Endurance",
  force: "🏋️ Force",
  remise_en_forme: "🌟 Remise en forme",
  maintien: "⚖️ Maintien"
};

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
          "Clé Supabase (SUPABASE_ANON_KEY) invalide ou ne correspond pas au projet.\n" +
          "→ Supabase Dashboard → Settings → API → anon/public key\n" +
          "→ Vercel Dashboard → Settings → Environment Variables → SUPABASE_ANON_KEY"
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
  if (name === "bodyscan") loadScans();
  if (name === "profile") {
    loadProfile();
    loadStats();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

async function loadDashboard() {
  showGlobalLoader(true, "Chargement du dashboard…");
  try {
    await Promise.all([loadGoal(), loadMeals(), loadStats(), loadNutritionTargets(), loadStreak()]);
  } catch (e) {
    console.error("[Dashboard] Error:", e);
  }
  showGlobalLoader(false);
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
    if (gType) gType.value = data.type || "";
    if (gLevel) gLevel.value = data.level || "";
    if (gText) gText.value = data.text || "";
    if (gConstraints) gConstraints.value = data.constraints || "";

    const lines = [
      ["Type", GOAL_LABELS[data.type] || data.type || "—"],
      ["Niveau", data.level || "—"],
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

  if (!COACH_HISTORY.length) {
    const userName = U?.email?.split("@")[0] || "champion";
    el.innerHTML = `
      <div class="chat-msg chat-msg-ai">
        <div class="chat-avatar">🤖</div>
        <div class="chat-bubble">
          <div>Salut ${escapeHtml(userName)} ! 👋</div>
          <div style="margin-top:6px">Je suis ton <strong>Coach IA</strong> personnel FitAI Pro. J'analyse tes données en temps réel pour te donner les meilleurs conseils.</div>
          <ul style="margin:8px 0 0 16px;list-style:disc;color:rgba(238,238,245,.8);font-size:.84rem">
            <li>Prêt à démarrer ta semaine d'entraînement ?</li>
            <li>Niveau détecté : en attente</li>
          </ul>
          <div style="margin-top:8px"><strong>Qu'est-ce qui te ferait plaisir aujourd'hui ?</strong></div>
          <span class="chat-time">${new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}</span>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = COACH_HISTORY.map(msg => {
    if (msg.role === "user") {
      return `<div class="chat-msg chat-msg-user"><div class="chat-bubble">${escapeHtml(msg.content)}<span class="chat-time">${msg.time || ""}</span></div></div>`;
    } else {
      return `<div class="chat-msg chat-msg-ai"><div class="chat-avatar">🤖</div><div class="chat-bubble">${msg.content}<span class="chat-time">${msg.time || ""}</span></div></div>`;
    }
  }).join("");

  el.scrollTop = el.scrollHeight;
}

async function sendCoachMsg(quickMsg) {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");

  const coachInput = document.getElementById("coach-input");
  const prompt = quickMsg || (coachInput ? coachInput.value.trim() : "");
  const errorEl = document.getElementById("coach-err");
  if (errorEl) errorEl.style.display = "none";

  if (!prompt) return;
  if (coachInput) coachInput.value = "";

  const now = new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
  COACH_HISTORY.push({ role: "user", content: prompt, time: now });
  saveCoachHistory();
  renderCoachChat();

  // Scroll chat to bottom
  const chatEl = document.getElementById("chat-messages");
  if (chatEl) setTimeout(() => chatEl.scrollTop = chatEl.scrollHeight, 50);

  // Hide quick chips after first message
  const quickEl = document.getElementById("chat-quick");
  if (quickEl && COACH_HISTORY.length > 1) quickEl.style.display = "none";

  const btn = document.getElementById("btn-gen");
  if (btn) btn.disabled = true;

  try {
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

    // Charger le contexte d'objectif
    let goalContext = null;
    try {
      const { data } = await SB.from("goals").select("type,level,constraints").eq("user_id", U.id).maybeSingle();
      if (data) goalContext = data;
    } catch (e) { console.warn("[Coach] Could not load goal:", e); }

    // Build conversation context from history (last 6 messages)
    const recentHistory = COACH_HISTORY.slice(-7, -1).map(m => `${m.role === "user" ? "User" : "Coach"}: ${m.content}`).join("\n");
    const contextPrompt = recentHistory ? `Conversation précédente:\n${recentHistory}\n\nNouvelle demande: ${prompt}` : prompt;

    const r = await fetch("/api/workout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: contextPrompt, goalContext })
    });
    const j = await safeResponseJson(r);
    if (!r.ok || !j.ok) throw new Error(j.error || `Erreur serveur (HTTP ${r.status})`);

    PLAN = j.data;

    // Format AI response as chat message
    let aiResponse = `<strong>${escapeHtml(PLAN.title || "Séance générée")}</strong>`;
    if (PLAN.notes) aiResponse += `<div style="margin-top:6px;font-style:italic;opacity:.8">${escapeHtml(PLAN.notes)}</div>`;
    if (PLAN.blocks?.length) {
      aiResponse += '<div style="margin-top:8px">';
      PLAN.blocks.forEach(b => {
        aiResponse += `<div style="margin-top:6px"><strong>${escapeHtml(b.title)}</strong> <span style="opacity:.6">(${formatDuration(b.duration_sec)})</span></div>`;
        if (b.items?.length) {
          aiResponse += '<ul style="margin:4px 0 0 16px;list-style:disc;font-size:.82rem;color:rgba(238,238,245,.75)">';
          b.items.forEach(it => { aiResponse += `<li>${escapeHtml(it)}</li>`; });
          aiResponse += '</ul>';
        }
      });
      aiResponse += '</div>';
    }
    aiResponse += '<div style="margin-top:10px;font-size:.82rem;opacity:.7">💾 Tu peux sauvegarder cette séance ci-dessous.</div>';

    const aiTime = new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
    COACH_HISTORY.push({ role: "ai", content: aiResponse, time: aiTime });
    saveCoachHistory();
    renderCoachChat();
    renderPlan(PLAN);

    if (chatEl) setTimeout(() => chatEl.scrollTop = chatEl.scrollHeight, 50);

  } catch (e) {
    const errTime = new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
    COACH_HISTORY.push({ role: "ai", content: `⚠️ <strong>Erreur:</strong> ${escapeHtml(e.message)}`, time: errTime });
    saveCoachHistory();
    renderCoachChat();
    if (errorEl) {
      errorEl.textContent = `Erreur: ${e.message}`;
      errorEl.style.display = "block";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Keep original generateWorkout as alias
async function generateWorkout() {
  return sendCoachMsg();
}

function renderPlan(plan) {
  const head = document.getElementById("plan-head");
  const notes = document.getElementById("plan-notes");
  const blocks = document.getElementById("plan-blocks");

  if (head) {
    head.innerHTML = `<div><div class="plan-title-text">${escapeHtml(plan.title || "Séance")}</div><div class="page-sub">${escapeHtml(plan.intensity || "medium")} · ${plan.duration || "?"} min</div></div>`;
  }
  if (notes) {
    notes.textContent = plan.notes || "";
    notes.style.display = plan.notes ? "block" : "none";
  }
  if (blocks) {
    blocks.innerHTML = (plan.blocks || []).map((b) => `
      <div class="block">
        <div class="block-head">
          <span class="block-name">${escapeHtml(b.title)}</span>
          <span class="bdur">⏱ ${formatDuration(b.duration_sec)}</span>
        </div>
        <ul class="block-items">${(b.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join("")}</ul>
      </div>
    `).join("");
  }

  const planCard = document.getElementById("plan-card");
  if (planCard) planCard.style.display = "block";
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
    if (targetKcal) targetKcal.textContent = String(target.calories);
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
    const { data } = await SB.from("nutrition_targets").select("calories").eq("user_id", U.id).maybeSingle();
    const targetCalories = data?.calories || 2200;
    const pct = Math.max(0, Math.min(100, Math.round((totals.kcal / targetCalories) * 100)));
    const calFill = document.getElementById("cal-progress-fill");
    const calText = document.getElementById("cal-progress-text");
    if (calFill) calFill.style.width = `${pct}%`;
    if (calText) calText.textContent = `${totals.kcal} / ${targetCalories} kcal`;
  } catch (e) {
    console.error("[Nutrition] renderProgress error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNAUTÉ
// ══════════════════════════════════════════════════════════════════════════════

async function createPost() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  
  const postInput = document.getElementById("post-input");
  const content = postInput ? postInput.value.trim() : "";
  if (!content) return toast("Écrivez un message.", "err");
  
  const btn = document.getElementById("btn-post");
  await withButton(btn, "Publication…", async () => {
    const { error } = await SB.from("community_posts").insert({ user_id: U.id, content, kudos: 0 });
    if (error) throw error;
    if (postInput) postInput.value = "";
    await loadFeed();
    toast("Publié ✓", "ok");
  }).catch((e) => toast(`Erreur: ${e.message}`, "err"));
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

async function loadFeed() {
  const el = document.getElementById("feed");
  if (!el) return;
  
  try {
    const { data, error } = await SB.from("community_posts")
      .select("id,user_id,content,kudos,comment_count,post_type,created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;

    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">👥</span>Soyez le premier à publier !</div>';
      return;
    }

    el.innerHTML = data.map((post) => {
      const me = U && post.user_id === U.id;
      const liked = LIKED.has(post.id);
      const date = timeAgo(post.created_at);
      const commentCount = post.comment_count || 0;
      return `
        <div class="post">
          <div class="post-head">
            <div class="post-author">${me ? "Vous 👤" : "Membre 💪"}</div>
            <div class="post-date">${date}</div>
          </div>
          <div class="post-body">${escapeHtml(post.content)}</div>
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

  await withButton(btn, "Analyse…", async () => {
    const ext = (FILE.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${U.id}/bodyscans/${Date.now()}.${ext}`;
    const token = await getToken();
    if (!token) throw new Error("Session expirée. Reconnectez-vous.");

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

    FILE = null;
    const fileInput = document.getElementById("file-input");
    const scanPreview = document.getElementById("scan-preview");
    if (fileInput) fileInput.value = "";
    if (scanPreview) scanPreview.style.display = "none";
    toast("Analyse terminée ✓", "ok");
    await loadScans();
  }).catch((e) => {
    if (errEl) {
      errEl.textContent = `Erreur: ${e.message}`;
      errEl.style.display = "block";
    }
  });
}

async function loadScans() {
  if (!U) return;
  const el = document.getElementById("scans-list");
  if (!el) return;
  
  try {
    const { data, error } = await SB.from("body_scans").select("*").eq("user_id", U.id).order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    
    if (!data?.length) {
      el.innerHTML = '<div class="empty"><span class="empty-ic">🔬</span>Aucune analyse</div>';
      return;
    }

    el.innerHTML = data.map((scan) => {
      const done = Boolean(scan.ai_feedback);
      const physScore = scan.physical_score;
      return `
        <div class="scan-card">
          <div class="post-head">
            <strong>${new Date(scan.created_at).toLocaleDateString("fr-FR")}</strong>
            <span class="badge ${done ? "bg-green" : "bg-orange"}">${done ? "Analysé" : "En attente"}</span>
          </div>
          ${done ? `
            ${physScore ? `<div class="physical-score"><span class="score-big">${physScore}</span><span class="score-label">/100 Score Physique</span></div>` : ""}
            <div class="scores-row">
              <div class="score-chip"><div class="score-v">${scan.symmetry_score ?? "—"}</div><div class="score-l">Symétrie</div></div>
              <div class="score-chip"><div class="score-v">${scan.posture_score ?? "—"}</div><div class="score-l">Posture</div></div>
              <div class="score-chip"><div class="score-v">${scan.bodyfat_proxy ? scan.bodyfat_proxy + "%" : "—"}</div><div class="score-l">Bodyfat</div></div>
            </div>
            <div class="scan-feedback">${formatFeedback(scan.ai_feedback || "")}</div>
          ` : '<div class="meal-info">Analyse en cours…</div>'}
        </div>`;
    }).join("");
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

async function loadProfile() {
  if (!U) return;
  try {
    const { data } = await SB.from("profiles").select("display_name").eq("id", U.id).maybeSingle();
    const name = data?.display_name || U.email?.split("@")[0] || "Membre";
    const pName = document.getElementById("p-name");
    const pEmail = document.getElementById("p-email");
    const pAvatar = document.getElementById("p-avatar");
    const pPseudo = document.getElementById("p-pseudo");
    const tu = document.getElementById("tu");
    if (pName) pName.textContent = name;
    if (pEmail) pEmail.textContent = U.email || "";
    if (pAvatar) pAvatar.textContent = name.charAt(0).toUpperCase();
    if (pPseudo) pPseudo.value = data?.display_name || "";
    if (tu) tu.textContent = name;
  } catch (e) {
    console.error("[Profile] Load error:", e);
  }
}

async function saveProfile() {
  if (!U) return toast("Session expirée. Reconnectez-vous.", "err");
  
  const pPseudo = document.getElementById("p-pseudo");
  const display_name = pPseudo ? pPseudo.value.trim() : "";
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
  if (!U) return;
  try {
    const [sessions, scans, posts] = await Promise.all([
      SB.from("workout_sessions").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("body_scans").select("id", { count: "exact", head: true }).eq("user_id", U.id),
      SB.from("community_posts").select("id", { count: "exact", head: true }).eq("user_id", U.id)
    ]);
    const stSess = document.getElementById("st-sess");
    const stScans = document.getElementById("st-scans");
    const stPosts = document.getElementById("st-posts");
    if (stSess) stSess.textContent = sessions.count ?? "0";
    if (stScans) stScans.textContent = scans.count ?? "0";
    if (stPosts) stPosts.textContent = posts.count ?? "0";
    const dbSess = document.getElementById("db-sess");
    if (dbSess) dbSess.textContent = sessions.count ?? "0";
    const totalSess = document.getElementById("db-total-sessions");
    if (totalSess) totalSess.textContent = sessions.count ?? "0";
  } catch (e) {
    console.error("[Stats] Load error:", e);
  }
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
    const { data } = await SB.from("user_streaks").select("current_streak,longest_streak,total_workouts").eq("user_id", U.id).maybeSingle();
    const streak = data || { current_streak: 0, longest_streak: 0, total_workouts: 0 };
    
    const streakEl = document.getElementById("user-streak");
    if (streakEl) streakEl.textContent = `🔥 ${streak.current_streak}`;
    
    const dbStreak = document.getElementById("db-streak");
    if (dbStreak) dbStreak.textContent = streak.current_streak;
    
    const longestEl = document.getElementById("st-longest");
    if (longestEl) longestEl.textContent = streak.longest_streak;
  } catch (e) {
    console.error("[Streak] Load error:", e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ══════════════════════════════════════════════════════════════════════════════

boot();

// Exports globaux pour les événements HTML onclick
window.authTab = authMode;
window.gotoTab = gotoTab;
window.sendCoachMsg = sendCoachMsg;
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
window.toggleComments = toggleComments;
window.addComment = addComment;
window.deleteComment = deleteComment;
