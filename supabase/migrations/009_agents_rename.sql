-- ============================================================
-- 009_agents_rename.sql — rename app table agents -> claw_agents
-- ============================================================
-- Fixes Issue #35: n8n >= 2.21.4 ships a core "Agents" feature whose
-- migration CreateAgentTables1783000000000 creates a table named
-- `agents` and indexes its `projectId` column. n8n-claw already owns
-- `public.agents` (persona/config table) in the SAME database, so
-- n8n's createTable no-ops, the createIndex on projectId fails, and
-- n8n never boots.
--
-- Fix: move the n8n-claw data to `claw_agents`, freeing the `agents`
-- name for n8n's own table.
--
-- Data-preserving, idempotent, and safe by design:
--   * Only ever touches a public.agents table that has a `key` column.
--     That uniquely identifies n8n-claw's table and NEVER matches
--     n8n's core `agents` (which has no `key`). If n8n already created
--     its own `agents`, the whole block is a no-op.
--   * Two paths, because 001_schema.sql (which creates `claw_agents`)
--     runs BEFORE this migration in setup.sh:
--       - claw_agents does NOT exist yet  -> plain RENAME (carries data).
--       - claw_agents already exists (empty shell created by 001 on an
--         upgrade) -> copy the legacy rows over, then DROP the legacy
--         table to free the `agents` name.
--   * Re-runs are no-ops once the legacy table is gone.
-- ============================================================

DO $$
BEGIN
  -- Act only if the LEGACY n8n-claw table (identified by `key`) still
  -- exists under the old name `agents`.
  IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'agents'
          AND column_name  = 'key'
     )
  THEN
    IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name   = 'claw_agents'
       )
    THEN
      -- claw_agents does not exist yet: rename in place (keeps all data).
      ALTER TABLE public.agents RENAME TO claw_agents;
      ALTER SEQUENCE IF EXISTS public.agents_id_seq RENAME TO claw_agents_id_seq;
    ELSE
      -- claw_agents already exists (created empty by 001 on an upgrade):
      -- move legacy rows over, then drop the legacy table to free `agents`.
      INSERT INTO public.claw_agents (key, content, updated_at)
        SELECT key, content, updated_at FROM public.agents
        ON CONFLICT (key) DO NOTHING;
      DROP TABLE public.agents;
    END IF;
  END IF;
END $$;
