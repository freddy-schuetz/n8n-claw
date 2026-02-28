#!/bin/bash
# ============================================================
# n8n-claw Setup Script
# ============================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [ ! -f .env ]; then
  cp .env.example .env
  echo -e "${YELLOW}📝 .env created from .env.example${NC}"
  echo ""
  echo "Please fill in these required values in .env:"
  echo "  ANTHROPIC_API_KEY   → your Anthropic API key"
  echo "  TELEGRAM_BOT_TOKEN  → from @BotFather on Telegram"
  echo "  TELEGRAM_CHAT_ID    → your Telegram user ID (get it from @userinfobot)"
  echo "  N8N_API_KEY         → generate in n8n UI after first start"
  echo ""
  echo "Then run: ./setup.sh again"
  echo ""
  echo -e "${YELLOW}Tip: Start n8n first to get your API key:${NC}"
  echo "  docker compose up -d n8n"
  echo "  open http://localhost:5678 → Settings → API → Create key"
  exit 0
fi

source .env

# Validate required vars
MISSING=()
[ -z "$N8N_API_KEY" ] || [ "$N8N_API_KEY" = "your_n8n_api_key" ] && MISSING+=("N8N_API_KEY")
[ -z "$ANTHROPIC_API_KEY" ] || [ "$ANTHROPIC_API_KEY" = "your_anthropic_key" ] && MISSING+=("ANTHROPIC_API_KEY")
[ -z "$TELEGRAM_BOT_TOKEN" ] || [ "$TELEGRAM_BOT_TOKEN" = "your_bot_token" ] && MISSING+=("TELEGRAM_BOT_TOKEN")
[ -z "$TELEGRAM_CHAT_ID" ] || [ "$TELEGRAM_CHAT_ID" = "your_chat_id" ] && MISSING+=("TELEGRAM_CHAT_ID")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo -e "${RED}❌ Missing required values in .env:${NC}"
  for v in "${MISSING[@]}"; do echo "   → $v"; done
  echo ""
  echo "Edit .env and run ./setup.sh again"
  exit 1
fi

echo -e "${GREEN}🚀 n8n-claw Setup${NC}"
echo "=============================="

# ── 1. Generate JWT tokens if not set ──────────────────────
if [ -z "$SUPABASE_JWT_SECRET" ]; then
  export SUPABASE_JWT_SECRET=$(openssl rand -base64 32)
  echo "SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET" >> .env
  echo -e "${YELLOW}⚠️  Generated JWT secret — saved to .env${NC}"
fi

if [ -z "$SUPABASE_SERVICE_KEY" ] || [ "$SUPABASE_SERVICE_KEY" = "your_service_role_key" ]; then
  echo -e "${YELLOW}Generating Supabase keys...${NC}"
  # Generate anon + service_role JWTs
  python3 - <<PYEOF
import base64, json, hmac, hashlib, time, os

secret = os.environ.get('SUPABASE_JWT_SECRET', '').encode()

def make_jwt(role):
    header = base64.urlsafe_b64encode(json.dumps({"alg":"HS256","typ":"JWT"}).encode()).rstrip(b'=').decode()
    payload = base64.urlsafe_b64encode(json.dumps({"role":role,"iss":"supabase","iat":1771793684,"exp":2087153684}).encode()).rstrip(b'=').decode()
    sig_input = f"{header}.{payload}".encode()
    sig = base64.urlsafe_b64encode(hmac.new(secret, sig_input, hashlib.sha256).digest()).rstrip(b'=').decode()
    return f"{header}.{payload}.{sig}"

anon = make_jwt("anon")
svc = make_jwt("service_role")
print(f"SUPABASE_ANON_KEY={anon}")
print(f"SUPABASE_SERVICE_KEY={svc}")
PYEOF
  echo -e "${YELLOW}Add the above keys to your .env and re-run setup.sh${NC}"
  exit 0
fi

# ── 2. Replace placeholders in Kong config ─────────────────
echo -e "\n${GREEN}🔧 Configuring Supabase gateway...${NC}"
sed \
  -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
  -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
  supabase/kong.yml > supabase/kong.deployed.yml
echo "  ✅ Kong config generated"

# ── 3. Start Docker services ────────────────────────────────
echo -e "\n${GREEN}🐳 Starting Docker services...${NC}"
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-changeme} \
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET} \
N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY:-$(openssl rand -base64 24)} \
N8N_HOST=${N8N_HOST:-localhost} \
N8N_PROTOCOL=${N8N_PROTOCOL:-http} \
N8N_WEBHOOK_URL=${N8N_URL:-http://localhost:5678} \
TIMEZONE=${TIMEZONE:-Europe/Berlin} \
  docker compose up -d

echo "  Waiting for services to be ready..."
sleep 10

# Wait for n8n
for i in {1..30}; do
  if curl -s http://localhost:5678/healthz > /dev/null 2>&1; then
    echo "  ✅ n8n ready"
    break
  fi
  sleep 2
done

# Wait for DB
for i in {1..30}; do
  if PGPASSWORD=${POSTGRES_PASSWORD:-changeme} psql -h localhost -U postgres -d postgres -c "SELECT 1" > /dev/null 2>&1; then
    echo "  ✅ Database ready"
    break
  fi
  sleep 2
done

# ── 4. Apply Supabase schema ────────────────────────────────
echo -e "\n${GREEN}🗄️  Applying database schema...${NC}"
PGPASSWORD=${POSTGRES_PASSWORD:-changeme} psql \
  -h localhost -p 5432 -U postgres -d postgres \
  -f supabase/migrations/001_schema.sql 2>/dev/null
echo "  ✅ Schema applied"

# ── 5. Replace placeholders in workflows ───────────────────
echo -e "\n${GREEN}🔧 Preparing workflows...${NC}"
mkdir -p workflows/deployed
SUPABASE_INTERNAL_URL="http://$(docker inspect n8n-claw-rest -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo 'rest'):3000"

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
    -e "s|{{VPS_IP}}|${VPS_IP:-localhost}|g" \
    "$f" > "$out"
  echo "  ✅ $(basename $f)"
done

# ── 6. Create n8n credentials ──────────────────────────────
echo -e "\n${GREEN}🔑 Creating n8n credentials...${NC}"

N8N_BASE="${N8N_URL:-http://localhost:5678}"
N8N_HEAD=(-H "X-N8N-API-KEY: ${N8N_API_KEY}" -H "Content-Type: application/json")

create_credential() {
  local name="$1"
  local type="$2"
  local data="$3"
  local response
  response=$(curl -s -X POST "${N8N_BASE}/api/v1/credentials" \
    "${N8N_HEAD[@]}" \
    -d "{\"name\":\"${name}\",\"type\":\"${type}\",\"data\":${data}}")
  local cred_id
  cred_id=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','ERROR: '+d.get('message','unknown')))" 2>/dev/null)
  echo "  ${cred_id}"
}

# Anthropic
if [ -n "$ANTHROPIC_API_KEY" ] && [ "$ANTHROPIC_API_KEY" != "your_anthropic_key" ]; then
  ANTHROPIC_CRED_ID=$(create_credential \
    "${N8N_CREDENTIAL_ANTHROPIC_NAME:-Anthropic API}" \
    "anthropicApi" \
    "{\"apiKey\":\"${ANTHROPIC_API_KEY}\"}")
  echo "  ✅ Anthropic API → ${ANTHROPIC_CRED_ID}"
else
  echo -e "  ${YELLOW}⚠️  ANTHROPIC_API_KEY not set — skipping${NC}"
fi

# Telegram
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ "$TELEGRAM_BOT_TOKEN" != "your_bot_token" ]; then
  TELEGRAM_CRED_ID=$(create_credential \
    "${N8N_CREDENTIAL_TELEGRAM_NAME:-Telegram Bot}" \
    "telegramApi" \
    "{\"accessToken\":\"${TELEGRAM_BOT_TOKEN}\"}")
  echo "  ✅ Telegram Bot → ${TELEGRAM_CRED_ID}"
else
  echo -e "  ${YELLOW}⚠️  TELEGRAM_BOT_TOKEN not set — skipping${NC}"
fi

# Supabase Postgres (direct DB access for some workflows)
POSTGRES_CRED_ID=$(create_credential \
  "${N8N_CREDENTIAL_POSTGRES_NAME:-Supabase Postgres}" \
  "postgres" \
  "{\"host\":\"db\",\"port\":5432,\"database\":\"postgres\",\"user\":\"postgres\",\"password\":\"${POSTGRES_PASSWORD:-changeme}\",\"ssl\":false}")
echo "  ✅ Supabase Postgres → ${POSTGRES_CRED_ID}"

# Patch workflow JSONs with real credential IDs
if [ -n "$ANTHROPIC_CRED_ID" ] && [ "$ANTHROPIC_CRED_ID" != "ERROR"* ]; then
  for f in workflows/deployed/*.json; do
    python3 -c "
import sys,json,re
wf=json.load(open('$f'))
s=json.dumps(wf)
s=s.replace('\"id\": \"REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Anthropic API\"','\"id\": \"${ANTHROPIC_CRED_ID}\", \"name\": \"${N8N_CREDENTIAL_ANTHROPIC_NAME:-Anthropic API}\"')
s=s.replace('\"id\": \"REPLACE_WITH_YOUR_CREDENTIAL_ID\", \"name\": \"Telegram Bot\"','\"id\": \"${TELEGRAM_CRED_ID}\", \"name\": \"${N8N_CREDENTIAL_TELEGRAM_NAME:-Telegram Bot}\"')
open('$f','w').write(s)
" 2>/dev/null
  done
  echo "  ✅ Credential IDs patched into workflow files"
fi

# ── 7. Import workflows into n8n ───────────────────────────
echo -e "\n${GREEN}📦 Importing workflows into n8n...${NC}"

declare -A WF_IDS

# Import in order (sub-workflows first)
IMPORT_ORDER="mcp-client caldav-sub-workflow reminder-factory mcp-wetter-example workflow-builder mcp-builder setup-wizard greg-ai-agent"

for name in $IMPORT_ORDER; do
  f="workflows/deployed/${name}.json"
  [ -f "$f" ] || continue
  wf_name=$(python3 -c "import sys,json; print(json.load(open('$f')).get('name','?'))")
  response=$(curl -s -X POST "${N8N_URL:-http://localhost:5678}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$f")
  wf_id=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','ERROR'))" 2>/dev/null)
  WF_IDS[$name]=$wf_id
  echo "  ✅ ${wf_name} → ${wf_id}"
done

# ── 7. Wire up workflow IDs ─────────────────────────────────
echo -e "\n${GREEN}🔗 Wiring workflow references...${NC}"
AGENT_ID=${WF_IDS['greg-ai-agent']}
WIZARD_ID=${WF_IDS['setup-wizard']}

# Patch setup wizard with greg agent ID
if [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "ERROR" ]; then
  curl -s -X GET "${N8N_URL:-http://localhost:5678}/api/v1/workflows/${WIZARD_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" | \
  python3 -c "
import sys,json
wf=json.load(sys.stdin)
nodes=wf.get('nodes',wf.get('activeVersion',{}).get('nodes',[]))
for n in nodes:
    if n.get('parameters',{}).get('value','')=='REPLACE_WITH_GREG_AGENT_ID':
        n['parameters']['value']='${AGENT_ID}'
    if isinstance(n.get('parameters',{}).get('workflowId'),dict):
        if n['parameters']['workflowId'].get('value')=='REPLACE_WITH_GREG_AGENT_ID':
            n['parameters']['workflowId']['value']='${AGENT_ID}'
print(json.dumps({'name':wf['name'],'nodes':nodes,'connections':wf.get('connections',{}),'settings':wf.get('settings',{})}))
" | curl -s -X PUT "${N8N_URL:-http://localhost:5678}/api/v1/workflows/${WIZARD_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @- > /dev/null
  echo "  ✅ Setup Wizard wired to Greg Agent (${AGENT_ID})"
fi

# Activate setup wizard
curl -s -X POST "${N8N_URL:-http://localhost:5678}/api/v1/workflows/${WIZARD_ID}/activate" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null
echo "  ✅ Setup Wizard activated"

# ── 8. Apply seed data with real IDs ───────────────────────
echo -e "\n${GREEN}🌱 Seeding database...${NC}"
PGPASSWORD=${POSTGRES_PASSWORD:-changeme} psql \
  -h localhost -p 5432 -U postgres -d postgres \
  -c "
INSERT INTO public.soul (key, content) VALUES
  ('name', 'Assistant'),
  ('persona', 'Du bist ein hilfreicher KI-Assistent. Sprich locker und direkt. Keine Floskeln. Kurz, klar. Emojis sparsam.'),
  ('vibe', 'Locker, direkt, hilfsbereit ohne Gelaber.'),
  ('boundaries', 'Private Daten bleiben privat. Externe Aktionen nur nach Rückfrage.'),
  ('communication', 'Du kommunizierst über Telegram. Antworte direkt in der Konversation.')
ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;

INSERT INTO public.mcp_registry (server_name, path, mcp_url, description, tools, active) VALUES
  ('Wetter', 'wetter', '${N8N_URL:-http://localhost:5678}/mcp/wetter', 'Wetter via Open-Meteo', ARRAY['get_weather'], true)
ON CONFLICT (path) DO UPDATE SET active = true;
" 2>/dev/null
echo "  ✅ Seed data applied"

# ── 9. Done ─────────────────────────────────────────────────
echo -e "\n${GREEN}🎉 Setup complete!${NC}"
echo "=============================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Open n8n: ${N8N_URL:-http://localhost:5678}"
if [ -z "$ANTHROPIC_API_KEY" ] || [ "$ANTHROPIC_API_KEY" = "your_anthropic_key" ]; then
echo "  ⚠️  Add credentials manually in n8n UI:"
echo "     → Anthropic API  (name it exactly: 'Anthropic API')"
echo "     → Telegram Bot   (name it exactly: 'Telegram Bot', token: your bot token)"
fi
echo ""
echo "  2. Activate these workflows manually in n8n UI:"
echo "     → 🤖 Greg AI Agent (ID: ${WF_IDS['greg-ai-agent']})"
echo "     → 🏗️ MCP Builder"
echo "     → 📅 CalDAV Sub-Workflow"
echo ""
echo "  4. Send /start to your Telegram bot → Setup Wizard runs!"
echo ""
echo "Workflow IDs:"
for name in "${!WF_IDS[@]}"; do
  echo "  ${name}: ${WF_IDS[$name]}"
done
