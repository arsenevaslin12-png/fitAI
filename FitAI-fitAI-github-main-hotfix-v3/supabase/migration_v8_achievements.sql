-- Migration V8 — Table achievements
-- Pour les installations existantes qui ont déjà appliqué les migrations précédentes.
-- IDEMPOTENT : peut être exécuté plusieurs fois sans erreur.

CREATE TABLE IF NOT EXISTS public.achievements (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  earned_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, code)
);

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ach_select_own" ON public.achievements;
CREATE POLICY "ach_select_own" ON public.achievements
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "ach_insert_own" ON public.achievements;
CREATE POLICY "ach_insert_own" ON public.achievements
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ach_delete_own" ON public.achievements;
CREATE POLICY "ach_delete_own" ON public.achievements
  FOR DELETE USING (auth.uid() = user_id);
