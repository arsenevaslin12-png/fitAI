// api/workout.js
// ------------------------------------------------------------
// FitAI V18 — API (config + generation + kudos)
// ENV required:
// - SUPABASE_URL
// - SUPABASE_ANON_KEY
// - SUPABASE_SERVICE_ROLE_KEY   (recommandé pour kudos fiable)
// - FITAI_CLIENT_TOKEN          (optionnel; défaut "fitai-v18")
// ------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
};

const env = (k, fallback = null) => {
  const v = process.env[k];
  return (v == null || String(v).trim() === "") ? fallback : v;
};

const safeTrim = (s, n = 240) => String(s || "").trim().slice(0, n);

// ------------------------------
// RPE Progressive Overload Engine
// ------------------------------
// Rules asked:
// - RPE < 8  => +10%
// - RPE = 10 => -5%
// - Math.round() for clean number
// Production guardrails:
// - rounding by tool increment
// - avoid increasing if reps below target range
// - cap excessive jumps
const roundToIncrement = (value, inc) => {
  const v = Number(value);
  const i = Number(inc);
  if (!Number.isFinite(v)) return null;
  if (!Number.isFinite(i) || i <= 0) return Math.round(v);
  return Math.round(v / i) * i;
};

const parseRepRange = (s) => {
  const m = String(s || "").match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return { min: null, max: null };
  return { min: Number(m[1]), max: Number(m[2]) };
};

function rpeNextLoad({
  prevLoad,
  prevReps,
  prevRpe,
  targetReps,
  tool = "barbell"
}) {
  const load = Number(prevLoad);
  if (!Number.isFinite(load) || load <= 0) return { suggested: null, reason: "no_prev_load" };

  const rpe = Number(prevRpe);
  const reps = Number(prevReps);

  const inc =
    tool === "dumbbell" ? 1 :
    tool === "machine" ? 2.5 :
    tool === "barbell" ? 2.5 :
    1;

  // base rule
  let pct = 0;
  if (Number.isFinite(rpe) && rpe < 8) pct = 0.10;
  else if (Number.isFinite(rpe) && Math.round(rpe) >= 10) pct = -0.05;
  else pct = 0.0; // stable by default (you can make micro +2.5% later)

  // guardrail: if reps below target min => no increase
  const rr = parseRepRange(targetReps);
  if (Number.isFinite(reps) && Number.isFinite(rr.min) && reps < rr.min) {
    pct = Math.min(pct, 0);
  }

  // cap movement
  pct = Math.max(-0.08, Math.min(0.10, pct));

  const raw = load * (1 + pct);

  // asked: Math.round() => we still keep tool increment rounding; but we can Math.round first then inc round
  const rounded = roundToIncrement(Math.round(raw), inc);

  let suggested = rounded;
  if (pct > 0 && suggested <= load) suggested = roundToIncrement(load + inc, inc);
  if (pct < 0 && suggested >= load) suggested = roundToIncrement(Math.max(inc, load - inc), inc);

  return { suggested, reason: pct > 0 ? "increase" : pct < 0 ? "decrease" : "hold", inc };
}

// -------------------------------------
// Simple deterministic workout generator
// -------------------------------------
function buildPrescription(goal = "hypertrophy") {
  const g = String(goal || "hypertrophy");
  if (g === "strength") {
    return { comp: { sets: 4, reps: "4-6", rpe: 8.5 }, acc: { sets: 3, reps: "8-12", rpe: 8 } };
  }
  if (g === "conditioning") {
    return { comp: { sets: 3, reps: "6-10", rpe: 8 }, acc: { sets: 2, reps: "10-15", rpe: 7.5 }, finisher: true };
  }
  return { comp: { sets: 3, reps: "6-10", rpe: 8 }, acc: { sets: 3, reps: "10-15", rpe: 8 } };
}

function pickExercises(equipment = { bodyweight: true }) {
  const eq = equipment || { bodyweight: true };
  const hasBar = !!eq.barbell;
  const hasDb = !!eq.dumbbells;
  const hasMach = !!eq.machines;
  const bw = eq.bodyweight !== false;

  const compounds = [];
  const accessories = [];
  const conditioning = [
    { name: "Intervals (bike/row/run)", tool: "cardio", category: "conditioning" },
    { name: "EMOM Bodyweight", tool: "bodyweight", category: "conditioning" }
  ];

  if (hasBar) compounds.push(
    { name: "Back Squat", tool: "barbell", category: "compound" },
    { name: "Bench Press", tool: "barbell", category: "compound" },
    { name: "Overhead Press", tool: "barbell", category: "compound" },
    { name: "Romanian Deadlift", tool: "barbell", category: "compound" }
  );

  if (hasDb) compounds.push(
    { name: "DB Bench Press", tool: "dumbbell", category: "compound" },
    { name: "DB Split Squat", tool: "dumbbell", category: "compound" },
    { name: "DB Romanian Deadlift", tool: "dumbbell", category: "compound" }
  );

  if (hasMach) compounds.push(
    { name: "Leg Press", tool: "machine", category: "compound" },
    { name: "Lat Pulldown", tool: "machine", category: "compound" },
    { name: "Chest Press Machine", tool: "machine", category: "compound" }
  );

  if (bw) compounds.push(
    { name: "Push-ups", tool: "bodyweight", category: "compound" },
    { name: "Pull-ups / Assisted", tool: "bodyweight", category: "compound" },
    { name: "Tempo Squats", tool: "bodyweight", category: "compound" }
  );

  if (hasDb) accessories.push(
    { name: "DB Row", tool: "dumbbell", category: "accessory" },
    { name: "DB Lateral Raise", tool: "dumbbell", category: "accessory" },
    { name: "DB Curl", tool: "dumbbell", category: "accessory" }
  );

  if (hasMach) accessories.push(
    { name: "Leg Curl", tool: "machine", category: "accessory" },
    { name: "Leg Extension", tool: "machine", category: "accessory" },
    { name: "Cable Row", tool: "machine", category: "accessory" }
  );

  if (bw) accessories.push(
    { name: "Plank", tool: "bodyweight", category: "accessory" },
    { name: "Hollow Hold", tool: "bodyweight", category: "accessory" }
  );

  const shuffle = (a) => [...a].sort(() => Math.random() - 0.5);

  return {
    compounds: shuffle(compounds).slice(0, 2),
    accessories: shuffle(accessories).slice(0, 3),
    conditioning: shuffle(conditioning).slice(0, 1)
  };
}

function intensityFromKPIs(kpis) {
  const rec = Number(kpis?.recovery || 0);
  const sleep = Number(kpis?.sleep || 0);
  if (rec < 40 || sleep < 5.5) return "Light";
  if (rec > 78 && sleep >= 7) return "Hard";
  return "Moderate";
}

// --------------------
// Auth (bearer -> user)
// --------------------
async function getUserFromBearer(serverSupabase, req) {
  const hdr = req.headers.authorization || req.headers.Authorization || "";
  const token = typeof hdr === "string" && hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return { user: null, token: null };
  const { data, error } = await serverSupabase.auth.getUser(token);
  if (error) return { user: null, token: null };
  return { user: data?.user || null, token };
}

export default async function handler(req, res) {
  const CLIENT = env("FITAI_CLIENT_TOKEN", "fitai-v18");
  const clientHeader = String(req.headers["x-fitai-client"] || "");
  if (clientHeader && clientHeader !== CLIENT) {
    return json(res, 401, { error: "Invalid client token." });
  }

  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: "Missing SUPABASE_URL / SUPABASE_ANON_KEY." });
  }

  // config bootstrap
  if (req.method === "GET") {
    if (String(req.query?.config || "") === "1") {
      return json(res, 200, { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
    }
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  // parse body
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const action = String(body?.action || "generate");

  // server client
  const serverKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const serverSupabase = createClient(SUPABASE_URL, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // -------------------------
  // action: generate (RPE in)
  // -------------------------
  if (action === "generate") {
    const prompt = safeTrim(body?.prompt, 260);
    const ctx = body?.context || {};

    const goal = safeTrim(ctx?.goal || "hypertrophy", 32);
    const minutes = Math.max(20, Math.min(120, Number(ctx?.minutes || 45)));
    const equipment = ctx?.equipment || { bodyweight: true };
    const kpis = ctx?.kpis || null;

    // Optional: exercise history passed by client (recommended)
    // Format:
    // exHistory: { "Back Squat": { load: 100, reps: 8, rpe: 7.5 } }
    const exHistory = ctx?.exHistory || {};

    const pres = buildPrescription(goal);
    const pick = pickExercises(equipment);

    const intensity = intensityFromKPIs(kpis);

    const exercises = [];

    // compounds first
    for (const ex of pick.compounds) {
      const sets = pres.comp.sets;
      const reps = pres.comp.reps;
      const target_rpe = pres.comp.rpe;

      const hist = exHistory?.[ex.name];
      let suggested_load = "Auto";
      let note = "Monte progressivement jusqu’à RPE cible, propre, sans ego.";

      if (hist && Number.isFinite(Number(hist.load))) {
        const nxt = rpeNextLoad({
          prevLoad: Number(hist.load),
          prevReps: Number(hist.reps),
          prevRpe: Number(hist.rpe),
          targetReps: reps,
          tool: ex.tool
        });

        if (nxt.suggested != null && ex.tool !== "bodyweight" && ex.tool !== "cardio") {
          suggested_load = `${nxt.suggested} kg`;
          note = `Surcharge RPE: ${nxt.reason} (depuis ${hist.load}kg @RPE${hist.rpe}).`;
        }
      }

      exercises.push({
        name: ex.name,
        category: ex.category,
        tool: ex.tool,
        sets,
        reps,
        target_rpe,
        suggested_load,
        note
      });
    }

    // accessories
    for (const ex of pick.accessories) {
      exercises.push({
        name: ex.name,
        category: ex.category,
        tool: ex.tool,
        sets: pres.acc.sets,
        reps: pres.acc.reps,
        target_rpe: pres.acc.rpe,
        suggested_load: ex.tool === "bodyweight" ? "Auto" : "Auto (RPE)",
        note: "Reste à 1–2 reps en réserve sur la 1ère série."
      });
    }

    // optional finisher for conditioning goal
    if (goal === "conditioning" && pick.conditioning[0]) {
      const fin = pick.conditioning[0];
      exercises.push({
        name: fin.name,
        category: fin.category,
        tool: fin.tool,
        sets: 1,
        reps: "8–12 min",
        target_rpe: 7.5,
        suggested_load: "Auto",
        note:
          fin.name.includes("Intervals")
            ? "Protocole: 8×(30s hard / 60s easy)."
            : "Template: 10min EMOM (min impair pompes / min pair squats)."
      });
    }

    const title = prompt ? `Coach: ${prompt}` : "Séance Coach";
    const summary =
      `Objectif: ${goal} • Durée: ${minutes}min • Intensité: ${intensity}\n` +
      `Règle: RPE guide la surcharge. RPE<8 => +10%. RPE=10 => -5%. Arrondis propres.\n` +
      `Matériel: ${Object.entries(equipment).filter(([,v])=>!!v).map(([k])=>k).join(", ") || "bodyweight"}`;

    return json(res, 200, {
      title,
      summary,
      intensity,
      exercises
    });
  }

  // -------------------------
  // action: kudos
  // -------------------------
  if (action === "kudos") {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY (needed for kudos update)." });
    }

    const workoutId = safeTrim(body?.workout_id, 64);
    const delta = Number(body?.delta || 1);
    const d = delta >= 1 ? 1 : -1;

    if (!workoutId) return json(res, 400, { error: "workout_id required." });

    const { user } = await getUserFromBearer(serverSupabase, req);
    if (!user) return json(res, 401, { error: "Unauthorized." });

    const sel = await serverSupabase
      .from("workouts")
      .select("kudos_count")
      .eq("id", workoutId)
      .maybeSingle();

    if (sel.error || !sel.data) return json(res, 404, { error: "Workout not found." });

    const cur = Number(sel.data.kudos_count || 0);
    const next = Math.max(0, cur + d);

    const up = await serverSupabase
      .from("workouts")
      .update({ kudos_count: next })
      .eq("id", workoutId)
      .select("kudos_count")
      .maybeSingle();

    if (up.error || !up.data) return json(res, 500, { error: up.error?.message || "Update failed." });

    return json(res, 200, { ok: true, kudos_count: Number(up.data.kudos_count || 0) });
  }

  return json(res, 400, { error: "Unknown action." });
}

