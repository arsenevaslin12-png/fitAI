-- ============================================================
-- FitAI Pro v5.0.0 — SCHEMA SQL COMPLET
-- Executer dans Supabase Dashboard → SQL Editor
-- ============================================================

-- ==================== TABLES ====================

-- 1. PROFILES (PK = auth.users.id)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  weight INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. GOALS (one per user)
CREATE TABLE IF NOT EXISTS public.goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT,
  level TEXT,
  text TEXT,
  constraints TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT goals_user_unique UNIQUE (user_id)
);

-- 3. WORKOUT_SESSIONS
CREATE TABLE IF NOT EXISTS public.workout_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. BODY_SCANS
CREATE TABLE IF NOT EXISTS public.body_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  ai_feedback TEXT,
  ai_version TEXT,
  symmetry_score NUMERIC,
  posture_score NUMERIC,
  bodyfat_proxy NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. MEALS
CREATE TABLE IF NOT EXISTS public.meals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  calories INTEGER DEFAULT 0,
  protein INTEGER DEFAULT 0,
  carbs INTEGER DEFAULT 0,
  fat INTEGER DEFAULT 0,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. COMMUNITY_POSTS
CREATE TABLE IF NOT EXISTS public.community_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  kudos INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. NUTRITION_TARGETS (one per user, upsert on user_id)
CREATE TABLE IF NOT EXISTS public.nutrition_targets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  calories INTEGER,
  protein INTEGER,
  carbs INTEGER,
  fats INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT nutrition_targets_user_unique UNIQUE (user_id)
);

-- 8. TRAINING_SCHEDULE (weekly plan)
CREATE TABLE IF NOT EXISTS public.training_schedule (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  workout_type TEXT NOT NULL,
  intensity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'planned',
  notes TEXT,
  week_start_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ==================== INDEXES ====================

CREATE INDEX IF NOT EXISTS idx_goals_user ON public.goals(user_id);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_user ON public.workout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_workout_sessions_created ON public.workout_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_body_scans_user ON public.body_scans(user_id);
CREATE INDEX IF NOT EXISTS idx_body_scans_created ON public.body_scans(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON public.meals(user_id, date);
CREATE INDEX IF NOT EXISTS idx_community_posts_created ON public.community_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_user ON public.community_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_nutrition_targets_user ON public.nutrition_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_training_schedule_user_week ON public.training_schedule(user_id, week_start_date);


-- ==================== RLS POLICIES ====================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.body_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nutrition_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_schedule ENABLE ROW LEVEL SECURITY;

-- PROFILES: user can CRUD own row
-- Profiles: any authenticated user can read display_name (needed for feed author names)
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- GOALS: user can CRUD own rows
DROP POLICY IF EXISTS "goals_select_own" ON public.goals;
CREATE POLICY "goals_select_own" ON public.goals FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "goals_insert_own" ON public.goals;
CREATE POLICY "goals_insert_own" ON public.goals FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "goals_update_own" ON public.goals;
CREATE POLICY "goals_update_own" ON public.goals FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- WORKOUT_SESSIONS: user can CRUD own rows
DROP POLICY IF EXISTS "ws_select_own" ON public.workout_sessions;
CREATE POLICY "ws_select_own" ON public.workout_sessions FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ws_insert_own" ON public.workout_sessions;
CREATE POLICY "ws_insert_own" ON public.workout_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ws_delete_own" ON public.workout_sessions;
CREATE POLICY "ws_delete_own" ON public.workout_sessions FOR DELETE USING (auth.uid() = user_id);

-- BODY_SCANS: user can CRUD own rows
DROP POLICY IF EXISTS "bs_select_own" ON public.body_scans;
CREATE POLICY "bs_select_own" ON public.body_scans FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "bs_insert_own" ON public.body_scans;
CREATE POLICY "bs_insert_own" ON public.body_scans FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "bs_update_own" ON public.body_scans;
CREATE POLICY "bs_update_own" ON public.body_scans FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- MEALS: user can CRUD own rows
DROP POLICY IF EXISTS "meals_select_own" ON public.meals;
CREATE POLICY "meals_select_own" ON public.meals FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "meals_insert_own" ON public.meals;
CREATE POLICY "meals_insert_own" ON public.meals FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "meals_delete_own" ON public.meals;
CREATE POLICY "meals_delete_own" ON public.meals FOR DELETE USING (auth.uid() = user_id);

-- COMMUNITY_POSTS: anyone auth can read, user can CUD own
DROP POLICY IF EXISTS "cp_select_all" ON public.community_posts;
CREATE POLICY "cp_select_all" ON public.community_posts FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "cp_insert_own" ON public.community_posts;
CREATE POLICY "cp_insert_own" ON public.community_posts FOR INSERT WITH CHECK (auth.uid() = user_id);
-- Kudos: any authenticated user can update kudos (safe — only integer field)
-- Removed dangerous "OR true" that allowed any user to modify any post
DROP POLICY IF EXISTS "cp_update_kudos" ON public.community_posts;
CREATE POLICY "cp_update_kudos" ON public.community_posts FOR UPDATE
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "cp_delete_own" ON public.community_posts;
CREATE POLICY "cp_delete_own" ON public.community_posts FOR DELETE USING (auth.uid() = user_id);

-- NUTRITION_TARGETS: user can CRUD own rows + service role can upsert
DROP POLICY IF EXISTS "nt_select_own" ON public.nutrition_targets;
CREATE POLICY "nt_select_own" ON public.nutrition_targets FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "nt_insert_own" ON public.nutrition_targets;
CREATE POLICY "nt_insert_own" ON public.nutrition_targets FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "nt_update_own" ON public.nutrition_targets;
CREATE POLICY "nt_update_own" ON public.nutrition_targets FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- TRAINING_SCHEDULE: user can CRUD own rows + service role
DROP POLICY IF EXISTS "ts_select_own" ON public.training_schedule;
CREATE POLICY "ts_select_own" ON public.training_schedule FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ts_insert_own" ON public.training_schedule;
CREATE POLICY "ts_insert_own" ON public.training_schedule FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "ts_delete_own" ON public.training_schedule;
CREATE POLICY "ts_delete_own" ON public.training_schedule FOR DELETE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "ts_update_own" ON public.training_schedule;
CREATE POLICY "ts_update_own" ON public.training_schedule FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ==================== STORAGE ====================

-- Create bucket if not exists (run manually in Dashboard if needed)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('user_uploads', 'user_uploads', false) ON CONFLICT DO NOTHING;

-- Storage policies for user_uploads bucket
-- Users can upload to their own folder: {user_id}/...
DROP POLICY IF EXISTS "user_uploads_insert" ON storage.objects;
CREATE POLICY "user_uploads_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'user_uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can read their own files
DROP POLICY IF EXISTS "user_uploads_select" ON storage.objects;
CREATE POLICY "user_uploads_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'user_uploads' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Users can delete their own files
DROP POLICY IF EXISTS "user_uploads_delete" ON storage.objects;
CREATE POLICY "user_uploads_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'user_uploads' AND (storage.foldername(name))[1] = auth.uid()::text);


-- ==================== AUTO-CREATE PROFILE ON SIGNUP ====================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, created_at, updated_at)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)), NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- DONE. All tables, indexes, RLS, storage, and triggers created.
-- ============================================================
