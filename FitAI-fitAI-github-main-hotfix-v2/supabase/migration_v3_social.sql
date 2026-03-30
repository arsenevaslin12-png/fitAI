-- ============================================================
-- FitAI Pro — Migration V3: Social Features
-- Run in Supabase SQL Editor
-- Idempotent: safe to run multiple times
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add `username` column to profiles (for friend search)
-- ------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username
  ON public.profiles(username) WHERE username IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Add `image_url` column to community_posts (photo posts)
-- ------------------------------------------------------------
ALTER TABLE public.community_posts ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ------------------------------------------------------------
-- 3. Add `visibility` column to community_posts (private feed)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'community_posts'
      AND column_name = 'visibility'
  ) THEN
    ALTER TABLE public.community_posts
      ADD COLUMN visibility TEXT DEFAULT 'public'
      CHECK (visibility IN ('public', 'friends'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Create `friendships` table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friendships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT friendships_no_self CHECK (requester_id != addressee_id),
  CONSTRAINT friendships_unique_pair UNIQUE (requester_id, addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON public.friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON public.friendships(addressee_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status    ON public.friendships(status);

-- ------------------------------------------------------------
-- 5. RLS policies for friendships
-- ------------------------------------------------------------
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friendships_select" ON public.friendships;
CREATE POLICY "friendships_select" ON public.friendships FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

DROP POLICY IF EXISTS "friendships_insert" ON public.friendships;
CREATE POLICY "friendships_insert" ON public.friendships FOR INSERT
  WITH CHECK (auth.uid() = requester_id);

DROP POLICY IF EXISTS "friendships_update" ON public.friendships;
CREATE POLICY "friendships_update" ON public.friendships FOR UPDATE
  USING (auth.uid() = addressee_id);

DROP POLICY IF EXISTS "friendships_delete" ON public.friendships;
CREATE POLICY "friendships_delete" ON public.friendships FOR DELETE
  USING (auth.uid() = requester_id OR auth.uid() = addressee_id);

-- ------------------------------------------------------------
-- 6. Update community_posts SELECT policy for visibility
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "cp_select_all" ON public.community_posts;

DROP POLICY IF EXISTS "cp_select_with_visibility" ON public.community_posts;
CREATE POLICY "cp_select_with_visibility" ON public.community_posts FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      visibility = 'public'
      OR (
        visibility = 'friends'
        AND (
          user_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.friendships
            WHERE status = 'accepted'
            AND (
              (requester_id = auth.uid() AND addressee_id = community_posts.user_id)
              OR (addressee_id = auth.uid() AND requester_id = community_posts.user_id)
            )
          )
        )
      )
    )
  );

DROP POLICY IF EXISTS "cp_update_own" ON public.community_posts;
CREATE POLICY "cp_update_own" ON public.community_posts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "cp_update_kudos" ON public.community_posts;

-- ------------------------------------------------------------
-- 7. Update profiles SELECT policy (allow username search)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;

DROP POLICY IF EXISTS "profiles_search_by_username" ON public.profiles;
CREATE POLICY "profiles_search_by_username" ON public.profiles FOR SELECT
  USING (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 8. Storage policy for community post images
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "community_posts_images_read" ON storage.objects;
CREATE POLICY "community_posts_images_read" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'user_uploads'
    AND position('/posts/' in name) > 0
    AND EXISTS (
      SELECT 1
      FROM public.community_posts cp
      WHERE cp.image_url = name
        AND (
          cp.user_id = auth.uid()
          OR cp.visibility = 'public'
          OR (
            cp.visibility = 'friends'
            AND EXISTS (
              SELECT 1 FROM public.friendships f
              WHERE f.status = 'accepted'
                AND (
                  (f.requester_id = auth.uid() AND f.addressee_id = cp.user_id)
                  OR (f.addressee_id = auth.uid() AND f.requester_id = cp.user_id)
                )
            )
          )
        )
    )
  );

-- ------------------------------------------------------------
-- 9. Helper function: give_kudos (atomic increment)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.give_kudos(target_post_id UUID)
RETURNS JSON AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  UPDATE public.community_posts
  SET kudos = COALESCE(kudos, 0) + 1
  WHERE id = target_post_id;

  RETURN json_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------
-- 10. Create `comments` table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) <= 500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_post
  ON public.comments(post_id, created_at);

ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comments_select" ON public.comments;
CREATE POLICY "comments_select" ON public.comments FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.community_posts cp
      WHERE cp.id = comments.post_id
        AND (
          cp.user_id = auth.uid()
          OR cp.visibility = 'public'
          OR (
            cp.visibility = 'friends'
            AND EXISTS (
              SELECT 1 FROM public.friendships f
              WHERE f.status = 'accepted'
                AND (
                  (f.requester_id = auth.uid() AND f.addressee_id = cp.user_id)
                  OR (f.addressee_id = auth.uid() AND f.requester_id = cp.user_id)
                )
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "comments_insert" ON public.comments;
CREATE POLICY "comments_insert" ON public.comments FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.community_posts cp
      WHERE cp.id = comments.post_id
        AND (
          cp.user_id = auth.uid()
          OR cp.visibility = 'public'
          OR (
            cp.visibility = 'friends'
            AND EXISTS (
              SELECT 1 FROM public.friendships f
              WHERE f.status = 'accepted'
                AND (
                  (f.requester_id = auth.uid() AND f.addressee_id = cp.user_id)
                  OR (f.addressee_id = auth.uid() AND f.requester_id = cp.user_id)
                )
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "comments_delete" ON public.comments;
CREATE POLICY "comments_delete" ON public.comments FOR DELETE
  USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 11. Create `user_streaks` table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_streaks (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  total_workouts INTEGER DEFAULT 0,
  last_workout_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.user_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "streaks_select_own" ON public.user_streaks;
CREATE POLICY "streaks_select_own" ON public.user_streaks FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "streaks_upsert_own" ON public.user_streaks;
CREATE POLICY "streaks_upsert_own" ON public.user_streaks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "streaks_update_own" ON public.user_streaks;
CREATE POLICY "streaks_update_own" ON public.user_streaks FOR UPDATE
  USING (auth.uid() = user_id);

-- ============================================================
-- Migration V3 complete.
-- ============================================================
