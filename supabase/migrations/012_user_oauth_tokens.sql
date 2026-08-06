--
-- Per-user OAuth tokens (Microsoft 365 foundation)
--
-- Until now every OAuth provider had exactly ONE credential set for the whole
-- instance: template_credentials is keyed UNIQUE(template_id, cred_key), so all
-- five Google skills share a single Google account. That is fine for a shared
-- API key and wrong for a personal mailbox: for Microsoft every person connects
-- their own account and the agent must act as that person and no other.
--
-- Two design decisions worth knowing before changing anything here:
--
-- 1. Tokens are encrypted at rest with pgcrypto. The key is passed per call by
--    n8n, which is why the only supported access path is the RPCs below: a plain
--    PostgREST insert cannot encrypt, and reading the columns without the key
--    returns ciphertext.
--    Be honest about what this buys: the table is revoked for anon and
--    authenticated, so the tokens are unreachable through the data API even with
--    a valid application key, and a dump of the application tables alone is
--    useless. It does NOT protect against someone with full database access,
--    because n8n stores its workflows in the same database and the key travels
--    with them. The clean fix would be an environment variable, but n8n denies
--    Code nodes access to the environment, and lifting that block would let a
--    prompt-injected agent read every secret of the installation. A small
--    key-holding sidecar is the production answer; this is the test phase.
--
-- 2. The user key is the Entra object id in the form entra:<oid>, never an email
--    address or a login name. Microsoft is explicit that mail and UPN are mutable
--    and must not be used to store data per user, and oid is the one identifier
--    that stays the same across services.
--
-- Idempotent. All identifiers public.-qualified (repo convention).
--

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.user_oauth_tokens (
  id              BIGSERIAL PRIMARY KEY,
  user_key        TEXT NOT NULL,                 -- entra:<oid>, telegram:<id>, web:<name>
  provider        TEXT NOT NULL,                 -- microsoft | google | ...
  account_id      TEXT NOT NULL DEFAULT '',      -- oid of the connected account, empty = the only one
  access_token    BYTEA,                         -- pgp_sym_encrypt
  refresh_token   BYTEA,                         -- pgp_sym_encrypt
  expires_at      TIMESTAMPTZ,                   -- validity of the access token
  scopes          TEXT,
  status          TEXT NOT NULL DEFAULT 'connected',  -- connected | reconnect_required | revoked
  status_detail   TEXT,                          -- e.g. the AADSTS code that ended it
  last_refresh_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_key, provider, account_id)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_lookup  ON public.user_oauth_tokens (user_key, provider);
CREATE INDEX IF NOT EXISTS idx_user_oauth_refresh ON public.user_oauth_tokens (expires_at)
  WHERE status = 'connected';
CREATE INDEX IF NOT EXISTS idx_user_oauth_broken  ON public.user_oauth_tokens (user_key)
  WHERE status <> 'connected';

-- oauth_states carries the authorization flow across the redirect. It had no user
-- reference at all (only a Telegram chat id for the success message), so a
-- returning authorization could not be attributed to anyone. PKCE needs a place
-- for the verifier as well.
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS user_key      TEXT;
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS provider      TEXT NOT NULL DEFAULT 'google';
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS code_verifier TEXT;
ALTER TABLE public.oauth_states ADD COLUMN IF NOT EXISTS redirect_to   TEXT;

--
-- Access path. Both functions run as the calling role on purpose: the table is
-- service_role only, so a caller without that role fails on the table, not on a
-- REVOKE. Destructive RPCs are additionally guarded in the body -- revoking
-- EXECUTE has crashed the Supabase image before (see memory-stack lesson).
--

CREATE OR REPLACE FUNCTION public.upsert_user_token(
  p_user_key      TEXT,
  p_provider      TEXT,
  p_key           TEXT,
  p_access_token  TEXT,
  p_refresh_token TEXT,
  p_expires_at    TIMESTAMPTZ,
  p_scopes        TEXT DEFAULT NULL,
  p_account_id    TEXT DEFAULT ''
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE v_id BIGINT;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'upsert_user_token: not allowed for role %', current_user;
  END IF;
  IF coalesce(p_key, '') = '' THEN
    RAISE EXCEPTION 'upsert_user_token: encryption key missing';
  END IF;

  INSERT INTO public.user_oauth_tokens AS t
    (user_key, provider, account_id, access_token, refresh_token, expires_at, scopes,
     status, status_detail, last_refresh_at, updated_at)
  VALUES
    (p_user_key, p_provider, coalesce(p_account_id, ''),
     pgp_sym_encrypt(p_access_token, p_key),
     -- Microsoft does not always return a new refresh token. Keeping the old one
     -- instead of overwriting it with NULL is the difference between a working
     -- connection and a silent reconnect prompt a day later.
     CASE WHEN coalesce(p_refresh_token, '') = '' THEN NULL
          ELSE pgp_sym_encrypt(p_refresh_token, p_key) END,
     p_expires_at, p_scopes, 'connected', NULL, now(), now())
  ON CONFLICT (user_key, provider, account_id) DO UPDATE SET
     access_token    = EXCLUDED.access_token,
     refresh_token   = coalesce(EXCLUDED.refresh_token, t.refresh_token),
     expires_at      = EXCLUDED.expires_at,
     scopes          = coalesce(EXCLUDED.scopes, t.scopes),
     status          = 'connected',
     status_detail   = NULL,
     last_refresh_at = now(),
     updated_at      = now()
  RETURNING t.id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_token(
  p_user_key   TEXT,
  p_provider   TEXT,
  p_key        TEXT,
  p_account_id TEXT DEFAULT ''
) RETURNS TABLE (
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scopes        TEXT,
  status        TEXT,
  account_id    TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'get_user_token: not allowed for role %', current_user;
  END IF;
  IF coalesce(p_key, '') = '' THEN
    RAISE EXCEPTION 'get_user_token: encryption key missing';
  END IF;

  RETURN QUERY
  SELECT
    pgp_sym_decrypt(t.access_token, p_key),
    CASE WHEN t.refresh_token IS NULL THEN NULL ELSE pgp_sym_decrypt(t.refresh_token, p_key) END,
    t.expires_at, t.scopes, t.status, t.account_id
  FROM public.user_oauth_tokens t
  WHERE t.user_key = p_user_key
    AND t.provider = p_provider
    AND (p_account_id = '' OR t.account_id = p_account_id)
  ORDER BY t.updated_at DESC
  LIMIT 1;
END;
$$;

-- Marking a connection as broken must not need the encryption key: the refresh
-- worker knows the AADSTS code but has no reason to touch the token itself.
CREATE OR REPLACE FUNCTION public.mark_user_token(
  p_user_key   TEXT,
  p_provider   TEXT,
  p_status     TEXT,
  p_detail     TEXT DEFAULT NULL,
  p_account_id TEXT DEFAULT ''
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE v_count INTEGER;
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'mark_user_token: not allowed for role %', current_user;
  END IF;
  IF p_status NOT IN ('connected', 'reconnect_required', 'revoked') THEN
    RAISE EXCEPTION 'mark_user_token: unknown status %', p_status;
  END IF;

  UPDATE public.user_oauth_tokens
     SET status = p_status, status_detail = p_detail, updated_at = now()
   WHERE user_key = p_user_key
     AND provider = p_provider
     AND (p_account_id = '' OR account_id = p_account_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Rights. 001_schema.sql sets ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES
-- TO anon/authenticated/service_role, so a new table starts out readable AND
-- writable by anon. For personal mailbox tokens that is exactly wrong, and not
-- granting anything is not enough: the grants have to be revoked explicitly.
REVOKE ALL ON TABLE public.user_oauth_tokens FROM anon;
REVOKE ALL ON TABLE public.user_oauth_tokens FROM authenticated;
REVOKE ALL ON SEQUENCE public.user_oauth_tokens_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.user_oauth_tokens_id_seq FROM authenticated;

GRANT ALL ON TABLE public.user_oauth_tokens TO service_role;
GRANT ALL ON SEQUENCE public.user_oauth_tokens_id_seq TO service_role;

COMMENT ON TABLE public.user_oauth_tokens IS
  'One OAuth connection per person and provider. Tokens encrypted with pgcrypto; the key lives in n8n, not here. Use upsert_user_token / get_user_token / mark_user_token.';
COMMENT ON COLUMN public.user_oauth_tokens.user_key IS
  'entra:<oid> for Microsoft. Never an email address or login name: both are mutable.';
