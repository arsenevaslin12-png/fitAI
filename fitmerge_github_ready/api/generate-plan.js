"use strict";
// api/generate-plan.js — FitAI Pro v7.0.0
// Evidence-based flexible-cycle personalized planning engine

const TIMEOUT = 25000;
const MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite"];
const DEFAULT_CYCLE_WEEKS = 8;
const { createClient } = require("@supabase/supabase-js");

let _AI = null;
function getAI() {
  if (_AI) return _AI;
  try { _AI = require("@google/generative-ai").GoogleGenerativeAI; return _AI; } catch { return null; }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function safeJsonExtract(text) {
  const s = String(text || "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += String(chunk || ""); });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function getWeekStartDate() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  return monday.toISOString().split("T")[0];
}

const PHASE_LIBRARY = {
  1: [
    { week: 1, phase: "Semaine personnalisée", desc: "Microcycle hebdomadaire structuré : assez de renforcement, un peu de cardio utile, mobilité et récupération prévues.", goal: "tenir une semaine réaliste, bénéfique et durable" },
  ],
  4: [
    { week: 1, phase: "Adaptation", desc: "Installation de la routine, montée douce de la charge et priorité à la technique.", goal: "tenir une semaine réaliste, bénéfique et durable" },
    { week: 2, phase: "Hypertrophie I", desc: "Volume utile et régularité, sans aller à l'échec.", goal: "accumuler du travail de qualité" },
    { week: 3, phase: "Hypertrophie II", desc: "Volume toujours élevé avec un peu plus d'intensité.", goal: "consolider les repères et progresser" },
    { week: 4, phase: "Deload", desc: "Volume réduit pour récupérer et repartir plus frais.", goal: "dissiper la fatigue" },
  ],
  8: [
    { week: 1, phase: "Adaptation", desc: "Installation de la routine, montée douce de la charge et priorité à la technique.", goal: "tenir une semaine réaliste, bénéfique et durable" },
    { week: 2, phase: "Hypertrophie I", desc: "Volume utile et régularité, sans aller à l'échec.", goal: "accumuler du travail de qualité" },
    { week: 3, phase: "Hypertrophie II", desc: "Volume toujours élevé avec un peu plus d'intensité.", goal: "consolider les repères et progresser" },
    { week: 4, phase: "Deload", desc: "Volume réduit pour récupérer et repartir plus frais.", goal: "dissiper la fatigue" },
    { week: 5, phase: "Force I", desc: "Moins de reps, plus de tension et de repos sur les mouvements principaux.", goal: "améliorer la force utile" },
    { week: 6, phase: "Force II", desc: "Bloc lourd contrôlé avec progression mesurée.", goal: "consolider la force sans casser la technique" },
    { week: 7, phase: "Puissance", desc: "Accent sur l'explosivité, la vitesse et la fraîcheur.", goal: "garder des reps rapides et nettes" },
    { week: 8, phase: "Consolidation & test", desc: "Semaine de synthèse pour mesurer les progrès et préparer la suite.", goal: "stabiliser les acquis" },
  ],
  12: []
};
PHASE_LIBRARY[12] = [...PHASE_LIBRARY[8],
  { week: 9, phase: "Hypertrophie I", desc: "Retour sur un bloc volume utile avec meilleurs repères techniques.", goal: "reprendre de la marge de progression" },
  { week: 10, phase: "Force I", desc: "Remontée progressive de l'intensité avec exécution propre.", goal: "renforcer les mouvements de base" },
  { week: 11, phase: "Deload", desc: "Baisse du volume pour faire tomber la fatigue accumulée.", goal: "récupérer avant la dernière semaine" },
  { week: 12, phase: "Consolidation & test", desc: "Bilan de cycle avec repères concrets et semaine durable.", goal: "mesurer les progrès" },
];
function normalizeCycleWeeks(v){ const n=parseInt(v,10); return [1,4,8,12].includes(n)?n:DEFAULT_CYCLE_WEEKS; }
function getCyclePhases(cycleWeeks){ return PHASE_LIBRARY[normalizeCycleWeeks(cycleWeeks)] || PHASE_LIBRARY[DEFAULT_CYCLE_WEEKS]; }

const PHASE_RULES = {
  "Adaptation":             { mainSets: 3, mainReps: "8-12", accSets: 2, accReps: "10-15", restSec: 75, rir: "2-4", cardioMin: [25, 35], progression: "si toutes les séries sont propres, ajoute 1 rep la prochaine fois" },
  "Hypertrophie I":         { mainSets: 4, mainReps: "8-12", accSets: 3, accReps: "10-15", restSec: 90, rir: "1-3", cardioMin: [25, 40], progression: "+1 rep ou +2-5% si tu dépasses la cible" },
  "Hypertrophie II":        { mainSets: 4, mainReps: "6-10", accSets: 3, accReps: "8-12", restSec: 105, rir: "1-2", cardioMin: [20, 35], progression: "garde 1-2 reps en réserve puis ajoute 2-5% quand la fourchette est maîtrisée" },
  "Deload":                 { mainSets: 2, mainReps: "6-10", accSets: 1, accReps: "8-12", restSec: 75, rir: "3-4", cardioMin: [20, 30], progression: "ne cherche pas à battre un record cette semaine" },
  "Force I":                { mainSets: 5, mainReps: "4-6", accSets: 2, accReps: "6-8", restSec: 165, rir: "1-2", cardioMin: [20, 30], progression: "+2-5% seulement si la technique reste stable" },
  "Force II":               { mainSets: 5, mainReps: "3-5", accSets: 2, accReps: "5-8", restSec: 180, rir: "1-2", cardioMin: [20, 30], progression: "priorité à la qualité de vitesse sur chaque rep" },
  "Puissance":              { mainSets: 4, mainReps: "3-5", accSets: 2, accReps: "5-6", restSec: 180, rir: "2", rirNote: "arrête chaque série avant ralentissement net", cardioMin: [15, 25], progression: "recherche l'explosivité, pas la fatigue" },
  "Consolidation & test":   { mainSets: 3, mainReps: "3-5", accSets: 1, accReps: "6-8", restSec: 150, rir: "2-3", cardioMin: [20, 30], progression: "note tes charges et ta récupération pour préparer le prochain cycle" },
};

const WORKOUT_LIBRARY = {
  push_gym: {
    main: ["Développé couché", "Développé incliné haltères", "Développé militaire"],
    secondary: ["Développé incliné haltères", "Développé militaire", "Pompes lestées"],
    accessories: ["Élévations latérales", "Dips assistés", "Extension triceps poulie", "Pompes serrées"],
  },
  push_home: {
    main: ["Pompes", "Pompes pieds surélevés", "Pike push-ups"],
    secondary: ["Pompes tempo 3-1-1", "Dips sur chaise", "Pompes diamant"],
    accessories: ["Shoulder taps", "Pompes serrées", "Y-T-W au sol", "Planche scapulaire"],
  },
  pull_gym: {
    main: ["Tirage vertical", "Tractions assistées", "Rowing barre"],
    secondary: ["Rowing assis câble", "Rowing haltère un bras", "Tirage poitrine"],
    accessories: ["Face pulls", "Curl haltères", "Curl marteau", "Oiseau haltères"],
  },
  pull_home: {
    main: ["Tractions barre de porte", "Inverted row sous table", "Rowing élastique"],
    secondary: ["Superman contrôlé", "Bird dog", "Good morning poids du corps"],
    accessories: ["Reverse snow angel", "Curl serviette isométrique", "Prone cobra", "Dead bug"],
  },
  legs_gym: {
    main: ["Squat", "Presse à cuisses", "Soulevé de terre roumain"],
    secondary: ["Fentes marchées", "Hip thrust", "Front squat"],
    accessories: ["Leg curl", "Leg extension", "Mollets debout", "Abducteurs machine"],
  },
  legs_home: {
    main: ["Squat contrôlé", "Split squat", "Hip thrust au sol"],
    secondary: ["Fentes arrière", "Single-leg Romanian deadlift", "Step-ups"],
    accessories: ["Wall sit", "Mollets debout", "Pont fessier unilatéral", "Nordic curl assisté"],
  },
  upper_gym: {
    main: ["Développé couché", "Tirage vertical", "Développé militaire"],
    secondary: ["Rowing haltère", "Développé incliné", "Tractions assistées"],
    accessories: ["Élévations latérales", "Curl marteau", "Extension triceps", "Face pulls"],
  },
  lower_gym: {
    main: ["Squat", "Soulevé de terre roumain", "Hip thrust"],
    secondary: ["Presse à cuisses", "Fentes marchées", "Front squat"],
    accessories: ["Leg curl", "Mollets", "Abducteurs", "Gainage"],
  },
  full_home: {
    main: ["Squat", "Pompes", "Split squat"],
    secondary: ["Hip thrust au sol", "Inverted row sous table", "Pike push-ups"],
    accessories: ["Planche", "Bird dog", "Mountain climbers lents", "Dead bug"],
  },
  full_gym: {
    main: ["Squat goblet", "Développé couché", "Rowing assis câble"],
    secondary: ["Soulevé de terre roumain", "Tirage vertical", "Développé haltères"],
    accessories: ["Planche", "Élévations latérales", "Mollets", "Crunch câble"],
  },
  core: {
    main: ["Planche", "Dead bug", "Side plank"],
    secondary: ["Pallof press", "Crunch inversé", "Bird dog"],
    accessories: ["Respiration costale", "Farmer carry", "Hollow hold", "Rotation thoracique"],
  },
  mobility: {
    main: ["Respiration 90/90", "World's greatest stretch", "Mobilité cheville"],
    secondary: ["Ouverture thoracique", "Étirement fléchisseurs de hanche", "Cat-cow"],
    accessories: ["Squat hold", "Pigeon stretch", "Dead hang assisté", "Marche légère"],
  },
  hiit: {
    main: ["Burpees", "Jump squats", "Mountain climbers"],
    secondary: ["Pompes", "Fentes alternées", "High knees"],
    accessories: ["Marche de récupération", "Gainage", "Respiration"],
  },
  zone2: {
    main: ["Marche rapide", "Vélo", "Rameur facile"],
    secondary: ["Elliptique", "Natation douce", "Jog léger"],
    accessories: ["Retour au calme", "Respiration nasale", "Mobilité hanches/chevilles"],
  },
};

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function titleCase(s) { return String(s || "").replace(/\b\w/g, (m) => m.toUpperCase()); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }

function parseSessionsPerWeek(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? clamp(n, 2, 6) : null;
}

function normalizeGoal(goal) {
  const g = String(goal || "").toLowerCase();
  if (["prise_de_masse", "perte_de_poids", "endurance", "force", "remise_en_forme", "maintien"].includes(g)) return g;
  return "remise_en_forme";
}

function normalizeLevel(level) {
  const l = String(level || "").toLowerCase();
  if (["beginner", "debutant"].includes(l)) return "beginner";
  if (["intermediate", "intermediaire"].includes(l)) return "intermediate";
  if (["advanced", "avance", "elite"].includes(l)) return "advanced";
  return "beginner";
}

function getPhaseInfo(weekNum, cycleWeeks) {
  const phases = getCyclePhases(cycleWeeks);
  return phases[(weekNum - 1) % phases.length] || phases[0];
}

function computeCycleWeek(existingWeeks, cycleWeeks, preferredWeekNumber) {
  const total = normalizeCycleWeeks(cycleWeeks);
  const preferred = parseInt(preferredWeekNumber, 10);
  if (Number.isFinite(preferred) && preferred >= 1 && preferred <= total) return preferred;
  const past = parseInt(existingWeeks, 10);
  if (!Number.isFinite(past) || past < 0) return 1;
  return ((past % total) + 1);
}

function getGoalDesc(goal) {
  const map = {
    prise_de_masse: "accent hypertrophie, volume modéré à élevé, progression graduelle",
    perte_de_poids: "dépense énergétique, maintien de la masse maigre, cardio structuré",
    endurance: "tolérance à l'effort, base aérobie, fractionné dosé",
    force: "mouvements de base lourds, repos longs, faible à moyen volume",
    remise_en_forme: "régularité, technique, récupération, progression douce",
    maintien: "équilibre force-cardio-mobilité, variété et adhérence"
  };
  return map[normalizeGoal(goal)] || map.remise_en_forme;
}

function getLevelDesc(level) {
  const map = {
    beginner: "débutant : 2-4 séances, mouvements simples, bonne marge avant l'échec",
    intermediate: "intermédiaire : 3-5 séances, plus de variété et progression plus active",
    advanced: "avancé : 4-6 séances, précision du dosage et blocs plus marqués"
  };
  return map[normalizeLevel(level)] || map.beginner;
}

function hasGymEquipment(equipment) {
  return /halt[eè]re|barre|salle|machine|kettlebell|banc|cable|poulie/i.test(String(equipment || ""));
}

function detectConstraintFlags(text) {
  const s = String(text || "").toLowerCase();
  return {
    shoulder: /epaule|épaule|coiffe|impingement/.test(s),
    knee: /genou|rotule|menisque|ménisque/.test(s),
    back: /dos|lomb|sciatique|hernie/.test(s),
    wrist: /poignet|coude/.test(s),
    noJump: /pas de saut|sans saut|impact|tendon d'achille|cheville/.test(s),
  };
}

function getEvidenceTargets(ctx) {
  const goal = normalizeGoal(ctx.goal);
  const level = normalizeLevel(ctx.level);
  const phaseName = ctx.phase?.phase || "Adaptation";
  const requested = parseSessionsPerWeek(ctx.sessionsPerWeek);
  let strengthDays = level === "advanced" ? 4 : (level === "intermediate" ? 3 : 2);
  let cardioDays = goal === "endurance" ? 3 : (goal === "perte_de_poids" ? 2 : 1);
  let mobilityDays = ctx.age >= 60 ? 3 : 2;

  if (goal === "prise_de_masse") cardioDays = 1;
  if (goal === "force") cardioDays = 1;
  if (goal === "remise_en_forme") cardioDays = 2;
  if (/Deload|Consolidation/i.test(phaseName)) mobilityDays += 1;
  if (/Deload/i.test(phaseName)) strengthDays = Math.max(2, strengthDays - 1);

  let activeDays = requested || clamp(strengthDays + cardioDays, 3, 6);
  if (/Deload|Consolidation/i.test(phaseName)) activeDays = Math.max(3, activeDays - 1);
  const cardioMinutes = goal === "endurance" ? [150, 240] : (goal === "perte_de_poids" ? [120, 210] : [90, 180]);

  return { strengthDays, cardioDays, mobilityDays, activeDays, cardioMinutes };
}

function getSlotTypeLabel(type, gym) {
  const map = {
    push: gym ? "Push (Pecs/Épaules/Triceps)" : "Push poids du corps",
    pull: gym ? "Pull (Dos/Biceps)" : "Pull / dos maison",
    legs: gym ? "Lower body / jambes" : "Jambes / fessiers maison",
    upper: "Upper body",
    lower: "Lower body",
    full: gym ? "Full body" : "Full body maison",
    zone2: "Cardio zone 2",
    hiit: "HIIT contrôlé",
    core: "Core + stabilité",
    mobility: "Mobilité / récupération",
    rest: "REST",
  };
  return map[type] || titleCase(type);
}

function chooseDayTemplates(ctx) {
  const goal = normalizeGoal(ctx.goal);
  const gym = hasGymEquipment(ctx.equipment);
  const requested = getEvidenceTargets(ctx).activeDays;
  const baseByGoal = {
    prise_de_masse: ["push", "pull", "legs", "rest", gym ? "upper" : "full", gym ? "lower" : "mobility", "rest"],
    perte_de_poids: ["full", "zone2", "hiit", "rest", "full", "zone2", "rest"],
    endurance: ["zone2", "full", "hiit", "rest", "zone2", "core", "rest"],
    force: ["legs", "rest", "push", "mobility", "pull", "core", "rest"],
    remise_en_forme: ["full", "zone2", "full", "rest", "full", "mobility", "rest"],
    maintien: ["upper", "zone2", "lower", "rest", "full", "mobility", "rest"],
  };
  const days = (baseByGoal[goal] || baseByGoal.remise_en_forme).slice();
  const activeIndices = days.map((t, i) => ({ t, i })).filter((x) => x.t !== "rest");
  while (activeIndices.length > requested) {
    const removableIndex = activeIndices.find((x) => ["mobility", "core", "zone2"].includes(x.t)) || activeIndices[activeIndices.length - 1];
    days[removableIndex.i] = "rest";
    activeIndices.splice(activeIndices.findIndex((x) => x.i === removableIndex.i), 1);
  }
  if (ctx.age >= 60) {
    const mobDays = days.filter((d) => d === "mobility").length;
    if (mobDays === 0) {
      const restIdx = days.findIndex((d) => d === "rest");
      if (restIdx >= 0) days[restIdx] = "mobility";
    }
  }
  return days.map((type, idx) => ({ day: idx + 1, slotType: type, workout_type: getSlotTypeLabel(type, gym) }));
}

function adjustForFatigue(dayTemplates, ctx) {
  if (ctx.lastWorkoutDays <= 5) return dayTemplates;
  return dayTemplates.map((d) => {
    if (d.day === 1 && d.slotType !== "rest") return { ...d, slotType: "mobility", workout_type: "Réintégration / mobilité" };
    if (d.day === 2 && ["hiit", "legs", "push", "pull", "upper", "lower"].includes(d.slotType)) {
      return { ...d, slotType: "full", workout_type: "Full body réintégration" };
    }
    return d;
  });
}

function pickFromPool(pool, index, bannedRegex) {
  const clean = pool.filter((name) => !bannedRegex || !bannedRegex.test(name));
  const src = clean.length ? clean : pool;
  return src[index % src.length];
}

function buildExercisePools(slotType, ctx) {
  const gym = hasGymEquipment(ctx.equipment);
  const flags = detectConstraintFlags(ctx.constraints);
  const bannedParts = [];
  if (flags.shoulder) bannedParts.push("développé militaire", "pompes pieds", "pike");
  if (flags.knee) bannedParts.push("jump", "squat sauté", "fentes marchées");
  if (flags.back) bannedParts.push("soulevé de terre", "rowing barre");
  if (flags.wrist) bannedParts.push("pompes", "dips");
  if (flags.noJump) bannedParts.push("burpees", "jump", "high knees");
  const bannedRegex = bannedParts.length ? new RegExp(bannedParts.join("|"), "i") : null;

  const keyMap = {
    push: gym ? "push_gym" : "push_home",
    pull: gym ? "pull_gym" : "pull_home",
    legs: gym ? "legs_gym" : "legs_home",
    upper: gym ? "upper_gym" : "full_home",
    lower: gym ? "lower_gym" : "legs_home",
    full: gym ? "full_gym" : "full_home",
    core: "core",
    mobility: "mobility",
    hiit: "hiit",
    zone2: "zone2",
  };
  return { library: WORKOUT_LIBRARY[keyMap[slotType]] || WORKOUT_LIBRARY.full_home, bannedRegex };
}

function buildStrengthNote(slotType, ctx, occurrence) {
  const rule = PHASE_RULES[ctx.phase.phase] || PHASE_RULES.Adaptation;
  const { library, bannedRegex } = buildExercisePools(slotType, ctx);
  const main1 = pickFromPool(library.main, occurrence * 2, bannedRegex);
  const main2 = pickFromPool(library.secondary || library.main, occurrence * 2 + 1, bannedRegex);
  const acc1 = pickFromPool(library.accessories || library.secondary || library.main, occurrence + 1, bannedRegex);
  const acc2 = pickFromPool((library.accessories || library.secondary || library.main).slice().reverse(), occurrence + 2, bannedRegex);
  const warmup = ctx.age >= 60 ? "Échauffement 8-10 min + 1 série légère de chaque mouvement" : "Échauffement 6-8 min + 2 séries de montée en charge";
  const constraintCue = buildConstraintCue(ctx.constraints, slotType);
  return `${warmup} — ${main1} ${rule.mainSets}×${rule.mainReps}, ${main2} ${Math.max(2, rule.mainSets - 1)}×${rule.mainReps}, ${acc1} ${rule.accSets}×${rule.accReps}, ${acc2} ${rule.accSets}×${rule.accReps} — repos ${Math.round(rule.restSec / 60)}-${Math.ceil(rule.restSec / 60)} min, ${rule.progression}, garde ${rule.rir} reps en réserve.${constraintCue}`;
}

function buildCoreNote(ctx, occurrence) {
  const rule = PHASE_RULES[ctx.phase.phase] || PHASE_RULES.Adaptation;
  const pool = WORKOUT_LIBRARY.core;
  const a = pickFromPool(pool.main, occurrence, null);
  const b = pickFromPool(pool.secondary, occurrence + 1, null);
  const c = pickFromPool(pool.accessories, occurrence + 2, null);
  return `Bloc stabilité 18-25 min — ${a} ${rule.accSets + 1}×30-45s, ${b} ${rule.accSets + 1}×8-12/côté, ${c} ${rule.accSets}×8-12 — respiration lente, bassin neutre et exécution contrôlée.`;
}

function buildMobilityNote(ctx, occurrence) {
  const pool = WORKOUT_LIBRARY.mobility;
  const a = pickFromPool(pool.main, occurrence, null);
  const b = pickFromPool(pool.secondary, occurrence + 1, null);
  const c = pickFromPool(pool.accessories, occurrence + 2, null);
  const balanceAdd = ctx.age >= 60 ? " Ajoute 2×30s d'équilibre unipodal par côté." : "";
  return `20-30 min récupération active — ${a} 2 tours, ${b} 2 tours, ${c} 2 tours + marche facile 10-20 min. Cherche amplitude, respiration et zéro douleur.${balanceAdd}`;
}

function buildZone2Note(ctx, occurrence) {
  const rule = PHASE_RULES[ctx.phase.phase] || PHASE_RULES.Adaptation;
  const pool = WORKOUT_LIBRARY.zone2;
  const a = pickFromPool(pool.main, occurrence, null);
  const b = pickFromPool(pool.secondary, occurrence + 1, null);
  const minutes = clamp(rule.cardioMin[0] + occurrence * 5 + (normalizeGoal(ctx.goal) === "endurance" ? 10 : 0), 20, rule.cardioMin[1] + 15);
  return `${a} ${minutes}-${minutes + 10} min à allure conversationnelle${b ? ` (option: ${b})` : ""} — finis avec 5 min retour au calme. Tu dois pouvoir parler en phrases courtes pendant l'effort.`;
}

function buildHiitNote(ctx, occurrence) {
  const pool = WORKOUT_LIBRARY.hiit;
  const a = pickFromPool(pool.main, occurrence, detectConstraintFlags(ctx.constraints).noJump ? /Burpees|Jump/i : null);
  const b = pickFromPool(pool.secondary, occurrence + 1, detectConstraintFlags(ctx.constraints).noJump ? /High knees/i : null);
  const c = pickFromPool(pool.main.concat(pool.secondary), occurrence + 2, detectConstraintFlags(ctx.constraints).noJump ? /Jump|Burpees/i : null);
  const work = ctx.phase.phase.includes("Puissance") ? 15 : 30;
  const rest = ctx.phase.phase.includes("Puissance") ? 45 : 30;
  const rounds = normalizeGoal(ctx.goal) === "perte_de_poids" ? 8 : 6;
  return `HIIT ${rounds} tours — ${a} ${work}s, ${b} ${work}s, ${c} ${work}s, repos ${rest}s entre exercices et 90s entre tours. Arrête-toi si la technique se dégrade.`;
}

function buildRestNote(ctx) {
  if (/Deload|Consolidation/i.test(ctx.phase.phase)) return "Repos complet ou 20 min de marche facile. Priorité sommeil, protéines réparties sur la journée et hydratation.";
  return "Repos complet ou marche légère 20-30 min. 5-10 min de mobilité douce autorisés, mais aucune séance intense aujourd'hui.";
}

function buildConstraintCue(constraints, slotType) {
  const f = detectConstraintFlags(constraints);
  const cues = [];
  if (f.shoulder && ["push", "upper"].includes(slotType)) cues.push("évite l'amplitude douloureuse au-dessus de la tête");
  if (f.knee && ["legs", "lower", "full", "hiit"].includes(slotType)) cues.push("réduis l'amplitude sur les flexions si le genou tire");
  if (f.back && ["pull", "legs", "lower", "full"].includes(slotType)) cues.push("garde la colonne neutre et remplace tout hinge douloureux");
  if (f.wrist && ["push", "full", "hiit"].includes(slotType)) cues.push("utilise poignées neutres ou appui sur poings si besoin");
  return cues.length ? ` Ajustement contrainte: ${cues.join(" ; ")}.` : "";
}

function buildWeekSummary(ctx) {
  const targets = getEvidenceTargets(ctx);
  const rule = PHASE_RULES[ctx.phase.phase] || PHASE_RULES.Adaptation;
  const goalMap = {
    prise_de_masse: "priorité au volume de qualité et à une progression sobre mais régulière",
    perte_de_poids: "priorité au maintien du muscle avec une dépense utile et tenable",
    endurance: "priorité à la base aérobie et à la tolérance à l'effort",
    force: "priorité aux mouvements de base lourds, propres et reproductibles",
    remise_en_forme: "priorité à la régularité, à la technique et à la récupération",
    maintien: "priorité à l'équilibre force-cardio-mobilité sans épuisement"
  };
  const objective = goalMap[normalizeGoal(ctx.goal)] || goalMap.remise_en_forme;
  const progression = ctx.phase.phase === "Deload"
    ? "réduis volontairement le volume et garde de la marge : cette semaine sert à récupérer, pas à te tester"
    : ctx.phase.phase.includes("Force")
      ? `sur les mouvements principaux, vise ${rule.mainSets} séries de ${rule.mainReps} avec ${rule.rir} reps en réserve puis monte seulement si la technique reste stable`
      : `sur les mouvements principaux, vise ${rule.mainSets} séries de ${rule.mainReps} puis applique la règle suivante : ${rule.progression}`;
  const recovery = ctx.lastWorkoutDays >= 5
    ? "reprise progressive : échauffement plus long, première série conservatrice, puis monte seulement si les sensations sont bonnes"
    : `récupération cible : ${targets.cardioMinutes[0]} à ${targets.cardioMinutes[1]} min de cardio facile dans la semaine, 2 à ${targets.mobilityDays} blocs mobilité/récup et au moins 7h de sommeil quand possible`;
  const painRule = ctx.constraints && ctx.constraints !== "aucune"
    ? `si une zone sensible se réveille (${ctx.constraints}), remplace immédiatement par une variante plus tolérante et garde une douleur ≤ 3/10`
    : "si un mouvement pince ou irrite une articulation, réduis l'amplitude ou change de variante au lieu de forcer";
  const coachPriority = ctx.phase.phase === "Deload"
    ? "cette semaine, gagne en fraîcheur"
    : ctx.phase.phase.includes("Puissance")
      ? "chaque rep doit rester rapide et propre"
      : ctx.phase.phase.includes("Force")
        ? "qualité de tension et repos complets avant tout"
        : "accumule du travail propre sans te cramer";
  return {
    objective,
    progression,
    recovery,
    pain_rule: painRule,
    coach_priority: coachPriority,
    weekly_frequency_target: targets.activeDays,
    strength_days_target: targets.strengthDays,
    cardio_minutes_target: targets.cardioMinutes,
  };
}

function buildDeterministicPlan(ctx) {
  const adjusted = adjustForFatigue(chooseDayTemplates(ctx), ctx);
  const occurrences = {};
  return adjusted.map((item) => {
    occurrences[item.slotType] = (occurrences[item.slotType] || 0) + 1;
    const occ = occurrences[item.slotType] - 1;
    let intensity = "medium";
    let notes = "";
    switch (item.slotType) {
      case "push":
      case "pull":
      case "legs":
      case "upper":
      case "lower":
      case "full":
        intensity = /Force|Puissance/.test(ctx.phase.phase) ? "hard" : "medium";
        if (/Deload|Consolidation/.test(ctx.phase.phase)) intensity = "medium";
        notes = buildStrengthNote(item.slotType, ctx, occ);
        break;
      case "core":
        intensity = "medium";
        notes = buildCoreNote(ctx, occ);
        break;
      case "mobility":
        intensity = "easy";
        notes = buildMobilityNote(ctx, occ);
        break;
      case "zone2":
        intensity = "easy";
        notes = buildZone2Note(ctx, occ);
        break;
      case "hiit":
        intensity = ctx.phase.phase === "Deload" ? "medium" : "hard";
        notes = buildHiitNote(ctx, occ);
        break;
      default:
        intensity = "easy";
        notes = buildRestNote(ctx);
        break;
    }
    return {
      day: item.day,
      workout_type: item.slotType === "rest" ? "REST" : item.workout_type,
      intensity,
      notes: item.slotType === "rest" ? buildRestNote(ctx) : notes,
    };
  });
}

function validatePlan(obj) {
  if (!obj || !Array.isArray(obj.plan) || obj.plan.length !== 7) return null;
  const allowed = new Set(["easy", "medium", "hard"]);
  const validated = obj.plan.map((item) => {
    if (!item || typeof item !== "object") return null;
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) return null;
    const workoutType = String(item.workout_type || "").trim();
    if (!workoutType) return null;
    const rawIntensity = String(item.intensity || "medium").trim().toLowerCase();
    const intensity = allowed.has(rawIntensity) ? rawIntensity : (/easy|facile|light/.test(rawIntensity) ? "easy" : (/hard|high|fort/.test(rawIntensity) ? "hard" : "medium"));
    const notes = String(item.notes || "").trim().replace(/\s+/g, " ");
    return { day, workout_type: workoutType, intensity, notes };
  }).filter(Boolean);
  return validated.length === 7 ? validated : null;
}

function buildPlanPrompt(ctx, scaffold) {
  const targets = getEvidenceTargets(ctx);
  return `Tu es un préparateur physique senior. Tu dois AMÉLIORER les notes d'un plan déjà structuré sans modifier les jours ni les types de séance.

Profil:
- âge: ${ctx.age || "?"}
- poids: ${ctx.weight || "?"}kg
- taille: ${ctx.height || "?"}cm
- objectif: ${ctx.goal} (${getGoalDesc(ctx.goal)})
- niveau: ${ctx.level} (${getLevelDesc(ctx.level)})
- matériel: ${ctx.equipment || "poids du corps"}
- contraintes: ${ctx.constraints || "aucune"}
- fréquence voulue: ${ctx.sessionsPerWeek || targets.activeDays} séances / semaine
- semaine ${ctx.weekNum}/${ctx.cycleWeeks}, phase ${ctx.phase.phase}: ${ctx.phase.desc}

Règles scientifiques à respecter:
- garder au moins 2 séances de renforcement des grands groupes musculaires dans la semaine
- garder une logique progressive adaptée à la phase
- pas de jargon inutile
- chaque note = protocole concret + coaching d'exécution
- si contrainte articulaire: proposer variante plus tolérante
- conserver EXACTEMENT le workout_type, intensity et day de chaque entrée

Plan de base à enrichir:
${JSON.stringify({ plan: scaffold })}

Retourne du JSON pur strict, même format, sans texte autour.`;
}

async function callGemini(apiKey, prompt, modelIndex) {
  const G = getAI();
  if (!G || !apiKey) throw Object.assign(new Error("Gemini indisponible"), { code: "DEP" });
  const modelName = process.env.GEMINI_MODEL || MODELS[modelIndex] || MODELS[0];
  const model = new G(apiKey).getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.45, maxOutputTokens: 2200 } });
  let tid;
  const tOut = new Promise((_, rej) => { tid = setTimeout(() => rej(Object.assign(new Error("Timeout"), { code: "TIMEOUT" })), TIMEOUT); });
  const call = model.generateContent(prompt)
    .then((r) => { clearTimeout(tid); const t = r?.response?.text; return typeof t === "function" ? t() : String(t || ""); })
    .catch(async (err) => {
      clearTimeout(tid);
      const msg = String(err?.message || "");
      if ((msg.includes("404") || msg.includes("not found") || msg.includes("not supported")) && modelIndex + 1 < MODELS.length) {
        return callGemini(apiKey, prompt, modelIndex + 1);
      }
      throw err;
    });
  return Promise.race([call, tOut]);
}

module.exports = async function handler(req, res) {
  setCors(res);
  const requestId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED", requestId });

  const body = await readBody(req);
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return sendJson(res, 500, { ok: false, error: "SUPABASE config manquante", requestId });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return sendJson(res, 401, { ok: false, error: "Bearer token requis", requestId });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return sendJson(res, 401, { ok: false, error: "Token invalide", requestId });
    userId = user.id;
  } catch {
    return sendJson(res, 401, { ok: false, error: "AUTH_FAILED", requestId });
  }

  try {
    const [profileRes, goalRes, lastWsRes, streakRes, weekCountRes] = await Promise.all([
      supabase.from("profiles").select("weight,height,age").eq("id", userId).maybeSingle(),
      supabase.from("goals").select("type,level,text,constraints,equipment").eq("user_id", userId).maybeSingle(),
      supabase.from("workout_sessions").select("created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("user_streaks").select("current_streak,total_workouts").eq("user_id", userId).maybeSingle(),
      supabase.from("training_schedule").select("week_start_date").eq("user_id", userId).order("week_start_date", { ascending: false }).limit(80),
    ]);

    const profile = profileRes.data || {};
    const goal = goalRes.data || {};
    const lastWs = lastWsRes.data || null;
    const streakData = streakRes.data || {};

    let lastWorkoutDays = 7;
    if (lastWs?.created_at) {
      try { lastWorkoutDays = Math.max(0, Math.floor((Date.now() - new Date(lastWs.created_at).getTime()) / (24 * 3600 * 1000))); } catch {}
    }

    const distinctWeeks = new Set((weekCountRes.data || []).map((r) => r.week_start_date)).size;
    const cycleWeeks = normalizeCycleWeeks(body.cycle_length_weeks || body.duration_weeks || body.program_duration_weeks || body.weeks || DEFAULT_CYCLE_WEEKS);
    const weekNum = computeCycleWeek(distinctWeeks, cycleWeeks, body.preferred_week_number || body.week_number);
    const phase = getPhaseInfo(weekNum, cycleWeeks);

    const ctx = {
      age: Number(profile.age || 0) || null,
      weight: Number(profile.weight || 0) || 75,
      height: Number(profile.height || 0) || null,
      goal: normalizeGoal(goal.type || body.goal || "remise_en_forme"),
      level: normalizeLevel(goal.level || body.level || "beginner"),
      equipment: goal.equipment || body.equipment || "poids du corps",
      constraints: goal.constraints || body.constraints || goal.text || "aucune",
      sessionsPerWeek: parseSessionsPerWeek(body.sessions_per_week || body.sessionsPerWeek || body.sessions || null),
      lastWorkoutDays,
      totalSessions: streakData.total_workouts || 0,
      streak: streakData.current_streak || 0,
      weekNum,
      phase,
      cycleWeeks,
    };

    let plan = buildDeterministicPlan(ctx);
    let source = "evidence_engine";
    const weekSummary = buildWeekSummary(ctx);

    if (GEMINI_API_KEY) {
      try {
        const text = await callGemini(GEMINI_API_KEY, buildPlanPrompt(ctx, plan), 0);
        const parsed = safeJsonExtract(text);
        const polished = validatePlan(parsed);
        if (polished) {
          plan = polished;
          source = "evidence_engine+ai_polish";
        }
      } catch (aiErr) {
        console.warn("[generate-plan] ai polish skipped", { requestId, msg: String(aiErr?.message || "") });
      }
    }

    const weekStart = getWeekStartDate();
    await supabase.from("training_schedule").delete().eq("user_id", userId).eq("week_start_date", weekStart);

    const rows = plan.map((item) => ({
      user_id: userId,
      day_of_week: item.day,
      workout_type: item.workout_type,
      intensity: item.intensity,
      status: "planned",
      notes: item.notes,
      week_start_date: weekStart,
    }));

    const { error: insertError } = await supabase.from("training_schedule").insert(rows);
    if (insertError) {
      console.error("[generate-plan] insert error", { requestId, err: insertError.message });
      return sendJson(res, 500, { ok: false, error: "DB_INSERT_FAILED", requestId });
    }

    return sendJson(res, 200, {
      ok: true,
      plan,
      week_start_date: weekStart,
      week_number: 1,
      cycle_length_weeks: cycleWeeks,
      phase: phase.phase,
      source,
      evidence: {
        strength_days_min: 2,
        cardio_target_minutes: getEvidenceTargets(ctx).cardioMinutes,
        active_days: getEvidenceTargets(ctx).activeDays,
      },
      week_summary: weekSummary,
      coach_priority: weekSummary.coach_priority,
      progression_rule: weekSummary.progression,
      recovery_target: weekSummary.recovery,
      pain_rule: weekSummary.pain_rule,
      requestId,
    });
  } catch (e) {
    const code = e?.code || "";
    const msg = String(e?.message || "");
    console.error("[generate-plan]", { requestId, code, msg: msg.slice(0, 180) });
    if (code === "TIMEOUT") return sendJson(res, 504, { ok: false, error: "Gemini timeout. Réessaie.", requestId });
    return sendJson(res, 502, { ok: false, error: msg || "Erreur serveur", requestId });
  }
};
