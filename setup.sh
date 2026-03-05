#!/bin/bash
# ============================================================
# n8n-claw Setup Script
# ============================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo -e "${GREEN}🚀 n8n-claw Setup${NC}"
echo "=============================="

# ── 0. Root check ───────────────────────────────────────────
if [ "$(id -u)" != "0" ]; then
  echo -e "${RED}❌ Please run as root: sudo ./setup.sh${NC}"
  exit 1
fi

# ── 1. Update system + install dependencies ─────────────────
echo -e "\n${GREEN}🔄 Updating system packages...${NC}"
apt-get update -qq && apt-get upgrade -y -qq 2>/dev/null
echo -e "  ${GREEN}✅ System up to date${NC}"

echo -e "\n${GREEN}📦 Checking dependencies...${NC}"

if ! command -v curl &>/dev/null; then
  echo "  Installing curl..."
  apt-get update -qq && apt-get install -y curl -qq
fi

if ! command -v docker &>/dev/null; then
  echo -e "  ${YELLOW}Installing Docker (this takes ~1 min)...${NC}"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker --now
  echo -e "  ${GREEN}✅ Docker installed${NC}"
else
  echo -e "  ${GREEN}✅ Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)${NC}"
fi

if ! docker compose version &>/dev/null; then
  echo "  Installing Docker Compose plugin..."
  apt-get install -y docker-compose-plugin -qq
fi
echo -e "  ${GREEN}✅ Docker Compose ready${NC}"

if ! command -v psql &>/dev/null; then
  echo "  Installing postgresql-client..."
  apt-get install -y postgresql-client -qq
  echo -e "  ${GREEN}✅ psql installed${NC}"
fi

# ── 2. Load .env ────────────────────────────────────────────
[ ! -f .env ] && cp .env.example .env

_load_env() {
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    line="${line%%#*}"
    line="$(echo "$line" | sed 's/[[:space:]]*=[[:space:]]*/=/; s/[[:space:]]*$//')"
    [[ "$line" =~ ^[A-Za-z0-9_]+=.* ]] && export "$line" 2>/dev/null || true
  done < .env
}
_load_env

# Helper: set env var in .env (update if exists, append if not) + export
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
  export "$key"="$val"
}

# ── Detect install mode ──────────────────────────────────────
INSTALL_MODE="fresh"
FORCE_FLAG=""
[[ "$1" == "--force" ]] && FORCE_FLAG="--force"

if docker volume inspect n8n-claw_n8n_data > /dev/null 2>&1; then
  INSTALL_MODE="update"
  CYAN='\033[0;36m'
  echo -e "\n${CYAN}🔄 Existing installation detected — running in update mode${NC}"
  echo "  Use --force to reimport workflows and reconfigure personality"
fi

ask() {
  local var="$1" prompt="$2" current="${!1}" secret="$4"
  if [ -n "$current" ] && [[ "$current" != your_* ]]; then
    return
  fi
  while true; do
    if [ "$secret" = "1" ]; then
      read -rsp "  $prompt: " val; echo
    else
      read -rp  "  $prompt: " val
    fi
    [ -n "$val" ] && break
    echo -e "  ${RED}Cannot be empty.${NC}"
  done
  if grep -q "^${var}=" .env; then
    sed -i "s|^${var}=.*|${var}=${val}|" .env
  else
    echo "${var}=${val}" >> .env
  fi
  export "$var"="$val"
}

# ── 3. Generate all crypto keys BEFORE any docker start ─────
# In update mode: recover encryption key from existing Docker volume
if [ "$INSTALL_MODE" = "update" ]; then
  VOLUME_KEY=$(docker run --rm -v n8n-claw_n8n_data:/data alpine \
    cat /data/config /data/.n8n/config 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['encryptionKey'])" 2>/dev/null) || true
  if [ -n "$VOLUME_KEY" ]; then
    if [ -n "$N8N_ENCRYPTION_KEY" ] && [ "$N8N_ENCRYPTION_KEY" != "$VOLUME_KEY" ]; then
      echo -e "  ${YELLOW}⚠️  .env key differs from volume — using volume key (source of truth)${NC}"
    fi
    N8N_ENCRYPTION_KEY="$VOLUME_KEY"
    set_env "N8N_ENCRYPTION_KEY" "$N8N_ENCRYPTION_KEY"
    echo -e "  ${GREEN}✅ Encryption key recovered from existing volume${NC}"
  else
    echo -e "  ${RED}⚠️  Could not read encryption key from volume!${NC}"
    echo -e "  ${RED}   Keeping existing key from .env — verify manually if n8n won't start${NC}"
  fi
fi
if [ -z "$N8N_ENCRYPTION_KEY" ] || [[ "$N8N_ENCRYPTION_KEY" == "your_"* ]]; then
  N8N_ENCRYPTION_KEY=$(openssl rand -hex 16)
  set_env "N8N_ENCRYPTION_KEY" "$N8N_ENCRYPTION_KEY"
fi
if [ -z "$POSTGRES_PASSWORD" ] || [[ "$POSTGRES_PASSWORD" == "changeme" ]]; then
  POSTGRES_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
  set_env "POSTGRES_PASSWORD" "$POSTGRES_PASSWORD"
fi
if [ -z "$SUPABASE_JWT_SECRET" ]; then
  SUPABASE_JWT_SECRET=$(openssl rand -base64 32)
  set_env "SUPABASE_JWT_SECRET" "$SUPABASE_JWT_SECRET"
fi
_load_env

# ── 4. Start n8n early so user can get API key ──────────────
if [ -z "$N8N_API_KEY" ] || [[ "$N8N_API_KEY" == your_* ]]; then
  echo -e "\n${GREEN}🐳 Starting n8n...${NC}"
  # Start DB first and create uuid extension before n8n connects
  POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
    docker compose up -d db 2>&1 | tail -3 || true
  echo "  Waiting for database..."
  for i in {1..30}; do
    LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres \
      -c "SELECT 1" > /dev/null 2>&1 && break
    sleep 2; echo -n "."
  done
  echo ""
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres \
    -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' > /dev/null 2>&1

  # Now start n8n (DB is ready with uuid extension)
  N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY \
  POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
  SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET \
    docker compose up -d n8n 2>&1 | grep -v "^#" | grep -v "^$" || true

  echo "  Waiting for n8n to start..."
  for i in {1..30}; do
    curl -s http://localhost:5678/healthz > /dev/null 2>&1 && break
    sleep 2
    echo -n "."
  done
  echo ""

  PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "YOUR-VPS-IP")
  echo -e "  ${GREEN}✅ n8n running at http://${PUBLIC_IP}:5678${NC}"
  echo ""
  echo "  1. Open http://${PUBLIC_IP}:5678 in your browser"
  echo "  2. Create your n8n account"
  echo "  3. Go to: Settings → API → Create API Key"
  echo ""
fi

# ── 4. Interactive configuration ────────────────────────────
echo -e "${GREEN}⚙️  Configuration${NC}"
echo "────────────────────────────"
ask "N8N_API_KEY"        "n8n API Key (Settings → API → Create key)" "" 1
ask "TELEGRAM_BOT_TOKEN" "Telegram Bot Token (from @BotFather)"      "" 1
ask "TELEGRAM_CHAT_ID"   "Your Telegram Chat ID (from @userinfobot)" "" 0
echo ""
echo -e "  ${YELLOW}Optional: Domain for HTTPS (required for Telegram webhooks)${NC}"
echo "  Leave empty to skip (you can set up HTTPS later)"
ask "DOMAIN" "Domain name (e.g. n8n.yourdomain.com, or press Enter to skip)" "" 0
_load_env
echo -e "${GREEN}✅ Configuration saved${NC}"

# ── 5. Verify keys (already generated in step 3) ─────────────
_load_env
echo -e "  ${GREEN}✅ Crypto keys ready${NC}"

# Generate Supabase JWT tokens if not set
if [ -z "$SUPABASE_SERVICE_KEY" ] || [[ "$SUPABASE_SERVICE_KEY" == "your_"* ]]; then
  echo -e "\n${GREEN}🔐 Generating Supabase JWT keys...${NC}"
  KEYS=$(python3 - <<PYEOF
import base64, json, hmac, hashlib, os
secret = b"${SUPABASE_JWT_SECRET}"
def jwt(role):
    h = base64.urlsafe_b64encode(json.dumps({"alg":"HS256","typ":"JWT"}).encode()).rstrip(b'=').decode()
    p = base64.urlsafe_b64encode(json.dumps({"role":role,"iss":"supabase","iat":1771793684,"exp":2087153684}).encode()).rstrip(b'=').decode()
    s = base64.urlsafe_b64encode(hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    return f"{h}.{p}.{s}"
print(f"SUPABASE_ANON_KEY={jwt('anon')}")
print(f"SUPABASE_SERVICE_KEY={jwt('service_role')}")
PYEOF
)
  while IFS='=' read -r k v; do
    [ -n "$k" ] && set_env "$k" "$v"
  done <<< "$KEYS"
  echo -e "  ${GREEN}✅ JWT keys generated${NC}"
fi
_load_env

# ── 6. Configure Kong ────────────────────────────────────────
echo -e "\n${GREEN}🔧 Configuring services...${NC}"
sed \
  -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
  -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
  supabase/kong.yml > supabase/kong.deployed.yml
echo "  ✅ Kong config ready"

# ── 7. Start all services ────────────────────────────────────
echo -e "\n${GREEN}🐳 Starting all services...${NC}"
if [ "$INSTALL_MODE" = "update" ]; then
  echo "  Pulling latest images..."
  docker compose pull 2>&1 | tail -5
fi
POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET \
N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY \
N8N_HOST=${N8N_HOST:-localhost} \
N8N_PROTOCOL=${N8N_PROTOCOL:-http} \
N8N_WEBHOOK_URL=${N8N_WEBHOOK_URL:-http://localhost:5678} \
TIMEZONE=${TIMEZONE:-Europe/Berlin} \
  docker compose up -d 2>&1 | tail -5

echo "  Waiting for database (up to 60s on first start)..."
for i in {1..60}; do
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres -c "SELECT 1" > /dev/null 2>&1 && break
  sleep 2; echo -n "."
done
echo ""
if ! LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres -c "SELECT 1" > /dev/null 2>&1; then
  echo -e "${RED}❌ Database failed to start. Check: docker logs n8n-claw-db${NC}"
  exit 1
fi
echo -e "  ${GREEN}✅ All services running${NC}"

# ── 8. Setup HTTPS (if domain provided) ─────────────────────
if [ -n "$DOMAIN" ] && [[ "$DOMAIN" != "your_"* ]]; then
  echo -e "\n${GREEN}🔒 Setting up HTTPS for ${DOMAIN}...${NC}"

  # Install nginx + certbot
  apt-get install -y nginx certbot python3-certbot-nginx -qq
  systemctl stop nginx 2>/dev/null || true

  # Get certificate
  certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos \
    --email "admin@${DOMAIN}" --no-eff-email 2>&1 | tail -3

  # Write nginx config
  cat > /etc/nginx/sites-available/n8n-claw << NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    location / {
        proxy_pass http://localhost:5678;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/n8n-claw /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  systemctl start nginx
  systemctl enable nginx

  # Update n8n webhook URL to HTTPS
  set_env "N8N_WEBHOOK_URL" "https://${DOMAIN}"
  set_env "N8N_HOST" "${DOMAIN}"
  set_env "N8N_PROTOCOL" "https"
  set_env "N8N_SECURE_COOKIE" "true"
  _load_env

  # Restart n8n with HTTPS config
  N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
  SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET N8N_WEBHOOK_URL="https://${DOMAIN}" \
  N8N_HOST=$DOMAIN N8N_PROTOCOL=https N8N_SECURE_COOKIE=true \
    docker compose up -d n8n > /dev/null 2>&1
  sleep 5

  echo -e "  ${GREEN}✅ HTTPS ready at https://${DOMAIN}${NC}"
  N8N_ACCESS_URL="https://${DOMAIN}"
else
  echo -e "\n${YELLOW}⚠️  No domain configured — running on HTTP${NC}"
  echo "  Telegram webhooks require HTTPS. Add a domain later and re-run setup.sh"
fi

# ── 9. Apply DB schema ───────────────────────────────────────
echo -e "\n${GREEN}🗄️  Applying database schema...${NC}"
LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/001_schema.sql > /dev/null 2>&1
echo "  ✅ Schema applied"

N8N_BASE="${N8N_URL:-http://localhost:5678}"
ANTHROPIC_CRED_ID="${ANTHROPIC_CRED_ID:-REPLACE_WITH_YOUR_CREDENTIAL_ID}"
POSTGRES_CRED_ID="REPLACE_WITH_YOUR_CREDENTIAL_ID"
TELEGRAM_CRED_ID=""

# ── 10. Wait for n8n API to be ready ────────────────────────
echo -e "\n${GREEN}⏳ Waiting for n8n API...${NC}"
for i in {1..30}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    "${N8N_BASE:-http://localhost:5678}/api/v1/workflows" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo -e "  ${GREEN}✅ n8n API ready${NC}"
    break
  fi
  sleep 3; echo -n "."
done
echo ""
if [ "$STATUS" != "200" ]; then
  echo -e "${RED}❌ n8n API not responding (status: $STATUS). Check n8n logs: docker logs n8n-claw${NC}"
  exit 1
fi

# ── 10b. Create n8n credentials (after API is confirmed ready) ──
if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo -e "\n${GREEN}🔑 Skipping credential creation (update mode)${NC}"
else
echo -e "\n${GREEN}🔑 Creating n8n credentials...${NC}"
fi
set +e
if [ "$INSTALL_MODE" = "fresh" ] || [ "$FORCE_FLAG" = "--force" ]; then

create_cred() {
  local raw_response
  raw_response=$(curl -s -X POST "${N8N_BASE}/api/v1/credentials" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"type\":\"$2\",\"data\":$3}")
  local result
  result=$(echo "$raw_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
  echo "$result"
}

TELEGRAM_CRED_ID=$(create_cred "Telegram Bot" "telegramApi" "{\"accessToken\":\"${TELEGRAM_BOT_TOKEN}\"}")
[ -z "$TELEGRAM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Telegram credential failed — will patch from existing${NC}" || echo "  ✅ Telegram Bot → ${TELEGRAM_CRED_ID}"

# Postgres: try n8n CLI first, then REST
cat > /tmp/pg-cred.json <<PGEOF
{"name":"Supabase Postgres","type":"postgres","data":{"host":"db","database":"postgres","user":"postgres","password":"${POSTGRES_PASSWORD}","port":5432,"ssl":"disable","allowUnauthorizedCerts":true,"sshTunnel":false,"sshAuthenticateWith":"password"}}
PGEOF
POSTGRES_CRED_ID=$(docker compose run --rm -T n8n \
  n8n import:credentials --input=/tmp/pg-cred.json 2>/dev/null | \
  grep -oP '(?<=ID )\S+' | tail -1)
[ -z "$POSTGRES_CRED_ID" ] && \
  POSTGRES_CRED_ID=$(curl -s -X POST "${N8N_BASE}/api/v1/credentials" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "Content-Type: application/json" \
    -d @/tmp/pg-cred.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -z "$POSTGRES_CRED_ID" ]; then
  echo -e "  ${YELLOW}⚠️  Postgres credential — add manually:${NC}"
  echo "     Host: db | DB: postgres | User: postgres | Pass: ${POSTGRES_PASSWORD} | SSL: disable"
  POSTGRES_CRED_ID="REPLACE_WITH_YOUR_CREDENTIAL_ID"
else
  echo "  ✅ Supabase Postgres → ${POSTGRES_CRED_ID}"
fi
fi  # end INSTALL_MODE guard for credentials

# ── 11. Prepare + import workflows ──────────────────────────
declare -A WF_IDS
if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo -e "\n${GREEN}📦 Skipping workflow import (update mode — use --force to reimport)${NC}"
else
echo -e "\n${GREEN}📦 Importing workflows...${NC}"
mkdir -p workflows/deployed

for f in workflows/*.json; do
  out="workflows/deployed/$(basename $f)"
  cp "$f" "$out"
  # Basic placeholder replacements
  sed -i \
    -e "s|{{N8N_URL}}|${N8N_URL:-http://localhost:5678}|g" \
    -e "s|{{N8N_INTERNAL_URL}}|http://172.17.0.1:5678|g" \
    -e "s|{{N8N_API_KEY}}|${N8N_API_KEY}|g" \
    -e "s|{{SUPABASE_URL}}|http://172.17.0.1:8000|g" \
    -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
    -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
    -e "s|{{TELEGRAM_CHAT_ID}}|${TELEGRAM_CHAT_ID}|g" \
    "$out"
  # Credential ID replacements — only if IDs are actually set
  [ -n "$TELEGRAM_CRED_ID" ] && [ "$TELEGRAM_CRED_ID" != "ERR" ] && \
    sed -i "s|REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Telegram Bot\"|${TELEGRAM_CRED_ID}\", \"name\": \"Telegram Bot\"|g" "$out"
  [ -n "$POSTGRES_CRED_ID" ] && [ "$POSTGRES_CRED_ID" != "REPLACE_WITH_YOUR_CREDENTIAL_ID" ] && \
    sed -i "s|REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Supabase Postgres\"|${POSTGRES_CRED_ID}\", \"name\": \"Supabase Postgres\"|g" "$out"
done
IMPORT_ORDER="mcp-client reminder-factory mcp-weather-example workflow-builder mcp-builder n8n-claw-agent"

for name in $IMPORT_ORDER; do
  f="workflows/deployed/${name}.json"
  [ -f "$f" ] || continue
  wf_name=$(python3 -c "import json; print(json.load(open('$f')).get('name','?'))" 2>/dev/null)
  resp=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" -d @"$f")
  wf_id=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
  if [ -z "$wf_id" ]; then
    err=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','unknown error'))" 2>/dev/null)
    echo -e "  ${RED}❌ ${wf_name}: ${err}${NC}"
  else
    WF_IDS[$name]=$wf_id
    echo "  ✅ ${wf_name} → ${wf_id}"
  fi
done

# ── 11. Patch workflow IDs in agent ─────────────────────────
echo -e "\n${GREEN}🔗 Wiring workflow references...${NC}"
AGENT_WF_ID=${WF_IDS['n8n-claw-agent']}
if [ -n "$AGENT_WF_ID" ]; then
  AGENT_JSON=$(curl -s "${N8N_BASE}/api/v1/workflows/${AGENT_WF_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}")

  PATCHED=$(echo "$AGENT_JSON" | python3 -c "
import sys, json
raw = sys.stdin.read()
replacements = {
  'REPLACE_REMINDER_FACTORY_ID': '${WF_IDS[reminder-factory]}',
  'REPLACE_WORKFLOW_BUILDER_ID': '${WF_IDS[workflow-builder]}',

  'REPLACE_MCP_BUILDER_ID':      '${WF_IDS[mcp-builder]}',
}
for placeholder, real_id in replacements.items():
    raw = raw.replace(placeholder, real_id)
wf = json.loads(raw)
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': wf.get('settings',{})}))
" 2>/dev/null)

  if [ -n "$PATCHED" ]; then
    # Also patch credential IDs: fetch real IDs from n8n and replace
    CRED_LIST=$(curl -s "${N8N_BASE}/api/v1/credentials" -H "X-N8N-API-KEY: ${N8N_API_KEY}")
    REAL_TELEGRAM_ID=$(echo "$CRED_LIST" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='telegramApi': print(c['id']); break
" 2>/dev/null)
    REAL_ANTHROPIC_ID=$(echo "$CRED_LIST" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='anthropicApi': print(c['id']); break
" 2>/dev/null)
    REAL_POSTGRES_ID=$(echo "$CRED_LIST" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='postgres': print(c['id']); break
" 2>/dev/null)

    # Apply all replacements together via python
    FINAL=$(echo "$PATCHED" | python3 -c "
import sys, json
raw = sys.stdin.read()
if '${REAL_TELEGRAM_ID}': raw = raw.replace('REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Telegram Bot\"', '${REAL_TELEGRAM_ID}\", \"name\": \"Telegram Bot\"')
if '${REAL_ANTHROPIC_ID}': raw = raw.replace('REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Anthropic API\"', '${REAL_ANTHROPIC_ID}\", \"name\": \"Anthropic API\"')
if '${REAL_POSTGRES_ID}': raw = raw.replace('REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Supabase Postgres\"', '${REAL_POSTGRES_ID}\", \"name\": \"Supabase Postgres\"')
print(raw)
" 2>/dev/null)

    echo "${FINAL:-$PATCHED}" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${AGENT_WF_ID}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @- > /dev/null
    echo "  ✅ Reminder:        ${WF_IDS[reminder-factory]}"
    echo "  ✅ WorkflowBuilder: ${WF_IDS[workflow-builder]}"
    echo "  ✅ MCP Builder:     ${WF_IDS[mcp-builder]}"
    [ -n "$REAL_TELEGRAM_ID" ]  && echo "  ✅ Telegram cred:   ${REAL_TELEGRAM_ID}"
    [ -n "$REAL_POSTGRES_ID" ]  && echo "  ✅ Postgres cred:   ${REAL_POSTGRES_ID}"
    [ -n "$REAL_ANTHROPIC_ID" ] && echo "  ✅ Anthropic cred:  ${REAL_ANTHROPIC_ID} (if already added)"
  fi
fi
fi  # end INSTALL_MODE guard for workflows

# ── 12. Activate agent ───────────────────────────────────────
AGENT_ID=${WF_IDS['n8n-claw-agent']}
if [ -n "$AGENT_ID" ]; then
  AGENT_ACTIVATE=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows/${AGENT_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}")
  AGENT_ACT_ERR=$(echo "$AGENT_ACTIVATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null)
  if [ -z "$AGENT_ACT_ERR" ]; then
    echo -e "  ${GREEN}✅ n8n-claw Agent activated${NC}"
  else
    echo -e "  ${YELLOW}⚠️  Agent activation: ${AGENT_ACT_ERR} — activate manually in n8n UI${NC}"
  fi
fi

# ── 12. Setup Wizard via CLI (no n8n workflow needed) ────────
if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo -e "\n${GREEN}🧙 Skipping personalization (update mode — use --force to reconfigure)${NC}"
else
echo -e "\n${GREEN}🧙 Personalization setup${NC}"
echo "────────────────────────────"
echo "Let's configure your agent's personality."
echo ""

cli_ask() {
  local prompt="$1" default="$2"
  read -rp "  ${prompt} [${default}]: " val
  echo "${val:-$default}"
}

BOT_NAME=$(cli_ask "Agent name" "Assistant")
USER_DISPLAY=$(cli_ask "Your name" "User")
LANG=$(cli_ask "Preferred language" "English")
CTX=$(cli_ask "What will you use this agent for" "Personal assistant and automation")

echo ""
echo "  Communication style:"
echo "    1) Casual & direct (short messages, no filler)"
echo "    2) Professional & formal"
echo "    3) Friendly & warm"
read -rp "  Choose [1]: " STYLE_CHOICE
case "${STYLE_CHOICE:-1}" in
  2) STYLE="Professional and formal. Full sentences. Polished tone." ;;
  3) STYLE="Friendly and warm. Encouraging. Uses occasional emojis." ;;
  *) STYLE="Casual and direct. Short messages. No filler phrases or pleasantries. Gets to the point." ;;
esac

echo ""
echo "  Proactive behavior:"
echo "    1) Proactive — reminds you of things, checks in, suggests next steps"
echo "    2) Reactive — only responds when you message first"
read -rp "  Choose [1]: " PROACTIVE_CHOICE
case "${PROACTIVE_CHOICE:-1}" in
  2) PROACTIVE="Only respond when the user initiates. Do not proactively reach out." ;;
  *) PROACTIVE="Be proactive: remind the user of upcoming events, suggest next steps, follow up on open tasks." ;;
esac

echo ""
echo "  Custom personality (optional — overrides the above):"
echo "  Describe exactly how the agent should behave, in your own words."
echo "  Leave empty to use the settings above."
read -rp "  Custom persona: " CUSTOM_PERSONA
if [ -n "$CUSTOM_PERSONA" ]; then
  STYLE="$CUSTOM_PERSONA"
  PROACTIVE=""
  echo -e "  ${GREEN}✅ Using custom persona${NC}"
fi

N8N_URL_FOR_MCP="${DOMAIN:+https://$DOMAIN}"
N8N_URL_FOR_MCP="${N8N_URL_FOR_MCP:-http://localhost:5678}"

# Use python to build safe SQL (avoids shell quoting/locale issues)
python3 - <<PYEOF
import subprocess, os

pw = os.environ.get('POSTGRES_PASSWORD', '')
env = {**os.environ, 'PGPASSWORD': pw, 'LANG': 'C', 'LC_ALL': 'C'}

def esc(s):
    return s.replace("'", "''")

bot     = esc('${BOT_NAME}')
user    = esc('${USER_DISPLAY}')
lang    = esc('${LANG}')
style   = esc('${STYLE}')
proact  = esc('${PROACTIVE}')
ctx     = esc('${CTX}')
chat_id = '${TELEGRAM_CHAT_ID}'
mcp_url = '${N8N_URL_FOR_MCP}'
uname   = user.lower().replace(' ', '_')

sql = f"""
INSERT INTO public.soul (key, content) VALUES
  ('name', '{bot}'),
  ('persona', 'You are {bot}, a helpful AI assistant for {user}. Preferred language: {lang}. {style}'),
  ('vibe', '{style}'),
  ('proactive', '{proact}'),
  ('boundaries', 'Keep private data private. Ask before external actions.'),
  ('communication', 'You communicate via Telegram. Reply directly.')
ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;

INSERT INTO public.user_profiles (user_id, name, display_name, timezone, context, setup_done, setup_step)
VALUES ('telegram:{chat_id}', '{uname}', '{user}', 'UTC', '{ctx}', true, 5)
ON CONFLICT (user_id) DO UPDATE SET
  display_name = EXCLUDED.display_name, context = EXCLUDED.context, setup_done = true;

INSERT INTO public.mcp_registry (server_name, path, mcp_url, description, tools, active)
VALUES ('Wetter', 'wetter', '{mcp_url}/mcp/wetter', 'Weather via Open-Meteo', ARRAY['get_weather'], true)
ON CONFLICT (path) DO UPDATE SET active = true;
"""

result = subprocess.run(
    ['psql', '-h', 'localhost', '-U', 'postgres', '-d', 'postgres'],
    input=sql, capture_output=True, text=True, env=env
)
if result.returncode != 0:
    print('SQL ERROR:', result.stderr[:300])
    exit(1)
PYEOF

python3 - <<PYEOF2
import subprocess, os
pw = os.environ.get('POSTGRES_PASSWORD', '')
env = {**os.environ, 'PGPASSWORD': pw, 'LANG': 'C', 'LC_ALL': 'C'}
mcp_url = '${N8N_URL_FOR_MCP}'
bot = '${BOT_NAME}'.replace("'", "''")
user = '${USER_DISPLAY}'.replace("'", "''")
ctx = '${CTX}'.replace("'", "''")

sql = f"""
INSERT INTO public.agents (key, content) VALUES
  ('mcp_instructions', 'You have MCP (Model Context Protocol) capabilities:

## MCP Client (mcp_client tool)
Call tools on MCP servers. Parameters:
- mcp_url: Server URL
- tool_name: Name of the tool
- arguments: JSON object with tool parameters

## MCP Builder (mcp_builder tool)
ALWAYS use this when the user wants to build an MCP server or integration.
NEVER use WorkflowBuilder for MCP servers.
Parameter: task (description of what the MCP server should do)
NOTE: After build, manually deactivate + activate in n8n UI (webhook bug).

## Available MCP Servers:
- Wetter: {mcp_url}/mcp/wetter (tool: get_weather, param: city)

## Registry
Query all active servers: SELECT * FROM mcp_registry WHERE active = true;'),

  ('tools', 'Available tools and when to use them:

CALENDAR (Kalender tool):
- Use for: reading upcoming events, creating new appointments
- Input: JSON with action (list/create) and parameters

REMINDER (Reminder tool):
- Use for: setting timed reminders, e.g. "remind me in 2 hours"
- Input: ISO 8601 time + message

WORKFLOW BUILDER (WorkflowBuilder tool):
- Use for: building new n8n automations (NOT for MCP servers)
- Input: JSON with task description

MEMORY (memory_search / memory_save):
- Search: find relevant past information
- Save: store important decisions or facts

HTTP (http_request):
- Use for: simple API calls without authentication'),

  ('user_context', 'The user is {user}. Context: {ctx}')

ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;
"""
result = subprocess.run(['psql','-h','localhost','-U','postgres','-d','postgres'],
  input=sql, capture_output=True, text=True, env=env)
if result.returncode != 0:
    print('agents SQL error:', result.stderr[:200])
PYEOF2
# Verify soul was written
SOUL_COUNT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c "SELECT COUNT(*) FROM soul" 2>/dev/null | tr -d ' ')
if [ "${SOUL_COUNT:-0}" -gt 0 ]; then
  echo -e "  ${GREEN}✅ Agent configured as '${BOT_NAME}', user '${USER_DISPLAY}' (${SOUL_COUNT} soul rows)${NC}"
else
  echo -e "  ${RED}❌ Soul table empty — DB write failed. Check postgres connection.${NC}"
fi
fi  # end INSTALL_MODE guard for personalization

# ── Done ─────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "YOUR-VPS-IP")
N8N_FINAL_URL=${DOMAIN:+https://$DOMAIN}
N8N_FINAL_URL=${N8N_FINAL_URL:-http://$PUBLIC_IP:5678}
STUDIO_URL="http://${PUBLIC_IP}:3001"

echo ""
if [ "$INSTALL_MODE" = "update" ]; then
  echo -e "${GREEN}🎉 Update complete!${NC}"
  echo "=============================="
  echo ""
  echo -e "  ${GREEN}n8n:${NC} ${N8N_FINAL_URL}"
  echo -e "  ${GREEN}Mode:${NC} update (services restarted, DB schema applied)"
  if [ "$FORCE_FLAG" = "--force" ]; then
    echo "  Workflows reimported, personality reconfigured"
  else
    echo "  Workflows + personality unchanged (use --force to reimport)"
  fi
  echo ""
  exit 0
fi
echo -e "${GREEN}🎉 Setup complete!${NC}"
echo "=============================="
echo ""
echo -e "  ${GREEN}URLs:${NC}"
echo "    n8n:             ${N8N_FINAL_URL}"
echo "    Supabase Studio:    ${STUDIO_URL}"
echo ""
echo -e "  ${GREEN}Supabase credentials:${NC}"
echo "    Host:     db:5432  (or localhost:5432 from host)"
echo "    DB:       postgres"
echo "    User:     postgres"
echo "    Password: ${POSTGRES_PASSWORD}"
echo "    Anon Key: ${SUPABASE_ANON_KEY:0:40}..."
echo ""
if [ "$POSTGRES_CRED_ID" = "REPLACE_WITH_YOUR_CREDENTIAL_ID" ]; then
echo -e "  ${YELLOW}⚠️  Manual step required — Postgres credential:${NC}"
echo "    n8n UI → Settings → Credentials → New → Postgres"
echo "    Name: Supabase Postgres"
echo "    Host: db  |  DB: postgres  |  User: postgres"
echo "    Password: ${POSTGRES_PASSWORD}  |  SSL: disable"
echo ""
fi
echo -e "  ${GREEN}Next steps:${NC}"
echo "    1. Open ${N8N_FINAL_URL}"
if [ "$POSTGRES_CRED_ID" = "REPLACE_WITH_YOUR_CREDENTIAL_ID" ]; then
echo "    2. Add Postgres credential (details above)"
echo "    3. Add Anthropic API credential:"
else
echo "    2. Add Anthropic API credential:"
fi
echo "       Settings → Credentials → New → Anthropic API"
echo "       Name: 'Anthropic API'  |  Key: your key"
echo "    4. Activate ALL workflows in n8n UI (Workflows → toggle each one on):"
echo "       → 🤖 n8n-claw Agent      (ID: ${WF_IDS['n8n-claw-agent']})"
echo "       → 🏗️  MCP Builder        (ID: ${WF_IDS['mcp-builder']})"
echo "       → 🔌 MCP Client          (ID: ${WF_IDS['mcp-client']})"
echo "       → ⏰ ReminderFactory      (ID: ${WF_IDS['reminder-factory']})"
echo "       → 🌤️  MCP: Weather        (ID: ${WF_IDS['mcp-weather-example']})"
echo "       → ⚙️  WorkflowBuilder     (ID: ${WF_IDS['workflow-builder']})"
echo ""
echo -e "  ${YELLOW}⚠️  MCP Builder extra step:${NC}"
echo "     Open MCP Builder workflow → click the LLM node"
echo "     → select 'Anthropic API' as the chat model"
echo "     (not set by default due to n8n credential linking)"
echo ""
echo "    5. Message your Telegram bot!"
echo ""
if [ -z "$DOMAIN" ]; then
echo -e "  ${YELLOW}HTTPS: Point a domain here → re-run: DOMAIN=n8n.yourdomain.com ./setup.sh${NC}"
fi
