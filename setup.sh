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

# ── 1. Install dependencies ─────────────────────────────────
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
    line="$(echo "$line" | sed 's/[[:space:]]*=[[:space:]]*/=/')"
    [[ "$line" =~ ^[A-Z_]+=.* ]] && export "$line" 2>/dev/null || true
  done < .env
}
_load_env

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

# ── 3. Start n8n early so user can get API key ──────────────
if [ -z "$N8N_API_KEY" ] || [[ "$N8N_API_KEY" == your_* ]]; then
  echo -e "\n${GREEN}🐳 Starting n8n...${NC}"
  N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:-$(openssl rand -base64 24)} \
  POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-changeme} \
  SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET:-$(openssl rand -base64 32)} \
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
ask "ANTHROPIC_API_KEY"  "Anthropic API Key (console.anthropic.com)" "" 1
ask "TELEGRAM_BOT_TOKEN" "Telegram Bot Token (from @BotFather)"      "" 1
ask "TELEGRAM_CHAT_ID"   "Your Telegram Chat ID (from @userinfobot)" "" 0
_load_env
echo -e "${GREEN}✅ Configuration saved${NC}"

# ── 5. Generate keys if missing ─────────────────────────────
if [ -z "$SUPABASE_JWT_SECRET" ]; then
  SUPABASE_JWT_SECRET=$(openssl rand -base64 32)
  echo "SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET" >> .env
fi
if [ -z "$N8N_ENCRYPTION_KEY" ]; then
  N8N_ENCRYPTION_KEY=$(openssl rand -base64 24)
  echo "N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY" >> .env
fi
if [ -z "$POSTGRES_PASSWORD" ] || [[ "$POSTGRES_PASSWORD" == "changeme" ]]; then
  POSTGRES_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
  echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >> .env
fi

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
  echo "$KEYS" >> .env
  eval "$KEYS"
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
POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET \
N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY \
N8N_HOST=${N8N_HOST:-localhost} \
N8N_PROTOCOL=${N8N_PROTOCOL:-http} \
N8N_WEBHOOK_URL=${N8N_URL:-http://localhost:5678} \
TIMEZONE=${TIMEZONE:-Europe/Berlin} \
  docker compose up -d 2>&1 | tail -5

echo "  Waiting for database..."
for i in {1..30}; do
  PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "SELECT 1" > /dev/null 2>&1 && break
  sleep 2; echo -n "."
done
echo ""
echo -e "  ${GREEN}✅ All services running${NC}"

# ── 8. Apply DB schema ───────────────────────────────────────
echo -e "\n${GREEN}🗄️  Applying database schema...${NC}"
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/001_schema.sql > /dev/null 2>&1
echo "  ✅ Schema applied"

# ── 9. Create n8n credentials ────────────────────────────────
echo -e "\n${GREEN}🔑 Creating n8n credentials...${NC}"
N8N_BASE="${N8N_URL:-http://localhost:5678}"

create_cred() {
  curl -s -X POST "${N8N_BASE}/api/v1/credentials" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"type\":\"$2\",\"data\":$3}" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','ERR'))" 2>/dev/null
}

ANTHROPIC_CRED_ID=$(create_cred "Anthropic API" "anthropicApi" "{\"apiKey\":\"${ANTHROPIC_API_KEY}\"}")
echo "  ✅ Anthropic API → ${ANTHROPIC_CRED_ID}"

TELEGRAM_CRED_ID=$(create_cred "Telegram Bot" "telegramApi" "{\"accessToken\":\"${TELEGRAM_BOT_TOKEN}\"}")
echo "  ✅ Telegram Bot → ${TELEGRAM_CRED_ID}"

POSTGRES_CRED_ID=$(create_cred "Supabase Postgres" "postgres" \
  "{\"host\":\"db\",\"port\":5432,\"database\":\"postgres\",\"user\":\"postgres\",\"password\":\"${POSTGRES_PASSWORD}\",\"ssl\":false}")
echo "  ✅ Supabase Postgres → ${POSTGRES_CRED_ID}"

# ── 10. Prepare + import workflows ──────────────────────────
echo -e "\n${GREEN}📦 Importing workflows...${NC}"
mkdir -p workflows/deployed

for f in workflows/*.json; do
  out="workflows/deployed/$(basename $f)"
  sed \
    -e "s|{{N8N_URL}}|${N8N_URL:-http://localhost:5678}|g" \
    -e "s|{{N8N_INTERNAL_URL}}|http://172.17.0.1:5678|g" \
    -e "s|{{N8N_API_KEY}}|${N8N_API_KEY}|g" \
    -e "s|{{SUPABASE_URL}}|http://localhost:8000|g" \
    -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
    -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
    -e "s|{{TELEGRAM_CHAT_ID}}|${TELEGRAM_CHAT_ID}|g" \
    -e "s|REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Anthropic API\"|${ANTHROPIC_CRED_ID}\", \"name\": \"Anthropic API\"|g" \
    -e "s|REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Telegram Bot\"|${TELEGRAM_CRED_ID}\", \"name\": \"Telegram Bot\"|g" \
    "$f" > "$out"
done

declare -A WF_IDS
IMPORT_ORDER="mcp-client caldav-sub-workflow reminder-factory mcp-wetter-example workflow-builder mcp-builder setup-wizard greg-ai-agent"

for name in $IMPORT_ORDER; do
  f="workflows/deployed/${name}.json"
  [ -f "$f" ] || continue
  wf_name=$(python3 -c "import json; print(json.load(open('$f')).get('name','?'))" 2>/dev/null)
  resp=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" -d @"$f")
  wf_id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
  WF_IDS[$name]=$wf_id
  echo "  ✅ ${wf_name} → ${wf_id}"
done

# ── 11. Wire setup wizard → greg agent ──────────────────────
AGENT_ID=${WF_IDS['greg-ai-agent']}
WIZARD_ID=${WF_IDS['setup-wizard']}
if [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "ERR" ]; then
  curl -s "${N8N_BASE}/api/v1/workflows/${WIZARD_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" | \
  python3 -c "
import sys,json
wf=json.load(sys.stdin)
s=json.dumps(wf).replace('REPLACE_WITH_GREG_AGENT_ID','${AGENT_ID}')
d=json.loads(s)
print(json.dumps({'name':d['name'],'nodes':d.get('nodes',d.get('activeVersion',{}).get('nodes',[])),'connections':d.get('connections',{}),'settings':d.get('settings',{})}))
" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${WIZARD_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" -d @- > /dev/null
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${WIZARD_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null
  echo -e "\n  ${GREEN}✅ Setup Wizard wired + activated${NC}"
fi

# ── 12. Seed DB ──────────────────────────────────────────────
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres > /dev/null 2>&1 <<SQL
INSERT INTO public.soul (key, content) VALUES
  ('name','Assistant'),
  ('persona','Du bist ein hilfreicher KI-Assistent. Sprich locker und direkt. Keine Floskeln. Kurz, klar.'),
  ('vibe','Locker, direkt, hilfsbereit.'),
  ('boundaries','Private Daten bleiben privat. Externe Aktionen nur nach Rückfrage.'),
  ('communication','Du kommunizierst über Telegram. Antworte direkt.')
ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;
INSERT INTO public.mcp_registry (server_name, path, mcp_url, description, tools, active) VALUES
  ('Wetter','wetter','http://localhost:5678/mcp/wetter','Wetter via Open-Meteo',ARRAY['get_weather'],true)
ON CONFLICT (path) DO UPDATE SET active = true;
SQL
echo -e "  ${GREEN}✅ Database seeded${NC}"

# ── Done ─────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || echo "YOUR-VPS-IP")
echo ""
echo -e "${GREEN}🎉 Setup complete!${NC}"
echo "=============================="
echo ""
echo "  n8n:  http://${PUBLIC_IP}:5678"
echo ""
echo "  Activate these workflows in n8n UI:"
echo "    → 🤖 Greg AI Agent  (ID: ${WF_IDS['greg-ai-agent']})"
echo "    → 🏗️  MCP Builder    (ID: ${WF_IDS['mcp-builder']})"
echo ""
echo "  Then send /start to your Telegram bot → Setup Wizard runs!"
