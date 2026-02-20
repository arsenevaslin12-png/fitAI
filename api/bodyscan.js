/* public/app.js
   FitAI Pro v10 — Cyberpunk Lime/Indigo — Supabase v2
   FIXES:
   - Onglet Body Scan (upload + DB + appel /api/bodyscan + timeline + compare slider)
   - Onglet Trophées (achievements) avec icônes SVG (pas d’emoji)
   - Boutons qui “ne marchent plus” : supprime TOUT markup ``` dans tes fichiers (ça casse JS). Cette version n’en contient pas.

   ATTEND:
   - window.SUPABASE_URL
   - window.SUPABASE_ANON_KEY (ou publishable key)
   - Tables: profiles, public_profiles, achievements, workouts_feed, body_scans
   - Storage bucket privé: user_uploads
   - API routes: /api/workout, /api/bodyscan
*/

(() => {
  "use strict";

  /* =========================
     0) Config
     ========================= */

  const APP_NAME = "FitAI";
  const BUCKET = "user_uploads";
  const SIGNED_URL_TTL_SECONDS = 60 * 30; // 30 min

  const SUPABASE_URL = String(window.SUPABASE_URL || "").trim();
  const SUPABASE_ANON_KEY = String(window.SUPABASE_ANON_KEY || window.SUPABASE_PUBLISHABLE_KEY || "").trim();

  const root =
    document.getElementById("app") ||
    document.getElementById("root") ||
    document.body;

  const hasSupabaseGlobal = typeof window.supabase !== "undefined";
  const hasCreateClient = hasSupabaseGlobal && typeof window.supabase.createClient === "function";

  const state = {
    supabase: null,
    session: null,
    user: null,

    activeTab: "dashboard",

    busy: false,
    toastTimer: null,

    profile: null,
    publicProfile: null,

    feed: [],
    achievements: [],

    bodyScans: [],
    signedUrlCache: new Map(), // path -> { url, expiresAtMs }

    // Focus Mode
    focus: {
      seconds: 10 * 60,
      running: false,
      endAt: 0,
      tickTimer: null,
      lastBeepAt: 0,
      audioAllowed: false,
      audioCtx: null,
      osc: null,
    },
  };

  function bootFail(message) {
    root.replaceChildren(
      ui.pageShell({
        headerRight: null,
        content: ui.card({
          title: "Configuration requise",
          body: [
            ui.p(message),
            ui.p("Vérifie que Supabase v2 est chargé et que SUPABASE_URL / SUPABASE_ANON_KEY sont définis dans public/index.html."),
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
     1) UI helpers (safe DOM)
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
        if (typeof ch === "string" || typeof ch === "number") node.appendChild(document.createTextNode(String(ch)));
        else node.appendChild(ch);
      }
      return node;
    },

    svgIcon(name, size = 18) {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.classList.add("fitai-ico");

      function p(d) {
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
      }
      function c(cx, cy, r) {
        const circ = document.createElementNS(ns, "circle");
        circ.setAttribute("cx", String(cx));
        circ.setAttribute("cy", String(cy));
        circ.setAttribute("r", String(r));
        svg.appendChild(circ);
      }
      function l(x1, y1, x2, y2) {
        const line = document.createElementNS(ns, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
        svg.appendChild(line);
      }

      // Minimal icon set (clean, no emoji)
      if (name === "trophy") {
        p("M8 21h8");
        p("M12 17v4");
        p("M7 4h10v3a5 5 0 0 1-10 0V4Z");
        p("M17 7h1a3 3 0 0 1 0 6h-2");
        p("M7 7H6a3 3 0 0 0 0 6h2");
      } else if (name === "star") {
        p("M12 2l3 7h7l-5.5 4.2L18.5 21 12 16.8 5.5 21l2-7.8L2 9h7z");
      } else if (name === "target") {
        c(12, 12, 9);
        c(12, 12, 5);
        c(12, 12, 1.5);
      } else if (name === "bolt") {
        p("M13 2L3 14h7l-1 8 10-12h-7z");
      } else if (name === "shield") {
        p("M12 2l8 4v6c0 5-3.5 9-8 10C7.5 21 4 17 4 12V6l8-4z");
      } else if (name === "camera") {
        p("M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3l2-3h6l2 3h3a2 2 0 0 1 2 2z");
        c(12, 13, 4);
      } else if (name === "upload") {
        p("M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");
        p("M7 10l5-5 5 5");
        p("M12 5v12");
      } else if (name === "spark") {
        p("M12 2l1.5 5L19 9l-5.5 2L12 16l-1.5-5L5 9l5.5-2z");
      } else if (name === "chart") {
        p("M4 19V5");
        p("M4 19h16");
        p("M7 15l3-3 3 2 4-5");
      } else {
        // fallback dot
        c(12, 12, 3);
      }
      return svg;
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

    badge(text, iconName) {
      const bits = [];
      if (iconName) bits.push(ui.svgIcon(iconName, 16));
      bits.push(ui.el("span", { text }));
      return ui.el("span", { class: "fitai-badge" }, bits);
    },

    btn(label, opts = {}) {
      const { variant = "primary", onClick, disabled = false, type = "button", title, leftIcon } = opts;

      const cls =
        variant === "ghost"
          ? "fitai-btn fitai-btn-ghost"
          : variant === "danger"
          ? "fitai-btn fitai-btn-danger"
          : "fitai-btn fitai-btn-primary";

      const children = [];
      if (leftIcon) children.push(ui.svgIcon(leftIcon, 18));
      children.push(ui.el("span", { text: label }));

      return ui.el(
        "button",
        {
          class: cls,
          type,
          disabled: !!disabled,
          title: title ? String(title) : "",
          on: onClick ? { click: onClick } : undefined,
        },
        children
      );
    },

    input(opts = {}) {
      const { type = "text", placeholder = "", value = "", onInput, onChange, autocomplete, min, max, step } = opts;
      return ui.el("input", {
        class: "fitai-input",
        type,
        placeholder,
        value,
        min: min != null ? String(min) : undefined,
        max: max != null ? String(max) : undefined,
        step: step != null ? String(step) : undefined,
        autocomplete: autocomplete || "off",
        on: { input: onInput || undefined, change: onChange || undefined },
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

    navTab(label, key, iconName) {
      const active = state.activeTab === key;
      const cls = active ? "fitai-tab fitai-tab-active" : "fitai-tab";
      return ui.el(
        "button",
        {
          class: cls,
          type: "button",
          on: { click: () => ((state.activeTab = key), render()) },
        },
        [iconName ? ui.svgIcon(iconName, 18) : null, ui.el("span", { text: label })]
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
      state.toastTimer = window.setTimeout(() => toast.remove(), 2600);
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
          ui.btn("Fermer", { variant: "ghost", onClick: () => (typeof onClose === "function" ? onClose() : null) }),
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
.fitai-content{max-width:1160px;margin:0 auto;padding:18px}
.fitai-row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.fitai-col{display:flex;flex-direction:column;gap:14px;min-width:300px;flex:1}
.fitai-card{background:linear-gradient(180deg, rgba(11,15,34,.92), rgba(10,20,43,.88));
border:1px solid rgba(182,255,59,.16); border-radius: var(--fitai-radius); box-shadow: var(--fitai-shadow); overflow:hidden}
.fitai-card-header{padding:14px 14px 0}
.fitai-card-title{font-size:16px;font-weight:900;display:flex;gap:10px;align-items:center}
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
.fitai-btn{border:1px solid transparent;border-radius: 14px; padding:10px 12px; cursor:pointer; font-weight:900; display:inline-flex; gap:10px; align-items:center}
.fitai-btn-primary{background:linear-gradient(135deg, rgba(182,255,59,.16), rgba(108,92,231,.22));
border-color: rgba(182,255,59,.28); color: var(--fitai-ink)}
.fitai-btn-ghost{background:rgba(255,255,255,.04);border-color: rgba(108,92,231,.20); color: var(--fitai-ink)}
.fitai-btn-danger{background:rgba(255,59,122,.10);border-color: rgba(255,59,122,.28); color: var(--fitai-ink)}
.fitai-btn:disabled{opacity:.55; cursor:not-allowed}
.fitai-tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.fitai-tab{background:rgba(255,255,255,.03);border:1px solid rgba(108,92,231,.20);color:var(--fitai-ink);
padding:10px 12px;border-radius: 999px; cursor:pointer; font-weight:900; display:inline-flex; gap:10px; align-items:center}
.fitai-tab-active{border-color: rgba(182,255,59,.40); box-shadow: 0 0 0 3px rgba(182,255,59,.10)}
.fitai-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;
background:rgba(182,255,59,.10);border:1px solid rgba(182,255,59,.20);color:var(--fitai-lime);font-weight:900;font-size:12px}
.fitai-ico{opacity:.95}
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
.fitai-img{width:100%;max-height:460px;object-fit:cover;border-radius: 14px;border:1px solid rgba(182,255,59,.16)}
.fitai-grid{display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:12px}
@media (max-width: 980px){.fitai-grid{grid-template-columns:repeat(2, minmax(0, 1fr));}}
@media (max-width: 620px){.fitai-grid{grid-template-columns:1fr}}
.fitai-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.70);backdrop-filter: blur(8px);z-index:90;display:flex;align-items:center;justify-content:center;padding:18px}
.fitai-modal{width:min(1040px, 100%); max-height: 86vh; overflow:auto;background:linear-gradient(180deg, rgba(11,15,34,.98), rgba(10,20,43,.96));
border:1px solid rgba(182,255,59,.16); border-radius: var(--fitai-radius); box-shadow: var(--fitai-shadow)}
.fitai-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border-bottom:1px solid rgba(108,92,231,.14)}
.fitai-modal-title{font-weight:900}
.fitai-modal-body{padding:14px}
.fitai-modal-footer{padding:12px 14px;border-top:1px solid rgba(108,92,231,.14);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end}
.fitai-compare-wrap{position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(182,255,59,.16)}
.fitai-compare-wrap img{display:block;width:100%;height:auto}
.fitai-compare-top{position:absolute;inset:0;overflow:hidden}
.fitai-compare-slider{width:100%}
.fitai-kpi{display:flex;gap:12px;align-items:center;justify-content:space-between}
.fitai-kpi strong{font-size:14px}
.fitai-kpi input{max-width:120px}
.fitai-chiprow{display:flex;gap:10px;flex-wrap:wrap}
.fitai-chip{padding:8px 10px;border-radius:999px;border:1px solid rgba(108,92,231,.20);background:rgba(255,255,255,.03);cursor:pointer;font-weight:900}
.fitai-chip-on{border-color: rgba(182,255,59,.40); box-shadow: 0 0 0 3px rgba(182,255,59,.10)}
        `,
      });
      document.head.appendChild(style);
      return ui.el("div");
    },
  };

  /* =========================
     2) Utils
     ========================= */

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

  function clampText(s, max = 180) {
    const str = String(s || "");
    if (str.length <= max) return str;
    return str.slice(0, max - 1) + "…";
  }

  function ensureNotBusy() {
    return !state.busy;
  }

  function setBusy(v) {
    state.busy = !!v;
    const spinner = document.getElementById("fitai-busy");
    if (spinner) spinner.style.display = state.busy ? "inline-flex" : "none";
  }

  function uuid12() {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    } catch (_) {}
    return Math.random().toString(16).slice(2, 14);
  }

  async function getSignedUrl(path) {
    const now = Date.now();
    const cached = state.signedUrlCache.get(path);
    if (cached && cached.url && cached.expiresAtMs && cached.expiresAtMs - now > 60_000) return cached.url;

    const { data, error } = await state.supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) throw error || new Error("Signed URL failed");

    const expiresAtMs = now + SIGNED_URL_TTL_SECONDS * 1000;
    state.signedUrlCache.set(path, { url: data.signedUrl, expiresAtMs });
    return data.signedUrl;
  }

  async function readImageMeta(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
        img.src = url;
      });
      return { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
    } finally {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
  }

  async function compressToJpeg(file, maxDim = 1400, quality = 0.86) {
    // If already small, keep
    const meta = await readImageMeta(file).catch(() => ({ width: 0, height: 0 }));
    const w = meta.width || 0;
    const h = meta.height || 0;

    // If we can't read meta, no compression
    if (!w || !h) return { blob: file, mime: file.type || "image/jpeg" };

    const scale = Math.min(1, maxDim / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    // If no resizing and already jpeg, return original
    if (scale === 1 && (file.type === "image/jpeg" || file.type === "image/jpg") && file.size <= 3.5 * 1024 * 1024) {
      return { blob: file, mime: "image/jpeg" };
    }

    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image decode failed"));
        img.src = url;
      });

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { blob: file, mime: file.type || "image/jpeg" };

      ctx.drawImage(img, 0, 0, outW, outH);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) return { blob: file, mime: file.type || "image/jpeg" };
      return { blob, mime: "image/jpeg" };
    } finally {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
  }

  /* =========================
     3) Auth + session
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
    if (!state.user) {
      // stop focus timers on signout
      stopFocus();
    }
    render();
  });

  /* =========================
     4) Data loaders
     ========================= */

  async function loadProfile() {
    if (!state.user) return null;
    const { data, error } = await state.supabase.from("profiles").select("*").eq("user_id", state.user.id).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function loadPublicProfile() {
    if (!state.user) return null;
    const { data, error } = await state.supabase
      .from("public_profiles")
      .select("*")
      .eq("user_id", state.user.id)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function loadAchievements() {
    if (!state.user) return [];
    const { data, error } = await state.supabase
      .from("achievements")
      .select("badge_type,created_at")
      .eq("user_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function loadFeed() {
    const { data, error } = await state.supabase.from("workouts_feed").select("*").order("created_at", { ascending: false }).limit(40);
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
      .limit(60);
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  /* =========================
     5) Save helpers (NO upsert/onConflict)
     ========================= */

  async function saveProfilePatch(patch) {
    if (!state.user) throw new Error("Not authed");

    // Update first
    const upd = await state.supabase
      .from("profiles")
      .update(patch)
      .eq("user_id", state.user.id)
      .select("user_id")
      .maybeSingle();

    if (!upd.error && upd.data?.user_id) return;

    // If no row yet, insert
    const ins = await state.supabase.from("profiles").insert({ user_id: state.user.id, ...patch });
    if (ins.error) throw ins.error;
  }

  async function savePublicProfilePatch(patch) {
    if (!state.user) throw new Error("Not authed");

    const upd = await state.supabase
      .from("public_profiles")
      .update(patch)
      .eq("user_id", state.user.id)
      .select("user_id")
      .maybeSingle();

    if (!upd.error && upd.data?.user_id) return;

    const ins = await state.supabase.from("public_profiles").insert({ user_id: state.user.id, ...patch });
    if (ins.error) throw ins.error;
  }

  /* =========================
     6) Focus Mode (no auto AudioContext)
     ========================= */

  function stopFocus() {
    state.focus.running = false;
    state.focus.endAt = 0;
    if (state.focus.tickTimer) {
      clearInterval(state.focus.tickTimer);
      state.focus.tickTimer = null;
    }
  }

  function formatMMSS(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  async function allowAudioOnce() {
    // Must be called from a user gesture
    state.focus.audioAllowed = true;

    // Use AudioContext only when needed; resume on user gesture
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!state.focus.audioCtx) state.focus.audioCtx = new AudioCtx();
      if (state.focus.audioCtx.state === "suspended") await state.focus.audioCtx.resume();
    } catch (_) {
      // ignore
    }
  }

  function beep() {
    if (!state.focus.audioAllowed) return;
    const now = Date.now();
    if (now - state.focus.lastBeepAt < 900) return;
    state.focus.lastBeepAt = now;

    try {
      const ctx = state.focus.audioCtx;
      if (!ctx) return;

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.06;

      o.connect(g);
      g.connect(ctx.destination);

      o.start();
      setTimeout(() => {
        try {
          o.stop();
          o.disconnect();
          g.disconnect();
        } catch (_) {}
      }, 120);
    } catch (_) {}
  }

  function startFocus(seconds) {
    if (state.focus.running) return;
    state.focus.running = true;
    state.focus.endAt = Date.now() + seconds * 1000;

    if (state.focus.tickTimer) clearInterval(state.focus.tickTimer);
    state.focus.tickTimer = setInterval(() => {
      if (!state.focus.running) return;
      const left = Math.max(0, Math.ceil((state.focus.endAt - Date.now()) / 1000));
      const timerEl = document.getElementById("fitai-focus-timer");
      if (timerEl) timerEl.textContent = formatMMSS(left);

      if (left <= 0) {
        stopFocus();
        ui.toast("Focus terminé. GG.", "success");
        beep();
      } else if (left === 3 || left === 2 || left === 1) {
        beep();
      }
    }, 250);
  }

  /* =========================
     7) Views
     ========================= */

  function viewAuth() {
    const emailInput = ui.input({ type: "email", placeholder: "Email", autocomplete: "email" });
    const passInput = ui.input({ type: "password", placeholder: "Mot de passe", autocomplete: "current-password" });

    const busyBadge = ui.badge("SYNC", "bolt");
    busyBadge.id = "fitai-busy";
    busyBadge.style.display = "none";

    const btnLogin = ui.btn("Connexion", {
      variant: "primary",
      leftIcon: "shield",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        const em = String(emailInput.value || "").trim();
        const pw = String(passInput.value || "").trim();
        if (!em || !pw) return ui.toast("Email + mot de passe requis.", "error");

        try {
          setBusy(true);
          const { error } = await state.supabase.auth.signInWithPassword({ email: em, password: pw });
          if (error) throw error;
          ui.toast("Connecté.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur auth"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const btnSignup = ui.btn("Créer compte", {
      variant: "ghost",
      leftIcon: "star",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        const em = String(emailInput.value || "").trim();
        const pw = String(passInput.value || "").trim();
        if (!em || !pw) return ui.toast("Email + mot de passe requis.", "error");

        try {
          setBusy(true);
          const { error } = await state.supabase.auth.signUp({ email: em, password: pw });
          if (error) throw error;
          ui.toast("Compte créé. Vérifie ton email si confirmation activée.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur signup"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const content = ui.row([
      ui.col([
        ui.card({
          title: "FitAI — Accès",
          subtitle: "Connexion sécurisée Supabase",
          body: [
            ui.row([ui.badge("AUTH", "shield"), busyBadge]),
            ui.sep(),
            ui.el("div", { class: "fitai-muted", text: "Email" }),
            emailInput,
            ui.el("div", { class: "fitai-muted", text: "Mot de passe", style: { marginTop: "10px" } }),
            passInput,
            ui.sep(),
            ui.el("div", { class: "fitai-muted", text: "⚠️ Si rien ne marche: supprime tout “```” dans app.js (ça casse le JS)." }),
          ],
          footer: [btnSignup, btnLogin],
        }),
      ]),
      ui.col([
        ui.card({
          title: "Body Scan (vrai IA)",
          subtitle: "Upload privé + analyse Gemini (côté serveur)",
          body: [
            ui.p("Bucket privé. Images affichées uniquement via signed URLs."),
            ui.p("Analyse IA via /api/bodyscan (Gemini)."),
          ],
        }),
      ]),
    ]);

    return ui.pageShell({ headerRight: [], content });
  }

  function headerRightForAuthed() {
    const email = state.user?.email ? String(state.user.email) : "User";
    const busyBadge = ui.badge("SYNC", "bolt");
    busyBadge.id = "fitai-busy";
    busyBadge.style.display = state.busy ? "inline-flex" : "none";

    return [
      ui.badge(clampText(email, 26), "shield"),
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
      ui.navTab("Dashboard", "dashboard", "chart"),
      ui.navTab("Workout", "workout", "spark"),
      ui.navTab("Body Scan", "bodyscan", "camera"),
      ui.navTab("Trophées", "trophies", "trophy"),
      ui.navTab("Profil", "profile", "target"),
      ui.navTab("Feed", "feed", "star"),
    ]);

    return ui.pageShell({
      headerRight: headerRightForAuthed(),
      content: ui.el("div", {}, [tabs, contentNode]),
    });
  }

  /* -------- Dashboard -------- */

  function viewDashboard() {
    const kpiRecovery = ui.input({ type: "number", placeholder: "70", min: 0, max: 100, step: 1 });
    const kpiWeight = ui.input({ type: "number", placeholder: "70", min: 20, max: 300, step: 0.1 });
    const kpiSleep = ui.input({ type: "number", placeholder: "7", min: 0, max: 16, step: 0.1 });

    const equipChips = [
      { key: "gym", label: "Salle" },
      { key: "home", label: "Maison" },
      { key: "bodyweight", label: "PDC" },
      { key: "dumbbells", label: "Haltères" },
      { key: "bands", label: "Élastiques" },
    ];

    const equipment = new Set();

    const equipRow = ui.el("div", { class: "fitai-chiprow" }, equipChips.map((c) => {
      const chip = ui.el("button", { class: "fitai-chip", type: "button" }, [c.label]);
      chip.addEventListener("click", () => {
        if (equipment.has(c.key)) equipment.delete(c.key);
        else equipment.add(c.key);
        chip.classList.toggle("fitai-chip-on", equipment.has(c.key));
      });
      return chip;
    }));

    const btnLoad = ui.btn("Charger profil", {
      variant: "ghost",
      leftIcon: "shield",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        try {
          setBusy(true);
          await hydrateProfileIntoDashboard({ kpiRecovery, kpiWeight, kpiSleep, equipment, equipRow });
          ui.toast("Profil chargé.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur chargement profil"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const btnSave = ui.btn("Sauvegarder", {
      variant: "primary",
      leftIcon: "bolt",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        try {
          setBusy(true);

          const kpis = {
            recovery: Number(kpiRecovery.value || 0),
            weight: Number(kpiWeight.value || 0),
            sleep: Number(kpiSleep.value || 0),
          };

          const equipmentObj = {};
          for (const k of equipment.values()) equipmentObj[k] = true;

          await saveProfilePatch({
            kpis,
            equipment: equipmentObj,
            weight: Number.isFinite(kpis.weight) ? kpis.weight : null,
            last_workout_date: new Date().toISOString(),
          });

          ui.toast("Dashboard sauvegardé.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur sauvegarde"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const focusInput = ui.input({ type: "number", placeholder: "10", min: 1, max: 120, step: 1 });

    const timerBox = ui.el("div", { class: "fitai-item" }, [
      ui.el("div", { class: "fitai-item-head" }, [
        ui.el("div", { class: "fitai-item-title", text: "Focus Mode" }),
        ui.badge("NO-AUTO-AUDIO", "shield"),
      ]),
      ui.el("div", { class: "fitai-item-sub", text: "Le son démarre uniquement après un clic (plus d’erreur AudioContext)." }),
      ui.sep(),
      ui.el("div", { class: "fitai-kpi" }, [
        ui.el("div", {}, [ui.el("strong", { text: "Durée (min)" }), ui.el("div", { class: "fitai-muted", text: "1 à 120" })]),
        focusInput,
      ]),
      ui.sep(),
      ui.el("div", { class: "fitai-item-sub", text: "Timer" }),
      ui.el("div", { id: "fitai-focus-timer", class: "fitai-h1", text: formatMMSS(state.focus.seconds) }),
      ui.row([
        ui.btn("Start", {
          variant: "primary",
          leftIcon: "bolt",
          onClick: async () => {
            await allowAudioOnce(); // user gesture
            const mins = Number(focusInput.value || 10);
            const seconds = Math.max(60, Math.min(120 * 60, Math.floor(mins * 60)));
            state.focus.seconds = seconds;
            const timerEl = document.getElementById("fitai-focus-timer");
            if (timerEl) timerEl.textContent = formatMMSS(seconds);
            startFocus(seconds);
          },
        }),
        ui.btn("Stop", {
          variant: "ghost",
          onClick: () => stopFocus(),
        }),
      ]),
    ]);

    const card = ui.card({
      title: "Dashboard",
      subtitle: "KPIs + Matériel + Focus Mode",
      body: [
        ui.row([ui.badge("KPIs", "chart"), ui.badge("SAVE", "bolt")]),
        ui.sep(),
        ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: "KPIs" }),
            ui.badge("EDITABLE", "spark"),
          ]),
          ui.sep(),
          ui.el("div", { class: "fitai-kpi" }, [
            ui.el("div", {}, [ui.el("strong", { text: "Recovery" }), ui.el("div", { class: "fitai-muted", text: "0..100" })]),
            kpiRecovery,
          ]),
          ui.el("div", { class: "fitai-kpi" }, [
            ui.el("div", {}, [ui.el("strong", { text: "Weight (kg)" }), ui.el("div", { class: "fitai-muted", text: "optionnel" })]),
            kpiWeight,
          ]),
          ui.el("div", { class: "fitai-kpi" }, [
            ui.el("div", {}, [ui.el("strong", { text: "Sleep (h)" }), ui.el("div", { class: "fitai-muted", text: "optionnel" })]),
            kpiSleep,
          ]),
          ui.sep(),
          ui.el("div", { class: "fitai-item-sub", text: "Matériel" }),
          equipRow,
        ]),
        timerBox,
      ],
      footer: [btnLoad, btnSave],
    });

    // hydrate from DB quickly
    hydrateProfileIntoDashboard({ kpiRecovery, kpiWeight, kpiSleep, equipment, equipRow }).catch(() => void 0);

    return viewAppShell(ui.row([ui.col([card])]));
  }

  async function hydrateProfileIntoDashboard({ kpiRecovery, kpiWeight, kpiSleep, equipment, equipRow }) {
    if (!state.user) return;
    const prof = await loadProfile().catch(() => null);
    state.profile = prof;

    const kpis = prof?.kpis && typeof prof.kpis === "object" ? prof.kpis : {};
    const eq = prof?.equipment && typeof prof.equipment === "object" ? prof.equipment : {};

    if (kpiRecovery) kpiRecovery.value = kpis.recovery != null ? String(kpis.recovery) : "";
    if (kpiWeight) kpiWeight.value = kpis.weight != null ? String(kpis.weight) : (prof?.weight != null ? String(prof.weight) : "");
    if (kpiSleep) kpiSleep.value = kpis.sleep != null ? String(kpis.sleep) : "";

    equipment.clear();
    for (const [k, v] of Object.entries(eq)) if (v) equipment.add(k);

    // refresh chip styles
    if (equipRow) {
      const chips = equipRow.querySelectorAll(".fitai-chip");
      const defs = ["gym", "home", "bodyweight", "dumbbells", "bands"];
      chips.forEach((chip, idx) => chip.classList.toggle("fitai-chip-on", equipment.has(defs[idx])));
    }
  }

  /* -------- Workout -------- */

  function viewWorkout() {
    const goalInput = ui.input({ placeholder: "Objectif (cut/bulk/recomp/fullbody)", value: "" });
    const levelInput = ui.input({ placeholder: "Niveau (beginner/intermediate/advanced)", value: "intermediate" });
    const equipInput = ui.input({ placeholder: "Matériel (gym/home/dumbbells/bodyweight)", value: "gym" });
    const output = ui.textarea({ placeholder: "Résultat généré…", value: "", rows: 12 });

    const generateBtn = ui.btn("Générer", {
      variant: "primary",
      leftIcon: "spark",
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
          const text = (data && (data.workout || data.text || data.result)) || JSON.stringify(data, null, 2) || "OK";
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
      subtitle: "Coach via /api/workout (Gemini côté serveur)",
      body: [
        ui.row([ui.badge("GEMINI", "spark"), ui.badge("SERVER", "shield")]),
        ui.sep(),
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

  /* -------- Profile -------- */

  function viewProfile() {
    const displayName = ui.input({ placeholder: "Ton pseudo public", value: "" });
    const age = ui.input({ type: "number", placeholder: "25", min: 0, max: 120, step: 1, value: "" });
    const weight = ui.input({ type: "number", placeholder: "70", min: 20, max: 300, step: 0.1, value: "" });
    const height = ui.input({ type: "number", placeholder: "175", min: 80, max: 230, step: 0.1, value: "" });

    const btnLoad = ui.btn("Charger", {
      variant: "ghost",
      leftIcon: "shield",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        try {
          setBusy(true);
          const prof = await loadProfile().catch(() => null);
          const pub = await loadPublicProfile().catch(() => null);
          state.profile = prof;
          state.publicProfile = pub;

          displayName.value = pub?.display_name || "";
          age.value = prof?.age != null ? String(prof.age) : "";
          weight.value = prof?.weight != null ? String(prof.weight) : "";
          height.value = prof?.height != null ? String(prof.height) : "";
          ui.toast("Profil chargé.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const btnSave = ui.btn("Sauvegarder", {
      variant: "primary",
      leftIcon: "bolt",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        try {
          setBusy(true);

          const dn = String(displayName.value || "").trim();
          if (dn) await savePublicProfilePatch({ display_name: dn });

          await saveProfilePatch({
            age: age.value ? Number(age.value) : null,
            weight: weight.value ? Number(weight.value) : null,
            height: height.value ? Number(height.value) : null,
          });

          ui.toast("Profil sauvegardé.", "success");
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur sauvegarde"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    // auto fill
    (async () => {
      try {
        const prof = await loadProfile().catch(() => null);
        const pub = await loadPublicProfile().catch(() => null);
        displayName.value = pub?.display_name || "";
        age.value = prof?.age != null ? String(prof.age) : "";
        weight.value = prof?.weight != null ? String(prof.weight) : "";
        height.value = prof?.height != null ? String(prof.height) : "";
      } catch (_) {}
    })();

    const card = ui.card({
      title: "Profil",
      subtitle: "Sauvegarde stable (sans upsert / sans ON CONFLICT)",
      body: [
        ui.row([ui.badge("RLS", "shield"), ui.badge("SAFE-SAVE", "bolt")]),
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Pseudo public" }),
        displayName,
        ui.el("div", { class: "fitai-muted", text: "Âge", style: { marginTop: "10px" } }),
        age,
        ui.el("div", { class: "fitai-muted", text: "Poids (kg)", style: { marginTop: "10px" } }),
        weight,
        ui.el("div", { class: "fitai-muted", text: "Taille (cm)", style: { marginTop: "10px" } }),
        height,
      ],
      footer: [btnLoad, btnSave],
    });

    return viewAppShell(ui.row([ui.col([card])]));
  }

  /* -------- Feed -------- */

  function viewFeed() {
    const list = ui.el("div", { class: "fitai-list" }, [ui.el("div", { class: "fitai-muted", text: "Chargement du feed…" })]);

    const refreshBtn = ui.btn("Rafraîchir", {
      variant: "ghost",
      leftIcon: "chart",
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
      const items = await loadFeed();
      state.feed = items;

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
        if (userDisplay) metaBits.push(ui.el("div", { class: "fitai-item-sub", text: `by ${String(userDisplay)}` }));

        const preview = it.summary || it.description || it.notes || it.plan || it.content || "";
        const kudos = it.kudos_count != null ? `kudos: ${it.kudos_count}` : "";

        return ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: String(title) }),
            ui.badge(it.is_public ? "PUBLIC" : "LIVE", "star"),
          ]),
          ...metaBits,
          ui.sep(),
          preview ? ui.el("div", { class: "fitai-item-sub", text: clampText(preview, 240) }) : ui.el("div", { class: "fitai-item-sub", text: kudos || "—" }),
          kudos ? ui.el("div", { class: "fitai-item-sub", text: kudos }) : null,
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

  /* -------- Trophies (Achievements) -------- */

  function badgeIconForType(type) {
    const t = String(type || "").toLowerCase();
    if (t.includes("streak") || t.includes("daily")) return "bolt";
    if (t.includes("first") || t.includes("start")) return "star";
    if (t.includes("goal")) return "target";
    if (t.includes("scan") || t.includes("body")) return "camera";
    if (t.includes("kudos")) return "spark";
    return "trophy";
  }

  function badgeLabel(type) {
    const t = String(type || "");
    const map = {
      first_workout: "Premier workout",
      first_scan: "Premier body scan",
      streak_7: "Série 7 jours",
      streak_30: "Série 30 jours",
      kudos_10: "10 Kudos",
      goal_set: "Objectif défini",
    };
    return map[t] || t.replaceAll("_", " ");
  }

  function viewTrophies() {
    const box = ui.el("div", { class: "fitai-list" }, [ui.el("div", { class: "fitai-muted", text: "Chargement des trophées…" })]);

    const refreshBtn = ui.btn("Rafraîchir", {
      variant: "ghost",
      leftIcon: "trophy",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        await hydrateTrophies(box);
      },
    });

    const card = ui.card({
      title: "Trophées",
      subtitle: "Table achievements (icônes propres, pas d’emoji)",
      body: [box],
      footer: [refreshBtn],
    });

    hydrateTrophies(box).catch(() => void 0);
    return viewAppShell(ui.row([ui.col([card])]));
  }

  async function hydrateTrophies(container) {
    try {
      setBusy(true);
      container.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Synchronisation…" }));
      if (!state.user) {
        container.replaceChildren(ui.el("div", { class: "fitai-muted", text: "Non connecté." }));
        return;
      }

      const list = await loadAchievements();
      state.achievements = list;

      if (!list.length) {
        container.replaceChildren(
          ui.el("div", { class: "fitai-muted", text: "Aucun trophée pour le moment." }),
          ui.el("div", { class: "fitai-muted", text: "Tip: fais 1 workout public / 1 body scan pour débloquer." })
        );
        return;
      }

      const nodes = list.map((a) =>
        ui.el("div", { class: "fitai-item" }, [
          ui.el("div", { class: "fitai-item-head" }, [
            ui.el("div", { class: "fitai-item-title", text: badgeLabel(a.badge_type) }),
            ui.badge("UNLOCKED", badgeIconForType(a.badge_type)),
          ]),
          ui.el("div", { class: "fitai-item-sub", text: a.created_at ? fmtDate(a.created_at) : "—" }),
          ui.el("div", { class: "fitai-item-sub", text: `badge_type: ${a.badge_type}` }),
        ])
      );

      container.replaceChildren(...nodes);
    } catch (e) {
      container.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur achievements." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("Erreur trophées.", "error");
    } finally {
      setBusy(false);
    }
  }

  /* -------- Body Scan -------- */

  function viewBodyScan() {
    const info = ui.el("div", { class: "fitai-muted", text: "Sélectionne une photo (jpg/png/webp). Max 10MB. Min 400x600." });

    const previewImg = ui.el("img", { class: "fitai-img", alt: "Preview Body Scan" });
    previewImg.style.display = "none";

    const previewMeta = ui.el("div", { class: "fitai-muted", text: "—" });

    const timeline = ui.el("div", { class: "fitai-list" }, [ui.el("div", { class: "fitai-muted", text: "Chargement des scans…" })]);

    const fileState = { file: null, objectUrl: null };

    const fileInput = ui.fileInput({
      accept: "image/*",
      onChange: async (e) => {
        const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
        if (!f) return;

        // Guard rails
        if (!f.type.startsWith("image/")) {
          ui.toast("Fichier invalide (image uniquement).", "error");
          e.target.value = "";
          return;
        }
        if (f.size > 10 * 1024 * 1024) {
          ui.toast("Image trop lourde (max 10MB).", "error");
          e.target.value = "";
          return;
        }

        const meta = await readImageMeta(f).catch(() => ({ width: 0, height: 0 }));
        if ((meta.width && meta.height) && (meta.width < 400 || meta.height < 600)) {
          ui.toast("Photo trop petite (min 400x600).", "error");
          e.target.value = "";
          return;
        }

        fileState.file = f;

        if (fileState.objectUrl) {
          try { URL.revokeObjectURL(fileState.objectUrl); } catch (_) {}
        }
        fileState.objectUrl = URL.createObjectURL(f);

        previewImg.src = fileState.objectUrl;
        previewImg.style.display = "block";
        previewMeta.textContent = `${f.name} • ${(f.size / (1024 * 1024)).toFixed(2)} MB • ${meta.width}×${meta.height}`;
        uploadBtn.disabled = false;
      },
    });

    const uploadBtn = ui.btn("Uploader + analyser", {
      variant: "primary",
      leftIcon: "upload",
      disabled: true,
      onClick: async () => {
        if (!ensureNotBusy()) return;
        if (!state.user) return ui.toast("Non connecté.", "error");
        if (!fileState.file) return ui.toast("Choisis une image.", "error");

        try {
          setBusy(true);

          // 1) Compress/rescale (sauve quota + plus stable)
          const { blob, mime } = await compressToJpeg(fileState.file, 1400, 0.86).catch(() => ({ blob: fileState.file, mime: fileState.file.type || "image/jpeg" }));
          const ext = "jpg";
          const ts = Date.now();
          const rnd = uuid12();
          const path = `${state.user.id}/bodyscans/bodyscan_${rnd}_${ts}.${ext}`;

          // 2) Upload storage
          const up = await state.supabase.storage.from(BUCKET).upload(path, blob, {
            cacheControl: "3600",
            upsert: false,
            contentType: mime || "image/jpeg",
          });
          if (up.error) throw up.error;

          // 3) Insert DB row (AI fields default)
          const ins = await state.supabase.from("body_scans").insert({ user_id: state.user.id, image_path: path });
          if (ins.error) throw ins.error;

          // 4) Call server analyzer (/api/bodyscan) with bearer
          const token = state.session?.access_token || (await state.supabase.auth.getSession()).data?.session?.access_token || "";
          if (!token) throw new Error("Missing access token (auth)");

          const res = await fetch("/api/bodyscan", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({ user_id: state.user.id, image_path: path }),
          });

          const payload = await res.json().catch(() => null);
          if (!res.ok || !payload?.ok) {
            const detail = payload?.detail || payload?.error || "bodyscan api error";
            throw new Error(detail);
          }

          ui.toast("Body Scan ajouté + analysé.", "success");

          // reset
          fileInput.value = "";
          fileState.file = null;
          if (fileState.objectUrl) {
            try { URL.revokeObjectURL(fileState.objectUrl); } catch (_) {}
          }
          fileState.objectUrl = null;
          previewImg.src = "";
          previewImg.style.display = "none";
          previewMeta.textContent = "—";
          uploadBtn.disabled = true;

          await hydrateBodyScans(timeline);
        } catch (e) {
          ui.toast(String(e?.message || e || "Erreur body scan"), "error");
        } finally {
          setBusy(false);
        }
      },
    });

    const refreshBtn = ui.btn("Rafraîchir", {
      variant: "ghost",
      leftIcon: "camera",
      onClick: async () => {
        if (!ensureNotBusy()) return;
        await hydrateBodyScans(timeline);
      },
    });

    const infoCard = ui.card({
      title: "Body Scan",
      subtitle: "Upload privé + analyse Gemini (/api/bodyscan)",
      body: [
        ui.row([ui.badge("PRIVATE", "shield"), ui.badge("SIGNED URL", "spark"), ui.badge("RLS", "target")]),
        ui.sep(),
        info,
        ui.el("div", { class: "fitai-muted", text: "Photo" }),
        fileInput,
        ui.sep(),
        previewMeta,
        previewImg,
        ui.sep(),
        ui.el("div", { class: "fitai-muted", text: "Conseil: lumière stable + cadrage identique pour avant/après." }),
      ],
      footer: [refreshBtn, uploadBtn],
    });

    const timelineCard = ui.card({
      title: "Timeline",
      subtitle: "Compare slider + scores",
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
          ui.el("div", { class: "fitai-muted", text: "Ajoute ton premier scan pour démarrer." })
        );
        return;
      }

      const nodes = [];
      for (let i = 0; i < state.bodyScans.length; i++) {
        const scan = state.bodyScans[i];
        const prev = i + 1 < state.bodyScans.length ? state.bodyScans[i + 1] : null;

        let urlA = "";
        try { urlA = await getSignedUrl(scan.image_path); } catch (_) {}

        const img = ui.el("img", { class: "fitai-img", alt: "Body Scan" });
        if (urlA) img.src = urlA;

        const scores = [];
        if (scan.symmetry_score != null) scores.push(`Sym: ${Number(scan.symmetry_score).toFixed(0)}`);
        if (scan.posture_score != null) scores.push(`Post: ${Number(scan.posture_score).toFixed(0)}`);
        if (scan.bodyfat_proxy != null) scores.push(`Dry: ${Number(scan.bodyfat_proxy).toFixed(0)}`);

        const btnCompare = ui.btn("Comparer", {
          variant: "ghost",
          leftIcon: "chart",
          disabled: !prev,
          onClick: async () => {
            if (!prev) return;
            try {
              setBusy(true);
              const [u1, u2] = await Promise.all([getSignedUrl(scan.image_path), getSignedUrl(prev.image_path)]);
              const modal = buildCompareModal({
                current: scan,
                prev,
                urlCurrent: u1,
                urlPrev: u2,
              });
              document.body.appendChild(modal);
            } catch (e) {
              ui.toast(String(e?.message || e || "Erreur compare"), "error");
            } finally {
              setBusy(false);
            }
          },
        });

        const btnDelete = ui.btn("Supprimer", {
          variant: "danger",
          onClick: async () => {
            const ok = window.confirm("Supprimer ce scan ? (fichier + DB)");
            if (!ok) return;
            try {
              setBusy(true);
              await deleteScan(scan);
              ui.toast("Scan supprimé.", "success");
              await hydrateBodyScans(timelineNode);
            } catch (e) {
              ui.toast(String(e?.message || e || "Erreur suppression"), "error");
            } finally {
              setBusy(false);
            }
          },
        });

        nodes.push(
          ui.el("div", { class: "fitai-item" }, [
            ui.el("div", { class: "fitai-item-head" }, [
              ui.el("div", { class: "fitai-item-title", text: fmtDate(scan.created_at) }),
              ui.badge(prev ? "COMPARE" : "LATEST", prev ? "chart" : "camera"),
            ]),
            ui.el("div", { class: "fitai-item-sub", text: scan.image_path }),
            ui.el("div", { class: "fitai-item-sub", text: scan.ai_version ? `model: ${scan.ai_version}` : "—" }),
            scores.length ? ui.el("div", { class: "fitai-item-sub", text: scores.join(" • ") }) : ui.el("div", { class: "fitai-item-sub", text: "scores: —" }),
            ui.sep(),
            urlA ? img : ui.el("div", { class: "fitai-muted", text: "Signed URL indisponible (storage policy / bucket)." }),
            ui.sep(),
            ui.el("div", { class: "fitai-item-sub", text: scan.ai_feedback ? clampText(scan.ai_feedback, 260) : "Analyse en cours / non disponible." }),
            ui.sep(),
            ui.row([btnCompare, btnDelete]),
          ])
        );
      }

      timelineNode.replaceChildren(...nodes);
    } catch (e) {
      timelineNode.replaceChildren(
        ui.el("div", { class: "fitai-muted", text: "Erreur body_scans." }),
        ui.el("div", { class: "fitai-muted", text: String(e?.message || e || "") })
      );
      ui.toast("Erreur Body Scan.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteScan(scan) {
    if (!state.user) throw new Error("Not authed");
    if (!scan || !scan.id || !scan.image_path) throw new Error("Scan invalide");

    const rm = await state.supabase.storage.from(BUCKET).remove([scan.image_path]);
    if (rm.error) throw rm.error;

    const del = await state.supabase.from("body_scans").delete().eq("id", scan.id).eq("user_id", state.user.id);
    if (del.error) throw del.error;

    state.signedUrlCache.delete(scan.image_path);
  }

  function buildCompareModal({ current, prev, urlCurrent, urlPrev }) {
    const slider = ui.el("input", { class: "fitai-compare-slider", type: "range", min: "0", max: "100", value: "50" });

    const base = ui.el("img", { alt: "Avant" });
    base.src = urlPrev || "";

    const topImg = ui.el("img", { alt: "Après" });
    topImg.src = urlCurrent || "";

    const topWrap = ui.el("div", { class: "fitai-compare-top" }, [topImg]);

    function setClip(v) {
      const pct = Math.max(0, Math.min(100, Number(v)));
      topWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    }
    setClip(50);

    slider.addEventListener("input", () => setClip(slider.value));

    const compare = ui.el("div", { class: "fitai-compare-wrap" }, [base, topWrap]);

    const body = [
      ui.el("div", { class: "fitai-item-sub", text: `Après: ${fmtDate(current.created_at)} • Avant: ${fmtDate(prev.created_at)}` }),
      ui.sep(),
      compare,
      ui.sep(),
      ui.el("div", { class: "fitai-muted", text: "Slider = vrai avant/après (pas un mock)." }),
      slider,
    ];

    const modal = ui.modal({
      title: "Comparaison Body Scan",
      body,
      onClose: () => {
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
      },
    });

    return modal;
  }

  /* =========================
     8) Router + render
     ========================= */

  function render() {
    if (!state.user) {
      root.replaceChildren(viewAuth());
      return;
    }

    let content = null;
    if (state.activeTab === "dashboard") content = viewDashboard();
    else if (state.activeTab === "workout") content = viewWorkout();
    else if (state.activeTab === "bodyscan") content = viewBodyScan();
    else if (state.activeTab === "trophies") content = viewTrophies();
    else if (state.activeTab === "profile") content = viewProfile();
    else if (state.activeTab === "feed") content = viewFeed();
    else content = viewDashboard();

    root.replaceChildren(content);

    // ensure busy badge state
    const busy = document.getElementById("fitai-busy");
    if (busy) busy.style.display = state.busy ? "inline-flex" : "none";
  }

  /* =========================
     9) Start
     ========================= */

  (async () => {
    await refreshSession();
    if (state.user) {
      // prefetch essential
      Promise.allSettled([
        loadProfile().then((p) => (state.profile = p)),
        loadPublicProfile().then((p) => (state.publicProfile = p)),
        loadAchievements().then((a) => (state.achievements = a)),
      ]).catch(() => void 0);
    }
    render();
  })();
})(); 
