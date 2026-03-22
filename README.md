# FitAI Pro

Application fitness full-stack (frontend statique + API Vercel + Supabase) stabilisée pour soutenance de fin d'étude.

## Stack
- Frontend: HTML/CSS/JS vanilla dans `public/`
- API: fonctions serverless Vercel dans `api/`
- DB/Auth/Storage: Supabase
- IA: Gemini avec fallbacks immédiats

## Démarrage
1. Configurez les variables d'environnement à partir de `env.example`
2. Appliquez `supabase/schema.sql`
3. Installez les dépendances: `npm install`
4. Vérifiez la syntaxe: `npm run verify`
5. Lancez localement: `npm run dev`

## Points importants
- `/api/workout` retourne toujours un JSON utile même si Gemini échoue
- `/api/coach` et `/api/generate-recipe` ont des fallbacks immédiats
- `/api/bodyscan` enregistre toujours un résultat exploitable ou un mode dégradé clair
- les métriques frontend critiques (séances, streak, progrès) sont recalculées à partir des données réelles `workout_sessions`

## Dossier principal
- `public/index.html` : interface
- `public/app.js` : logique frontend
- `api/_coach-core.js` : génération / normalisation workouts et réponses coach
- `api/_gemini.js` : wrapper Gemini avec timeout + retries limités
- `api/config.js` : bootstrap config Supabase côté client
- `supabase/schema.sql` : schéma consolidé

## Vérification
`npm run verify` lance un check de syntaxe sur le frontend et les routes API critiques.
