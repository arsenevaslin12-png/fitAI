/* public/app.js
   FitAI — Supabase v2 — Cyberpunk Lime/Indigo
   Fix: Magic Link callback (code/hash) + Body Scan tab calling /api/bodyscan
*/

(() => {
  "use strict";

  const APP_NAME = "FitAI";
  const BUCKET = "user_uploads";
  const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
  const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

  // Expect these in public/index.html:
  // window.SUPABASE_URL, window.SUPABASE_ANON_KEY
  const SUPABASE_URL = String(window.SUPABASE_URL || "").trim();
  const SUPABASE_ANON_KEY = String(window.SUPABASE_ANON_KEY || "").trim();

  const root =
    document.getElementById("app") ||
    document.getElementById("root") ||
    document.body;

  const hasSupabaseGlobal = typeof window.supabase !== "undefined";
  const hasCreateClient =
    hasSupabaseGlobal && typeof window.supabase.createClient === "function";

  const state = {
    supabase: null,
    session: null,
    user: null,
    activeTab: "feed",
    toastTimer: null,
    busy: false,

    bodyScans: [],
    signedCache: new Map(), // path -> { url, expiresAtMs }
  };

  function bootFail(message) {
    root.replaceChildren(
      ui.pageShell({
        headerRight: null,
        content: ui.card({
          title: "Configuration requise",
          body: [
            ui.p(message),
            ui.p(
              "Vérifie que Supabase v2 est chargé et que SUPABASE_URL / SUPABASE_ANON_KEY sont définis dans public/index.html."
            ),
          ],
        }),
      })
    );
  }

  if (!hasCreateClient) {
    bootFail("Supabase JS v2 n’est pas chargé (window.supabase.createClient introuvable).");
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    bootFail("SUPABASE_URL ou SUPABASE_ANON_KEY manquant.");
    return;
  }

  state.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* =========================
     UI helpers
     ========================= */
  const ui = {
    el(tag, props = {}, children = []) {
      const node = document.createElement(tag);

      for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null) continue;

        if (k === "class") node.className = String(v);
        else if (k === "text") node.textContent = String(v);
        else if (k === "on" && typeof v === "object") {
          for (const [evt, fn] of Object.entries(v)) {
            if (typeof fn === "function") node.addEventListener(evt, fn);
          }
        } else if (k === "style" && typeof v === "object") {
          Object.assign(node.style, v);
        } else if (k in node) {
          try {
            node[k] = v;
          } catch (_) {
            node.setAttribute(k, String(v));
          }
        } else {
          node.setAttribute(k, String(v));
        }
      }

      const arr = Array.isArray(children) ? children : [children];
      for (const ch of arr) {
        if (ch === undefined || ch === null) continue;
        if (typeof ch === "string" || typeof ch === "number") {
          node.appendChild(document.createTextNode(String(ch)));
        } else {
          node.appendChild(ch);
        }
      }
      return node;
    },

    h1(text) {
      return ui.el("div", { class: "fitai-h1", text });
    },
    h2(text) {
      return ui.el("div", { class: "fitai-h2", text });
    },
    p(text) {
      return ui.el("div", { class: "fitai-p", text });
    },

    badge(text) {
      return ui.el("span", { class: "fitai-badge", text });
    },

    btn(label, opts = {}) {
      const {
        variant = "primary",
        onClick,
        disabled = false,
        type = "button",
        title,
      } = opts;

      const cls =
        variant === "ghost"
          ? "fitai-btn fitai-btn-ghost"
          : variant === "danger"
          ? "fitai-btn fitai-btn-danger"
          : "fitai-btn fitai-btn-primary";

      return ui.el(
        "button",
        {
          class: cls,
          type,
          disabled: !!disabled,
          title: title ? String(title) : "",
          on: onClick ? { click: onClick } : undefined,
        },
        [label]
      );
    },

    input(opts = {}) {
      const {
        type = "text",
        placeholder = "",
        value = "",
        onInput,
        onChange,
        autocomplete,
      } = opts;
      return ui.el("input", {
        class: "fitai-input",
        type,
        placeholder,
        value,
        autocomplete: autocomplete || "off",
        on: {
          input: onInput || undefined,
          change: onChange || undefined,
        },
      });
    },

    fileInput(opts = {}) {
      const { accept = "image/*", onChange } = opts;
      return ui.el("input", {
        class: "fitai-input",
        type: "file",
        accept,
        on: { change: onChange || undefined },
      });
    },

    textarea(opts = {}) {
      const { placeholder = "", value = "", onInput, rows = 4 } = opts;
      return ui.el("textarea", {
        class: "fitai-textarea",
        placeholder,
        value,
        rows,
        on: { input: onInput || undefined },
      });
    },

    sep() {
      return ui.el("div", { class: "fitai-sep" });
    },

    row(children = []) {
      return ui.el("div", { class: "fitai-row" }, children);
    },

    col(children = []) {
      return ui.el("div", { class: "fitai-col" }, children);
    },

    card(opts = {}) {
      const { title, subtitle, body = [], footer = [] } = opts;
      const headerBits = [];
      if (title) headerBits.push(ui.el("div", { class: "fitai-card-title", text: title }));
      if (subtitle) headerBits.push(ui.el("div", { class: "fitai-card-subtitle", text: subtitle }));

      return ui.el("div", { class: "fitai-card" }, [
        headerBits.length ? ui.el("div", { class: "fitai-card-header" }, headerBits) : null,
        ui.el("div", { class: "fitai-card-body" }, body),
        footer.length ? ui.el("div", { class: "fitai-card-footer" }, footer) : null,
      ]);
    },

    navTab(label, key) {
      const active = state.activeTab === key;
      return ui.el(
        "button",
        {
          class: active ? "fitai-tab fitai-tab-active" : "fitai-tab",
          type: "button",
          on: {
            click: () => {
              state.activeTab = key;
              render();
            },
          },
        },
        [label]
      );
    },

    toast(message, kind = "info") {
      const existing = document.getElementById("fitai-toast");
      if (existing) existing.remove();
      if (state.toastTimer) window.clearTimeout(state.toastTimer);

      const toast = ui.el("div", {
        id: "fitai-toast",
        class:
          kind === "error"
            ? "fitai-toast fitai-toast-error"
            : kind === "success"
            ? "fitai-toast fitai-toast-success"
            : "fitai-toast",
        text: message,
      });

      document.body.appendChild(toast);
      state.toastTimer = window.setTimeout(() => {
        toast.remove();
      }, 2600);
    },

    pageShell(opts = {}) {
      const { headerRight, content } = opts;

      const header = ui.el("div", { class: "fitai-header" }, [
        ui.el("div", { class: "fitai-brand" }, [
          ui.el("div", { class: "fitai-brand-mark", text: "F" }),
          ui.el("div", { class: "fitai-brand-text" }, [
            ui.el("div", { class: "fitai-brand-title", text: APP_NAME }),
            ui.el("div", { class: "fitai-brand-sub", text: "Cyberpunk Coach" }),
          ]),
        ]),
        headerRight ? ui.el("div", { class: "fitai-header-right" }, headerRight) : null,
      ]);

      return ui.el("div", { class: "fitai-shell" }, [
        ui.injectStylesOnce(),
        header,
        ui.el("div", { class: "fitai-content" }, [content]),
      ]);
    },

    modal(opts = {}) {
      const { title, body = [], footer = [], onClose } = opts;

      const overlay = ui.el("div", {
        class: "fitai-modal-overlay",
        on: {
          click: (e) => {
            if (e.target === overlay && typeof onClose === "function") onClose();
          },
        },
      });

      const box = ui.el("div", { class: "fitai-modal" }, [
        ui.el("div", { class: "fitai-modal-header" }, [
          ui.el("div", { class: "fitai-modal-title", text: title || "" }),
          ui.btn("✕", {
            variant: "ghost",
            onClick: () => (typeof onClose === "function" ? onClose() : null),
            title: "Fermer",
          }),
        ]),
        ui.el("div", { class: "fitai-modal-body" }, body),
        footer.length ? ui.el("div", { class: "fitai-modal-footer" }, footer) : null,
      ]);

      overlay.appendChild(box);
      return overlay;
    },

    injectStylesOnce() {
      if (document.getElementById("fitai-appjs-styles")) return ui.el("div");
      const style = ui.el("style", {
        id: "fitai-appjs-styles",
        text: `
:root{
  --fitai-bg:#070812;
  --fitai-panel:#0b0f22;
  --fitai-panel2:#0a142b;
  --fitai-ink:#e9ecff;
  --fitai-sub:#b7bde6;
  --fitai-indigo:#6c5ce7;
  --fitai-lime:#b6ff3b;
  --fitai-danger:#ff3b7a;
  --fitai-stroke:rgba(182,255,59,.22);
  --fitai-stroke2:rgba(108,92,231,.22);
  --fitai-shadow: 0 10px 40px rgba(0,0,0,.55);
  --fitai-radius: 18px;
  --fitai-radius2: 14px;
  --fitai-font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Apple Color Emoji","Segoe UI Emoji";
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 800px at 20% 10%, rgba(108,92,231,.18), transparent 60%),
radial-gradient(1000px 700px at 80% 0%, rgba(182,255,59,.10), transparent 55%), var(--fitai-bg);
color:var(--fitai-ink); font-family:var(--fitai-font)}
.fitai-shell{min-height:100vh}
.fitai-header{position:sticky;top:0;z-index:30;display:flex;align-items:center;justify-content:space-between;
padding:14px 18px;background:rgba(7,8,18,.72);backdrop-filter: blur(10px); border-bottom:1px solid rgba(182,255,59,.14)}
.fitai-brand{display:flex;gap:12px;align-items:center}
.fitai-brand-mark{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;
background:linear-gradient(135deg, rgba(182,255,59,.16), rgba(108,92,231,.18));
border:1px solid rgba(182,255,59,.25); box-shadow: var(--fitai-shadow); color: var(--fitai-lime); font-weight:800}
.fitai-brand-title{font-weight:800;letter-spacing:.3px}
.fitai-brand-sub{font-size:12px;color:var(--fitai-sub);margin-top:2px}
.fitai-header-right{display:flex;gap:10px;align-items:center}
.fitai-content{max-width:1080px;margin:0 auto;padding:18px}
.fitai-row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.fitai-col{display:flex;flex-direction:column;gap:14px;min-width:280px;flex:1}
.fitai-card{background:linear-gradient(180deg, rgba(11,15,34,.92), rgba(10,20,43,.88));
border:1px solid rgba(182,255,59,.16); border-radius: var(--fitai-radius); box-shadow: var(--fitai-shadow); overflow:hidden}
.fitai-card-header{padding:14px 14px 0}
.fitai-card-title{font-size:16px;font-weight:800}
.fitai-card-subtitle{font-size:12px;color:var(--fitai-sub);margin-top:4px}
.fitai-card-body{padding:14px}
.fitai-card-footer{padding:12px 14px;border-top:1px solid rgba(108,92,231,.14);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.fitai-h1{font-size:22px;font-weight:900;letter-spacing:.2px;margin:0 0 6px 0}
.fitai-h2{font-size:14px;font-weight:800;color:var(--fitai-sub);margin:0}
.fitai-p{color:var(--fitai-sub);font-size:13px;line-height:1.45}
.fitai-sep{height:1px;background:linear-gradient(90deg, rgba(182,255,59,.18), rgba(108,92,231,.18), transparent);margin:10px 0}
.fitai-input,.fitai-textarea{width:100%;background:rgba(0,0,0,.20);border:1px solid rgba(182,255,59,.18);
color:var(--fitai-ink); border-radius: 12px; padding:10px 12px; outline:none}
.fitai-input:focus,.fitai-textarea:focus{border-color: rgba(182,255,59,.45); box-shadow: 0 0 0 3px rgba(182,255,59,.10)}
.fitai-btn{border:1px solid transparent;border-radius: 14px; padding:10px 12px; cursor:pointer; font-weight:800}
.fitai-btn-primary{background:linear-gradient(135deg, rgba(182,255,59,.16), rgba(108,92,231,.22));
border-color: rgba(182,255,59,.28); color: var(--fitai-ink)}
.fitai-btn-ghost{background:rgba(255,255,255,.04);border-color: rgba(108,92,231,.20); color: var(--fitai-ink)}
.fitai-btn-danger{background:rgba(255,59,122,.10);border-color: rgba(255,59,122,.28); color: var(--fitai-ink)}
.fitai-btn:disabled{opacity:.55; cursor:not-allowed}
.fitai-tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.fitai-tab{background:rgba(255,255,255,.03);border:1px solid rgba(108,92,231,.20);color:var(--fitai-ink);
padding:10px 12px;border-radius: 999px; cursor:pointer; font-weight:800}
.fitai-tab-active{border-color: rgba(182,255,59,.40); box-shadow: 0 0 0 3px rgba(182,255,59,.10)}
.fitai-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;
background:rgba(182,255,59,.10);border:1px solid rgba(182,255,59,.20);color:var(--fitai-lime);font-weight:800;font-size:12px}
.fitai-muted{color:var(--fitai-sub);font-size:12px}
.fitai-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:80;
background:rgba(0,0,0,.75);border:1px solid rgba(182,255,59,.20);padding:10px 12px;border-radius: 14px; box-shadow: var(--fitai-shadow)}
.fitai-toast-success{border-color: rgba(182,255,59,.40)}
.fitai-toast-error{border-color: rgba(255,59,122,.40)}
.fitai-list{display:flex;flex-direction:column;gap:12px}
.fitai-item{padding:12px;border-radius: 14px;border:1px solid rgba(108,92,231,.18);background:rgba(0,0,0,.16)}
.fitai-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.fitai-item-title{font-weight:900}
.fitai-item-sub{color:var(--fitai-sub);font-size:12px;margin-top:4px}
.fitai-img{width:100%;max-height:420px;object-fit:cover;border-radius: 14px;border:1px solid rgba(182,255,59,.16)}
.fitai-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width: 860px){.fitai-compare{grid-template-columns:1fr}}
.fitai-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.70);backdrop-filter: blur(8px);z-index:90;display:flex;align-items:center;justify-content:center;padding:18px}
.fitai-modal{width:min(980px, 100%); max-height: 86vh; overflow:auto;background:linear-gradient(180deg, rgba(11,15,34,.98), rgba(10,20,43,.96));
border:1px solid rgba(182,255,59,.16); border-radius: var(--fitai-radius); box-shadow: var(--fitai-shadow)}
.fitai-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border-bottom:1px solid rgba(108,92,231,.14)}
.fitai-modal-title{font-weight:900}
.fitai-modal-body{padding:14px}
.fitai-modal-footer{padding:12px 14px;border-top:1px solid rgba(108,92,231,.14);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
`,
      });
      document.head.appendChild(style);
      return ui.el("div");
    },
  };

  /* =========================
     Utils
     ========================= */
  function clampText(s, max = 180) {
    const str = String(s || "");
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + "…";
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return String(iso || "");
    }
  }

  function ensureNotBusy() {
    if (state.busy) return false;
    return true;
  }

  function setBusy(v) {
    state.busy = !!v;
    const spinner = document.getElementById("fitai-busy");
    if (spinner) spinner.style.display = state.busy ? "inline-flex" : "none";
  }

  function safeUUID() {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_) {}
    return "uuid_" + Math.random().toString(16).slice(2) + "_" + Date.now();
  }

  function parseHashParams() {
    const h = String(window.location.hash || "");
    if (!h || h.length < 2) return {};
    const s = h.startsWith("#") ? h.slice(1) : h;
    const p = new URLSearchParams(s);
    const out = {};
    for (const [k, v] of p.entries()) out[k] = v;
    return out;
  }

  function clearUrlArtifacts() {
    // Clear hash + code param to avoid re-processing on refresh
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("code");
      url.searchParams.delete("error");
      url.searchParams.delete("error_code");
      url.searchParams.delete("error_description");
      window.history.replaceState({}, document.title, url.toString());
    } catch (_) {
      // ignore
    }
  }

  async function getSignedUrl(path) {
    const now = Date.now();
    const cached = state.signedCache.get(path);
    if (cached && cached.url && cached.expiresAtMs && cached.expiresAtMs - now > 60_000) {
      return cached.url;
    }
    const { data, error } = await state.supabase
      .storage
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) throw error || new Error("Signed URL failed");
    const expiresAtMs = now + SIGNED_URL_TTL_SECONDS * 1000;
    state.signedCache.set(path, { url: data.signedUrl, expiresAtMs });
    return data.signedUrl;
  }

  /* =========================
     Magic link callback handling
     ========================= */
  async function handleAuthCallbackIfAny() {
    // 1) hash errors (your friend got otp_expired in hash)
    const hash = parseHashParams();
    if (hash.error_code || hash.error) {
      const code = String(hash.error_code || hash.error || "auth_error");
      const desc = decodeURIComponent(String(hash.error_description || ""));
      if (code === "otp_expired") {
        ui.toast("Lien expiré. Renvoie un nouveau magic link et clique uniquement le dernier.", "error");
      } else {
        ui.toast(`Auth error: ${code}${desc ? " — " + desc : ""}`, "error");
      }
      clearUrlArtifacts();
      return;
    }

    // 2) PKCE code in query (?code=...)
    try {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      if (code) {
        const { error } = await state.supabase.auth.exchangeCodeForSession(code);
        if (error) {
          ui.toast("Magic link invalide/expiré. Renvoie un nouveau lien.", "error");
        } else {
          ui.toast("Connecté (magic link).", "success");
        }
        clearUrlArtifacts();
      }
    } catch (_) {}

    // 3) implicit tokens in hash (#access_token=...)
    if (hash.access_token && hash.refresh_token) {
      const access_token = String(hash.access_token);
      const refresh_token = String(hash.refresh_token);
      const { error } = await state.supabase.auth.setSession({ access_token, refresh_token });
      if (error) ui.toast("Impossible de finaliser la connexion.", "error");
      else ui.toast("Connecté (magic link).", "success");
      clearUrlArtifacts();
    }
  }

  /* =========================
     Session handling
     ========================= */
  async function refreshSession() {
    const { data, error } = await state.supabase.auth.getSession();
    if (error) {
      state.session = null;
      state.user = null;
      return;
    }
    state.session = data.session;
    state.user = data.session?.user || null;
  }

  state.supabase.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    state.user = session?.user || null;
    render();
  });

  /* =========================
     Data loaders
     ========================= */
  async function loadFeedWorkouts() {
    const { data, error } = await state.supabase
      .from("workouts_feed")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(40);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function loadBodyScans() {
    if (!state.user) return [];
    const { data, error } = await state.supabase
      .from("body_scans")
      .select("id,user_id,image_path,ai_feedback,ai_version,symmetry_score,posture_score,bodyfat_proxy,created_at")
      .eq("user_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(80);

    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  /* =========================
     Views
     ========================= */
  function viewAuth() {
    const emailInput = ui.input({
      type: "email",
      placeholder: "Email",
      autocomplete: "email",
    });

    const passInput = ui.input({
      type: "password",
      placeholder: "Mot de passe (optionnel si magic link)",
      autocomplete: "current-password",
    });

    const mode = { v: "magic" }; // magic | login | signup

    function modeButtons() {
      return ui.row([
        ui.btn("Magic link", {
          variant: mode.v === "magic" ? "primary" : "ghost",
          onClick: () => {
            mode.v = "magic";
            passInput.style.display = "none";
            render();
          },
        }),
        ui.btn("Mot de passe", {
          variant: mode.v === "login" ? "primary" : "ghost",
          onClick: () => {
            mode.v = "login";
            passInput.style.display = "block";
            passInput.autocomplete = "current-password";
            render();
          },
        }),
        ui.btn("Créer compte", {
          variant: mode.v === "signup" ? "primary" : "ghost",
          onClick: () => {
            mode.v = "signup";
            passInput.style.display = "block";
            passInput.autocomplete = "new-password";
            render();
          },
        }),
      ]);
    }

    passInput.style.display = mode.v === "magic" ? "none" : "block";

    const submit = ui.btn("Continuer", {
      variant: "primary",
      onClick: async () => {
        if (!ensureNotBusy()) return;

        const email = String(emailInput.value || "").trim();
        const pass = String(passInput.value || "").trim();

        if (!email) {
          ui.toast("Email requis.", "error");
          return;
        }

        try {
          setBusy(true);

          if (mode.v === "magic") {
            // IMPORTANT: do not spam: each new link can invalidate previous -> otp_expired
            const { error } = await state.supabase.auth.signInWithOtp({
              email,
              options: {
                emailRedirectTo: `${window.location.origin}/`,
              },
            });
            if (error) throw error;
            ui.toast("Magic link envoyé. Clique uniquement le DERNIER mail.", "success");
            return;
          }

          if (!pass) {
            ui.toast("Mot de passe requis.", "error");
            return;
          }

          if (mode.v === "signup") {
            const { error } = await state.supabase.auth.signUp({ email, password: pass });
            if (error) throw error;
            ui.toast("Compte créé. Vérifie ton email si confirmation activée.", "success");
          } else {
            const { error } = await state.supabase.auth.signInWithPassword({ email, password: pass });
            if (error) throw error;
            ui.toast("Connecté.", "success");
          }
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur auth"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const info = ui.card({
      title: "Connexion FitAI",
      subtitle: "Magic link ou mot de passe (Supabase Auth)",
      body: [
        ui.row([ui.badge("AUTH"), ui.badge("RLS"), ui.badge("PRIVATE STORAGE")]),
        ui.sep(),
        modeButtons(),
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Email" }),
        emailInput,
        ui.el("div", { class: "fitai-muted", text: "Mot de passe", style: { marginTop: "10px" } }),
        passInput,
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Si tu vois otp_expired : renvoie un lien et clique uniquement le dernier." }),
      ],
      footer: [submit],
    });

    return ui.pageShell({
      headerRight: [ui.badge("SYNC")],
      content: ui.row([ui.col([info])]),
    });
  }

  function headerRightForAuthed() {
    const email = state.user?.email ? String(state.user.email) : "User";
    const busyBadge = ui.badge("SYNC");
    busyBadge.id = "fitai-busy";
    busyBadge.style.display = state.busy ? "inline-flex" : "none";

    return [
      ui.badge(clampText(email, 28)),
      busyBadge,
      ui.btn("Déconnexion", {
        variant: "ghost",
        onClick: async () => {
          if (!ensureNotBusy()) return;
          try {
            setBusy(true);
            const { error } = await state.supabase.auth.signOut();
            if (error) throw error;
            ui.toast("Déconnecté.", "success");
          } catch (e) {
            ui.toast(String(e?.message || e || "Erreur"), "error");
          } finally {
            setBusy(false);
          }
        },
      }),
    ];
  }

  function viewAppShell(contentNode) {
    const tabs = ui.el("div", { class: "fitai-tabs" }, [
      ui.navTab("Feed", "feed"),
      ui.navTab("Workout", "workout"),
      ui.navTab("Body Scan", "bodyscan"),
      ui.navTab("Profil", "profile"),
    ]);

    return ui.pageShell({
      headerRight: headerRightForAuthed(),
      content: ui.el("div", {}, [tabs, contentNode]),
    });
  }

  function viewFeed() {
    const list = ui.el("div", { class: "fitai-list" }, [
      ui.el("div", { class: "fitai-muted", text: "Chargement du feed…" }),
    ]);

    const refreshBtn = ui.btn("Rafraîchir", {
      variant: "ghost",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        await hydrateFeed(list);
      },
    });

    const card = ui.card({
      title: "Workouts Feed",
      subtitle: "View workouts_feed",
      body: [list],
      footer: [refreshBtn],
    });

    hydrateFeed(list).catch(() => void 0);

    return viewAppShell(ui.row([ui.col([card])]));
  }

  async function hydrateFeed(listNode) {
    try {
      setBusy(true);
      listNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Synchronisation…" }));
      const items = await loadFeedWorkouts();

      if (!items.length) {
        listNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Aucun item pour le moment." }));
        return;
      }

      const nodes = items.map((it) => {
        const title = it.title || it.name || it.workout_name || "Workout";
        const created = it.created_at || it.inserted_at || it.date || null;
        const userDisplay = it.user_display || it.display_name || it.user_name || null;

        const metaBits = [];
        if (created) metaBits.push(ui.el("div", { class: "fitai-item-sub", text: fmtDate(created) }));
        if (userDisplay) metaBits.push(ui.el("div", { class: "fitai-item-sub", text: `par: ${String(userDisplay)}` }));

        const preview = it.summary || it.description || it.notes || it.plan || "";
        return ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: String(title) }),
            ui.badge(it.is_public ? "PUBLIC" : "LIVE"),
          ]),
          ...metaBits,
          ui.sep(),
          ui.el("div", { class: "fitai-item-sub", text: preview ? clampText(preview, 220) : "—" }),
        ]);
      });

      listNode.replaceChildren(...nodes);
    } catch (e) {
      listNode.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur de lecture workouts_feed." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("Erreur feed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function viewWorkout() {
    const goalInput = ui.input({ placeholder: "Objectif (cut / bulk / recomposition)", value: "recomposition" });
    const levelInput = ui.input({ placeholder: "Niveau (beginner/intermediate/advanced)", value: "intermediate" });
    const equipInput = ui.input({ placeholder: "Matériel (gym/home/dumbbells)", value: "gym" });
    const output = ui.textarea({ placeholder: "Résultat généré…", value: "", rows: 10 });

    const generateBtn = ui.btn("Générer workout", {
      variant: "primary",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        try {
          setBusy(true);
          output.value = "Génération en cours…";

          const res = await fetch("/api/workout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              goal: String(goalInput.value || "").trim(),
              level: String(levelInput.value || "").trim(),
              equipment: String(equipInput.value || "").trim(),
            }),
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`API /api/workout: ${res.status} ${txt ? "- " + txt : ""}`);
          }

          const data = await res.json().catch(() => null);
          const text =
            (data && (data.workout || data.text || data.result)) ||
            JSON.stringify(data, null, 2) ||
            "OK";
          output.value = String(text);
          ui.toast("Workout généré.", "success");
        } catch (e) {
          output.value = "";
          ui.toast(String(e?.message || e || "Erreur workout"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const card = ui.card({
      title: "Workout Generator",
      subtitle: "api/workout.js",
      body: [
        ui.el("div", { class: "fitai-muted", text: "Objectif" }),
        goalInput,
        ui.el("div", { class: "fitai-muted", text: "Niveau", style: { marginTop: "10px" } }),
        levelInput,
        ui.el("div", { class: "fitai-muted", text: "Matériel", style: { marginTop: "10px" } }),
        equipInput,
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Output" }),
        output,
      ],
      footer: [generateBtn],
    });

    return viewAppShell(ui.row([ui.col([card])]));
  }

  function viewProfile() {
    const box = ui.el("div", { class: "fitai-list" }, [
      ui.el("div", { class: "fitai-muted", text: "Profil…" }),
    ]);

    const card = ui.card({
      title: "Profil",
      subtitle: "Session Supabase",
      body: [box],
      footer: [
        ui.btn("Rafraîchir", {
          variant: "ghost",
          onClick: async () => {
            if (!ensureNotBusy()) return;
            await hydrateProfile(box);
          },
        }),
      ],
    });

    hydrateProfile(box).catch(() => void 0);

    return viewAppShell(ui.row([ui.col([card])]));
  }

  async function hydrateProfile(container) {
    try {
      setBusy(true);
      container.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Synchronisation…" }));

      if (!state.user) {
        container.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Non connecté." }));
        return;
      }

      container.replaceChildren(
        ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: "Compte" }),
            ui.badge("RLS"),
          ]),
          ui.el("div", { class: "fitai-item-sub", text: `user_id: ${state.user.id}` }),
          ui.el("div", { class: "fitai-item-sub", text: `email: ${state.user.email || ""}` }),
        ]),
        ui.el("div", { class: "fitai-muted", text: "Si ton upsert profil fait ON CONFLICT, il faut une contrainte UNIQUE sur profiles.user_id." })
      );
    } catch (e) {
      container.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur profil." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("Erreur profil.", "error");
    } finally {
      setBusy(false);
    }
  }

  /* =========================
     Body Scan view (REAL Gemini via /api/bodyscan)
     ========================= */
  function viewBodyScan() {
    const fileState = { file: null, previewUrl: null };

    const timeline = ui.el("div", { class: "fitai-list" }, [
      ui.el("div", { class: "fitai-muted", text: "Chargement des scans…" }),
    ]);

    const previewImg = ui.el("img", { class: "fitai-img", alt: "Preview Body Scan" });
    previewImg.style.display = "none";

    const previewInfo = ui.el("div", { class: "fitai-muted", text: "Sélectionne une image (JPG/PNG/WEBP, max 10MB)." });

    const fileInput = ui.fileInput({
      accept: "image/jpeg,image/png,image/webp",
      onChange: (e) => {
        const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
        if (!f) return;

        const mime = String(f.type || "").toLowerCase();
        if (!ALLOWED_MIME.has(mime)) {
          ui.toast("Formats autorisés: JPG / PNG / WEBP.", "error");
          e.target.value = "";
          return;
        }
        if (typeof f.size === "number" && f.size > MAX_IMAGE_BYTES) {
          ui.toast("Image trop lourde (max 10MB).", "error");
          e.target.value = "";
          return;
        }

        fileState.file = f;
        if (fileState.previewUrl) {
          try { URL.revokeObjectURL(fileState.previewUrl); } catch (_) {}
        }
        fileState.previewUrl = URL.createObjectURL(f);
        previewImg.src = fileState.previewUrl;
        previewImg.style.display = "block";
        previewInfo.textContent = `${f.name} • ${(f.size / (1024 * 1024)).toFixed(2)} MB • ${mime}`;
        uploadBtn.disabled = false;
      },
    });

    const uploadBtn = ui.btn("Uploader + analyser (Gemini)", {
      variant: "primary",
      disabled: true,
      onClick: async () => {
        if (!ensureNotBusy()) return;
        if (!state.user) {
          ui.toast("Non connecté.", "error");
          return;
        }
        if (!fileState.file) {
          ui.toast("Choisis une image.", "error");
          return;
        }

        const f = fileState.file;
        const ts = Date.now();
        const uid = safeUUID().slice(0, 12);
        const ext = (String(f.name || "").toLowerCase().endsWith(".png") ? "png"
                  : String(f.name || "").toLowerCase().endsWith(".webp") ? "webp"
                  : "jpg");
        const path = `${state.user.id}/bodyscans/${uid}_${ts}.${ext}`;

        try {
          setBusy(true);

          // 0) get session token for /api/bodyscan
          const { data: sessData } = await state.supabase.auth.getSession();
          const token = sessData?.session?.access_token || null;
          if (!token) throw new Error("SESSION_TOKEN_MISSING");

          // 1) Upload to private bucket
          const { error: upErr } = await state.supabase
            .storage
            .from(BUCKET)
            .upload(path, f, {
              cacheControl: "3600",
              upsert: false,
              contentType: f.type || "application/octet-stream",
            });
          if (upErr) throw upErr;

          // 2) Insert DB row (front inserts, backend updates with AI)
          const { error: insErr } = await state.supabase
            .from("body_scans")
            .insert({
              user_id: state.user.id,
              image_path: path,
              ai_feedback: "",
            });
          if (insErr) throw insErr;

          // 3) Call serverless AI (Gemini)
          const res = await fetch("/api/bodyscan", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({ user_id: state.user.id, image_path: path }),
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`API /api/bodyscan: ${res.status} ${txt || ""}`);
          }

          ui.toast("Scan analysé (Gemini).", "success");

          // Reset selection
          fileState.file = null;
          if (fileState.previewUrl) {
            try { URL.revokeObjectURL(fileState.previewUrl); } catch (_) {}
          }
          fileState.previewUrl = null;
          fileInput.value = "";
          previewImg.src = "";
          previewImg.style.display = "none";
          previewInfo.textContent = "Sélectionne une image (JPG/PNG/WEBP, max 10MB).";
          uploadBtn.disabled = true;

          // Reload timeline
          await hydrateBodyScans(timeline);
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur upload/scan"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const refreshBtn = ui.btn("Rafraîchir", {
      variant: "ghost",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        await hydrateBodyScans(timeline);
      },
    });

    const infoCard = ui.card({
      title: "Body Scan (IA réelle)",
      subtitle: "Bucket privé • Signed URLs • Analyse Gemini via /api/bodyscan",
      body: [
        ui.row([ui.badge("PRIVATE"), ui.badge("SIGNED URL"), ui.badge("GEMINI")]),
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Upload" }),
        fileInput,
        ui.el("div", { class: "fitai-muted", style: { marginTop: "10px" }, text: "" }),
        previewInfo,
        ui.el("div", { style: { marginTop: "10px" } }, [previewImg]),
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Note: si tu vois otp_expired sur un ami, renvoyer un magic link et cliquer uniquement le dernier." }),
      ],
      footer: [refreshBtn, uploadBtn],
    });

    const timelineCard = ui.card({
      title: "Timeline des scans",
      subtitle: "Affichage via signed URLs (privé)",
      body: [timeline],
    });

    hydrateBodyScans(timeline).catch(() => void 0);

    return viewAppShell(ui.row([ui.col([infoCard]), ui.col([timelineCard])]));
  }

  async function hydrateBodyScans(timelineNode) {
    timelineNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Synchronisation…" }));

    if (!state.user) {
      timelineNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Non connecté." }));
      return;
    }

    try {
      setBusy(true);
      state.bodyScans = await loadBodyScans();

      if (!state.bodyScans.length) {
        timelineNode.replaceChildren(
          ui.el("div", { class: "fitai-muted", text: "Aucun scan pour le moment." }),
          ui.el("div", { class: "fitai-muted", text: "Ajoute ton premier Body Scan (max 10MB)." })
        );
        return;
      }

      const nodes = [];
      for (const scan of state.bodyScans) {
        let signedUrl = "";
        try {
          signedUrl = await getSignedUrl(scan.image_path);
        } catch (_) {
          signedUrl = "";
        }

        const img = ui.el("img", { class: "fitai-img", alt: "Body Scan" });
        if (signedUrl) img.src = signedUrl;

        const scores =
          scan.symmetry_score != null || scan.posture_score != null || scan.bodyfat_proxy != null
            ? `Sym:${scan.symmetry_score ?? "—"} • Post:${scan.posture_score ?? "—"} • Sec:${scan.bodyfat_proxy ?? "—"}`
            : "Scores: —";

        const item = ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: fmtDate(scan.created_at) }),
            ui.badge(scan.ai_version ? String(scan.ai_version).toUpperCase() : "SCAN"),
          ]),
          ui.el("div", { class: "fitai-item-sub", text: scores }),
          ui.el("div", { class: "fitai-item-sub", text: scan.image_path }),
          ui.sep(),
          signedUrl ? img : ui.el("div", { class: "fitai-muted", text: "Signed URL indisponible (storage policy / bucket)." }),
          ui.sep(),
          ui.el("div", { class: "fitai-item-sub", text: scan.ai_feedback ? clampText(scan.ai_feedback, 260) : "Analyse en cours / pas encore dispo." }),
        ]);

        nodes.push(item);
      }

      timelineNode.replaceChildren(...nodes);
    } catch (e) {
      timelineNode.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur de lecture body_scans." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") }),
        ui.el("div", { class: "fitai-muted", text: "Assure-toi que la table body_scans existe + RLS OK + bucket user_uploads privé." })
      );
      ui.toast("Erreur Body Scan.", "error");
    } finally {
      setBusy(false);
    }
  }

  /* =========================
     Router
     ========================= */
  function render() {
    if (!state.user) {
      root.replaceChildren(viewAuth());
      return;
    }

    let content = null;
    if (state.activeTab === "feed") content = viewFeed();
    else if (state.activeTab === "workout") content = viewWorkout();
    else if (state.activeTab === "bodyscan") content = viewBodyScan();
    else if (state.activeTab === "profile") content = viewProfile();
    else content = viewFeed();

    root.replaceChildren(content);
  }

  /* =========================
     Start
     ========================= */
  (async () => {
    await handleAuthCallbackIfAny(); // <-- FIX magic link
    await refreshSession();
    render();
  })();
})();
