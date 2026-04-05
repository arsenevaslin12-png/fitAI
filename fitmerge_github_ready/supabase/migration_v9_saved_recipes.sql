-- Migration V9 — Table saved_recipes
-- Pour les installations existantes. IDEMPOTENT.

CREATE TABLE IF NOT EXISTS public.saved_recipes (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  calories   INTEGER,
  protein    INTEGER,
  carbs      INTEGER,
  fat        INTEGER,
  prep_time  TEXT,
  steps      JSONB       DEFAULT '[]',
  tips       TEXT,
  saved_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_recipes_user ON public.saved_recipes(user_id, saved_at DESC);

ALTER TABLE public.saved_recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sr_select_own" ON public.saved_recipes;
CREATE POLICY "sr_select_own" ON public.saved_recipes FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "sr_insert_own" ON public.saved_recipes;
CREATE POLICY "sr_insert_own" ON public.saved_recipes FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "sr_update_own" ON public.saved_recipes;
CREATE POLICY "sr_update_own" ON public.saved_recipes FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "sr_delete_own" ON public.saved_recipes;
CREATE POLICY "sr_delete_own" ON public.saved_recipes FOR DELETE USING (auth.uid() = user_id);
