--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 15.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Required extensions (n8n migrations need uuid_generate_v4)
-- Must use explicit SCHEMA because pg_dump clears search_path above
--
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;

--
-- Required roles (must exist before GRANTs below)
--
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin WITH LOGIN SUPERUSER PASSWORD 'supabase_admin';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA IF NOT EXISTS public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: search_memory(public.vector, double precision, integer, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.search_memory(query_embedding public.vector, match_threshold double precision DEFAULT 0.7, match_count integer DEFAULT 5, filter_category text DEFAULT NULL::text) RETURNS TABLE(id integer, content text, category text, importance integer, similarity double precision, metadata jsonb, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ml.id,
    ml.content,
    ml.category,
    ml.importance,
    1 - (ml.embedding <=> query_embedding) as similarity,
    ml.metadata,
    ml.created_at
  FROM memory_long ml
  WHERE 
    (filter_category IS NULL OR ml.category = filter_category)
    AND 1 - (ml.embedding <=> query_embedding) > match_threshold
    AND (ml.expires_at IS NULL OR ml.expires_at > now())
  ORDER BY ml.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


ALTER FUNCTION public.search_memory(query_embedding public.vector, match_threshold double precision, match_count integer, filter_category text) OWNER TO postgres;

--
-- Name: search_memory_keyword(text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.search_memory_keyword(search_query text, match_count integer DEFAULT 5) RETURNS TABLE(id integer, content text, category text, importance integer, metadata jsonb, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ml.id,
    ml.content,
    ml.category,
    ml.importance,
    ml.metadata,
    ml.created_at
  FROM memory_long ml
  WHERE 
    ml.content ILIKE '%' || search_query || '%'
    AND (ml.expires_at IS NULL OR ml.expires_at > now())
  ORDER BY ml.importance DESC, ml.created_at DESC
  LIMIT match_count;
END;
$$;


ALTER FUNCTION public.search_memory_keyword(search_query text, match_count integer) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    key text NOT NULL,
    content text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.agents OWNER TO postgres;

--
-- Name: agents_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.agents_id_seq OWNER TO postgres;

--
-- Name: agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.agents_id_seq OWNED BY public.agents.id;


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.conversations (
    id integer NOT NULL,
    session_id text NOT NULL,
    user_id text,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT conversations_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


ALTER TABLE public.conversations OWNER TO postgres;

--
-- Name: conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.conversations_id_seq OWNER TO postgres;

--
-- Name: conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.conversations_id_seq OWNED BY public.conversations.id;


--
-- Name: heartbeat_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.heartbeat_config (
    id integer NOT NULL,
    check_name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_run timestamp with time zone,
    interval_minutes integer DEFAULT 30,
    enabled boolean DEFAULT true
);


ALTER TABLE public.heartbeat_config OWNER TO postgres;

--
-- Name: heartbeat_config_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.heartbeat_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.heartbeat_config_id_seq OWNER TO postgres;

--
-- Name: heartbeat_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.heartbeat_config_id_seq OWNED BY public.heartbeat_config.id;


--
-- Name: mcp_registry; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.mcp_registry (
    id integer NOT NULL,
    server_name text NOT NULL,
    path text NOT NULL,
    mcp_url text NOT NULL,
    description text,
    tools text[],
    workflow_id text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.mcp_registry OWNER TO postgres;

--
-- Name: mcp_registry_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.mcp_registry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.mcp_registry_id_seq OWNER TO postgres;

--
-- Name: mcp_registry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.mcp_registry_id_seq OWNED BY public.mcp_registry.id;


--
-- Name: memory_daily; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_daily (
    id integer NOT NULL,
    date date DEFAULT CURRENT_DATE,
    content text NOT NULL,
    role text DEFAULT 'assistant'::text,
    user_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.memory_daily OWNER TO postgres;

--
-- Name: memory_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.memory_daily_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.memory_daily_id_seq OWNER TO postgres;

--
-- Name: memory_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.memory_daily_id_seq OWNED BY public.memory_daily.id;


--
-- Name: memory_long; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_long (
    id integer NOT NULL,
    content text NOT NULL,
    category text DEFAULT 'general'::text,
    importance integer DEFAULT 5,
    embedding public.vector(1536),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    CONSTRAINT memory_long_importance_check CHECK (((importance >= 1) AND (importance <= 10)))
);


ALTER TABLE public.memory_long OWNER TO postgres;

--
-- Name: memory_long_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.memory_long_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.memory_long_id_seq OWNER TO postgres;

--
-- Name: memory_long_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.memory_long_id_seq OWNED BY public.memory_long.id;


--
-- Name: soul; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.soul (
    id integer NOT NULL,
    key text NOT NULL,
    content text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.soul OWNER TO postgres;

--
-- Name: soul_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.soul_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.soul_id_seq OWNER TO postgres;

--
-- Name: soul_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.soul_id_seq OWNED BY public.soul.id;


--
-- Name: tools_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tools_config (
    id integer NOT NULL,
    tool_name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.tools_config OWNER TO postgres;

--
-- Name: tools_config_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tools_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.tools_config_id_seq OWNER TO postgres;

--
-- Name: tools_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tools_config_id_seq OWNED BY public.tools_config.id;


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_profiles (
    id integer NOT NULL,
    user_id text NOT NULL,
    name text,
    display_name text,
    timezone text DEFAULT 'Europe/Berlin'::text,
    preferences jsonb DEFAULT '{}'::jsonb,
    context text,
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.user_profiles OWNER TO postgres;

--
-- Name: user_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.user_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.user_profiles_id_seq OWNER TO postgres;

--
-- Name: user_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.user_profiles_id_seq OWNED BY public.user_profiles.id;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id integer NOT NULL,
    user_id text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    due_date timestamp with time zone,
    parent_id integer,
    tags text[] DEFAULT '{}'::text[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    CONSTRAINT tasks_status_check CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'done'::text, 'cancelled'::text])),
    CONSTRAINT tasks_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))
);


ALTER TABLE public.tasks OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.tasks_id_seq OWNER TO postgres;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.reminders (
    id integer NOT NULL,
    user_id text NOT NULL,
    chat_id text NOT NULL,
    message text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    reminded_at timestamp with time zone,
    type text NOT NULL DEFAULT 'reminder',
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.reminders OWNER TO postgres;

CREATE SEQUENCE public.reminders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER TABLE public.reminders_id_seq OWNER TO postgres;

ALTER SEQUENCE public.reminders_id_seq OWNED BY public.reminders.id;


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.agents_id_seq'::regclass);


--
-- Name: conversations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversations ALTER COLUMN id SET DEFAULT nextval('public.conversations_id_seq'::regclass);


--
-- Name: heartbeat_config id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.heartbeat_config ALTER COLUMN id SET DEFAULT nextval('public.heartbeat_config_id_seq'::regclass);


--
-- Name: mcp_registry id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mcp_registry ALTER COLUMN id SET DEFAULT nextval('public.mcp_registry_id_seq'::regclass);


--
-- Name: memory_daily id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_daily ALTER COLUMN id SET DEFAULT nextval('public.memory_daily_id_seq'::regclass);


--
-- Name: memory_long id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_long ALTER COLUMN id SET DEFAULT nextval('public.memory_long_id_seq'::regclass);


--
-- Name: soul id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.soul ALTER COLUMN id SET DEFAULT nextval('public.soul_id_seq'::regclass);


--
-- Name: tools_config id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tools_config ALTER COLUMN id SET DEFAULT nextval('public.tools_config_id_seq'::regclass);


--
-- Name: user_profiles id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_profiles ALTER COLUMN id SET DEFAULT nextval('public.user_profiles_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: reminders id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reminders ALTER COLUMN id SET DEFAULT nextval('public.reminders_id_seq'::regclass);


--
-- Name: agents agents_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_key_key UNIQUE (key);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: heartbeat_config heartbeat_config_check_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.heartbeat_config
    ADD CONSTRAINT heartbeat_config_check_name_key UNIQUE (check_name);


--
-- Name: heartbeat_config heartbeat_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.heartbeat_config
    ADD CONSTRAINT heartbeat_config_pkey PRIMARY KEY (id);


--
-- Name: mcp_registry mcp_registry_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mcp_registry
    ADD CONSTRAINT mcp_registry_path_key UNIQUE (path);


--
-- Name: mcp_registry mcp_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.mcp_registry
    ADD CONSTRAINT mcp_registry_pkey PRIMARY KEY (id);


--
-- Name: memory_daily memory_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_daily
    ADD CONSTRAINT memory_daily_pkey PRIMARY KEY (id);


--
-- Name: memory_long memory_long_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_long
    ADD CONSTRAINT memory_long_pkey PRIMARY KEY (id);


--
-- Name: soul soul_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.soul
    ADD CONSTRAINT soul_key_key UNIQUE (key);


--
-- Name: soul soul_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.soul
    ADD CONSTRAINT soul_pkey PRIMARY KEY (id);


--
-- Name: tools_config tools_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tools_config
    ADD CONSTRAINT tools_config_pkey PRIMARY KEY (id);


--
-- Name: tools_config tools_config_tool_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tools_config
    ADD CONSTRAINT tools_config_tool_name_key UNIQUE (tool_name);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_key UNIQUE (user_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_fk FOREIGN KEY (parent_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: idx_tasks_user_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_user_status ON public.tasks USING btree (user_id, status);


--
-- Name: idx_tasks_due_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_due_date ON public.tasks USING btree (due_date) WHERE (due_date IS NOT NULL);


--
-- Name: idx_tasks_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_tasks_parent ON public.tasks USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_reminders_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_reminders_pending ON public.reminders USING btree (remind_at) WHERE (reminded_at IS NULL);


--
-- Name: idx_conversations_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_conversations_session ON public.conversations USING btree (session_id, created_at DESC);


--
-- Name: idx_conversations_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_conversations_user ON public.conversations USING btree (user_id, created_at DESC);


--
-- Name: idx_mcp_registry_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mcp_registry_active ON public.mcp_registry USING btree (active);


--
-- Name: idx_mcp_registry_path; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_mcp_registry_path ON public.mcp_registry USING btree (path);


--
-- Name: idx_memory_daily_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memory_daily_date ON public.memory_daily USING btree (date DESC);


--
-- Name: file_refs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS public.file_refs (
    id text NOT NULL PRIMARY KEY,
    session_id text NOT NULL,
    user_id text,
    file_name text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    size_bytes integer,
    bridge_url text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval)
);

ALTER TABLE public.file_refs OWNER TO postgres;

CREATE INDEX IF NOT EXISTS idx_file_refs_session ON public.file_refs USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_file_refs_expires ON public.file_refs USING btree (expires_at);


--
-- Name: idx_memory_long_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memory_long_category ON public.memory_long USING btree (category);


--
-- Name: idx_memory_long_embedding; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX IF NOT EXISTS idx_memory_long_embedding ON public.memory_long USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_long_importance; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memory_long_importance ON public.memory_long USING btree (importance DESC);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION search_memory(query_embedding public.vector, match_threshold double precision, match_count integer, filter_category text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.search_memory(query_embedding public.vector, match_threshold double precision, match_count integer, filter_category text) TO anon;
GRANT ALL ON FUNCTION public.search_memory(query_embedding public.vector, match_threshold double precision, match_count integer, filter_category text) TO authenticated;
GRANT ALL ON FUNCTION public.search_memory(query_embedding public.vector, match_threshold double precision, match_count integer, filter_category text) TO service_role;


--
-- Name: FUNCTION search_memory_keyword(search_query text, match_count integer); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.search_memory_keyword(search_query text, match_count integer) TO anon;
GRANT ALL ON FUNCTION public.search_memory_keyword(search_query text, match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_memory_keyword(search_query text, match_count integer) TO service_role;


--
-- Name: TABLE agents; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agents TO anon;
GRANT ALL ON TABLE public.agents TO authenticated;
GRANT ALL ON TABLE public.agents TO service_role;


--
-- Name: TABLE file_refs; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.file_refs TO anon;
GRANT ALL ON TABLE public.file_refs TO authenticated;
GRANT ALL ON TABLE public.file_refs TO service_role;


--
-- Name: SEQUENCE agents_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.agents_id_seq TO anon;
GRANT ALL ON SEQUENCE public.agents_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.agents_id_seq TO service_role;


--
-- Name: TABLE conversations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;


--
-- Name: SEQUENCE conversations_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.conversations_id_seq TO anon;
GRANT ALL ON SEQUENCE public.conversations_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.conversations_id_seq TO service_role;


--
-- Name: TABLE heartbeat_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.heartbeat_config TO anon;
GRANT ALL ON TABLE public.heartbeat_config TO authenticated;
GRANT ALL ON TABLE public.heartbeat_config TO service_role;


--
-- Name: SEQUENCE heartbeat_config_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.heartbeat_config_id_seq TO anon;
GRANT ALL ON SEQUENCE public.heartbeat_config_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.heartbeat_config_id_seq TO service_role;


--
-- Name: TABLE mcp_registry; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.mcp_registry TO anon;
GRANT ALL ON TABLE public.mcp_registry TO authenticated;
GRANT ALL ON TABLE public.mcp_registry TO service_role;


--
-- Name: SEQUENCE mcp_registry_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.mcp_registry_id_seq TO anon;
GRANT ALL ON SEQUENCE public.mcp_registry_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.mcp_registry_id_seq TO service_role;


--
-- Name: TABLE memory_daily; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.memory_daily TO anon;
GRANT ALL ON TABLE public.memory_daily TO authenticated;
GRANT ALL ON TABLE public.memory_daily TO service_role;


--
-- Name: SEQUENCE memory_daily_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.memory_daily_id_seq TO anon;
GRANT ALL ON SEQUENCE public.memory_daily_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.memory_daily_id_seq TO service_role;


--
-- Name: TABLE memory_long; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.memory_long TO anon;
GRANT ALL ON TABLE public.memory_long TO authenticated;
GRANT ALL ON TABLE public.memory_long TO service_role;


--
-- Name: SEQUENCE memory_long_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.memory_long_id_seq TO anon;
GRANT ALL ON SEQUENCE public.memory_long_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.memory_long_id_seq TO service_role;


--
-- Name: TABLE soul; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.soul TO anon;
GRANT ALL ON TABLE public.soul TO authenticated;
GRANT ALL ON TABLE public.soul TO service_role;


--
-- Name: SEQUENCE soul_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.soul_id_seq TO anon;
GRANT ALL ON SEQUENCE public.soul_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.soul_id_seq TO service_role;


--
-- Name: TABLE tools_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.tools_config TO anon;
GRANT ALL ON TABLE public.tools_config TO authenticated;
GRANT ALL ON TABLE public.tools_config TO service_role;


--
-- Name: SEQUENCE tools_config_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.tools_config_id_seq TO anon;
GRANT ALL ON SEQUENCE public.tools_config_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tools_config_id_seq TO service_role;


--
-- Name: TABLE user_profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_profiles TO anon;
GRANT ALL ON TABLE public.user_profiles TO authenticated;
GRANT ALL ON TABLE public.user_profiles TO service_role;


--
-- Name: SEQUENCE user_profiles_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.user_profiles_id_seq TO anon;
GRANT ALL ON SEQUENCE public.user_profiles_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.user_profiles_id_seq TO service_role;


GRANT ALL ON TABLE public.tasks TO anon;
GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;

GRANT ALL ON SEQUENCE public.tasks_id_seq TO anon;
GRANT ALL ON SEQUENCE public.tasks_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tasks_id_seq TO service_role;

GRANT ALL ON TABLE public.reminders TO anon;
GRANT ALL ON TABLE public.reminders TO authenticated;
GRANT ALL ON TABLE public.reminders TO service_role;

GRANT ALL ON SEQUENCE public.reminders_id_seq TO anon;
GRANT ALL ON SEQUENCE public.reminders_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.reminders_id_seq TO service_role;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS public.projects (
    id integer NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text])))
);

ALTER TABLE public.projects OWNER TO postgres;

CREATE SEQUENCE IF NOT EXISTS public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER TABLE public.projects_id_seq OWNER TO postgres;

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);

-- Use DO block for idempotent constraint creation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_pkey') THEN
    ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_pkey PRIMARY KEY (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_name_key') THEN
    ALTER TABLE ONLY public.projects ADD CONSTRAINT projects_name_key UNIQUE (name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_status ON public.projects USING btree (status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON public.projects USING btree (updated_at DESC);

GRANT ALL ON TABLE public.projects TO anon;
GRANT ALL ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;

GRANT ALL ON SEQUENCE public.projects_id_seq TO anon;
GRANT ALL ON SEQUENCE public.projects_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.projects_id_seq TO service_role;


-- Migration: add type column to reminders (idempotent for updates)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'reminders' AND column_name = 'type'
  ) THEN
    ALTER TABLE public.reminders ADD COLUMN type text NOT NULL DEFAULT 'reminder';
  END IF;
END $$;


--
-- Name: scheduled_actions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS public.scheduled_actions (
    id integer NOT NULL,
    user_id text NOT NULL,
    chat_id text NOT NULL,
    name text NOT NULL,
    action_type text NOT NULL DEFAULT 'agent_task',
    instruction text NOT NULL,
    schedule jsonb NOT NULL,
    timezone text DEFAULT 'Europe/Berlin',
    enabled boolean DEFAULT true,
    last_run timestamp with time zone,
    next_run timestamp with time zone,
    run_count integer DEFAULT 0,
    max_runs integer,
    notify_mode text NOT NULL DEFAULT 'always',
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.scheduled_actions OWNER TO postgres;

CREATE SEQUENCE IF NOT EXISTS public.scheduled_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER TABLE public.scheduled_actions_id_seq OWNER TO postgres;

ALTER SEQUENCE public.scheduled_actions_id_seq OWNED BY public.scheduled_actions.id;

ALTER TABLE ONLY public.scheduled_actions ALTER COLUMN id SET DEFAULT nextval('public.scheduled_actions_id_seq'::regclass);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_actions_pkey') THEN
    ALTER TABLE ONLY public.scheduled_actions ADD CONSTRAINT scheduled_actions_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Add notify_mode column for existing installations (CREATE TABLE IF NOT EXISTS skips new columns)
ALTER TABLE public.scheduled_actions ADD COLUMN IF NOT EXISTS notify_mode TEXT NOT NULL DEFAULT 'always';

CREATE INDEX IF NOT EXISTS idx_scheduled_actions_due ON public.scheduled_actions (next_run) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_user ON public.scheduled_actions (user_id);

GRANT ALL ON TABLE public.scheduled_actions TO anon;
GRANT ALL ON TABLE public.scheduled_actions TO authenticated;
GRANT ALL ON TABLE public.scheduled_actions TO service_role;

GRANT ALL ON SEQUENCE public.scheduled_actions_id_seq TO anon;
GRANT ALL ON SEQUENCE public.scheduled_actions_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.scheduled_actions_id_seq TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- PostgreSQL database dump complete
--


-- Setup wizard fields (added after initial schema)
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS setup_done boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS setup_step integer DEFAULT 0;

-- Template Registry columns (Phase 1: Library Manager)
ALTER TABLE public.mcp_registry
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS template_type text DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS sub_workflow_id text;

-- Phase 2: Credential Flow (One-Time-Link)
CREATE TABLE IF NOT EXISTS public.credential_tokens (
  token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id TEXT NOT NULL,
  cred_key    TEXT NOT NULL,
  cred_label  TEXT,
  cred_hint   TEXT,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used        BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.template_credentials (
  id          SERIAL PRIMARY KEY,
  template_id TEXT NOT NULL,
  cred_key    TEXT NOT NULL,
  cred_value  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(template_id, cred_key)
);

CREATE INDEX IF NOT EXISTS idx_credential_tokens_expires
  ON public.credential_tokens (expires_at) WHERE used = false;
CREATE INDEX IF NOT EXISTS idx_template_credentials_template
  ON public.template_credentials (template_id);

-- Roles already created at top of file (before GRANTs)
GRANT ALL ON SCHEMA public TO supabase_admin;
GRANT ALL ON ALL TABLES IN SCHEMA public TO supabase_admin;
GRANT USAGE ON SCHEMA public TO anon, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON SEQUENCE public.template_credentials_id_seq TO anon, authenticated, service_role;
