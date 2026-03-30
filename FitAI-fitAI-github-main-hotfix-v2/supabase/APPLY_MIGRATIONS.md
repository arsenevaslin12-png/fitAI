# FitAI Pro — Guide d'application des migrations Supabase

## ⚠️ OBLIGATOIRE avant de déployer

Exécutez chaque étape dans **Supabase Dashboard → SQL Editor** dans l'ordre indiqué.

---

## Étape 1 — Schema complet (si projet neuf ou tables manquantes)

Copiez-collez le contenu de `schema.sql` dans l'éditeur SQL et exécutez.

Ce fichier est **idempotent** (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`).

> **Note** : `schema.sql` inclut `user_streaks`, `daily_moods` et `achievements`.
> Pour une installation fraîche, ce fichier seul suffit — sans les migrations v3/v6/v7/v8.

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

### Symptômes si non appliquée :
- ❌ `loadFriends()` → erreur "relation 'friendships' does not exist"
- ❌ `searchUsers()` → 0 résultats (RLS bloque les autres profils)
- ❌ Commentaires → erreur "relation 'comments' does not exist"
- ❌ Streaks → erreur "relation 'user_streaks' does not exist"

---

## Étape 3 — Migration streak V7 (OBLIGATOIRE pour installations existantes)

Copiez-collez `migration_v7_streak_lastactive.sql` dans SQL Editor.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | `ADD COLUMN IF NOT EXISTS last_active DATE` | Le JS utilise `last_active`, migration_v3 avait `last_workout_date` |
| 2 | Backfill `last_active` depuis `last_workout_date` | Préserve les données existantes |
| 3 | `ADD COLUMN IF NOT EXISTS longest_streak` | Cohérence avec le schéma complet |
| 4 | `ADD COLUMN IF NOT EXISTS total_workouts` | Cohérence avec le schéma complet |

> Inutile si vous repartez d'une base vierge avec `schema.sql`.

---

## Étape 4 — Migration achievements V8 (OBLIGATOIRE pour installations existantes)

Copiez-collez `migration_v8_achievements.sql` dans SQL Editor.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | Crée table `achievements` (user_id, code, title, earned_at) | Système de succès/badges |
| 2 | RLS — chaque user ne voit que ses propres succès | Sécurité |

> Inutile si vous repartez d'une base vierge avec `schema.sql` (déjà inclus).

---

## Étape 5 — Migration humeur quotidienne V6 (OBLIGATOIRE pour mood tracker)

Copiez-collez le contenu de `migration_v6_daily_moods.sql` dans l'éditeur SQL et exécutez.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | Crée table `daily_moods` (user_id, mood_level 1-5, mood_label, date) | Persistance humeur quotidienne |
| 2 | Index `user_id + date DESC` | Chargement rapide de l'historique |
| 3 | RLS — chaque user ne voit que ses propres humeurs | Sécurité |

### Symptômes si non appliquée :
- L'humeur est sauvegardée localement (localStorage) mais perdue en changeant d'appareil

---

## Étape 5b — Migration recettes sauvegardées V9 (OBLIGATOIRE)

Copiez-collez `migration_v9_saved_recipes.sql` dans SQL Editor.

### Ce que fait cette migration :
| # | Action | Pourquoi |
|---|--------|----------|
| 1 | Crée table `saved_recipes` (user_id, name, macros, steps, tips) | Historique des recettes générées par l'IA |
| 2 | Index sur `user_id, saved_at DESC` | Chargement rapide des 8 dernières recettes |
| 3 | RLS CRUD — chaque user ne voit que ses propres recettes | Sécurité |
| 4 | `UNIQUE(user_id, name)` — pas de doublons | Upsert idempotent |

---

## Étape 6 — Bucket Supabase Storage (OBLIGATOIRE pour le bodyscan)

Le bodyscan photo nécessite un bucket de stockage. **Ce bucket doit être créé manuellement** dans le Dashboard Supabase — il ne peut pas être créé via SQL Editor.

### Procédure :

1. Ouvrez **Supabase Dashboard → Storage**
2. Cliquez **"New bucket"**
3. Nom : `user_uploads`
4. **Décochez** "Public bucket" (le bucket doit être privé)
5. Cliquez **"Create bucket"**

Ensuite, exécutez les politiques de storage en décommentant et exécutant la section `Storage policies` dans `schema.sql` (lignes ~224–260), ou exécutez manuellement :

```sql
-- Politique upload : chaque user ne peut uploader que dans son dossier
CREATE POLICY "user_uploads_insert" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Politique lecture : chaque user ne peut lire que ses propres fichiers
CREATE POLICY "user_uploads_select" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Politique suppression
CREATE POLICY "user_uploads_delete" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
```

### Symptômes si non fait :
- ❌ Bodyscan → "Erreur upload" ou `storage/object-not-found`
- ❌ Photos de posts → échec silencieux ou erreur 400

---

## Étape 7 — Variables d'environnement Vercel

Dans **Vercel Dashboard → Settings → Environment Variables**, configurez :

| Variable | Valeur | Obligatoire |
|----------|--------|-------------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | ✅ |
| `SUPABASE_ANON_KEY` | Clé anon/public depuis Supabase Settings → API | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service role depuis Supabase Settings → API | ✅ Pour `/api/generate-plan` |
| `GEMINI_API_KEY` | Clé Google AI Studio | ✅ (fallbacks texte si absent) |
| `ALLOWED_ORIGIN` | URL Vercel de production | Recommandé |

---

## Vérification rapide après déploiement

Testez ces endpoints depuis votre navigateur (après connexion) :

```
GET  /api/config              → { ok: true, supabaseUrl: "..." }
POST /api/generate-nutrition  → { ok: true, nutrition: {...} }
POST /api/generate-recipe     → { ok: true, recipe: {...} }
POST /api/coach               → { ok: true, type: "conversation"|"workout" }
```

Si `/api/config` retourne une erreur → vérifiez vos variables d'environnement.
