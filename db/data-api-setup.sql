-- One-time setup for the Neon Data API authenticated role + RLS.
-- Run against neondb as the owner role after creating the bets table.
-- Applied to the production branch on 2026-06-21.
--
-- What this does:
--   • Grants the 'authenticated' role (Neon Auth JWT role) read/write access to bets.
--   • Enables RLS on bets with a per-user policy driven by auth.user_id() (= JWT sub claim).
--   • Each user can only read and write their own rows — enforced at the database level.

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bets TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE bets_id_seq TO authenticated;

ALTER TABLE bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_rw_bets ON bets;

CREATE POLICY app_rw_bets ON bets
  FOR ALL TO authenticated
  USING      (auth.user_id() = user_id)
  WITH CHECK (auth.user_id() = user_id);
