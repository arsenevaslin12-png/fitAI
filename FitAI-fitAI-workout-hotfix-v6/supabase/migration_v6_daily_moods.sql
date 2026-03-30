-- ─────────────────────────────────────────────────────────────────────────────
-- migration_v6_daily_moods.sql
-- Table pour stocker l'humeur quotidienne de chaque utilisateur
-- Appliquer dans : Supabase Dashboard → SQL Editor → Run
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS daily_moods (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mood_level   INT         NOT NULL CHECK (mood_level BETWEEN 1 AND 5),
  mood_label   TEXT        NOT NULL DEFAULT '',
  date         DATE        NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, date)
);

-- Index pour les requêtes par user + date range
CREATE INDEX IF NOT EXISTS daily_moods_user_date_idx ON daily_moods (user_id, date DESC);

-- Row Level Security
ALTER TABLE daily_moods ENABLE ROW LEVEL SECURITY;

-- Politique : chaque utilisateur ne voit et ne modifie que ses propres humeurs
CREATE POLICY "Users manage own moods" ON daily_moods
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
