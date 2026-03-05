-- Required PostgreSQL extensions
-- This file runs before 001_schema.sql (alphabetical order in docker-entrypoint-initdb.d)
-- n8n migrations need uuid_generate_v4() from uuid-ossp
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
