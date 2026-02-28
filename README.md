# FitAI Pro — Guide de déploiement v3.4.0

## Structure finale du repo

```
fitai-pro/
├── api/
│   ├── config.js       ← NOUVEAU — config Supabase publique (retourne TOUJOURS JSON)
│   ├── workout.js      ← POST uniquement — génération IA
│   └── bodyscan.js     ← POST uniquement — analyse photo
├── public/
│   ├── index.html      ← SPA complète, 6 onglets fonctionnels
│   └── app.js          ← logique complète
├── vercel.json         ← routing explicite avec @vercel/node
├── package.json        ← node 20.x (IMPORTANT, pas 24.x)
└── supabase-schema.sql ← à coller dans Supabase SQL Editor
```

## Checklist déploiement (dans l'ordre)

### 1. Git — vérifiez que tous les fichiers sont trackés
```bash
git status
git add -A
git commit -m "FitAI Pro v3.4.0 — fix routing + tous onglets"
git push
```

### 2. Vercel — Variables d'environnement
Dans Vercel Dashboard → votre projet → Settings → Environment Variables
Ajouter ces 4 variables (Production + Preview + Development) :

| Variable                    | Valeur                        |
|-----------------------------|-------------------------------|
| SUPABASE_URL                | https://xxxx.supabase.co      |
| SUPABASE_ANON_KEY           | eyJhbGciO...                  |
| SUPABASE_SERVICE_ROLE_KEY   | eyJhbGciO... (service role)   |
| GEMINI_API_KEY              | AIza...                       |

### 3. Supabase — Exécuter le SQL
Dashboard → SQL Editor → coller supabase-schema.sql → Run

### 4. Supabase — Créer le bucket Storage
Dashboard → Storage → New Bucket
- Name: `user_uploads`
- Public: NON (décoché)

Puis Storage → Policies → ajouter 2 policies sur `user_uploads` :
- INSERT : `(bucket_id = 'user_uploads') AND ((auth.uid())::text = (storage.foldername(name))[1])`
- SELECT : `(bucket_id = 'user_uploads') AND ((auth.uid())::text = (storage.foldername(name))[1])`

### 5. Vercel — Redéployer
Settings → Deployments → Redeploy (ou pousser un nouveau commit)

---

## Tests curl post-déploiement

Remplacer `VOTRE-URL.vercel.app` par votre vraie URL.

```bash
# Test 1 — Config endpoint (doit retourner JSON {"ok":true,...})
curl -s "https://VOTRE-URL.vercel.app/api/config" | python3 -m json.tool

# Test 2 — Content-Type (doit afficher application/json)
curl -sI "https://VOTRE-URL.vercel.app/api/config" | grep -i content-type

# Test 3 — Workout POST (doit retourner un plan JSON)
curl -s -X POST "https://VOTRE-URL.vercel.app/api/workout" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"HIIT 20min sans matériel"}' | python3 -m json.tool

# Test 4 — OPTIONS preflight (doit retourner 204)
curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
  "https://VOTRE-URL.vercel.app/api/workout"
```

**Résultats attendus :**
- Test 1 : `{"ok": true, "supabaseUrl": "https://...", "supabaseAnonKey": "eyJ..."}`
- Test 2 : `content-type: application/json; charset=utf-8`
- Test 3 : `{"ok": true, "data": {"title": "...", "blocks": [...]}}`
- Test 4 : `204`

---

## Diagnostic si /api/config retourne encore du HTML

1. **`git status`** → vérifier que `api/config.js` est dans le repo
2. **Vercel Dashboard → Functions** → vérifier que les 3 fonctions apparaissent
3. **Vercel Dashboard → Deployments → votre déploiement → Build logs** → chercher des erreurs
4. **`node -e "require('./api/config.js')"` en local** → vérifier pas d'erreur de syntaxe

## Fonctionnalités par onglet

| Onglet      | Fonctionnalités                                              |
|-------------|--------------------------------------------------------------|
| 🎯 Objectif  | Créer/modifier objectif (type, niveau, texte, contraintes)  |
| 🤖 Coach     | Génération IA Gemini + sauvegarde + historique 8 séances    |
| 🥗 Nutrition | Ajout repas, totaux macros jour, suppression                 |
| 🌍 Communauté| Feed global, publication, kudos, suppression propres posts  |
| 📸 Scan      | Upload photo → analyse Gemini Vision → scores + feedback    |
| 👤 Profil    | Pseudo, stats (séances/scans/posts), déconnexion            |
