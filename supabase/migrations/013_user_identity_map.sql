--
-- Identity map: old login-based keys to the Entra object id
--
-- Conversations, memory, tasks, reminders and profiles are keyed by the login
-- based identity (web:rainer, telegram:123). The Microsoft connection is keyed
-- by the Entra object id, which is the only identifier Microsoft guarantees to
-- stay the same. Both have to keep working at the same time: the history must
-- not be orphaned, and a personal mailbox must never be reachable under a name
-- somebody else could get later.
--
-- A separate table on purpose. The first version of this wrote the mapping into
-- user_profiles.context, which is a free-text field the agent also uses for what
-- it knows about a person -- for anyone with an existing profile that would have
-- silently overwritten it.
--
-- Idempotent. All identifiers public.-qualified (repo convention).
--

CREATE TABLE IF NOT EXISTS public.user_identity_map (
  legacy_key TEXT PRIMARY KEY,             -- web:gretel, telegram:123
  entra_key  TEXT NOT NULL,                -- entra:<oid>
  entra_oid  TEXT,                         -- the bare oid, for lookups
  upn        TEXT,                         -- display only, mutable, never a key
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_map_entra ON public.user_identity_map (entra_key);

REVOKE ALL ON TABLE public.user_identity_map FROM anon;
REVOKE ALL ON TABLE public.user_identity_map FROM authenticated;
GRANT ALL ON TABLE public.user_identity_map TO service_role;

COMMENT ON TABLE public.user_identity_map IS
  'Maps the login based identity to the Entra object id. Kept permanently: historical rows in conversations and memory carry the old key.';
