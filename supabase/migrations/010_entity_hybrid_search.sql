--
-- Entity Hybrid Search Migration (SLT R3)
--
-- Fixes three defects that made the knowledge graph effectively unsearchable:
--
--   (a) search_entities() filtered text on `name` only. `summary` was selected
--       but never searched, so an entity whose description said "n8n Nerd" could
--       not be found by that phrase — no matter how often the agent tried.
--   (b) Rows without an embedding bypassed the similarity threshold and were
--       given ORDER BY key 0. Real semantic hits always have cosine distance > 0,
--       so every un-embedded row sorted AHEAD of every genuine match and ate the
--       result budget.
--   (c) With all parameters NULL (which is what the tool sent whenever the
--       embedding service failed silently) the WHERE clause was entirely TRUE:
--       10 arbitrary rows came back, indistinguishable from real hits.
--
-- Requires: 004 (kg_entities), 005 (public.immutable_unaccent), 007 (PG17 hardening).
-- Idempotent. All identifiers public.-qualified (repo convention; also required
-- for GENERATED expressions and index expressions under a cleared search_path).
--
-- IMPORTANT: this file must run AFTER 004 — 004 recreates the old, defective
-- search_entities() on every setup.sh run and would otherwise win.
--

-- ============================================================
-- 1. GENERATED tsvector COLUMN on kg_entities
-- ============================================================
-- name (weight A) > entity_type (B) > summary (C). ts_rank_cd weights those
-- 1.0 / 0.4 / 0.2, so a name hit beats a description hit without extra logic.
-- Underscores in entity_type are replaced by spaces so `meeting_note` also
-- matches the query "meeting".
-- GENERATED ALWAYS ... STORED: existing rows are filled during ALTER, new rows
-- are maintained by Postgres — the Entity Manager needs no write-side change.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'kg_entities'
      AND column_name = 'search_vector'
  ) THEN
    ALTER TABLE public.kg_entities
      ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', public.immutable_unaccent(coalesce(name, ''))), 'A')
        ||
        setweight(to_tsvector('simple', public.immutable_unaccent(coalesce(replace(entity_type, '_', ' '), ''))), 'B')
        ||
        setweight(to_tsvector('simple', public.immutable_unaccent(coalesce(summary, ''))), 'C')
      ) STORED;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_kg_entities_search_vector
  ON public.kg_entities USING gin (search_vector);


-- ============================================================
-- 2. RPC: hybrid_search_entities
-- ============================================================
-- Same Reciprocal Rank Fusion as hybrid_search_memory (005), four branches:
--   1 Semantic  — pgvector cosine distance, only rows that HAVE an embedding
--   2 Fulltext  — tsvector over name + type + summary (this is what fixes (a))
--   3 Name      — accent-tolerant substring match, exact before prefix before short
--   4 Browse    — only when no search signal at all is given except a type filter
-- score = SUM 1/(k + rank) over the branches a row appears in, k=60.
--
-- Deliberate differences to the old function:
--   * similarity is NULL, not 0.0, when nothing was measured. 0.0 means
--     "maximally dissimilar" and was a lie that also broke the ordering.
--   * match_threshold defaults to NULL (no cutoff) and only ever filters INSIDE
--     the semantic branch — never as a global WHERE.
--   * no search signal at all returns zero rows instead of arbitrary ones.
--   * matched_by shows which branch produced a row, which makes both debugging
--     and the agent's own reporting honest.

DROP FUNCTION IF EXISTS public.hybrid_search_entities(
  public.vector, text, text, text, integer, double precision, integer
);

CREATE FUNCTION public.hybrid_search_entities(
  query_embedding public.vector DEFAULT NULL,
  query_text text DEFAULT NULL,
  search_name text DEFAULT NULL,
  filter_type text DEFAULT NULL,
  match_count integer DEFAULT 10,
  match_threshold double precision DEFAULT NULL,
  rrf_k integer DEFAULT 60
) RETURNS TABLE(
  id UUID,
  name TEXT,
  entity_type TEXT,
  summary TEXT,
  metadata JSONB,
  similarity double precision,
  rrf_score double precision,
  matched_by TEXT[],
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  name_term text := NULLIF(btrim(coalesce(search_name, query_text, '')), '');
  ft_query tsquery := NULL;
BEGIN
  -- Defect (c): without any signal, return nothing rather than a random sample.
  IF query_embedding IS NULL
     AND NULLIF(btrim(coalesce(query_text, '')), '') IS NULL
     AND NULLIF(btrim(coalesce(search_name, '')), '') IS NULL
     AND NULLIF(btrim(coalesce(filter_type, '')), '') IS NULL
  THEN
    RETURN;
  END IF;

  IF NULLIF(btrim(coalesce(query_text, '')), '') IS NOT NULL THEN
    ft_query := plainto_tsquery('simple', public.immutable_unaccent(query_text));
    IF numnode(ft_query) = 0 THEN
      ft_query := NULL;
    END IF;
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT e.*
    FROM public.kg_entities e
    WHERE (filter_type IS NULL OR e.entity_type = filter_type)
      AND (search_name IS NULL OR e.name ILIKE '%' || search_name || '%')
  ),

  -- Branch 1: semantic (defect (b): un-embedded rows cannot enter here at all)
  semantic_hits AS (
    SELECT f.id AS hid,
           ROW_NUMBER() OVER (ORDER BY f.embedding <=> query_embedding) AS rnk
    FROM filtered f
    WHERE query_embedding IS NOT NULL
      AND f.embedding IS NOT NULL
      AND (match_threshold IS NULL OR 1 - (f.embedding <=> query_embedding) >= match_threshold)
    ORDER BY f.embedding <=> query_embedding
    LIMIT 50
  ),

  -- Branch 2: fulltext over name + type + summary (defect (a))
  fulltext_hits AS (
    SELECT f.id AS hid,
           ROW_NUMBER() OVER (
             ORDER BY ts_rank_cd(f.search_vector, ft_query) DESC, f.updated_at DESC
           ) AS rnk
    FROM filtered f
    WHERE ft_query IS NOT NULL
      AND f.search_vector @@ ft_query
    ORDER BY ts_rank_cd(f.search_vector, ft_query) DESC, f.updated_at DESC
    LIMIT 50
  ),

  -- Branch 3: accent-tolerant name match
  name_hits AS (
    SELECT f.id AS hid,
           ROW_NUMBER() OVER (
             ORDER BY (lower(f.name) = lower(name_term)) DESC,
                      (public.immutable_unaccent(f.name) ILIKE public.immutable_unaccent(name_term) || '%') DESC,
                      length(f.name) ASC
           ) AS rnk
    FROM filtered f
    WHERE name_term IS NOT NULL
      AND public.immutable_unaccent(f.name) ILIKE '%' || public.immutable_unaccent(name_term) || '%'
    LIMIT 50
  ),

  -- Branch 4: plain browsing by type
  browse_hits AS (
    SELECT f.id AS hid,
           ROW_NUMBER() OVER (ORDER BY f.updated_at DESC NULLS LAST, f.created_at DESC) AS rnk
    FROM filtered f
    WHERE query_embedding IS NULL
      AND ft_query IS NULL
      AND name_term IS NULL
    LIMIT 50
  ),

  fused AS (
    SELECT x.hid,
           SUM(x.w) AS score,
           array_agg(DISTINCT x.src) AS branches
    FROM (
      SELECT s.hid, 1.0 / (rrf_k + s.rnk) AS w, 'semantic'::text AS src FROM semantic_hits s
      UNION ALL
      SELECT h.hid, 1.0 / (rrf_k + h.rnk), 'fulltext'::text FROM fulltext_hits h
      UNION ALL
      SELECT n.hid, 1.0 / (rrf_k + n.rnk), 'name'::text FROM name_hits n
      UNION ALL
      SELECT b.hid, 1.0 / (rrf_k + b.rnk), 'browse'::text FROM browse_hits b
    ) x
    GROUP BY x.hid
  )

  SELECT
    f.id,
    f.name,
    f.entity_type,
    f.summary,
    f.metadata,
    (CASE WHEN query_embedding IS NOT NULL AND f.embedding IS NOT NULL
          THEN 1 - (f.embedding <=> query_embedding)
          ELSE NULL END)::double precision AS similarity,
    fused.score::double precision AS rrf_score,
    fused.branches AS matched_by,
    f.created_at,
    f.updated_at
  FROM fused
  JOIN filtered f ON f.id = fused.hid
  ORDER BY fused.score DESC, f.updated_at DESC NULLS LAST
  LIMIT match_count;
END;
$$;

ALTER FUNCTION public.hybrid_search_entities(
  public.vector, text, text, text, integer, double precision, integer
) OWNER TO postgres;

GRANT ALL ON FUNCTION public.hybrid_search_entities(
  public.vector, text, text, text, integer, double precision, integer) TO anon;
GRANT ALL ON FUNCTION public.hybrid_search_entities(
  public.vector, text, text, text, integer, double precision, integer) TO authenticated;
GRANT ALL ON FUNCTION public.hybrid_search_entities(
  public.vector, text, text, text, integer, double precision, integer) TO service_role;


-- ============================================================
-- 3. Repair the legacy RPC (same signature, still used by older callers)
-- ============================================================
-- Fixes (b) and (c) only. (a) is deliberately NOT changed here: search_name is
-- documented as a name filter, and quietly extending it to summaries would
-- change the meaning for every existing caller. Full text search lives in
-- hybrid_search_entities.
-- CREATE OR REPLACE cannot rename input parameters, so the names stay as in 004.

CREATE OR REPLACE FUNCTION public.search_entities(
  query_embedding public.vector DEFAULT NULL,
  search_name text DEFAULT NULL,
  filter_type text DEFAULT NULL,
  match_threshold double precision DEFAULT 0.7,
  match_count integer DEFAULT 10
) RETURNS TABLE(
  id UUID,
  name TEXT,
  entity_type TEXT,
  summary TEXT,
  metadata JSONB,
  similarity double precision,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Defect (c)
  IF query_embedding IS NULL AND search_name IS NULL AND filter_type IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.name,
    e.entity_type,
    e.summary,
    e.metadata,
    (CASE WHEN query_embedding IS NOT NULL AND e.embedding IS NOT NULL
          THEN 1 - (e.embedding <=> query_embedding)
          ELSE NULL END)::double precision AS similarity,
    e.created_at
  FROM public.kg_entities e
  WHERE
    (filter_type IS NULL OR e.entity_type = filter_type)
    AND (search_name IS NULL OR e.name ILIKE '%' || search_name || '%')
    AND (
      query_embedding IS NULL
      OR 1 - (e.embedding <=> query_embedding) > match_threshold
      -- rows without an embedding only when a non-semantic signal justifies them
      OR (e.embedding IS NULL AND (search_name IS NOT NULL OR filter_type IS NOT NULL))
    )
  -- Defect (b): NULLS LAST instead of sort key 0
  ORDER BY
    (CASE WHEN query_embedding IS NOT NULL AND e.embedding IS NOT NULL
          THEN e.embedding <=> query_embedding
          ELSE NULL END) ASC NULLS LAST,
    e.updated_at DESC NULLS LAST
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.search_entities(public.vector, text, text, double precision, integer) IS
  'DEPRECATED since 010_entity_hybrid_search.sql - use public.hybrid_search_entities(). Kept for backwards compatibility; does NOT search summary.';


-- ============================================================
-- 4. Smoke test
-- ============================================================
-- plpgsql only syntax-checks a function body at CREATE time; ambiguous column
-- references and type errors surface on the first CALL. Without this block a
-- broken function would install cleanly and fail silently in production, which
-- is exactly how the agent_status DDL slipped through once before. Every branch
-- is exercised once. Never aborts the migration, but prints ERROR so the
-- setup.sh output grep picks it up.

DO $$
DECLARE
  n_all integer;
  n_ft integer;
  n_name integer;
  n_browse integer;
  n_empty integer;
  n_vec integer;
BEGIN
  SELECT count(*) INTO n_all FROM public.kg_entities;

  SELECT count(*) INTO n_ft
    FROM public.hybrid_search_entities(query_text => 'test');
  SELECT count(*) INTO n_name
    FROM public.hybrid_search_entities(search_name => 'a', match_count => 5);
  SELECT count(*) INTO n_browse
    FROM public.hybrid_search_entities(filter_type => 'person', match_count => 5);
  SELECT count(*) INTO n_empty
    FROM public.hybrid_search_entities();

  IF n_empty <> 0 THEN
    RAISE WARNING 'ERROR: hybrid_search_entities() without any signal returned % rows, expected 0', n_empty;
  END IF;

  -- semantic branch: only meaningful once at least one row carries an embedding
  SELECT count(*) INTO n_vec FROM public.kg_entities WHERE embedding IS NOT NULL;
  IF n_vec > 0 THEN
    PERFORM * FROM public.hybrid_search_entities(
      query_embedding => (SELECT embedding FROM public.kg_entities WHERE embedding IS NOT NULL LIMIT 1),
      query_text => 'test',
      match_count => 5
    );
  END IF;

  PERFORM * FROM public.search_entities(search_name => 'a', match_count => 5);

  RAISE NOTICE 'entity search smoke test ok (% entities, % with embedding; fulltext=%, name=%, browse=%)',
    n_all, n_vec, n_ft, n_name, n_browse;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ERROR in entity search smoke test: % (%)', SQLERRM, SQLSTATE;
END
$$;
