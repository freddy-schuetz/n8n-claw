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
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


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
-- Name: idx_memory_long_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memory_long_category ON public.memory_long USING btree (category);


--
-- Name: idx_memory_long_embedding; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memory_long_embedding ON public.memory_long USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


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

