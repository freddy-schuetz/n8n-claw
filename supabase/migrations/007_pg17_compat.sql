-- ============================================================
-- 007_pg17_compat.sql — PostgreSQL 17 forward-compatibility
-- ============================================================
-- PG17 enforces a "safe search_path" during maintenance operations
-- (CREATE INDEX, REINDEX, REFRESH MATERIALIZED VIEW, VACUUM, ANALYZE,
-- CLUSTER, CREATE MATERIALIZED VIEW). Functions referenced from
-- index expressions or generated columns must explicitly set their
-- search_path to keep working under PG17.
--
-- See https://www.postgresql.org/docs/17/release-17.html
--
-- This is idempotent and runs cleanly under PG15 too — apply it
-- well before the actual PG17 upgrade.

-- public.immutable_unaccent is referenced from the GENERATED STORED
-- column memory_long.search_vector and indexed via GIN. Without an
-- explicit search_path, REINDEX/CLUSTER could fail under PG17.
ALTER FUNCTION public.immutable_unaccent(text)
  SET search_path = public, pg_catalog;
