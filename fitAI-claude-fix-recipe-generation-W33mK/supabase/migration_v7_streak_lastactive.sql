-- ─────────────────────────────────────────────────────────────────────────────
-- migration_v7_streak_lastactive.sql
-- Ajoute la colonne last_active à user_streaks pour les installations existantes
-- (migration_v3_social utilisait last_workout_date, le JS utilise last_active)
-- Idempotent — peut être relancé sans risque.
-- ─────────────────────────────────────────────────────────────────────────────

-- Ajoute last_active si elle n'existe pas encore
ALTER TABLE public.user_streaks
  ADD COLUMN IF NOT EXISTS last_active DATE;

-- Backfill depuis last_workout_date si la colonne existe et que last_active est vide
UPDATE public.user_streaks
SET last_active = last_workout_date
WHERE last_active IS NULL
  AND last_workout_date IS NOT NULL;

-- Ajoute longest_streak si elle n'existe pas (migration_v4 n'avait que best_streak)
ALTER TABLE public.user_streaks
  ADD COLUMN IF NOT EXISTS longest_streak INTEGER DEFAULT 0;

-- Ajoute total_workouts si elle n'existe pas
ALTER TABLE public.user_streaks
  ADD COLUMN IF NOT EXISTS total_workouts INTEGER DEFAULT 0;
