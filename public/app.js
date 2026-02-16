/* public/app.js — FitAI Pro (Cyberpunk Lime/Indigo)
   FIXES:
   - Boutons qui ne répondent plus (script robuste + UI rendue par JS)
   - Ajoute l’onglet BODY SCAN (upload + timeline + comparaison + appel /api/bodyscan)
   - Magic link plus fiable (emailRedirectTo + gestion erreurs hash)
   - Évite UP SERT / ON CONFLICT côté client (pour ne plus déclencher “no unique constraint…”)
   REQUIERT:
   - /api/workout?config=1 -> { supabaseUrl, supabaseAnonKey }
   - Tables: profiles, public_profiles, workouts, kudos, achievements, body_scans + view workouts_feed
   - Storage bucket privé: user_uploads (policies OK)
*/

(() => {
  "use strict";

  // =========================
  // 0) Const
  // =========================
  const CLIENT_TOKEN = "fitai-v18";
  const BUCKET = "user_uploads";
  const SIGNED_URL_TTL = 60 * 60; // 1h
  const MAX_IMAGE_MB = 10;
  const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
  const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

  const root =
    document.getElementById("app") ||
    document.getElementById("root") ||
    (() => {
      const d = document.createElement("div");
      d.id = "app";
      document.body.appendChild(d);
      return d;
    })();

  // =========================
  // 1) UI helpers (safe DOM)
  // =========================
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
          } catch {
            node.setAttribute(k, String(v));
          }
        } else {
          node.setAttribute(k, String(v));
        }
      }
      const arr = Array.isArray(children) ? children : [children];
      for (const ch of arr) {
        if (ch === undefined || ch === null) continue;
        node.appendChild(typeof ch === "string" || typeof ch === "number" ? document.createTextNode(String(ch)) : ch);
      }
      return node;
    },

    injectCssOnce() {
      if (document.getElementById("fitai-css")) return;
      const style = ui.el("style", {
        id: "fitai-css",
        text: `
:root{
  --bg:#070812;
  --panel:#0b0f22;
  --panel2:#0a142b;
  --ink:#e9ecff;
  --sub:#b7bde6;
  --indigo:#6c5ce7;
  --lime:#b6ff3b;
  --danger:#ff3b7a;
  --stroke:rgba(182,255,59,.22);
  --stroke2:rgba(108,92,231,.22);
  --shadow:0 10px 40px rgba(0,0,0,.55);
  --r:18px;
  --r2:14px;
  --font:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;
}
*{box-sizing:border-box}
body{margin:0;background:
radial-gradient(1200px 800px at 20% 10%, rgba(108,92,231,.18), transparent 60%),
radial-gradient(1000px 700px at 80% 0%, rgba(182,255,59,.10), transparent 55%), var(--bg);
color:var(--ink);font-family:var(--font)}
a{color:var(--lime)}
.fitai-shell{min-height:100vh}
.fitai-header{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
padding:14px 18px;background:rgba(7,8,18,.72);backdrop-filter:blur(10px);border-bottom:1px solid rgba(182,255,59,.14)}
.fitai-brand{display:flex;gap:12px;align-items:center}
.fitai-brand-mark{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;
background:linear-gradient(135deg, rgba(182,255,59,.16), rgba(108,92,231,.18));
border:1px solid rgba(182,255,59,.25);box-shadow:var(--shadow);color:var(--lime);font-weight:900}
.fitai-brand-title{font-weight:950;letter-spacing:.4px}
.fitai-brand-sub{font-size:12px;color:var(--sub);margin-top:2px}
.fitai-header-right{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.fitai-content{max-width:1120px;margin:0 auto;padding:18px}
.fitai-tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.fitai-tab{background:rgba(255,255,255,.03);border:1px solid rgba(108,92,231,.20);color:var(--ink);
padding:10px 12px;border-radius:999px;cursor:pointer;font-weight:900}
.fitai-tab.active{border-color:rgba(182,255,59,.40);box-shadow:0 0 0 3px rgba(182,255,59,.10)}
.fitai-row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.fitai-col{display:flex;flex-direction:column;gap:14px;min-width:300px;flex:1}
.fitai-card{background:linear-gradient(180deg, rgba(11,15,34,.92), rgba(10,20,43,.88));
border:1px solid rgba(182,255,59,.16);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
.fitai-card-header{padding:14px 14px 0}
.fitai-card-title{font-size:16px;font-weight:950}
.fitai-card-sub{font-size:12px;color:var(--sub);margin-top:4px;line-height:1.35}
.fitai-card-body{padding:14px}
.fitai-card-footer{padding:12px 14px;border-top:1px solid rgba(108,92,231,.14);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.fitai-muted{color:var(--sub);font-size:12px;line-height:1.45}
.fitai-sep{height:1px;background:linear-gradient(90deg, rgba(182,255,59,.18), rgba(108,92,231,.18), transparent);margin:10px 0}
.fitai-input,.fitai-textarea{width:100%;background:rgba(0,0,0,.20);border:1px solid rgba(182,255,59,.18);
color:var(--ink);border-radius:12px;padding:10px 12px;outline:none}
.fitai-input:focus,.fitai-textarea:focus{border-color:rgba(182,255,59,.45);box-shadow:0 0 0 3px rgba(182,255,59,.10)}
.fitai-btn{border:1px solid transparent;border-radius:14px;padding:10px 12px;cursor:pointer;font-weight:950}
.fitai-btn.primary{background:linear-gradient(135deg, rgba(182,255,59,.16), rgba(108,92,231,.22));border-color:rgba(182,255,59,.28);color:var(--ink)}
.fitai-btn.ghost{background:rgba(255,255,255,.04);border-color:rgba(108,92,231,.20);color:var(--ink)}
.fitai-btn.danger{background:rgba(255,59,122,.10);border-color:rgba(255,59,122,.28);color:var(--ink)}
.fitai-btn:disabled{opacity:.55;cursor:not-allowed}
.fitai-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;
background:rgba(182,255,59,.10);border:1px solid rgba(182,255,59,.20);color:var(--lime);font-weight:950;font-size:12px}
.fitai-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:80;
background:rgba(0,0,0,.75);border:1px solid rgba(182,255,59,.20);padding:10px 12px;border-radius:14px;box-shadow:var(--shadow)}
.fitai-toast.err{border-color:rgba(255,59,122,.40)}
.fitai-toast.ok{border-color:rgba(182,255,59,.40)}
.fitai-list{display:flex;flex-direction:column;gap:12px}
.fitai-item{padding:12px;border-radius:14px;border:1px solid rgba(108,92,231,.18);background:rgba(0,0,0,.16)}
.fitai-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.fitai-item-title{font-weight:950}
.fitai-img{width:100%;max-height:440px;object-fit:cover;border-radius:14px;border:1px solid rgba(182,255,59,.16)}
.fitai-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width: 900px){.fitai-compare{grid-template-columns:1fr}}
.fitai-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.70);backdrop-filter:blur(8px);z-index:90;
display:flex;align-items:center;justify-content:center;padding:18px}
.fitai-modal{width:min(1000px, 100%);max-height:86vh;overflow:auto;background:linear-gradient(180deg, rgba(11,15,34,.98), rgba(10,20,43,.96));
border:1px solid rgba(182,255,59,.16);border-radius:var(--r);box-shadow:var(--shadow)}
.fitai-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border-bottom:1px solid rgba(108,92,231,.14)}
.fitai-modal-title{font-weight:950}
.fitai-modal-body{padding:14px}
.fitai-modal-footer{padding:12px 14px;border-top:1px solid rgba(108,92,231,.14);display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.fitai-slider-wrap{position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(182,255,59,.16)}
.fitai-slider-img{display:block;width:100%;max-height:520px;object-fit:cover}
.fitai-slider-top{position:absolute;inset:0;overflow:hidden}
.fitai-slider-range{width:100%}
        `,
      });
      document.head.appendChild(style);
    },

    toast(msg, kind = "info") {
      const old = document.getElementById("fitai-toast");
      if (old) old.remove();
      const t = ui.el("div", { id: "fitai-toast", class: `fitai-toast ${kind === "error" ? "err" : kind === "success" ? "ok" : ""}`, text: msg });
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2600);
    },

    btn(label, variant = "primary", onClick = null, disabled = false) {
      return ui.el("button", {
        class: `fitai-btn ${variant === "danger" ? "danger" : variant === "ghost" ? "ghost" : "primary"}`,
        type: "button",
        disabled: !!disabled,
        on: onClick ? { click: onClick } : undefined,
      }, [label]);
    },

    card(title, subtitle, bodyNodes = [], footerNodes = []) {
      return ui.el("div", { class: "fitai-card" }, [
        ui.el("div", { class: "fitai-card-header" }, [
          ui.el("div", { class: "fitai-card-title", text: title || "" }),
          subtitle ? ui.el("div", { class: "fitai-card-sub", text: subtitle }) : null,
        ]),
        ui.el("div", { class: "fitai-card-body" }, bodyNodes),
        footerNodes.length ? ui.el("div", { class: "fitai-card-footer" }, footerNodes) : null,
      ]);
    },

    modal(title, bodyNodes = [], footerNodes = [], onClose = null) {
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
          ui.btn("✕", "ghost", () => (typeof onClose === "function" ? onClose() : null)),
        ]),
        ui.el("div", { class: "fitai-modal-body" }, bodyNodes),
        footerNodes.length ? ui.el("div", { class: "fitai-modal-footer" }, footerNodes) : null,
      ]);
      overlay.appendChild(box);
      return overlay;
    },
  };

  // =========================
  // 2) Supabase loader (robuste)
  // =========================
  async function getCreateClient() {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      return window.supabase.createClient;
    }
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    return mod.createClient;
  }

  async function fetchConfig() {
    const r = await fetch("/api/workout?config=1", {
      method: "GET",
      headers: { "X-FitAI-Client": CLIENT_TOKEN },
    });
    if (!r.ok) throw new Error(`Config failed (${r.status})`);
    const data = await r.json().catch(() => null);
    if (!data?.supabaseUrl || !data?.supabaseAnonKey) throw new Error("Invalid config payload.");
    return data;
  }

  // =========================
  // 3) Utils
  // =========================
  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch {
      return String(iso || "");
    }
  }

  function clampText(s, max = 220) {
    const str = String(s || "");
    return str.length <= max ? str : str.slice(0, max - 1) + "…";
  }

  function uuid12() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "").slice(0, 12);
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  async function readImageDims(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("Image load failed"));
      });
      return { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    } finally {
      try { URL.revokeObjectURL(url); } catch {}
    }
  }

  async function resizeToJpeg(file, maxDim = 1600, quality = 0.86) {
    // Convert to JPEG for bandwidth (good enough for body scan)
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return file;

    const w0 = bmp.width, h0 = bmp.height;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(bmp, 0, 0, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;
    return new File([blob], `bodyscan_${Date.now()}.jpg`, { type: "image/jpeg" });
  }

  // =========================
  // 4) App State
  // =========================
  const state = {
    cfg: null,
    sb: null,
    session: null,
    user: null,

    activeTab: "dash",
    busy: false,

    profile: null,
    publicProfile: null,

    feed: [],
    liked: new Set(),

    bodyScans: [],
    signedCache: new Map(), // path -> { url, expMs }
  };

  function setBusy(v) {
    state.busy = !!v;
    const b = document.getElementById("fitai-busy");
    if (b) b.style.display = state.busy ? "inline-flex" : "none";
  }

  // =========================
  // 5) Render
  // =========================
  function renderShell(contentNode, headerRightNodes = []) {
    const header = ui.el("div", { class: "fitai-header" }, [
      ui.el("div", { class: "fitai-brand" }, [
        ui.el("div", { class: "fitai-brand-mark", text: "F" }),
        ui.el("div", {}, [
          ui.el("div", { class: "fitai-brand-title", text: "FitAI" }),
          ui.el("div", { class: "fitai-brand-sub", text: "Cyberpunk Coach" }),
        ]),
      ]),
      ui.el("div", { class: "fitai-header-right" }, headerRightNodes),
    ]);

    return ui.el("div", { class: "fitai-shell" }, [
      header,
      ui.el("div", { class: "fitai-content" }, [contentNode]),
    ]);
  }

  function tabBtn(label, key) {
    const active = state.activeTab === key;
    return ui.el("button", {
      class: active ? "fitai-tab active" : "fitai-tab",
      type: "button",
      on: { click: () => { state.activeTab = key; render(); } },
    }, [label]);
  }

  function renderTabs() {
    return ui.el("div", { class: "fitai-tabs" }, [
      tabBtn("Dash", "dash"),
      tabBtn("Coach", "coach"),
      tabBtn("Nutrition", "nutrition"),
      tabBtn("Communauté", "community"),
      tabBtn("Body Scan", "bodyscan"),
      tabBtn("Profil", "profile"),
    ]);
  }

  function renderAuthedHeaderRight() {
    const email = state.user?.email ? clampText(state.user.email, 26) : "Connecté";
    const sync = ui.el("span", { id: "fitai-busy", class: "fitai-badge", text: "SYNC" });
    sync.style.display = state.busy ? "inline-flex" : "none";
    return [
      ui.el("span", { class: "fitai-badge", text: email }),
      sync,
      ui.btn("Déconnexion", "ghost", async () => {
        try {
          setBusy(true);
          await state.sb.auth.signOut();
          ui.toast("Déconnecté.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur"), "error");
        } finally {
          setBusy(false);
        }
      }),
    ];
  }

  function viewAuth() {
    const email = ui.el("input", { class: "fitai-input", type: "email", placeholder: "Email", autocomplete: "email" });
    const hint = ui.el("div", { class: "fitai-muted", text: "Magic link (recommandé). Vérifie aussi tes spams." });

    const btn = ui.btn("Envoyer Magic Link", "primary", async () => {
      const em = String(email.value || "").trim();
      if (!em) return ui.toast("Email requis.", "error");

      try {
        setBusy(true);
        const { error } = await state.sb.auth.signInWithOtp({
          email: em,
          options: {
            // IMPORTANT: rend le lien beaucoup plus fiable sur Vercel
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        ui.toast("Magic link envoyé ✅", "success");
        hint.textContent = "Ouvre le mail sur le même navigateur/appareil si possible.";
      } catch (e) {
        ui.toast(String(e?.message || e || "Erreur"), "error");
      } finally {
        setBusy(false);
      }
    });

    // Si Supabase a renvoyé un hash error (#error=...)
    const hash = String(window.location.hash || "");
    const errLine = hash.includes("error=")
      ? ui.el("div", {
          class: "fitai-muted",
          style: { color: "rgba(255,59,122,.95)", fontWeight: "900" },
          text: "Erreur Magic Link détectée dans l’URL. Regénère un lien (il expire vite).",
        })
      : null;

    const card = ui.card(
      "Connexion FitAI",
      "Supabase Auth (Magic Link)",
      [
        errLine,
        ui.el("div", { class: "fitai-muted", text: "Email" }),
        email,
        ui.el("div", { class: "fitai-sep" }),
        hint,
      ].filter(Boolean),
      [btn]
    );

    return renderShell(ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [card]),
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Note", "Si ton pote voit “otp_expired”", [
          ui.el("div", { class: "fitai-muted", text:
            "1) Le lien a expiré OU a été utilisé déjà.\n2) Dans Supabase → Auth → URL Configuration: Site URL = https://fit-ai-livid.vercel.app et ajoute ce domaine dans Redirect URLs.\n3) Regénérer un seul magic link et l’ouvrir immédiatement."
          }),
        ]),
      ]),
    ]));
  }

  function viewDash() {
    const k = state.profile?.kpis || null;
    const r = k ? Math.round(Number(k.recovery || 0)) : null;
    const w = k ? Number(k.weight || 0).toFixed(1) : null;
    const s = k ? Number(k.sleep || 0).toFixed(2) : null;

    const card = ui.card("Dashboard", "KPIs + état compte", [
      ui.el("div", { class: "fitai-row" }, [
        ui.el("div", { class: "fitai-col" }, [
          ui.el("div", { class: "fitai-item" }, [
            ui.el("div", { class: "fitai-item-title", text: "Recovery" }),
            ui.el("div", { class: "fitai-muted", text: r == null ? "--" : `${r}%` }),
          ]),
        ]),
        ui.el("div", { class: "fitai-col" }, [
          ui.el("div", { class: "fitai-item" }, [
            ui.el("div", { class: "fitai-item-title", text: "Poids" }),
            ui.el("div", { class: "fitai-muted", text: w == null ? "--" : `${w} kg` }),
          ]),
        ]),
        ui.el("div", { class: "fitai-col" }, [
          ui.el("div", { class: "fitai-item" }, [
            ui.el("div", { class: "fitai-item-title", text: "Sommeil" }),
            ui.el("div", { class: "fitai-muted", text: s == null ? "--" : `${s} h` }),
          ]),
        ]),
      ]),
      ui.el("div", { class: "fitai-sep" }),
      ui.el("div", { class: "fitai-muted", text: `User: ${state.user?.id || ""}` }),
    ]);

    return ui.el("div", { class: "fitai-row" }, [ui.el("div", { class: "fitai-col" }, [card])]);
  }

  function viewCoach() {
    const prompt = ui.el("textarea", { class: "fitai-textarea", rows: 6, placeholder: "Ex: Full body 45min, focus force, douleur épaule légère…" });
    const out = ui.el("textarea", { class: "fitai-textarea", rows: 12, placeholder: "Résultat…", readOnly: true });

    const btn = ui.btn("Générer (API)", "primary", async () => {
      const p = String(prompt.value || "").trim();
      if (!p) return ui.toast("Décris ta séance.", "error");

      try {
        setBusy(true);
        out.value = "Génération en cours…";

        const r = await fetch("/api/workout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-FitAI-Client": CLIENT_TOKEN },
          body: JSON.stringify({ prompt: p, userId: state.user.id }),
        });

        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`API error ${r.status} ${t}`);
        }

        const data = await r.json().catch(() => null);
        out.value = typeof data === "string" ? data : JSON.stringify(data, null, 2);
        ui.toast("OK", "success");
      } catch (e) {
        out.value = "";
        ui.toast(String(e?.message || e || "Erreur"), "error");
      } finally {
        setBusy(false);
      }
    });

    return ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Coach IA", "Génère via /api/workout", [
          ui.el("div", { class: "fitai-muted", text: "Prompt" }),
          prompt,
          ui.el("div", { class: "fitai-sep" }),
          ui.el("div", { class: "fitai-muted", text: "Output" }),
          out,
        ], [btn]),
      ]),
    ]);
  }

  function viewNutrition() {
    return ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Nutrition", "À revoir (recettes via ingrédients)", [
          ui.el("div", { class: "fitai-muted", text: "Prochaine étape: tu écris tes ingrédients → l’IA sort une recette structurée + macros." }),
        ]),
      ]),
    ]);
  }

  function viewCommunity() {
    const list = ui.el("div", { class: "fitai-list" }, [
      ui.el("div", { class: "fitai-muted", text: "Chargement du feed…" }),
    ]);

    const refresh = ui.btn("Rafraîchir", "ghost", async () => {
      await hydrateFeed(list);
    });

    hydrateFeed(list).catch(() => void 0);

    return ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Communauté", "workouts_feed", [list], [refresh]),
      ]),
    ]);
  }

  async function hydrateFeed(listNode) {
    try {
      setBusy(true);
      listNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "SYNC…" }));

      const { data, error } = await state.sb.from("workouts_feed").select("*").order("created_at", { ascending: false }).limit(40);
      if (error) throw error;

      const items = Array.isArray(data) ? data : [];
      if (!items.length) {
        listNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Aucune séance publique." }));
        return;
      }

      const nodes = items.map((it) => {
        const title = it.title || "Workout";
        const when = it.created_at ? fmtDate(it.created_at) : "";
        const user = it.user_display || String(it.user_id || "").slice(0, 8) + "…";
        const kudos = Number(it.kudos_count || 0);

        return ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: title }),
            ui.el("span", { class: "fitai-badge", text: `${kudos} kudos` }),
          ]),
          ui.el("div", { class: "fitai-muted", text: `${user} • ${when}` }),
          it.badges ? ui.el("div", { class: "fitai-muted", text: `🏆 ${String(it.badges)}` }) : null,
        ].filter(Boolean));
      });

      listNode.replaceChildren(...nodes);
    } catch (e) {
      listNode.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur feed." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("Erreur feed", "error");
    } finally {
      setBusy(false);
    }
  }

  function viewProfile() {
    const name = ui.el("input", { class: "fitai-input", placeholder: "Pseudo", value: state.publicProfile?.display_name || "" });
    const age = ui.el("input", { class: "fitai-input", type: "number", placeholder: "Âge", value: state.profile?.age ?? "" });
    const weight = ui.el("input", { class: "fitai-input", type: "number", step: "0.1", placeholder: "Poids (kg)", value: state.profile?.weight ?? "" });
    const height = ui.el("input", { class: "fitai-input", type: "number", step: "0.1", placeholder: "Taille (cm)", value: state.profile?.height ?? "" });

    const eq = {
      dumbbells: !!state.profile?.equipment?.dumbbells,
      barbell: !!state.profile?.equipment?.barbell,
      bodyweight: state.profile?.equipment?.bodyweight !== false,
      machines: !!state.profile?.equipment?.machines,
    };

    const cb = (label, key) => {
      const input = ui.el("input", { type: "checkbox", checked: !!eq[key] });
      input.addEventListener("change", () => { eq[key] = !!input.checked; });
      return ui.el("label", { class: "fitai-item", style: { display: "flex", gap: "10px", alignItems: "center" } }, [
        input,
        ui.el("div", { class: "fitai-item-title", text: label }),
      ]);
    };

    const saveBtn = ui.btn("Sauvegarder profil", "primary", async () => {
      try {
        setBusy(true);

        // profiles: update (no upsert) + insert fallback
        const updates = {
          age: age.value ? Number(age.value) : null,
          weight: weight.value ? Number(weight.value) : null,
          height: height.value ? Number(height.value) : null,
          equipment: { ...eq },
        };

        // 1) try update
        const u1 = await state.sb.from("profiles").update(updates).eq("user_id", state.user.id).select("user_id").maybeSingle();
        if (u1.error) throw u1.error;

        // if no row updated (maybe missing), insert
        if (!u1.data?.user_id) {
          const ins = await state.sb.from("profiles").insert({ user_id: state.user.id, ...updates }).select("user_id").maybeSingle();
          if (ins.error) throw ins.error;
        }

        // public_profiles: update then insert fallback
        const dn = String(name.value || "").trim();
        const u2 = await state.sb.from("public_profiles").update({ display_name: dn }).eq("user_id", state.user.id).select("user_id").maybeSingle();
        if (u2.error) throw u2.error;
        if (!u2.data?.user_id) {
          const ins2 = await state.sb.from("public_profiles").insert({ user_id: state.user.id, display_name: dn }).select("user_id").maybeSingle();
          if (ins2.error) throw ins2.error;
        }

        ui.toast("✅ Sauvegardé", "success");
        await loadProfile();
        render();
      } catch (e) {
        ui.toast(String(e?.message || e || "Erreur sauvegarde"), "error");
      } finally {
        setBusy(false);
      }
    });

    return ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Profil", "Infos + équipement (sans upsert)", [
          ui.el("div", { class: "fitai-muted", text: "Pseudo" }),
          name,
          ui.el("div", { class: "fitai-muted", style: { marginTop: "10px" }, text: "Âge" }),
          age,
          ui.el("div", { class: "fitai-muted", style: { marginTop: "10px" }, text: "Poids (kg)" }),
          weight,
          ui.el("div", { class: "fitai-muted", style: { marginTop: "10px" }, text: "Taille (cm)" }),
          height,
          ui.el("div", { class: "fitai-sep" }),
          ui.el("div", { class: "fitai-muted", text: "Équipement" }),
          cb("Haltères", "dumbbells"),
          cb("Barre", "barbell"),
          cb("Poids du corps", "bodyweight"),
          cb("Machines", "machines"),
        ], [saveBtn]),
      ]),
    ]);
  }

  // =========================
  // 6) Body Scan UI + logic
  // =========================
  function viewBodyScan() {
    const fileInput = ui.el("input", { class: "fitai-input", type: "file", accept: "image/jpeg,image/png,image/webp" });
    const info = ui.el("div", { class: "fitai-muted", text: `Max ${MAX_IMAGE_MB}MB • JPG/PNG/WEBP • Reco: photo cadrée plein corps.` });

    const preview = ui.el("img", { class: "fitai-img", alt: "Preview" });
    preview.style.display = "none";

    const timeline = ui.el("div", { class: "fitai-list" }, [
      ui.el("div", { class: "fitai-muted", text: "Chargement…" }),
    ]);

    const btnUpload = ui.btn("Uploader + analyser (Gemini)", "primary", async () => {
      const f = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (!f) return ui.toast("Choisis une image.", "error");
      await uploadAndAnalyze(f, timeline, fileInput, preview, info);
    }, true);

    const btnRefresh = ui.btn("Rafraîchir", "ghost", async () => {
      await hydrateBodyScans(timeline);
    });

    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (!f) {
        preview.style.display = "none";
        btnUpload.disabled = true;
        return;
      }

      if (!ALLOWED_MIME.has(String(f.type || "").toLowerCase())) {
        ui.toast("Format non supporté.", "error");
        fileInput.value = "";
        preview.style.display = "none";
        btnUpload.disabled = true;
        return;
      }

      if (f.size > MAX_IMAGE_BYTES) {
        ui.toast(`Image trop lourde (> ${MAX_IMAGE_MB}MB).`, "error");
        fileInput.value = "";
        preview.style.display = "none";
        btnUpload.disabled = true;
        return;
      }

      // dimensions mini
      try {
        const { w, h } = await readImageDims(f);
        if (w < 400 || h < 700) {
          ui.toast("Résolution trop faible (min ~400x700).", "error");
          fileInput.value = "";
          preview.style.display = "none";
          btnUpload.disabled = true;
          return;
        }
      } catch {
        // ignore
      }

      // preview
      const url = URL.createObjectURL(f);
      preview.src = url;
      preview.style.display = "block";
      info.textContent = `${f.name} • ${(f.size / (1024 * 1024)).toFixed(2)}MB • ${f.type}`;
      btnUpload.disabled = false;
    });

    // initial load
    hydrateBodyScans(timeline).catch(() => void 0);

    return ui.el("div", { class: "fitai-row" }, [
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Body Scan", "Privé (bucket) • Signed URLs • Analyse Gemini via /api/bodyscan", [
          ui.el("div", { class: "fitai-muted", text: "Upload" }),
          fileInput,
          ui.el("div", { class: "fitai-sep" }),
          info,
          ui.el("div", { style: { marginTop: "10px" } }, [preview]),
        ], [btnRefresh, btnUpload]),
      ]),
      ui.el("div", { class: "fitai-col" }, [
        ui.card("Timeline", "Compare avec le précédent + feedback enregistré", [timeline]),
      ]),
    ]);
  }

  async function getSignedUrl(path) {
    const now = Date.now();
    const c = state.signedCache.get(path);
    if (c && c.url && c.expMs && c.expMs - now > 60_000) return c.url;

    const { data, error } = await state.sb.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) throw error || new Error("Signed URL failed");
    const expMs = now + SIGNED_URL_TTL * 1000;
    state.signedCache.set(path, { url: data.signedUrl, expMs });
    return data.signedUrl;
  }

  async function hydrateBodyScans(timelineNode) {
    try {
      setBusy(true);
      timelineNode.replaceChildren(ui.el("div", { class: "fitai-muted", text: "SYNC…" }));

      const { data, error } = await state.sb
        .from("body_scans")
        .select("id,user_id,image_path,ai_feedback,ai_version,created_at,symmetry_score,posture_score,bodyfat_proxy")
        .eq("user_id", state.user.id)
        .order("created_at", { ascending: false })
        .limit(60);

      if (error) throw error;
      state.bodyScans = Array.isArray(data) ? data : [];

      if (!state.bodyScans.length) {
        timelineNode.replaceChildren(
          ui.el("div", { class: "fitai-muted", text: "Aucun scan. Ajoute ton premier." })
        );
        return;
      }

      const nodes = [];
      for (let i = 0; i < state.bodyScans.length; i++) {
        const scan = state.bodyScans[i];
        const prev = i + 1 < state.bodyScans.length ? state.bodyScans[i + 1] : null;

        let url = "";
        try { url = await getSignedUrl(scan.image_path); } catch {}

        const img = ui.el("img", { class: "fitai-img", alt: "Body scan" });
        if (url) img.src = url;

        const scores =
          scan.symmetry_score != null
            ? `Sym ${Math.round(Number(scan.symmetry_score))} • Post ${Math.round(Number(scan.posture_score))} • Sèche ${Math.round(Number(scan.bodyfat_proxy))}`
            : "Scores: —";

        const btnCompare = ui.btn("Comparer", "ghost", async () => {
          if (!prev) return;
          try {
            setBusy(true);
            const [a, b] = await Promise.all([getSignedUrl(scan.image_path), getSignedUrl(prev.image_path)]);
            const modal = buildCompareModal({
              current: scan,
              prev,
              urlCurrent: a,
              urlPrev: b,
              onClose: () => modal.remove(),
            });
            document.body.appendChild(modal);
          } catch (e) {
            ui.toast(String(e?.message || e || "Erreur compare"), "error");
          } finally {
            setBusy(false);
          }
        }, !prev);

        const btnDelete = ui.btn("Supprimer", "danger", async () => {
          const ok = window.confirm("Supprimer ce scan ? (fichier + DB)");
          if (!ok) return;
          try {
            setBusy(true);
            await deleteScan(scan);
            ui.toast("Supprimé.", "success");
            await hydrateBodyScans(timelineNode);
          } catch (e) {
            ui.toast(String(e?.message || e || "Erreur suppression"), "error");
          } finally {
            setBusy(false);
          }
        });

        nodes.push(
          ui.el("div", { class: "fitai-item" }, [
            ui.el("div", { class: "fitai-item-head" }, [
              ui.el("div", { class: "fitai-item-title", text: fmtDate(scan.created_at) }),
              ui.el("span", { class: "fitai-badge", text: prev ? "COMPARE" : "LATEST" }),
            ]),
            ui.el("div", { class: "fitai-muted", text: scan.ai_version ? `Model: ${scan.ai_version}` : "Model: —" }),
            ui.el("div", { class: "fitai-muted", text: scores }),
            ui.el("div", { class: "fitai-sep" }),
            url ? img : ui.el("div", { class: "fitai-muted", text: "Signed URL indisponible (policy/storage)." }),
            ui.el("div", { class: "fitai-sep" }),
            ui.el("div", { class: "fitai-muted", text: scan.ai_feedback ? clampText(scan.ai_feedback, 300) : "—" }),
            ui.el("div", { class: "fitai-sep" }),
            ui.el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } }, [btnCompare, btnDelete]),
          ])
        );
      }

      timelineNode.replaceChildren(...nodes);
    } catch (e) {
      timelineNode.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur lecture body_scans." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("BodyScan KO", "error");
    } finally {
      setBusy(false);
    }
  }

  function buildCompareModal({ current, prev, urlCurrent, urlPrev, onClose }) {
    // Slider overlay (wow simple)
    const base = ui.el("img", { class: "fitai-slider-img", alt: "Précédent" });
    base.src = urlPrev;

    const topImg = ui.el("img", { class: "fitai-slider-img", alt: "Actuel" });
    topImg.src = urlCurrent;

    const topWrap = ui.el("div", { class: "fitai-slider-top" }, [topImg]);
    topWrap.style.clipPath = "inset(0 50% 0 0)";

    const slider = ui.el("input", { class: "fitai-slider-range", type: "range", min: "0", max: "100", value: "50" });
    slider.addEventListener("input", () => {
      const v = Number(slider.value || 50);
      topWrap.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    });

    const wrap = ui.el("div", { class: "fitai-slider-wrap" }, [base, topWrap]);

    const body = [
      ui.el("div", { class: "fitai-muted", text: `Actuel: ${fmtDate(current.created_at)} — Précédent: ${fmtDate(prev.created_at)}` }),
      ui.el("div", { class: "fitai-sep" }),
      wrap,
      ui.el("div", { style: { marginTop: "10px" } }, [slider]),
      ui.el("div", { class: "fitai-sep" }),
      ui.el("div", { class: "fitai-muted", text: "Actuel (feedback)" }),
      ui.el("div", { class: "fitai-muted", text: current.ai_feedback || "—" }),
      ui.el("div", { class: "fitai-sep" }),
      ui.el("div", { class: "fitai-muted", text: "Précédent (feedback)" }),
      ui.el("div", { class: "fitai-muted", text: prev.ai_feedback || "—" }),
    ];

    const modal = ui.modal("Comparaison Body Scan", body, [
      ui.btn("Fermer", "ghost", () => (typeof onClose === "function" ? onClose() : modal.remove())),
    ], () => (typeof onClose === "function" ? onClose() : modal.remove()));

    return modal;
  }

  async function deleteScan(scan) {
    if (!scan?.id || !scan?.image_path) throw new Error("Scan invalide");

    // 1) storage remove
    const rm = await state.sb.storage.from(BUCKET).remove([scan.image_path]);
    if (rm.error) throw rm.error;

    // 2) db delete
    const del = await state.sb.from("body_scans").delete().eq("id", scan.id).eq("user_id", state.user.id);
    if (del.error) throw del.error;

    state.signedCache.delete(scan.image_path);
  }

  async function uploadAndAnalyze(file, timelineNode, fileInput, preview, infoNode) {
    if (!state.user) return ui.toast("Non connecté.", "error");

    const mime = String(file.type || "").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return ui.toast("Format non supporté.", "error");
    if (file.size > MAX_IMAGE_BYTES) return ui.toast(`Image trop lourde (> ${MAX_IMAGE_MB}MB).`, "error");

    try {
      setBusy(true);

      // Resize/compress client-side (garde la vie en 4G)
      const optimized = await resizeToJpeg(file, 1600, 0.86);
      if (optimized.size > MAX_IMAGE_BYTES) throw new Error("Image encore trop lourde après compression.");

      const name = `bodyscans/${uuid12()}_${Date.now()}.jpg`;
      const path = `${state.user.id}/${name}`;

      // Upload Storage (private bucket)
      const up = await state.sb.storage.from(BUCKET).upload(path, optimized, {
        cacheControl: "3600",
        upsert: false,
        contentType: "image/jpeg",
      });
      if (up.error) throw up.error;

      // Insert DB row (IA en cours)
      const ins = await state.sb.from("body_scans").insert({
        user_id: state.user.id,
        image_path: path,
        ai_version: "pending",
        ai_feedback: "Analyse en cours…",
      }).select("id").maybeSingle();
      if (ins.error) throw ins.error;

      // Call /api/bodyscan (Gemini) -> update row
      const token = state.session?.access_token || "";
      if (!token) throw new Error("Session token manquant (reco: relog).");

      const r = await fetch("/api/bodyscan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: state.user.id, image_path: path }),
      });

      const payload = await r.json().catch(() => null);
      if (!r.ok || !payload?.ok) {
        throw new Error(payload?.error || `bodyscan API error (${r.status})`);
      }

      ui.toast("✅ Analyse terminée", "success");

      // reset input
      fileInput.value = "";
      preview.src = "";
      preview.style.display = "none";
      infoNode.textContent = `Max ${MAX_IMAGE_MB}MB • JPG/PNG/WEBP • Reco: photo cadrée plein corps.`;

      await hydrateBodyScans(timelineNode);
    } catch (e) {
      ui.toast(String(e?.message || e || "Erreur body scan"), "error");
    } finally {
      setBusy(false);
    }
  }

  // =========================
  // 7) Data loaders
  // =========================
  async function ensureProfileRows() {
    if (!state.user) return;

    // profiles
    const p = await state.sb.from("profiles").select("user_id,kpis,equipment,last_workout_date,age,weight,height").eq("user_id", state.user.id).maybeSingle();
    if (p.error) throw p.error;

    if (!p.data) {
      const ins = await state.sb.from("profiles").insert({
        user_id: state.user.id,
        kpis: { recovery: 70, weight: 70, sleep: 7 },
        equipment: { bodyweight: true },
      }).select("*").maybeSingle();
      if (ins.error) throw ins.error;
      state.profile = ins.data;
    } else {
      state.profile = p.data;
    }

    // public_profiles
    const pub = await state.sb.from("public_profiles").select("user_id,display_name").eq("user_id", state.user.id).maybeSingle();
    if (pub.error) throw pub.error;
    if (!pub.data) {
      const ins2 = await state.sb.from("public_profiles").insert({ user_id: state.user.id, display_name: "" }).select("*").maybeSingle();
      if (ins2.error) throw ins2.error;
      state.publicProfile = ins2.data;
    } else {
      state.publicProfile = pub.data;
    }
  }

  async function loadProfile() {
    if (!state.user) return;
    const p = await state.sb.from("profiles").select("*").eq("user_id", state.user.id).maybeSingle();
    if (!p.error) state.profile = p.data || null;
    const pub = await state.sb.from("public_profiles").select("*").eq("user_id", state.user.id).maybeSingle();
    if (!pub.error) state.publicProfile = pub.data || null;
  }

  // =========================
  // 8) Router render
  // =========================
  function render() {
    ui.injectCssOnce();

    if (!state.user) {
      root.replaceChildren(viewAuth());
      return;
    }

    const tabs = renderTabs();

    let content = null;
    if (state.activeTab === "dash") content = viewDash();
    else if (state.activeTab === "coach") content = viewCoach();
    else if (state.activeTab === "nutrition") content = viewNutrition();
    else if (state.activeTab === "community") content = viewCommunity();
    else if (state.activeTab === "bodyscan") content = viewBodyScan();
    else if (state.activeTab === "profile") content = viewProfile();
    else content = viewDash();

    const page = renderShell(ui.el("div", {}, [tabs, content]), renderAuthedHeaderRight());
    root.replaceChildren(page);
  }

  // =========================
  // 9) Boot
  // =========================
  async function boot() {
    ui.injectCssOnce();
    root.replaceChildren(renderShell(ui.card("FitAI", "Boot…", [ui.el("div", { class: "fitai-muted", text: "Chargement config + Supabase…" })])));

    state.cfg = await fetchConfig();
    const createClient = await getCreateClient();

    state.sb = createClient(state.cfg.supabaseUrl, state.cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const { data } = await state.sb.auth.getSession();
    state.session = data.session || null;
    state.user = data.session?.user || null;

    state.sb.auth.onAuthStateChange(async (_evt, sess) => {
      state.session = sess || null;
      state.user = sess?.user || null;

      if (state.user) {
        try {
          setBusy(true);
          await ensureProfileRows();
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur profil"), "error");
        } finally {
          setBusy(false);
        }
      } else {
        state.profile = null;
        state.publicProfile = null;
        state.bodyScans = [];
        state.signedCache.clear();
      }

      render();
    });

    if (state.user) {
      try {
        setBusy(true);
        await ensureProfileRows();
      } finally {
        setBusy(false);
      }
    }

    render();
  }

  document.addEventListener("DOMContentLoaded", () => {
    boot().catch((e) => {
      ui.injectCssOnce();
      root.replaceChildren(
        renderShell(
          ui.card("Erreur boot FitAI", "Ton JS crashait, là on te montre l’erreur.", [
            ui.el("div", { class: "fitai-muted", text: String(e?.message || e || e) }),
            ui.el("div", { class: "fitai-muted", text: "Ouvre la console (F12) pour le stack." }),
          ])
        )
      );
    });
  });
})();
