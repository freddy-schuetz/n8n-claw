--
-- OAuth2 support for Google Skills (and future OAuth providers)
--

-- OAuth state tracking table (CSRF protection + flow context)
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  chat_id     TEXT,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used        BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON public.oauth_states (expires_at) WHERE used = false;

GRANT ALL ON TABLE public.oauth_states TO service_role;
GRANT SELECT ON TABLE public.oauth_states TO anon;
