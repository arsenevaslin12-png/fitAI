-- ============================================================
-- migration_v4_profiles_rls.sql
-- FitAI Pro — Social System Full Fix
-- APPLIQUER dans Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ── 1. Ajouter les colonnes manquantes dans profiles ────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS username     TEXT;

-- Index unique sur username (ignore NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_profiles_username'
  ) THEN
    CREATE UNIQUE INDEX idx_profiles_username
      ON public.profiles(username) WHERE username IS NOT NULL;
  END IF;
END $$;

-- ── 2. Corriger la RLS profiles : permettre la recherche cross-users ──
-- Supprimer les anciennes policies restrictives
DROP POLICY IF EXISTS profiles_select_own         ON public.profiles;
DROP POLICY IF EXISTS profiles_read_authenticated  ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own          ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own          ON public.profiles;
DROP POLICY IF EXISTS profiles_search_by_username  ON public.profiles;

-- Lecture : tout utilisateur authentifié peut lire tous les profils
CREATE POLICY profiles_read_authenticated
  ON public.profiles FOR SELECT
  USING (auth.role() = 'authenticated');

-- Écriture : uniquement le propriétaire
CREATE POLICY profiles_write_own
  ON public.profiles FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── 3. Créer la table friendships si absente ─────────────────
CREATE TABLE IF NOT EXISTS public.friendships (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  requester_id UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  addressee_id UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status       TEXT        DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(requester_id, addressee_id)
);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

-- Supprimer les anciennes policies friendships
DROP POLICY IF EXISTS friendships_auth   ON public.friendships;
DROP POLICY IF EXISTS friendships_select ON public.friendships;
DROP POLICY IF EXISTS friendships_insert ON public.friendships;
DROP POLICY IF EXISTS friendships_update ON public.friendships;
DROP POLICY IF EXISTS friendships_delete ON public.friendships;

-- Voir ses propres friendships (requester ou addressee)
CREATE POLICY friendships_select
  ON public.friendships FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- Envoyer une demande
CREATE POLICY friendships_insert
  ON public.friendships FOR INSERT
  WITH CHECK (auth.uid() = requester_id);

-- Accepter / refuser (l'addressee peut mettre à jour)
CREATE POLICY friendships_update
  ON public.friendships FOR UPDATE
  USING (auth.uid() = addressee_id);

-- Supprimer (l'un ou l'autre peut supprimer)
CREATE POLICY friendships_delete
  ON public.friendships FOR DELETE
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- ── 4. Table user_streaks (optionnelle, pour la gamification) ─
CREATE TABLE IF NOT EXISTS public.user_streaks (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  current_streak  INTEGER     DEFAULT 0,
  best_streak     INTEGER     DEFAULT 0,
  last_workout_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS streaks_own ON public.user_streaks;
CREATE POLICY streaks_own
  ON public.user_streaks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── Fin migration v4 ─────────────────────────────────────────
-- Résultat attendu :
--  ✓ profiles.username et profiles.display_name existent
--  ✓ Recherche cross-users activée (RLS permissive pour SELECT)
--  ✓ Table friendships créée avec policies granulaires
--  ✓ Table user_streaks prête
