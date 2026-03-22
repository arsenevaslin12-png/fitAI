# FitAI Pro — changements appliqués

## API
- `/api/workout`
  - réponse success flattenée + `data` conservé pour compatibilité
  - toujours fallback utile si Gemini échoue
- `api/_coach-core.js`
  - timeouts Gemini réduits
  - retries limités à 1 max
  - fallback workouts/conversation/recipe plus rapides
- `api/_env.js`
  - validation Supabase corrigée
  - support des publishable keys Supabase
  - `GEMINI_API_KEY` rendue optionnelle sur les routes avec fallback
- `/api/bodyscan`
  - analyse dégradée toujours utile, jamais vide
  - sauvegarde DB robuste (update existant ou insert)
  - meilleure normalisation des scores/feedback

## Frontend
- `public/index.html`
  - correction du lien dashboard → Scan IA (`bodyscan`)
  - IDs ajoutés pour alimenter la carte “Entraînement du jour”
  - cible `st-longest` ajoutée sans modifier l’UI
- `public/app.js`
  - ajout d’un calcul centralisé des métriques workout depuis `workout_sessions`
  - streak / total séances / défis / progrès désormais cohérents entre pages
  - la carte dashboard “Entraînement du jour” n’affiche plus de placeholder faux
  - body scans: signed URLs pour afficher les photos privées
  - suppression de l’upsert cassé sur `user_streaks.last_active`
  - requêtes `loadProgress()` sécurisées contre les dérives de schéma
  - cache local invalidé après sauvegarde de séance

## Base de données / repo
- `supabase/schema.sql`
  - patchs consolidés pour colonnes/tables réellement utilisées par l’app
  - ajout de `friendships`, `comments`, `user_streaks`, `daily_moods`
  - ajout de `physical_score` et `extended_analysis` sur `body_scans`
- `env.example`
  - remplacé par un vrai template d’environnement
- `package.json`
  - `npm run verify` ajouté
  - `lint` redirigé vers la vérification syntaxique
- nettoyage du repo final
  - suppression des ZIPs embarqués
  - suppression des faux fichiers racine non utilisés

## 2026-03-21 — Coach + Nutrition stability update
- Coach: streaming now bypassed for structured requests (workout / meal plan / shopping list / recipe)
- Coach: added client-side timeout on SSE stream and local fallback payloads if both stream and JSON fail
- Coach: frontend now renders `recipe` responses correctly in chat
- Coach API: structured fallback responses returned on Gemini failure instead of generic conversation only
- Nutrition API: rebuilt to return macros + hydration + simple day plan in one response
- Nutrition frontend: added persistent “Plan nutrition du jour” result card with meals + hydration summary
- Nutrition: fixed missing Supabase client import crash path with lazy loading guard

## Premium upgrade — Coach + Nutrition (2026-03-22)

### Nutrition
- plans enrichis avec `summary`, `day_type`, `coach_note`, `training_note`, `tips`, `substitutions`
- fallback nutrition rendu premium et crédible, plus seulement technique
- meilleure différenciation maintien / sèche / prise de masse
- meilleure différenciation jour d'entraînement / jour de repos
- variété repas + options de substitution + conseils d'adhérence
- rendu frontend enrichi : résumé objectif, hydratation, conseils, substitutions, coach notes

### Coach
- prompt conversationnel renforcé avec structure `Réponse directe / Pourquoi / Action du jour`
- fallbacks coach plus humains, motivants et actionnables
- rendu frontend enrichi avec badges visuels par type de réponse
- meilleur rendu des plans nutrition, recettes, listes de courses et séances dans le chat
- stream fallback premium plus utile en cas de lenteur / timeout
