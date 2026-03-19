-- Migration v5: Add age, weight, height to profiles table
-- Run this in Supabase Dashboard -> SQL Editor

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS age     INTEGER CHECK (age BETWEEN 10 AND 120),
  ADD COLUMN IF NOT EXISTS weight  NUMERIC(5,1) CHECK (weight BETWEEN 20 AND 500),
  ADD COLUMN IF NOT EXISTS height  NUMERIC(5,1) CHECK (height BETWEEN 50 AND 300);

COMMENT ON COLUMN profiles.age    IS 'Age in years';
COMMENT ON COLUMN profiles.weight IS 'Body weight in kg';
COMMENT ON COLUMN profiles.height IS 'Height in cm';
