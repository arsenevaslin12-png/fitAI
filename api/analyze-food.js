"use strict";
// api/analyze-food.js — FitAI natural language food analysis

const { callGeminiText, normalizeGeminiError, extractJson } = require("./_gemini");
const { assertEnv } = require("./_env");

// ── Offline keyword fallback ──────────────────────────────────────────────────
const FOOD_DB = {
  // Proteins
  "oeuf": { cal: 78, p: 6, c: 0.6, f: 5, unit: "unité" },
  "oeuf dur": { cal: 78, p: 6, c: 0.6, f: 5, unit: "unité" },
  "blanc d'oeuf": { cal: 17, p: 3.6, c: 0.2, f: 0, unit: "unité" },
  "blanc oeuf": { cal: 17, p: 3.6, c: 0.2, f: 0, unit: "unité" },
  "poulet": { cal: 165, p: 31, c: 0, f: 3.6, unit: "100g" },
  "poulet grillé": { cal: 165, p: 31, c: 0, f: 3.6, unit: "100g" },
  "filet poulet": { cal: 165, p: 31, c: 0, f: 3.6, unit: "100g" },
  "thon": { cal: 132, p: 29, c: 0, f: 1, unit: "100g" },
  "thon boite": { cal: 132, p: 29, c: 0, f: 1, unit: "100g" },
  "saumon": { cal: 208, p: 20, c: 0, f: 13, unit: "100g" },
  "boeuf": { cal: 250, p: 26, c: 0, f: 15, unit: "100g" },
  "steak": { cal: 250, p: 26, c: 0, f: 15, unit: "100g" },
  "bifteck": { cal: 250, p: 26, c: 0, f: 15, unit: "100g" },
  "dinde": { cal: 135, p: 29, c: 0, f: 1, unit: "100g" },
  "jambon": { cal: 105, p: 17, c: 1.5, f: 3.5, unit: "100g" },
  "tofu": { cal: 76, p: 8, c: 1.9, f: 4.2, unit: "100g" },
  "lentilles": { cal: 116, p: 9, c: 20, f: 0.4, unit: "100g cuit" },
  "pois chiche": { cal: 164, p: 9, c: 27, f: 2.6, unit: "100g cuit" },
  // Dairy
  "fromage": { cal: 350, p: 25, c: 1, f: 28, unit: "100g" },
  "fromage blanc": { cal: 80, p: 8, c: 4, f: 3, unit: "100g" },
  "yaourt": { cal: 59, p: 3.5, c: 4.7, f: 3.2, unit: "100g" },
  "yaourt grec": { cal: 97, p: 9, c: 3.6, f: 5, unit: "100g" },
  "lait": { cal: 61, p: 3.2, c: 4.8, f: 3.3, unit: "100ml" },
  "skyr": { cal: 65, p: 11, c: 4, f: 0.2, unit: "100g" },
  "cottage": { cal: 98, p: 11, c: 3.4, f: 4.3, unit: "100g" },
  // Carbs
  "pates": { cal: 158, p: 5.8, c: 31, f: 0.9, unit: "100g cuit" },
  "pâtes": { cal: 158, p: 5.8, c: 31, f: 0.9, unit: "100g cuit" },
  "riz": { cal: 130, p: 2.7, c: 28, f: 0.3, unit: "100g cuit" },
  "pain": { cal: 265, p: 9, c: 49, f: 3.2, unit: "100g" },
  "baguette": { cal: 265, p: 9, c: 49, f: 3.2, unit: "100g" },
  "patate douce": { cal: 86, p: 1.6, c: 20, f: 0.1, unit: "100g" },
  "pomme de terre": { cal: 77, p: 2, c: 17, f: 0.1, unit: "100g" },
  "pommes de terre": { cal: 77, p: 2, c: 17, f: 0.1, unit: "100g" },
  "quinoa": { cal: 120, p: 4.4, c: 22, f: 1.9, unit: "100g cuit" },
  "avoine": { cal: 389, p: 17, c: 66, f: 7, unit: "100g sec" },
  "flocons avoine": { cal: 389, p: 17, c: 66, f: 7, unit: "100g sec" },
  // Fats
  "avocat": { cal: 160, p: 2, c: 9, f: 15, unit: "100g" },
  "amandes": { cal: 579, p: 21, c: 22, f: 50, unit: "100g" },
  "noix": { cal: 654, p: 15, c: 14, f: 65, unit: "100g" },
  "huile olive": { cal: 884, p: 0, c: 0, f: 100, unit: "100ml" },
  "beurre": { cal: 717, p: 0.9, c: 0.1, f: 81, unit: "100g" },
  // Veggies
  "brocoli": { cal: 34, p: 2.8, c: 7, f: 0.4, unit: "100g" },
  "epinards": { cal: 23, p: 2.9, c: 3.6, f: 0.4, unit: "100g" },
  "épinards": { cal: 23, p: 2.9, c: 3.6, f: 0.4, unit: "100g" },
  "tomate": { cal: 18, p: 0.9, c: 3.9, f: 0.2, unit: "100g" },
  "tomates": { cal: 18, p: 0.9, c: 3.9, f: 0.2, unit: "100g" },
  "courgette": { cal: 17, p: 1.2, c: 3.1, f: 0.3, unit: "100g" },
  "salade": { cal: 15, p: 1.4, c: 2.9, f: 0.2, unit: "100g" },
  "carotte": { cal: 41, p: 0.9, c: 10, f: 0.2, unit: "100g" },
  "carottes": { cal: 41, p: 0.9, c: 10, f: 0.2, unit: "100g" },
  // Fruits
  "banane": { cal: 89, p: 1.1, c: 23, f: 0.3, unit: "unité" },
  "pomme": { cal: 52, p: 0.3, c: 14, f: 0.2, unit: "unité" },
  "orange": { cal: 47, p: 0.9, c: 12, f: 0.1, unit: "unité" },
  "fraises": { cal: 32, p: 0.7, c: 7.7, f: 0.3, unit: "100g" },
  "myrtilles": { cal: 57, p: 0.7, c: 14, f: 0.3, unit: "100g" },
  // Misc
  "chocolat noir": { cal: 598, p: 7.8, c: 46, f: 43, unit: "100g" },
  "chocolat": { cal: 535, p: 7.7, c: 60, f: 30, unit: "100g" },
  "pizza": { cal: 266, p: 11, c: 33, f: 10, unit: "100g" },
  "burger": { cal: 295, p: 17, c: 24, f: 14, unit: "100g" },
  "frites": { cal: 312, p: 3.4, c: 41, f: 15, unit: "100g" },
  "coca": { cal: 42, p: 0, c: 10.6, f: 0, unit: "100ml" },
  "jus orange": { cal: 45, p: 0.7, c: 10.4, f: 0.2, unit: "100ml" },
  "cafe": { cal: 5, p: 0.3, c: 0, f: 0, unit: "tasse" },
  "café": { cal: 5, p: 0.3, c: 0, f: 0, unit: "tasse" },
  "whey": { cal: 120, p: 24, c: 3, f: 2, unit: "scoop (30g)" },
  "proteine whey": { cal: 120, p: 24, c: 3, f: 2, unit: "scoop (30g)" }
};

function offlineFallback(description) {
  const text = String(description || "").toLowerCase();
  const found = [];
  let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;

  // Sort by length desc to match longer phrases first
  const keys = Object.keys(FOOD_DB).sort((a, b) => b.length - a.length);
  const matched = new Set();

  for (const key of keys) {
    if (text.includes(key) && !matched.has(key)) {
      matched.add(key);
      const f = FOOD_DB[key];
      // Try to extract quantity from text near the keyword
      let qty = 1;
      const idx = text.indexOf(key);
      const before = text.slice(Math.max(0, idx - 10), idx).trim();
      const numMatch = before.match(/(\d+)/);
      if (numMatch) qty = Math.min(10, parseInt(numMatch[1], 10));

      const cal = Math.round(f.cal * qty);
      const p = Math.round(f.p * qty * 10) / 10;
      const c = Math.round(f.c * qty * 10) / 10;
      const fat = Math.round(f.f * qty * 10) / 10;

      found.push({
        name: key.charAt(0).toUpperCase() + key.slice(1),
        quantity: `${qty > 1 ? qty + "×" : ""}${f.unit}`,
        calories: cal,
        protein: p,
        carbs: c,
        fat: fat
      });
      totalCal += cal;
      totalP += p;
      totalC += c;
      totalF += fat;
    }
  }

  if (!found.length) {
    // Generic estimate
    totalCal = 400; totalP = 20; totalC = 45; totalF = 15;
    found.push({ name: "Repas estimé", quantity: "portion", calories: 400, protein: 20, carbs: 45, fat: 15 });
  }

  // Quality score
  let score = 60;
  const proteinRatio = totalP * 4 / (totalCal || 1);
  if (proteinRatio > 0.25) score += 20;
  else if (proteinRatio < 0.10) score -= 15;
  if (totalCal > 1200) score -= 20;
  if (totalCal > 800) score -= 10;
  if (text.match(/legume|brocoli|epinard|tomate|courgette|salade|carotte/)) score += 10;
  if (text.match(/pizza|burger|frites|chocolat|chips/)) score -= 20;
  score = Math.max(10, Math.min(100, score));

  const comment = score >= 75
    ? "Excellent repas, bien équilibré en protéines et nutriments."
    : score >= 55
    ? "Repas correct. Pense à ajouter des légumes ou plus de protéines."
    : "Repas à améliorer — trop calorique ou peu de protéines.";

  return {
    items: found,
    total: {
      calories: Math.round(totalCal),
      protein: Math.round(totalP * 10) / 10,
      carbs: Math.round(totalC * 10) / 10,
      fat: Math.round(totalF * 10) / 10
    },
    quality_score: score,
    comment,
    source: "offline"
  };
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }

  let body = {};
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch { body = {}; }

  const description = String(body.description || "").trim().slice(0, 500);
  if (!description) return sendJson(res, 400, { ok: false, error: "description requise" });

  const date = String(body.date || new Date().toISOString().split("T")[0]);

  // Try Gemini first, fallback to offline
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallback = offlineFallback(description);
    return sendJson(res, 200, { ok: true, date, ...fallback });
  }

  const prompt = `Analyse ce repas et retourne UNIQUEMENT un objet JSON valide, sans markdown.

Repas décrit: "${description}"

Format JSON strict:
{
  "items": [
    {"name": "Nom aliment", "quantity": "portion estimée", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}
  ],
  "total": {"calories": 0, "protein": 0, "carbs": 0, "fat": 0},
  "quality_score": 75,
  "comment": "Commentaire court sur l'équilibre nutritionnel (max 80 chars)"
}

Règles:
- Estime les quantités de manière réaliste (portion standard)
- quality_score: 0-100 (100=parfait: protéines suffisantes, légumes, pas trop calorique)
- calories/protein/carbs/fat en nombres entiers
- Langue: français
- JSON pur uniquement, aucun texte avant ou après`;

  try {
    const { text } = await callGeminiText({
      apiKey,
      prompt,
      temperature: 0.3,
      maxOutputTokens: 600,
      timeoutMs: 10000
    });

    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.items) || !parsed.total) {
      throw new Error("Invalid JSON from Gemini");
    }

    // Sanitize
    const items = parsed.items.map(item => ({
      name: String(item.name || "").trim(),
      quantity: String(item.quantity || "").trim(),
      calories: Math.round(Number(item.calories) || 0),
      protein: Math.round((Number(item.protein) || 0) * 10) / 10,
      carbs: Math.round((Number(item.carbs) || 0) * 10) / 10,
      fat: Math.round((Number(item.fat) || 0) * 10) / 10,
    }));

    const total = {
      calories: Math.round(Number(parsed.total.calories) || 0),
      protein: Math.round((Number(parsed.total.protein) || 0) * 10) / 10,
      carbs: Math.round((Number(parsed.total.carbs) || 0) * 10) / 10,
      fat: Math.round((Number(parsed.total.fat) || 0) * 10) / 10,
    };

    const quality_score = Math.max(0, Math.min(100, Math.round(Number(parsed.quality_score) || 60)));
    const comment = String(parsed.comment || "").slice(0, 120);

    return sendJson(res, 200, {
      ok: true,
      date,
      items,
      total,
      quality_score,
      comment,
      source: "gemini"
    });
  } catch (err) {
    // Offline fallback
    const fallback = offlineFallback(description);
    return sendJson(res, 200, { ok: true, date, ...fallback });
  }
};
