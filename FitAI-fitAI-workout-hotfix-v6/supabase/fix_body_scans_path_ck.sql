-- ============================================================
-- FitAI Pro — body_scans_path_ck fix
-- Run in Supabase Dashboard → SQL Editor
-- ============================================================

-- STEP 1: Inspect the current constraint definition
SELECT
  conname,
  pg_get_constraintdef(oid) AS constraint_sql
FROM pg_constraint
WHERE conrelid = 'public.body_scans'::regclass
  AND contype = 'c'
ORDER BY conname;

-- STEP 2: If constraint is too restrictive, replace it with a permissive one.
--
-- The new app.js path format is: {user_id}/bodyscans/{timestamp}.{ext}
-- e.g. "550e8400-e29b-41d4-a716-446655440000/bodyscans/1709298765432.jpg"
--
-- Uncomment and run ONLY after reading STEP 1 output:

-- ALTER TABLE public.body_scans DROP CONSTRAINT IF EXISTS body_scans_path_ck;
-- ALTER TABLE public.body_scans
--   ADD CONSTRAINT body_scans_path_ck
--   CHECK (
--     image_path IS NOT NULL
--     AND length(image_path) > 10
--     AND image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.+\.(jpg|jpeg|png|webp|gif)$'
--   );

-- STEP 3: Verify any existing rows still pass the new constraint
-- SELECT id, image_path FROM public.body_scans
-- WHERE image_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.+\.(jpg|jpeg|png|webp|gif)$';
