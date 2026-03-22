# FitAI Pro

Application SaaS fitness en JavaScript vanilla avec API serverless Vercel, Supabase et modules IA pour coach, nutrition et body scan.

## Ce que fait vraiment le projet
- Dashboard fitness avec objectif, séance du jour, défis et progression
- Coach IA avec réponses conversationnelles, séances, recettes, listes de courses et plans repas
- Nutrition avec macros, plan du jour, hydratation, recettes et fallback local premium
- Body Scan avec analyse photo, score calibré, recommandations entraînement/nutrition et historique
- Communauté, amis, profil, humeur du jour et suivi des séances

## Stack
- Frontend : HTML / CSS / JavaScript vanilla dans `public/`
- Backend : fonctions serverless Vercel dans `api/`
- Données / auth / storage : Supabase
- IA : Gemini avec timeouts courts + fallbacks défensifs

## Lancer le projet
1. Copier `env.example` vers vos variables d'environnement Vercel/locales
2. Installer les dépendances : `npm install`
3. Appliquer le schéma principal : `supabase/schema.sql`
4. Si besoin, appliquer aussi les migrations complémentaires du dossier `supabase/`
5. Vérifier la syntaxe : `npm run verify`
6. Lancer en local : `npm run dev`

## Variables importantes
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` pour les routes serveur qui écrivent en base/storage
- `GEMINI_API_KEY` pour activer les réponses IA complètes

Le projet reste utilisable en mode dégradé sur les modules coach, nutrition, recette et body scan même si Gemini est indisponible.

## Structure utile
- `public/index.html` : structure UI et styles principaux
- `public/app.js` : logique SPA, rendu des onglets, coach, nutrition, body scan, progrès
- `api/_coach-core.js` : normalisation des réponses coach / workout / shopping list
- `api/_gemini.js` : wrapper Gemini avec timeout, retry minimal et extraction JSON
- `api/coach.js` : endpoint coach principal
- `api/generate-nutrition.js` : endpoint nutrition premium + fallback
- `api/bodyscan.js` : endpoint analyse photo + calibration score
- `supabase/schema.sql` : schéma consolidé

## État actuel
- APIs critiques défensives
- Frontend avec fallbacks sur les états vides
- Coach et nutrition utilisables même sans IA
- Body scan calibré mais dépendant de la qualité photo
- Certains modules optionnels, comme `daily_moods`, nécessitent les migrations associées pour supprimer les warnings Supabase

## Vérification
`npm run verify` lance un check de syntaxe sur le frontend et les routes API critiques.
