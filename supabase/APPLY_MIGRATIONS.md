# FitAI Pro — Guide d'application des migrations Supabase

## ⚠️ OBLIGATOIRE avant de déployer v7

Deux étapes SQL à exécuter dans **Supabase Dashboard → SQL Editor**.

---

## Étape 1 — Schema complet (si projet neuf ou tables manquantes)

Copiez-collez le contenu de `schema.sql` dans l'éditeur SQL et exécutez.

Ce fichier est **idempotent** (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`).

> **Mis à jour** : `schema.sql` inclut maintenant `user_streaks` et `daily_moods`. Pour une installation fraîche, ce fichier seul suffit (sans les migrations v3/v6 pour ces deux tables).

---

## Étape 2 — Migration sociale V3 (OBLIGATOIRE)

Copiez-collez le contenu de `migration_v3_social.sql` dans l'éditeur SQL et exécutez.

### Ce que fait cette migration :

| # | Action | Pourquoi c'est critique |
|---|--------|------------------------|
| 1 | Ajoute `username` dans `profiles` | Recherche d'amis par username |
| 2 | Ajoute `image_url`, `visibility` dans `community_posts` | Posts photo + fil privé amis |
| 3 | Crée table `friendships` avec RLS | Système d'amis complet |
| 4 | **Ouvre RLS `profiles` à tous les utilisateurs auth** | ✅ **FIX critique** — sans ça, toutes les requêtes friends retournent 400 |
| 5 | Crée table `comments` avec RLS | Commentaires sur les posts |
| 6 | Crée table `user_streaks` | Streaks et défis |
| 7 | Crée fonction `give_kudos()` | Kudos atomiques sans race condition |

### Symptômes si migration_v3_social.sql n'est PAS appliquée :
- ❌ `loadFriends()` → erreur "relation 'friendships' does not exist"
- ❌ `searchUsers()` → 0 résultats (RLS bloque les autres profils)
- ❌ `loadFriendRequests()` → erreur DB
- ❌ `profiles.select("id,display_name")` en `.in()` → retourne vide (RLS)
- ❌ Commentaires → erreur "relation 'comments' does not exist"
- ❌ Streaks → erreur "relation 'user_streaks' does not exist"

---

## Étape 3 — Migration streak V7 (OBLIGATOIRE pour les installations existantes)

Copiez-collez `migration_v7_streak_lastactive.sql` dans SQL Editor.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | `ADD COLUMN IF NOT EXISTS last_active DATE` | Le JS utilise `last_active`, migration_v3 avait `last_workout_date` |
| 2 | Backfill `last_active` depuis `last_workout_date` | Préserve les données existantes |
| 3 | `ADD COLUMN IF NOT EXISTS longest_streak` | Migration_v4 n'avait que `best_streak` |
| 4 | `ADD COLUMN IF NOT EXISTS total_workouts` | Cohérence avec le schéma complet |

> Inutile si vous repartez d'une base vierge avec `schema.sql` — cette migration est pour les instances déjà en production.

---

## Étape 4 — Migration humeur quotidienne V6 (OBLIGATOIRE pour mood tracker)

Copiez-collez le contenu de `migration_v6_daily_moods.sql` dans l'éditeur SQL et exécutez.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | Crée table `daily_moods` (user_id, mood_level 1-5, mood_label, date) | Persistance humeur quotidienne |
| 2 | Index `user_id + date DESC` | Chargement rapide de l'historique |
| 3 | RLS — chaque user ne voit que ses propres humeurs | Sécurité |

### Symptômes si non appliquée :
- L'humeur est sauvegardée localement (localStorage) mais perdue en changeant d'appareil
- La section "Humeur" dans les Progrès affiche "Pas de données"

---

## Étape 4 — Variables d'environnement Vercel

Dans **Vercel Dashboard → Settings → Environment Variables**, configurez :

| Variable | Valeur | Obligatoire |
|----------|--------|-------------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | ✅ |
| `SUPABASE_ANON_KEY` | Clé anon/public depuis Supabase Settings → API | ✅ |
| `GEMINI_API_KEY` | Clé Google AI Studio | Optionnel (fallbacks si absent) |
| `ALLOWED_ORIGIN` | URL Vercel de production | Recommandé |

> **Note v7** : `SUPABASE_SERVICE_ROLE_KEY` n'est plus requise.
> Les endpoints `generate-nutrition` et `generate-recipe` utilisent maintenant `SUPABASE_ANON_KEY`.

---

## Vérification rapide après déploiement

Testez ces endpoints depuis votre navigateur (après connexion) :

```
GET  /api/config           → { ok: true, supabaseUrl: "..." }
POST /api/generate-nutrition  → { ok: true, nutrition: {...} }
POST /api/generate-recipe     → { ok: true, recipe: {...} }
POST /api/coach               → { ok: true, type: "conversation"|"workout" }
```

Si `/api/config` retourne une erreur → vérifiez vos variables d'environnement.
