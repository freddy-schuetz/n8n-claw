--
-- Tool Audit Log Migration (SLT R3)
--
-- Append-only record of every MCP tool call: who ran which tool, with which
-- arguments, with what outcome. Written by the "MCP Client" node in the main
-- agent, the sub-agent runner and the background checker.
--
-- Why this exists: skills report only their result ("Page created [id: 123]",
-- "Issue PRO28-17 updated."). WHAT was written was nowhere to be found, so for
-- the 13 write operations of the SLT test phase it was impossible to reconstruct
-- afterwards which text or which fields the agent had set.
--
-- Not to be confused with public.agent_status: that one is live progress for the
-- web client and purges itself after an hour. This one is evidence.
--
-- Idempotent. All identifiers public.-qualified (repo convention).
--

CREATE TABLE IF NOT EXISTS public.tool_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id      TEXT,                                  -- e.g. web:rainer, telegram:123
  user_id         TEXT,                                  -- qualifiedUserId
  source          TEXT,                                  -- telegram | web | api | scheduled_task
  origin          TEXT NOT NULL DEFAULT 'agent',         -- agent | sub-agent | background
  server_url      TEXT,                                  -- mcp_url of the skill server
  tool_name       TEXT NOT NULL,
  is_write        BOOLEAN NOT NULL DEFAULT false,
  write_source    TEXT,                                  -- annotation | heuristic
  args            JSONB,                                 -- masked and truncated
  args_truncated  BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL,                         -- ok | error | rejected
  result_summary  TEXT,
  error           TEXT,
  duration_ms     INTEGER,
  execution_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_created ON public.tool_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_session ON public.tool_audit_log (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_user    ON public.tool_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_tool    ON public.tool_audit_log (tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_writes  ON public.tool_audit_log (created_at DESC) WHERE is_write;

-- Rights: service_role only.
-- CAREFUL: 001_schema.sql sets ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES
-- TO anon/authenticated/service_role. Every new table created as postgres in
-- public therefore starts out fully writable AND deletable by anon. For an audit
-- log that is exactly wrong, so simply not granting anything is not enough --
-- the grants have to be revoked explicitly.
REVOKE ALL ON TABLE public.tool_audit_log FROM anon;
REVOKE ALL ON TABLE public.tool_audit_log FROM authenticated;
REVOKE ALL ON SEQUENCE public.tool_audit_log_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.tool_audit_log_id_seq FROM authenticated;

GRANT ALL ON TABLE public.tool_audit_log TO service_role;
GRANT ALL ON SEQUENCE public.tool_audit_log_id_seq TO service_role;

COMMENT ON TABLE public.tool_audit_log IS
  'Append-only audit log of MCP tool calls. Arguments are masked (passwords, tokens) and truncated. Reachable only with the service_role key.';
