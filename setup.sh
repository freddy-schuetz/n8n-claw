#!/bin/bash
# ============================================================
# n8n-claw Setup Script
# ============================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

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

# Merge new keys from .env.example into existing .env (add missing, don't overwrite)
if [ -f .env ] && [ -f .env.example ]; then
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    key="$(echo "$key" | xargs)"
    if ! grep -q "^${key}=" .env 2>/dev/null; then
      echo "${key}=${val}" >> .env
    fi
  done < .env.example
  _load_env  # Reload after merge
fi

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
  # Auto-update from git if possible
  git pull --ff-only 2>/dev/null && echo -e "  ${GREEN}✅ Updated to latest version${NC}" \
    || echo -e "  ⚠️  Could not auto-update — run 'git pull' manually if needed"
fi

ask() {
  local var="$1" prompt="$2" current="${!1}" secret="$4"
  if [ -n "$current" ] && [[ "$current" != your_* ]]; then
    return
  fi
  while true; do
    if [ "$secret" = "1" ]; then
      echo -e "  ${YELLOW}(input is hidden for security)${NC}"
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

# Webhook API secret for external integrations
if [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  set_env "WEBHOOK_SECRET" "$WEBHOOK_SECRET"
fi

# SearXNG secret key (only patch if placeholder still present)
if grep -q '{{SEARXNG_SECRET_KEY}}' searxng/settings.yml 2>/dev/null; then
  SEARXNG_SECRET=$(openssl rand -hex 32)
  sed -i "s|{{SEARXNG_SECRET_KEY}}|${SEARXNG_SECRET}|g" searxng/settings.yml
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
  if ! LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${RED}❌ Database failed to start. Check: docker logs n8n-claw-db${NC}"
    exit 1
  fi
  # Supabase postgres image needs supabase_admin role for extension ownership
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 5432 -U postgres -d postgres \
    -c "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin LOGIN SUPERUSER; END IF; END\$\$;" \
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

# ── Discord (optional) ──
# Users who don't want Discord see a single y/N and move on. Opting in adds
# 'discord' to COMPOSE_PROFILES so the bot-sidecar container starts with the
# rest of the stack further down this script.
EXISTING_DISCORD_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' .env 2>/dev/null | cut -d= -f2-)
EXISTING_PROFILES=$(grep '^COMPOSE_PROFILES=' .env 2>/dev/null | cut -d= -f2-)
if [ -n "$EXISTING_DISCORD_TOKEN" ] && [ "$INSTALL_MODE" != "update" ]; then
  echo -e "  ${GREEN}💬 Discord: Using existing bot token${NC}"
elif [ -z "$EXISTING_DISCORD_TOKEN" ]; then
  read -rp "💬 Enable Discord as an additional chat interface? (y/N): " DISCORD_ENABLE
  if [[ "$DISCORD_ENABLE" =~ ^[Yy]$ ]]; then
    echo "  Setup: https://discord.com/developers/applications → New Application → Bot"
    echo "         Enable 'Message Content Intent' under Bot settings, then copy the token."
    read -rp "  Discord Bot Token: " DISCORD_BOT_TOKEN_INPUT
    if [ -n "$DISCORD_BOT_TOKEN_INPUT" ]; then
      set_env DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN_INPUT"
      if [ -z "$EXISTING_PROFILES" ]; then
        set_env COMPOSE_PROFILES "discord"
      elif [[ ",${EXISTING_PROFILES}," != *",discord,"* ]]; then
        set_env COMPOSE_PROFILES "${EXISTING_PROFILES},discord"
      fi
      echo -e "  ${GREEN}✅ Discord bridge will start with the rest of the stack${NC}"
      echo "  Invite the bot to your server with 'bot' + 'applications.commands' scopes."
    else
      echo -e "  ⏭️  Skipped — no token provided"
    fi
  fi
fi

# ── LLM Provider Selection ──
echo ""
echo -e "  ${GREEN}🤖 LLM Provider${NC}"
echo "  1) Anthropic Claude (default — recommended)"
echo "  2) OpenAI"
echo "  3) OpenRouter"
echo "  4) Ollama (local, no API key needed)"
echo "  5) DeepSeek"
echo "  6) Google Gemini"
echo "  7) Mistral AI (EU-hosted, GDPR-compliant)"
echo "  8) Other OpenAI-compatible endpoint"
echo ""
SKIP_LLM=false
LLM_PROVIDER="${LLM_PROVIDER:-}"
if [ -n "$LLM_PROVIDER" ] && [[ "$LLM_PROVIDER" != "your_"* ]] && [ "$FORCE_FLAG" = "--force" ]; then
  # --force on existing install: ask before reconfiguring
  read -rp "  Change LLM provider? (current: ${LLM_PROVIDER}) (y/N): " CHANGE_LLM
  if [[ "${CHANGE_LLM,,}" =~ ^y ]]; then
    LLM_PROVIDER=""
    LLM_API_KEY=""
    LLM_MODEL=""
    LLM_BASE_URL=""
  else
    SKIP_LLM=true
  fi
fi
if [ -z "$LLM_PROVIDER" ] || [[ "$LLM_PROVIDER" == "your_"* ]]; then
  read -rp "  Choose provider [1]: " LLM_CHOICE
  LLM_CHOICE="${LLM_CHOICE:-1}"
  case "$LLM_CHOICE" in
    1) LLM_PROVIDER="anthropic" ;;
    2) LLM_PROVIDER="openai" ;;
    3) LLM_PROVIDER="openrouter" ;;
    4) LLM_PROVIDER="ollama" ;;
    5) LLM_PROVIDER="deepseek" ;;
    6) LLM_PROVIDER="gemini" ;;
    7) LLM_PROVIDER="mistral" ;;
    8) LLM_PROVIDER="openai_compatible" ;;
    *) LLM_PROVIDER="anthropic" ;;
  esac
fi

if [ "$SKIP_LLM" = "false" ]; then
  set_env LLM_PROVIDER "$LLM_PROVIDER"

  # Provider-specific prompts
  case "$LLM_PROVIDER" in
    anthropic)
      ask "ANTHROPIC_API_KEY" "Anthropic API Key (from console.anthropic.com)" "" 1
      LLM_API_KEY="$ANTHROPIC_API_KEY"
      LLM_MODEL="${LLM_MODEL:-claude-sonnet-4-6}"
      ;;
    openai)
      if [ -z "$LLM_API_KEY" ] || [[ "$LLM_API_KEY" == "your_"* ]]; then
        ask "LLM_API_KEY" "OpenAI API Key (from platform.openai.com)" "" 1
      fi
      LLM_MODEL="${LLM_MODEL:-gpt-5.4}"
      # Reuse as OPENAI_API_KEY for vision/transcription too
      OPENAI_API_KEY="$LLM_API_KEY"
      set_env OPENAI_API_KEY "$OPENAI_API_KEY"
      ;;
    openrouter)
      if [ -z "$LLM_API_KEY" ] || [[ "$LLM_API_KEY" == "your_"* ]]; then
        ask "LLM_API_KEY" "OpenRouter API Key (from openrouter.ai/keys)" "" 1
      fi
      LLM_MODEL="${LLM_MODEL:-anthropic/claude-sonnet-4.6}"
      ;;
    ollama)
      if [ -z "$LLM_BASE_URL" ] || [[ "$LLM_BASE_URL" == "your_"* ]]; then
        # Detect OS for Docker networking default
        if [[ "$(uname -s)" == "Linux" ]]; then
          OLLAMA_DEFAULT="http://172.17.0.1:11434"
        else
          OLLAMA_DEFAULT="http://host.docker.internal:11434"
        fi
        read -rp "  Ollama Base URL [${OLLAMA_DEFAULT}]: " LLM_BASE_URL_INPUT
        LLM_BASE_URL="${LLM_BASE_URL_INPUT:-$OLLAMA_DEFAULT}"
      fi
      LLM_API_KEY="${LLM_API_KEY:-ollama}"
      read -rp "  Model name [glm-4.7-flash]: " LLM_MODEL_INPUT
      LLM_MODEL="${LLM_MODEL_INPUT:-glm-4.7-flash}"
      ;;
    deepseek)
      if [ -z "$LLM_API_KEY" ] || [[ "$LLM_API_KEY" == "your_"* ]]; then
        ask "LLM_API_KEY" "DeepSeek API Key (from platform.deepseek.com)" "" 1
      fi
      LLM_MODEL="${LLM_MODEL:-deepseek-chat}"
      ;;
    gemini)
      if [ -z "$LLM_API_KEY" ] || [[ "$LLM_API_KEY" == "your_"* ]]; then
        ask "LLM_API_KEY" "Google Gemini API Key (from aistudio.google.com)" "" 1
      fi
      LLM_MODEL="${LLM_MODEL:-gemini-3-flash-preview}"
      ;;
    mistral)
      if [ -z "$LLM_API_KEY" ] || [[ "$LLM_API_KEY" == "your_"* ]]; then
        ask "LLM_API_KEY" "Mistral API Key (from console.mistral.ai)" "" 1
      fi
      LLM_MODEL="${LLM_MODEL:-mistral-large-latest}"
      ;;
    openai_compatible)
      if [ -z "$LLM_BASE_URL" ] || [[ "$LLM_BASE_URL" == "your_"* ]]; then
        read -rp "  Base URL (e.g. http://localhost:8080/v1): " LLM_BASE_URL
      fi
      read -rp "  API Key (Enter to skip if not needed): " LLM_API_KEY_INPUT
      LLM_API_KEY="${LLM_API_KEY_INPUT:-not-needed}"
      read -rp "  Model name: " LLM_MODEL
      ;;
  esac
  set_env LLM_API_KEY "$LLM_API_KEY"
  set_env LLM_MODEL "$LLM_MODEL"
  [ -n "$LLM_BASE_URL" ] && set_env LLM_BASE_URL "$LLM_BASE_URL"
  echo -e "  ${GREEN}✅ LLM: ${LLM_PROVIDER} / ${LLM_MODEL}${NC}"
else
  echo -e "  ${GREEN}✅ LLM: ${LLM_PROVIDER} / ${LLM_MODEL} (unchanged)${NC}"
fi

# LLM credential name + type (for workflow node patching + credential patching)
case "${LLM_PROVIDER:-anthropic}" in
  anthropic)         LLM_CRED_NAME="Anthropic API";      LLM_CRED_TYPE="anthropicApi" ;;
  openai)            LLM_CRED_NAME="OpenAI API";         LLM_CRED_TYPE="openAiApi" ;;
  openrouter)        LLM_CRED_NAME="OpenRouter API";     LLM_CRED_TYPE="openRouterApi" ;;
  ollama)            LLM_CRED_NAME="Ollama";             LLM_CRED_TYPE="ollamaApi" ;;
  deepseek)          LLM_CRED_NAME="DeepSeek API";       LLM_CRED_TYPE="deepSeekApi" ;;
  gemini)            LLM_CRED_NAME="Google Gemini API";  LLM_CRED_TYPE="googlePalmApi" ;;
  mistral)           LLM_CRED_NAME="Mistral API";        LLM_CRED_TYPE="mistralCloudApi" ;;
  openai_compatible) LLM_CRED_NAME="LLM API";            LLM_CRED_TYPE="openAiApi" ;;
esac

# OpenAI is optional (for vision + voice) — skip if already set above (OpenAI provider)
if [ "$LLM_PROVIDER" != "openai" ]; then
  if [ -z "$OPENAI_API_KEY" ] || [[ "$OPENAI_API_KEY" == "your_"* ]]; then
    read -rsp "  OpenAI API Key (optional — voice + photo analysis, Enter to skip): " OPENAI_API_KEY_INPUT; echo
    if [ -n "$OPENAI_API_KEY_INPUT" ]; then
      OPENAI_API_KEY="$OPENAI_API_KEY_INPUT"
      set_env OPENAI_API_KEY "$OPENAI_API_KEY"
    fi
  fi
fi
echo ""
echo -e "  ${YELLOW}Optional: Domain for HTTPS (required for Telegram webhooks)${NC}"
echo "  Leave empty to skip (you can set up HTTPS later)"
ask "DOMAIN" "Domain name (e.g. n8n.yourdomain.com, or press Enter to skip)" "" 0
_load_env

# Ask about external reverse proxy (only if domain is set)
if [ -n "$DOMAIN" ] && [[ "$DOMAIN" != "your_"* ]] && [ -z "$SKIP_REVERSE_PROXY" ]; then
  echo ""
  echo -e "  ${YELLOW}Do you already have a reverse proxy (e.g. Caddy, Traefik, nginx)${NC}"
  echo -e "  ${YELLOW}handling HTTPS for ${DOMAIN}?${NC}"
  read -rp "  Skip nginx + Let's Encrypt installation? (y/N): " skip_rp
  if [[ "$skip_rp" =~ ^[Yy] ]]; then
    set_env "SKIP_REVERSE_PROXY" "true"
  else
    set_env "SKIP_REVERSE_PROXY" "false"
  fi
  _load_env
fi
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
echo "  Building local services..."
docker compose build --no-cache 2>&1 | tail -5
POSTGRES_PASSWORD=$POSTGRES_PASSWORD \
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET \
N8N_ENCRYPTION_KEY=$N8N_ENCRYPTION_KEY \
N8N_HOST=${N8N_HOST:-localhost} \
N8N_PROTOCOL=${N8N_PROTOCOL:-http} \
N8N_WEBHOOK_URL=${N8N_WEBHOOK_URL:-http://localhost:5678} \
TIMEZONE=${TIMEZONE:-UTC} \
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
if [ -n "$DOMAIN" ] && [[ "$DOMAIN" != "your_"* ]] && [ "$SKIP_REVERSE_PROXY" != "true" ]; then
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
  set_env "N8N_URL" "https://${DOMAIN}"
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
elif [ -n "$DOMAIN" ] && [[ "$DOMAIN" != "your_"* ]] && [ "$SKIP_REVERSE_PROXY" = "true" ]; then
  echo -e "\n${GREEN}🔒 Using external reverse proxy for ${DOMAIN}${NC}"
  echo "  Skipping nginx + Let's Encrypt (handled by your reverse proxy)"

  # Configure n8n for HTTPS (proxy terminates TLS externally)
  set_env "N8N_URL" "https://${DOMAIN}"
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

  echo -e "  ${GREEN}✅ n8n configured for https://${DOMAIN} (external proxy)${NC}"
  N8N_ACCESS_URL="https://${DOMAIN}"
else
  echo -e "\n${YELLOW}⚠️  No domain configured — running on HTTP${NC}"
  echo "  Telegram webhooks require HTTPS. Add a domain later and re-run setup.sh"
fi

# ── 9. Apply DB schema ───────────────────────────────────────
echo -e "\n${GREEN}🗄️  Applying database schema...${NC}"
SCHEMA_OUTPUT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/001_schema.sql 2>&1)
SCHEMA_ERRORS=$(echo "$SCHEMA_OUTPUT" | grep -i "error" | head -5)
if [ -n "$SCHEMA_ERRORS" ]; then
  echo -e "  ${YELLOW}⚠️  Schema warnings:${NC}"
  echo "$SCHEMA_ERRORS" | while read line; do echo "    $line"; done
fi
echo "  ✅ Schema applied"

# Apply OAuth support migration
echo "  Applying OAuth migration..."
OAUTH_OUTPUT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/003_oauth_support.sql 2>&1)
OAUTH_ERRORS=$(echo "$OAUTH_OUTPUT" | grep -i "error" | head -5)
if [ -n "$OAUTH_ERRORS" ]; then
  echo -e "  ${YELLOW}⚠️  OAuth migration warnings:${NC}"
  echo "$OAUTH_ERRORS" | while read line; do echo "    $line"; done
fi
echo "  ✅ OAuth migration applied"

echo "  Applying Knowledge System migration..."
KNOWLEDGE_OUTPUT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/004_knowledge.sql 2>&1)
KNOWLEDGE_ERRORS=$(echo "$KNOWLEDGE_OUTPUT" | grep -i "error" | head -5)
if [ -n "$KNOWLEDGE_ERRORS" ]; then
  echo -e "  ${YELLOW}⚠️  Knowledge migration warnings:${NC}"
  echo "$KNOWLEDGE_ERRORS" | while read line; do echo "    $line"; done
fi
echo "  ✅ Knowledge system tables applied"

echo "  Applying Hybrid Search migration..."
HYBRID_OUTPUT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/005_hybrid_search.sql 2>&1)
HYBRID_ERRORS=$(echo "$HYBRID_OUTPUT" | grep -i "error" | head -5)
if [ -n "$HYBRID_ERRORS" ]; then
  echo -e "  ${YELLOW}⚠️  Hybrid search migration warnings:${NC}"
  echo "$HYBRID_ERRORS" | while read line; do echo "    $line"; done
fi
echo "  ✅ Hybrid search applied"

echo "  Applying MCP Bridge migration..."
BRIDGE_OUTPUT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres \
  -f supabase/migrations/006_mcp_bridge.sql 2>&1)
BRIDGE_ERRORS=$(echo "$BRIDGE_OUTPUT" | grep -i "error" | head -5)
if [ -n "$BRIDGE_ERRORS" ]; then
  echo -e "  ${YELLOW}⚠️  MCP Bridge migration warnings:${NC}"
  echo "$BRIDGE_ERRORS" | while read line; do echo "    $line"; done
fi
echo "  ✅ MCP Bridge applied"

# Reload PostgREST schema cache so new tables are immediately available via API
docker kill --signal=SIGUSR1 $(docker ps -q --filter name=rest) 2>/dev/null || true

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
# Wait for credentials endpoint too (may lag behind workflows after restart)
for i in {1..10}; do
  CRED_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    "${N8N_BASE}/api/v1/credentials" 2>/dev/null)
  [ "$CRED_CHECK" = "200" ] && break
  sleep 2
done

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

# CLI import fallback — bypasses n8n Public API schema validation bug
# (API rejects valid Anthropic/Postgres/OpenAI credentials due to overly strict allOf validation)
import_cred() {
  local cred_id="cred-$(head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  local json
  json=$(python3 -c "
import json, sys
print(json.dumps([{'id': sys.argv[1], 'name': sys.argv[2], 'type': sys.argv[3], 'data': json.loads(sys.argv[4])}]))
" "$cred_id" "$1" "$2" "$3" 2>/dev/null)
  [ -z "$json" ] && return 1
  echo "$json" | docker compose exec -T n8n sh -c "cat > /tmp/_cred.json && n8n import:credentials --input=/tmp/_cred.json && rm -f /tmp/_cred.json" > /dev/null 2>&1
  if [ $? -eq 0 ]; then
    echo "$cred_id"
  fi
}

# Update existing credential data (PATCH)
update_cred() {
  local cred_id="$1" cred_name="$2" cred_type="$3" cred_data="$4"
  curl -s -X PATCH "${N8N_BASE}/api/v1/credentials/${cred_id}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${cred_name}\",\"type\":\"${cred_type}\",\"data\":${cred_data}}" > /dev/null 2>&1
}

# Check if credentials already exist before creating
EXISTING_CREDS=$(curl -s "${N8N_BASE}/api/v1/credentials" -H "X-N8N-API-KEY: ${N8N_API_KEY}")
EXISTING_TELEGRAM_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='telegramApi': print(c['id']); break
" 2>/dev/null)
EXISTING_POSTGRES_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='postgres': print(c['id']); break
" 2>/dev/null)
EXISTING_OPENAI_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='openAiApi': print(c['id']); break
" 2>/dev/null)
EXISTING_ANTHROPIC_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='anthropicApi': print(c['id']); break
" 2>/dev/null)
EXISTING_HEADERAUTH_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='httpHeaderAuth': print(c['id']); break
" 2>/dev/null)
EXISTING_SLACK_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='slackApi': print(c['id']); break
" 2>/dev/null)
# LLM credential — provider-dependent
LLM_CRED_ID=""
case "${LLM_PROVIDER:-anthropic}" in
  anthropic)
    if [ -n "$EXISTING_ANTHROPIC_ID" ]; then
      ANTHROPIC_CRED_ID="$EXISTING_ANTHROPIC_ID"
      LLM_CRED_ID="$ANTHROPIC_CRED_ID"
      if [ -n "$ANTHROPIC_API_KEY" ] && [[ "$ANTHROPIC_API_KEY" != "your_"* ]]; then
        update_cred "$ANTHROPIC_CRED_ID" "Anthropic API" "anthropicApi" "{\"apiKey\":\"${ANTHROPIC_API_KEY}\"}"
      fi
      echo "  ✅ Anthropic API → ${ANTHROPIC_CRED_ID} (existing, updated)"
    elif [ -n "$ANTHROPIC_API_KEY" ] && [[ "$ANTHROPIC_API_KEY" != "your_"* ]]; then
      ANTHROPIC_CRED_ID=$(create_cred "Anthropic API" "anthropicApi" "{\"apiKey\":\"${ANTHROPIC_API_KEY}\"}")
      if [ -z "$ANTHROPIC_CRED_ID" ]; then
        ANTHROPIC_CRED_ID=$(import_cred "Anthropic API" "anthropicApi" "{\"apiKey\":\"${ANTHROPIC_API_KEY}\"}")
      fi
      LLM_CRED_ID="$ANTHROPIC_CRED_ID"
      [ -z "$ANTHROPIC_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Anthropic credential failed — add manually in n8n UI${NC}" || echo "  ✅ Anthropic API → ${ANTHROPIC_CRED_ID} (created)"
    fi
    ;;
  openai)
    # OpenAI as LLM — credential created below in the OpenAI section (shared with vision)
    echo "  ℹ️  OpenAI credential will be created below (shared with vision/voice)"
    ;;
  openrouter)
    EXISTING_OPENROUTER_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='openRouterApi': print(c['id']); break
" 2>/dev/null)
    if [ -n "$EXISTING_OPENROUTER_ID" ]; then
      LLM_CRED_ID="$EXISTING_OPENROUTER_ID"
      update_cred "$LLM_CRED_ID" "OpenRouter API" "openRouterApi" "{\"apiKey\":\"${LLM_API_KEY}\"}"
      echo "  ✅ OpenRouter API → ${LLM_CRED_ID} (existing, updated)"
    else
      LLM_CRED_ID=$(create_cred "OpenRouter API" "openRouterApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      if [ -z "$LLM_CRED_ID" ]; then
        LLM_CRED_ID=$(import_cred "OpenRouter API" "openRouterApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      fi
      [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  OpenRouter credential failed — add manually in n8n UI${NC}" || echo "  ✅ OpenRouter API → ${LLM_CRED_ID} (created)"
    fi
    ;;
  ollama)
    EXISTING_OLLAMA_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='ollamaApi': print(c['id']); break
" 2>/dev/null)
    if [ -n "$EXISTING_OLLAMA_ID" ]; then
      LLM_CRED_ID="$EXISTING_OLLAMA_ID"
      update_cred "$LLM_CRED_ID" "Ollama" "ollamaApi" "{\"baseUrl\":\"${LLM_BASE_URL}\"}"
      echo "  ✅ Ollama → ${LLM_CRED_ID} (existing, updated)"
    else
      LLM_CRED_ID=$(create_cred "Ollama" "ollamaApi" "{\"baseUrl\":\"${LLM_BASE_URL}\"}")
      if [ -z "$LLM_CRED_ID" ]; then
        LLM_CRED_ID=$(import_cred "Ollama" "ollamaApi" "{\"baseUrl\":\"${LLM_BASE_URL}\"}")
      fi
      [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Ollama credential failed — add manually in n8n UI${NC}" || echo "  ✅ Ollama → ${LLM_CRED_ID} (created)"
    fi
    ;;
  deepseek)
    EXISTING_DEEPSEEK_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='deepSeekApi': print(c['id']); break
" 2>/dev/null)
    if [ -n "$EXISTING_DEEPSEEK_ID" ]; then
      LLM_CRED_ID="$EXISTING_DEEPSEEK_ID"
      update_cred "$LLM_CRED_ID" "DeepSeek API" "deepSeekApi" "{\"apiKey\":\"${LLM_API_KEY}\"}"
      echo "  ✅ DeepSeek API → ${LLM_CRED_ID} (existing, updated)"
    else
      LLM_CRED_ID=$(create_cred "DeepSeek API" "deepSeekApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      if [ -z "$LLM_CRED_ID" ]; then
        LLM_CRED_ID=$(import_cred "DeepSeek API" "deepSeekApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      fi
      [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  DeepSeek credential failed — add manually in n8n UI${NC}" || echo "  ✅ DeepSeek API → ${LLM_CRED_ID} (created)"
    fi
    ;;
  gemini)
    EXISTING_GEMINI_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='googlePalmApi': print(c['id']); break
" 2>/dev/null)
    if [ -n "$EXISTING_GEMINI_ID" ]; then
      LLM_CRED_ID="$EXISTING_GEMINI_ID"
      update_cred "$LLM_CRED_ID" "Google Gemini API" "googlePalmApi" "{\"apiKey\":\"${LLM_API_KEY}\"}"
      echo "  ✅ Google Gemini API → ${LLM_CRED_ID} (existing, updated)"
    else
      LLM_CRED_ID=$(create_cred "Google Gemini API" "googlePalmApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      if [ -z "$LLM_CRED_ID" ]; then
        LLM_CRED_ID=$(import_cred "Google Gemini API" "googlePalmApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      fi
      [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Google Gemini credential failed — add manually in n8n UI${NC}" || echo "  ✅ Google Gemini API → ${LLM_CRED_ID} (created)"
    fi
    ;;
  mistral)
    EXISTING_MISTRAL_ID=$(echo "$EXISTING_CREDS" | python3 -c "
import sys,json
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')=='mistralCloudApi': print(c['id']); break
" 2>/dev/null)
    if [ -n "$EXISTING_MISTRAL_ID" ]; then
      LLM_CRED_ID="$EXISTING_MISTRAL_ID"
      update_cred "$LLM_CRED_ID" "Mistral API" "mistralCloudApi" "{\"apiKey\":\"${LLM_API_KEY}\"}"
      echo "  ✅ Mistral API → ${LLM_CRED_ID} (existing, updated)"
    else
      LLM_CRED_ID=$(create_cred "Mistral API" "mistralCloudApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      if [ -z "$LLM_CRED_ID" ]; then
        LLM_CRED_ID=$(import_cred "Mistral API" "mistralCloudApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
      fi
      [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Mistral credential failed — add manually in n8n UI${NC}" || echo "  ✅ Mistral API → ${LLM_CRED_ID} (created)"
    fi
    ;;
  openai_compatible)
    # Uses openAiApi credential type with a distinct name
    LLM_CRED_ID=$(create_cred "LLM API" "openAiApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
    if [ -z "$LLM_CRED_ID" ]; then
      LLM_CRED_ID=$(import_cred "LLM API" "openAiApi" "{\"apiKey\":\"${LLM_API_KEY}\"}")
    fi
    [ -z "$LLM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  LLM credential failed — add manually in n8n UI${NC}" || echo "  ✅ LLM API → ${LLM_CRED_ID} (created)"
    ;;
esac

if [ -n "$EXISTING_TELEGRAM_ID" ]; then
  TELEGRAM_CRED_ID="$EXISTING_TELEGRAM_ID"
  update_cred "$TELEGRAM_CRED_ID" "Telegram Bot" "telegramApi" "{\"accessToken\":\"${TELEGRAM_BOT_TOKEN}\"}"
  echo "  ✅ Telegram Bot → ${TELEGRAM_CRED_ID} (existing, updated)"
else
  TELEGRAM_CRED_ID=$(create_cred "Telegram Bot" "telegramApi" "{\"accessToken\":\"${TELEGRAM_BOT_TOKEN}\"}")
  [ -z "$TELEGRAM_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Telegram credential failed — will patch from existing${NC}" || echo "  ✅ Telegram Bot → ${TELEGRAM_CRED_ID} (created)"
fi

if [ -n "$EXISTING_POSTGRES_ID" ]; then
  POSTGRES_CRED_ID="$EXISTING_POSTGRES_ID"
  echo "  ✅ Supabase Postgres → ${POSTGRES_CRED_ID} (existing)"
else
  # Postgres: try API first, then CLI import fallback
  PG_DATA="{\"host\":\"db\",\"database\":\"postgres\",\"user\":\"postgres\",\"password\":\"${POSTGRES_PASSWORD}\",\"port\":5432,\"ssl\":\"disable\",\"allowUnauthorizedCerts\":false,\"sshTunnel\":false,\"sshAuthenticateWith\":\"password\"}"
  POSTGRES_CRED_ID=$(create_cred "Supabase Postgres" "postgres" "$PG_DATA")
  if [ -z "$POSTGRES_CRED_ID" ]; then
    POSTGRES_CRED_ID=$(import_cred "Supabase Postgres" "postgres" "$PG_DATA")
  fi
  if [ -z "$POSTGRES_CRED_ID" ]; then
    echo -e "  ${YELLOW}⚠️  Postgres credential — add manually:${NC}"
    echo "     Host: db | DB: postgres | User: postgres | Pass: ${POSTGRES_PASSWORD} | SSL: disable"
    POSTGRES_CRED_ID="REPLACE_WITH_YOUR_CREDENTIAL_ID"
  else
    echo "  ✅ Supabase Postgres → ${POSTGRES_CRED_ID} (created)"
  fi
fi

# OpenAI credential (optional — for voice transcription)
OPENAI_CRED_ID=""
if [ -n "$OPENAI_API_KEY" ] && [[ "$OPENAI_API_KEY" != "your_"* ]]; then
  if [ -n "$EXISTING_OPENAI_ID" ]; then
    OPENAI_CRED_ID="$EXISTING_OPENAI_ID"
    update_cred "$OPENAI_CRED_ID" "OpenAI API" "openAiApi" "{\"apiKey\":\"${OPENAI_API_KEY}\"}"
    echo "  ✅ OpenAI API → ${OPENAI_CRED_ID} (existing, updated)"
  else
    OPENAI_CRED_ID=$(create_cred "OpenAI API" "openAiApi" "{\"apiKey\":\"${OPENAI_API_KEY}\"}")
    if [ -z "$OPENAI_CRED_ID" ]; then
      OPENAI_CRED_ID=$(import_cred "OpenAI API" "openAiApi" "{\"apiKey\":\"${OPENAI_API_KEY}\"}")
    fi
    [ -z "$OPENAI_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  OpenAI credential failed — voice transcription won't work${NC}" || echo "  ✅ OpenAI API → ${OPENAI_CRED_ID} (created)"
  fi
else
  echo -e "  ${YELLOW}ℹ️  OpenAI API Key not set — voice transcription disabled${NC}"
fi

# If LLM provider is OpenAI, reuse OpenAI credential as LLM credential
if [ "${LLM_PROVIDER:-}" = "openai" ] && [ -n "$OPENAI_CRED_ID" ]; then
  LLM_CRED_ID="$OPENAI_CRED_ID"
fi

# Webhook Auth credential (for webhook API authentication)
HEADERAUTH_CRED_ID=""
if [ -n "$EXISTING_HEADERAUTH_ID" ]; then
  HEADERAUTH_CRED_ID="$EXISTING_HEADERAUTH_ID"
  echo "  ✅ Webhook Auth → ${HEADERAUTH_CRED_ID} (existing)"
else
  HEADERAUTH_CRED_ID=$(create_cred "Webhook Auth" "httpHeaderAuth" "{\"name\":\"X-API-Key\",\"value\":\"${WEBHOOK_SECRET}\"}")
  [ -z "$HEADERAUTH_CRED_ID" ] && echo -e "  ${YELLOW}⚠️  Webhook Auth credential failed — create manually in n8n UI${NC}" || echo "  ✅ Webhook Auth → ${HEADERAUTH_CRED_ID} (created)"
fi

fi  # end INSTALL_MODE guard for credentials
set -e
# (pg-cred.json no longer created — CLI import writes directly into container)

# ── Paperclip integration (optional, before workflow import) ──
# Must run before sed replaces {{PAPERCLIP_*}} placeholders in workflows
if [ "$INSTALL_MODE" != "update" ] || [ "$FORCE_FLAG" = "--force" ]; then
  # Load existing values from .env (may already be set from previous run)
  PAPERCLIP_INTERNAL_URL=$(grep '^PAPERCLIP_INTERNAL_URL=' .env 2>/dev/null | cut -d= -f2-)
  PAPERCLIP_AGENT_KEY=$(grep '^PAPERCLIP_AGENT_KEY=' .env 2>/dev/null | cut -d= -f2-)
  if [ -n "$PAPERCLIP_INTERNAL_URL" ] && [ -n "$PAPERCLIP_AGENT_KEY" ]; then
    echo -e "\n${GREEN}🧷 Paperclip: Using existing config (${PAPERCLIP_INTERNAL_URL})${NC}"
    read -rp "  Reconfigure? (y/N): " PAPERCLIP_RECONFIG
    if [[ ! "$PAPERCLIP_RECONFIG" =~ ^[Yy]$ ]]; then
      echo -e "  ${GREEN}✅ Keeping current Paperclip config${NC}"
    else
      read -rp "  Paperclip internal URL [${PAPERCLIP_INTERNAL_URL}]: " PAPERCLIP_INTERNAL_URL_INPUT
      PAPERCLIP_INTERNAL_URL="${PAPERCLIP_INTERNAL_URL_INPUT:-$PAPERCLIP_INTERNAL_URL}"
      set_env PAPERCLIP_INTERNAL_URL "$PAPERCLIP_INTERNAL_URL"
      read -rp "  Paperclip Agent API Key: " PAPERCLIP_AGENT_KEY_INPUT
      if [ -n "$PAPERCLIP_AGENT_KEY_INPUT" ]; then
        PAPERCLIP_AGENT_KEY="$PAPERCLIP_AGENT_KEY_INPUT"
        set_env PAPERCLIP_AGENT_KEY "$PAPERCLIP_AGENT_KEY"
      fi
      echo -e "  ${GREEN}✅ Paperclip integration updated${NC}"
    fi
  else
    echo ""
    read -rp "🧷 Connect Paperclip agent orchestration? (y/N): " PAPERCLIP_ENABLE
    if [[ "$PAPERCLIP_ENABLE" =~ ^[Yy]$ ]]; then
      read -rp "  Paperclip internal URL [http://paperclip:3100]: " PAPERCLIP_INTERNAL_URL_INPUT
      PAPERCLIP_INTERNAL_URL="${PAPERCLIP_INTERNAL_URL_INPUT:-http://paperclip:3100}"
      set_env PAPERCLIP_INTERNAL_URL "$PAPERCLIP_INTERNAL_URL"
      read -rp "  Paperclip Agent API Key: " PAPERCLIP_AGENT_KEY_INPUT
      if [ -n "$PAPERCLIP_AGENT_KEY_INPUT" ]; then
        PAPERCLIP_AGENT_KEY="$PAPERCLIP_AGENT_KEY_INPUT"
        set_env PAPERCLIP_AGENT_KEY "$PAPERCLIP_AGENT_KEY"
        echo -e "  ${GREEN}✅ Paperclip integration configured${NC}"
      else
        echo -e "  ⏭️  Skipped — no API key provided"
      fi
    fi
  fi
fi

# ── 11. Prepare + import workflows ──────────────────────────

# Extract credential form webhookId from workflow JSON (used by Library Manager)
CREDENTIAL_FORM_WEBHOOK_ID=$(python3 -c "
import json
wf = json.load(open('workflows/credential-form.json'))
for n in wf.get('nodes', []):
    if n.get('webhookId'):
        print(n['webhookId'])
        break
" 2>/dev/null || echo "")

declare -A WF_IDS
if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo -e "\n${GREEN}📦 Skipping workflow import (update mode — use --force to reimport)${NC}"

  # Import NEW workflows that don't exist yet on the instance
  echo "  Checking for new workflows..."
  mkdir -p workflows/deployed
  EXISTING_WF_NAMES=$(curl -s "${N8N_BASE}/api/v1/workflows?limit=100" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" | python3 -c "
import json,sys
data = json.load(sys.stdin)
for wf in data.get('data', []):
    print(wf['name'])
" 2>/dev/null)

  for f in workflows/*.json workflows/adapters/*.json; do
    [ -f "$f" ] || continue
    wf_name=$(python3 -c "import json; print(json.load(open('$f')).get('name','?'))" 2>/dev/null)

    # Skip if workflow already exists on instance
    if echo "$EXISTING_WF_NAMES" | grep -qF "$wf_name"; then
      continue
    fi

    # New workflow found — prepare and import
    echo -e "  ${CYAN}📥 New workflow: ${wf_name}${NC}"
    out="workflows/deployed/$(basename $f)"
    cp "$f" "$out"
    sed -i \
      -e "s|{{N8N_URL}}|${N8N_URL:-http://localhost:5678}|g" \
      -e "s|{{N8N_INTERNAL_URL}}|http://172.17.0.1:5678|g" \
      -e "s|{{N8N_API_KEY}}|${N8N_API_KEY}|g" \
      -e "s|{{SUPABASE_URL}}|http://kong:8000|g" \
      -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
      -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
      -e "s|{{TELEGRAM_CHAT_ID}}|${TELEGRAM_CHAT_ID}|g" \
      -e "s|{{CREDENTIAL_FORM_WEBHOOK_ID}}|${CREDENTIAL_FORM_WEBHOOK_ID}|g" \
      -e "s|{{WEBHOOK_SECRET}}|${WEBHOOK_SECRET}|g" \
      -e "s|{{PAPERCLIP_INTERNAL_URL}}|${PAPERCLIP_INTERNAL_URL}|g" \
      -e "s|{{PAPERCLIP_AGENT_KEY}}|${PAPERCLIP_AGENT_KEY}|g" \
      -e "s|{{TELEGRAM_BOT_TOKEN}}|${TELEGRAM_BOT_TOKEN}|g" \
      "$out"

    # LLM node patch — replace lmChatAnthropic nodes with chosen provider
    if [ "${LLM_PROVIDER:-anthropic}" != "anthropic" ]; then
      python3 -c "
import json, sys
f = sys.argv[1]
provider = sys.argv[2]
model = sys.argv[3]
cred_name = sys.argv[4]
base_url = sys.argv[5] if len(sys.argv) > 5 else ''
with open(f) as fh:
    wf = json.load(fh)
PROVIDERS = {
    'openai': {'type': '@n8n/n8n-nodes-langchain.lmChatOpenAi', 'ver': 1.3, 'cred': 'openAiApi', 'model_key': 'model', 'tokens_key': 'maxTokens', 'use_rl': True, 'dn': 'OpenAI Chat Model'},
    'openrouter': {'type': '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 'ver': 1, 'cred': 'openRouterApi', 'model_key': 'model', 'tokens_key': 'maxTokens', 'use_rl': False, 'dn': 'OpenRouter Chat Model'},
    'ollama': {'type': '@n8n/n8n-nodes-langchain.lmChatOllama', 'ver': 1, 'cred': 'ollamaApi', 'model_key': 'model', 'tokens_key': 'numPredict', 'use_rl': False, 'dn': 'Ollama Chat Model'},
    'deepseek': {'type': '@n8n/n8n-nodes-langchain.lmChatDeepSeek', 'ver': 1, 'cred': 'deepSeekApi', 'model_key': 'model', 'tokens_key': 'maxTokens', 'use_rl': False, 'dn': 'DeepSeek Chat Model'},
    'gemini': {'type': '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 'ver': 1, 'cred': 'googlePalmApi', 'model_key': 'modelName', 'tokens_key': 'maxOutputTokens', 'use_rl': False, 'dn': 'Google Gemini Chat Model'},
    'mistral': {'type': '@n8n/n8n-nodes-langchain.lmChatMistralCloud', 'ver': 1, 'cred': 'mistralCloudApi', 'model_key': 'model', 'tokens_key': 'maxTokens', 'use_rl': False, 'dn': 'Mistral Cloud Chat Model'},
    'openai_compatible': {'type': '@n8n/n8n-nodes-langchain.lmChatOpenAi', 'ver': 1.3, 'cred': 'openAiApi', 'model_key': 'model', 'tokens_key': 'maxTokens', 'use_rl': True, 'dn': 'OpenAI Chat Model'},
}
if provider not in PROVIDERS:
    sys.exit(0)
cfg = PROVIDERS[provider]
changed = False
renames = {}
for node in wf.get('nodes', []):
    if node.get('type') != '@n8n/n8n-nodes-langchain.lmChatAnthropic':
        continue
    old_opts = node.get('parameters', {}).get('options', {})
    temp = old_opts.get('temperature')
    tokens = old_opts.get('maxTokensToSample')
    old_name = node['name']
    node['type'] = cfg['type']
    node['typeVersion'] = cfg['ver']
    # Rename nodes that reference Anthropic/Claude (but keep functional names like "Fix Model")
    if old_name in ('Claude', 'Anthropic Chat Model'):
        node['name'] = cfg['dn']
        renames[old_name] = cfg['dn']
    model_val = {'__rl': True, 'value': model, 'mode': 'id'} if cfg['use_rl'] else model
    params = {cfg['model_key']: model_val}
    if provider in ('openai', 'openai_compatible'):
        params['responsesApiEnabled'] = False
    opts = {}
    if tokens is not None: opts[cfg['tokens_key']] = tokens
    if temp is not None: opts['temperature'] = temp
    if base_url and provider == 'openai_compatible': opts['baseURL'] = base_url
    if opts: params['options'] = opts
    node['parameters'] = params
    node['credentials'] = {cfg['cred']: {'id': 'REPLACE_WITH_YOUR_CREDENTIAL_ID', 'name': cred_name}}
    changed = True
# Update connection references for renamed nodes
if renames:
    conns = wf.get('connections', {})
    updated_conns = {}
    for src, type_dict in conns.items():
        new_src = renames.get(src, src)
        new_type_dict = {}
        for conn_type, output_groups in type_dict.items():
            new_groups = []
            for group in output_groups:
                new_group = []
                for conn in group:
                    if isinstance(conn, dict) and conn.get('node') in renames:
                        conn = dict(conn, node=renames[conn['node']])
                    new_group.append(conn)
                new_groups.append(new_group)
            new_type_dict[conn_type] = new_groups
        updated_conns[new_src] = new_type_dict
    wf['connections'] = updated_conns
if changed:
    with open(f, 'w') as fh:
        json.dump(wf, fh, indent=2, ensure_ascii=False)
" "$out" "${LLM_PROVIDER}" "${LLM_MODEL}" "${LLM_CRED_NAME}" "${LLM_BASE_URL:-}"
    fi

    # Patch credential IDs
    python3 -c "
import json, sys
f = sys.argv[1]
mapping = {}
if sys.argv[2] and sys.argv[2] not in ('', 'ERR', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['telegramApi'] = sys.argv[2]
if sys.argv[3] and sys.argv[3] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['postgres'] = sys.argv[3]
if sys.argv[4] and sys.argv[4] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['anthropicApi'] = sys.argv[4]
if sys.argv[5] and sys.argv[5] not in ('',):
    mapping['openAiApi'] = sys.argv[5]
if len(sys.argv) > 6 and sys.argv[6] and sys.argv[6] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['httpHeaderAuth'] = sys.argv[6]
slack_id = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] else ''
llm_cred_id = sys.argv[8] if len(sys.argv) > 8 and sys.argv[8] else ''
llm_cred_type = sys.argv[9] if len(sys.argv) > 9 and sys.argv[9] else ''
if llm_cred_id and llm_cred_type:
    mapping[llm_cred_type] = llm_cred_id
with open(f) as fh:
    wf = json.load(fh)
for node in wf.get('nodes', []):
    for cred_type, cred_data in node.get('credentials', {}).items():
        if cred_type in mapping:
            cred_data['id'] = mapping[cred_type]
    # If Slack credential exists, patch + enable Slack nodes
    if slack_id:
        for sk in ('slackOAuth2Api', 'slackApi'):
            if sk in node.get('credentials', {}):
                node['credentials'][sk]['id'] = slack_id
                node.pop('disabled', None)
with open(f, 'w') as fh:
    json.dump(wf, fh, indent=2, ensure_ascii=False)
" "$out" "${TELEGRAM_CRED_ID:-}" "${POSTGRES_CRED_ID:-}" "${ANTHROPIC_CRED_ID:-}" "${OPENAI_CRED_ID:-}" "${HEADERAUTH_CRED_ID:-}" "${EXISTING_SLACK_ID:-}" "${LLM_CRED_ID:-}" "${LLM_CRED_TYPE:-}"

    resp=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @"$out")
    new_id=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [ -n "$new_id" ]; then
      echo -e "    ✅ Imported (ID: $new_id)"
    else
      echo -e "    ⚠️  Import failed"
    fi
  done

else
echo -e "\n${GREEN}📦 Importing workflows...${NC}"
mkdir -p workflows/deployed

for f in workflows/*.json workflows/adapters/*.json; do
  out="workflows/deployed/$(basename $f)"
  cp "$f" "$out"
  # Basic placeholder replacements
  sed -i \
    -e "s|{{N8N_URL}}|${N8N_URL:-http://localhost:5678}|g" \
    -e "s|{{N8N_INTERNAL_URL}}|http://172.17.0.1:5678|g" \
    -e "s|{{N8N_API_KEY}}|${N8N_API_KEY}|g" \
    -e "s|{{SUPABASE_URL}}|http://kong:8000|g" \
    -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
    -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
    -e "s|{{TELEGRAM_CHAT_ID}}|${TELEGRAM_CHAT_ID}|g" \
    -e "s|{{CREDENTIAL_FORM_WEBHOOK_ID}}|${CREDENTIAL_FORM_WEBHOOK_ID}|g" \
    -e "s|{{WEBHOOK_SECRET}}|${WEBHOOK_SECRET}|g" \
    -e "s|{{PAPERCLIP_INTERNAL_URL}}|${PAPERCLIP_INTERNAL_URL}|g" \
    -e "s|{{PAPERCLIP_AGENT_KEY}}|${PAPERCLIP_AGENT_KEY}|g" \
    -e "s|{{TELEGRAM_BOT_TOKEN}}|${TELEGRAM_BOT_TOKEN}|g" \
    "$out"
  # LLM node patch — replace lmChatAnthropic nodes with chosen provider
  if [ "${LLM_PROVIDER:-anthropic}" != "anthropic" ]; then
    python3 -c "
import json, sys
f = sys.argv[1]
provider = sys.argv[2]
model = sys.argv[3]
cred_name = sys.argv[4]
base_url = sys.argv[5] if len(sys.argv) > 5 else ''
with open(f) as fh:
    wf = json.load(fh)
PROVIDERS = {
    'openai': {
        'type': '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        'ver': 1.3,
        'cred': 'openAiApi',
        'model_key': 'model',
        'tokens_key': 'maxTokens',
        'use_rl': True,
        'dn': 'OpenAI Chat Model',
    },
    'openrouter': {
        'type': '@n8n/n8n-nodes-langchain.lmChatOpenRouter',
        'ver': 1,
        'cred': 'openRouterApi',
        'model_key': 'model',
        'tokens_key': 'maxTokens',
        'use_rl': False,
        'dn': 'OpenRouter Chat Model',
    },
    'ollama': {
        'type': '@n8n/n8n-nodes-langchain.lmChatOllama',
        'ver': 1,
        'cred': 'ollamaApi',
        'model_key': 'model',
        'tokens_key': 'numPredict',
        'use_rl': False,
        'dn': 'Ollama Chat Model',
    },
    'deepseek': {
        'type': '@n8n/n8n-nodes-langchain.lmChatDeepSeek',
        'ver': 1,
        'cred': 'deepSeekApi',
        'model_key': 'model',
        'tokens_key': 'maxTokens',
        'use_rl': False,
        'dn': 'DeepSeek Chat Model',
    },
    'gemini': {
        'type': '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
        'ver': 1,
        'cred': 'googlePalmApi',
        'model_key': 'modelName',
        'tokens_key': 'maxOutputTokens',
        'use_rl': False,
        'dn': 'Google Gemini Chat Model',
    },
    'mistral': {
        'type': '@n8n/n8n-nodes-langchain.lmChatMistralCloud',
        'ver': 1,
        'cred': 'mistralCloudApi',
        'model_key': 'model',
        'tokens_key': 'maxTokens',
        'use_rl': False,
        'dn': 'Mistral Cloud Chat Model',
    },
    'openai_compatible': {
        'type': '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        'ver': 1.3,
        'cred': 'openAiApi',
        'model_key': 'model',
        'tokens_key': 'maxTokens',
        'use_rl': True,
        'dn': 'OpenAI Chat Model',
    },
}
if provider not in PROVIDERS:
    sys.exit(0)
cfg = PROVIDERS[provider]
changed = False
renames = {}
for node in wf.get('nodes', []):
    if node.get('type') != '@n8n/n8n-nodes-langchain.lmChatAnthropic':
        continue
    old_opts = node.get('parameters', {}).get('options', {})
    temp = old_opts.get('temperature')
    tokens = old_opts.get('maxTokensToSample')
    old_name = node['name']
    node['type'] = cfg['type']
    node['typeVersion'] = cfg['ver']
    if old_name in ('Claude', 'Anthropic Chat Model'):
        node['name'] = cfg['dn']
        renames[old_name] = cfg['dn']
    # Build model value
    if cfg['use_rl']:
        model_val = {'__rl': True, 'value': model, 'mode': 'id'}
    else:
        model_val = model
    # Build parameters
    params = {cfg['model_key']: model_val}
    if provider in ('openai', 'openai_compatible'):
        params['responsesApiEnabled'] = False
    opts = {}
    if tokens is not None:
        opts[cfg['tokens_key']] = tokens
    if temp is not None:
        opts['temperature'] = temp
    if base_url and provider in ('openai_compatible',):
        opts['baseURL'] = base_url
    if opts:
        params['options'] = opts
    node['parameters'] = params
    node['credentials'] = {cfg['cred']: {'id': 'REPLACE_WITH_YOUR_CREDENTIAL_ID', 'name': cred_name}}
    changed = True
if renames:
    conns = wf.get('connections', {})
    updated_conns = {}
    for src, type_dict in conns.items():
        new_src = renames.get(src, src)
        new_type_dict = {}
        for conn_type, output_groups in type_dict.items():
            new_groups = []
            for group in output_groups:
                new_group = []
                for conn in group:
                    if isinstance(conn, dict) and conn.get('node') in renames:
                        conn = dict(conn, node=renames[conn['node']])
                    new_group.append(conn)
                new_groups.append(new_group)
            new_type_dict[conn_type] = new_groups
        updated_conns[new_src] = new_type_dict
    wf['connections'] = updated_conns
if changed:
    with open(f, 'w') as fh:
        json.dump(wf, fh, indent=2, ensure_ascii=False)
" "$out" "${LLM_PROVIDER}" "${LLM_MODEL}" "${LLM_CRED_NAME}" "${LLM_BASE_URL:-}"
  fi
  # Credential ID replacements — proper JSON manipulation (sed can't match
  # across line breaks, and "id"/"name" are on separate lines in the JSON)
  python3 -c "
import json, sys
f = sys.argv[1]
mapping = {}
if sys.argv[2] and sys.argv[2] not in ('', 'ERR', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['telegramApi'] = sys.argv[2]
if sys.argv[3] and sys.argv[3] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['postgres'] = sys.argv[3]
if sys.argv[4] and sys.argv[4] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['anthropicApi'] = sys.argv[4]
if sys.argv[5] and sys.argv[5] not in ('',):
    mapping['openAiApi'] = sys.argv[5]
if len(sys.argv) > 6 and sys.argv[6] and sys.argv[6] not in ('', 'REPLACE_WITH_YOUR_CREDENTIAL_ID'):
    mapping['httpHeaderAuth'] = sys.argv[6]
slack_id = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] else ''
llm_cred_id = sys.argv[8] if len(sys.argv) > 8 and sys.argv[8] else ''
llm_cred_type = sys.argv[9] if len(sys.argv) > 9 and sys.argv[9] else ''
if llm_cred_id and llm_cred_type:
    mapping[llm_cred_type] = llm_cred_id
with open(f) as fh:
    wf = json.load(fh)
for node in wf.get('nodes', []):
    for cred_type, cred_data in node.get('credentials', {}).items():
        if cred_type in mapping:
            cred_data['id'] = mapping[cred_type]
    # If Slack credential exists, patch + enable Slack nodes
    if slack_id:
        for sk in ('slackOAuth2Api', 'slackApi'):
            if sk in node.get('credentials', {}):
                node['credentials'][sk]['id'] = slack_id
                node.pop('disabled', None)
with open(f, 'w') as fh:
    json.dump(wf, fh, indent=2, ensure_ascii=False)
" "$out" "${TELEGRAM_CRED_ID:-}" "${POSTGRES_CRED_ID:-}" "${ANTHROPIC_CRED_ID:-}" "${OPENAI_CRED_ID:-}" "${HEADERAUTH_CRED_ID:-}" "${EXISTING_SLACK_ID:-}" "${LLM_CRED_ID:-}" "${LLM_CRED_TYPE:-}"
done
IMPORT_ORDER="error-notification mcp-client reminder-factory reminder-runner mcp-weather-example workflow-builder mcp-builder mcp-library-manager agent-library-manager sub-agent-runner credential-form oauth-callback memory-consolidation background-checker heartbeat webhook-adapter n8n-claw-agent"

# n8n Public API settings whitelist — the PUT endpoint rejects any settings
# field not in its OpenAPI schema (additionalProperties: false), even though
# the GET response may include extra fields like binaryMode, timeSavedMode.
# See: https://github.com/n8n-io/n8n/issues/19587
N8N_SETTINGS_WHITELIST="saveExecutionProgress,saveManualExecutions,saveDataErrorExecution,saveDataSuccessExecution,executionTimeout,errorWorkflow,timezone,executionOrder,callerPolicy,callerIds,timeSavedPerExecution,availableInMCP"

# Fetch existing workflows once (for upsert: update if exists, create if not)
EXISTING_WFS=$(curl -s "${N8N_BASE}/api/v1/workflows?limit=100" \
  -H "X-N8N-API-KEY: ${N8N_API_KEY}")

for name in $IMPORT_ORDER; do
  f="workflows/deployed/${name}.json"
  [ -f "$f" ] || continue
  wf_name=$(python3 -c "import json; print(json.load(open('$f')).get('name','?'))" 2>/dev/null)

  # Check if workflow with this name already exists
  existing_id=$(echo "$EXISTING_WFS" | python3 -c "
import json,sys
name = sys.argv[1]
data = json.load(sys.stdin)
for wf in data.get('data', []):
    if wf['name'] == name:
        print(wf['id']); break
" "$wf_name" 2>/dev/null)

  if [ -n "$existing_id" ]; then
    if [ "$FORCE_FLAG" = "--force" ]; then
      # FORCE: delete + re-create so n8n builds fresh credential-workflow
      # associations. PUT preserves existing associations but cannot create
      # new ones — so workflows that were first imported with invalid
      # credential IDs (placeholders) would never get credentials via PUT.
      curl -s -X DELETE "${N8N_BASE}/api/v1/workflows/${existing_id}" \
        -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null
      resp=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows" \
        -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
        -H "Content-Type: application/json" -d @"$f")
      wf_id=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
      if [ -z "$wf_id" ]; then
        err=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','unknown error'))" 2>/dev/null)
        echo -e "  ${RED}❌ ${wf_name}: ${err}${NC}"
      else
        WF_IDS[$name]=$wf_id
        echo "  ✅ ${wf_name} → ${wf_id} (re-created)"
      fi
    else
      # Normal update: PUT — preserves workflow ID and existing credential associations
      UPDATE_BODY=$(python3 -c "
import json, sys
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
wf = json.load(open(sys.argv[1]))
settings = {k: v for k, v in wf.get('settings', {}).items() if k in ALLOWED}
print(json.dumps({
    'name': wf['name'],
    'nodes': wf.get('nodes', []),
    'connections': wf.get('connections', {}),
    'settings': settings
}))
" "$f" 2>/dev/null)
      resp=$(curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${existing_id}" \
        -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
        -H "Content-Type: application/json" -d "$UPDATE_BODY")
      WF_IDS[$name]="$existing_id"
      echo "  ✅ ${wf_name} → ${existing_id} (updated)"
    fi
  else
    # CREATE new workflow (POST)
    resp=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @"$f")
    wf_id=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
    if [ -z "$wf_id" ]; then
      err=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','unknown error'))" 2>/dev/null)
      echo -e "  ${RED}❌ ${wf_name}: ${err}${NC}"
    else
      WF_IDS[$name]=$wf_id
      echo "  ✅ ${wf_name} → ${wf_id} (created)"
    fi
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
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
raw = sys.stdin.read()
replacements = {
  'REPLACE_REMINDER_FACTORY_ID': '${WF_IDS[reminder-factory]}',
  'REPLACE_WORKFLOW_BUILDER_ID': '${WF_IDS[workflow-builder]}',

  'REPLACE_MCP_BUILDER_ID':      '${WF_IDS[mcp-builder]}',
  'REPLACE_LIBRARY_MANAGER_ID':  '${WF_IDS[mcp-library-manager]}',
  'REPLACE_SUB_AGENT_RUNNER_ID': '${WF_IDS[sub-agent-runner]}',
  'REPLACE_AGENT_LIBRARY_MANAGER_ID': '${WF_IDS[agent-library-manager]}',
}
for placeholder, real_id in replacements.items():
    raw = raw.replace(placeholder, real_id)
wf = json.loads(raw)
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
settings = {k: v for k, v in wf.get('settings',{}).items() if k in ALLOWED}
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': settings}))
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
if '${OPENAI_CRED_ID}': raw = raw.replace('REPLACE_WITH_YOUR_OPENAI_CREDENTIAL_ID\", \"name\": \"OpenAI API\"', '${OPENAI_CRED_ID}\", \"name\": \"OpenAI API\"')
print(raw)
" 2>/dev/null)

    echo "${FINAL:-$PATCHED}" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${AGENT_WF_ID}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @- > /dev/null
    echo "  ✅ Reminder:        ${WF_IDS[reminder-factory]}"
    echo "  ✅ WorkflowBuilder: ${WF_IDS[workflow-builder]}"
    echo "  ✅ MCP Builder:     ${WF_IDS[mcp-builder]}"
    echo "  ✅ Library Manager: ${WF_IDS[mcp-library-manager]}"
    echo "  ✅ Sub-Agent Runner: ${WF_IDS[sub-agent-runner]}"
    echo "  ✅ Agent Library:   ${WF_IDS[agent-library-manager]}"
    [ -n "$REAL_TELEGRAM_ID" ]  && echo "  ✅ Telegram cred:   ${REAL_TELEGRAM_ID}"
    [ -n "$REAL_POSTGRES_ID" ]  && echo "  ✅ Postgres cred:   ${REAL_POSTGRES_ID}"
    [ -n "$REAL_ANTHROPIC_ID" ] && echo "  ✅ Anthropic cred:  ${REAL_ANTHROPIC_ID} (if already added)"
  fi
fi
# ── 11b. Patch Agent workflow ID in Reminder Runner ──────────
REMINDER_RUNNER_WF_ID=${WF_IDS['reminder-runner']}
AGENT_WF_ID_FOR_RUNNER=${WF_IDS['n8n-claw-agent']}
if [ -n "$REMINDER_RUNNER_WF_ID" ] && [ -n "$AGENT_WF_ID_FOR_RUNNER" ]; then
  RUNNER_JSON=$(curl -s "${N8N_BASE}/api/v1/workflows/${REMINDER_RUNNER_WF_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}")

  PATCHED_RUNNER=$(echo "$RUNNER_JSON" | python3 -c "
import sys, json
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
raw = sys.stdin.read()
raw = raw.replace('REPLACE_AGENT_WORKFLOW_ID', '${AGENT_WF_ID_FOR_RUNNER}')
wf = json.loads(raw)
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
settings = {k: v for k, v in wf.get('settings',{}).items() if k in ALLOWED}
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': settings}))
" 2>/dev/null)

  if [ -n "$PATCHED_RUNNER" ]; then
    echo "$PATCHED_RUNNER" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${REMINDER_RUNNER_WF_ID}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @- > /dev/null
    echo "  ✅ Reminder Runner → Agent: ${AGENT_WF_ID_FOR_RUNNER}"
  fi
fi
# ── 11c. Patch Agent workflow ID in Heartbeat ──────────────────
HEARTBEAT_WF_ID=${WF_IDS['heartbeat']}
AGENT_WF_ID_FOR_HB=${WF_IDS['n8n-claw-agent']}
if [ -n "$HEARTBEAT_WF_ID" ] && [ -n "$AGENT_WF_ID_FOR_HB" ]; then
  HB_JSON=$(curl -s "${N8N_BASE}/api/v1/workflows/${HEARTBEAT_WF_ID}" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}")

  PATCHED_HB=$(echo "$HB_JSON" | python3 -c "
import sys, json
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
raw = sys.stdin.read()
raw = raw.replace('REPLACE_AGENT_WORKFLOW_ID', '${AGENT_WF_ID_FOR_HB}')
raw = raw.replace('REPLACE_BACKGROUND_CHECKER_ID', '${WF_IDS[background-checker]}')
wf = json.loads(raw)
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
settings = {k: v for k, v in wf.get('settings',{}).items() if k in ALLOWED}
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': settings}))
" 2>/dev/null)

  if [ -n "$PATCHED_HB" ]; then
    echo "$PATCHED_HB" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${HEARTBEAT_WF_ID}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" -d @- > /dev/null
    echo "  ✅ Heartbeat → Agent: ${AGENT_WF_ID_FOR_HB}"
  fi
fi
# ── 11d. Patch LLM credential in Background Checker ──────────
BG_CHECKER_WF_ID=${WF_IDS['background-checker']}
if [ -n "$BG_CHECKER_WF_ID" ]; then
  # Fetch real LLM credential ID (provider-aware)
  BG_CRED_TYPE="${LLM_CRED_TYPE:-anthropicApi}"
  BG_CRED_NAME="${LLM_CRED_NAME:-Anthropic API}"
  CRED_LIST_BG=$(curl -s "${N8N_BASE}/api/v1/credentials" -H "X-N8N-API-KEY: ${N8N_API_KEY}")
  REAL_LLM_BG=$(echo "$CRED_LIST_BG" | python3 -c "
import sys,json
cred_type = sys.argv[1]
creds=json.load(sys.stdin).get('data',[])
for c in creds:
    if c.get('type')==cred_type: print(c['id']); break
" "${BG_CRED_TYPE}" 2>/dev/null)

  if [ -n "$REAL_LLM_BG" ]; then
    BG_JSON=$(curl -s "${N8N_BASE}/api/v1/workflows/${BG_CHECKER_WF_ID}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}")

    PATCHED_BG=$(echo "$BG_JSON" | python3 -c "
import sys, json
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
cred_id = '${REAL_LLM_BG}'
cred_type = '${BG_CRED_TYPE}'
wf = json.loads(sys.stdin.read())
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
for node in nodes:
    for ct, cd in node.get('credentials', {}).items():
        if ct == cred_type and ('REPLACE' in cd.get('id','') or cd.get('id','').startswith('cred-')):
            cd['id'] = cred_id
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
settings = {k: v for k, v in wf.get('settings',{}).items() if k in ALLOWED}
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': settings}))
" 2>/dev/null)

    if [ -n "$PATCHED_BG" ]; then
      echo "$PATCHED_BG" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${BG_CHECKER_WF_ID}" \
        -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
        -H "Content-Type: application/json" -d @- > /dev/null
      echo "  ✅ Background Checker → ${BG_CRED_NAME}: ${REAL_LLM_BG}"
    fi
  fi
fi

# ── 11e. Wire error workflow to critical workflows ──────────
ERROR_WF_ID=${WF_IDS['error-notification']}
if [ -n "$ERROR_WF_ID" ]; then
  for target in n8n-claw-agent background-checker sub-agent-runner; do
    target_id=${WF_IDS[$target]}
    [ -z "$target_id" ] && continue
    WF_JSON=$(curl -s "${N8N_BASE}/api/v1/workflows/${target_id}" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}")
    PATCHED_ERR=$(echo "$WF_JSON" | python3 -c "
import sys, json
ALLOWED = set('${N8N_SETTINGS_WHITELIST}'.split(','))
wf = json.load(sys.stdin)
nodes = wf.get('nodes') or wf.get('activeVersion',{}).get('nodes',[])
conns = wf.get('connections') or wf.get('activeVersion',{}).get('connections',{})
settings = {k: v for k, v in wf.get('settings',{}).items() if k in ALLOWED}
settings['errorWorkflow'] = '${ERROR_WF_ID}'
print(json.dumps({'name': wf['name'], 'nodes': nodes, 'connections': conns, 'settings': settings}))
" 2>/dev/null)
    if [ -n "$PATCHED_ERR" ]; then
      echo "$PATCHED_ERR" | curl -s -X PUT "${N8N_BASE}/api/v1/workflows/${target_id}" \
        -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
        -H "Content-Type: application/json" -d @- > /dev/null
      echo "  ✅ ${target} → error workflow ${ERROR_WF_ID}"
    fi
  done
fi

fi  # end INSTALL_MODE guard for workflows

# ── 12. Activate agent ───────────────────────────────────────
AGENT_ID=${WF_IDS['n8n-claw-agent']}
if [ -n "$AGENT_ID" ]; then
  # Deactivate first (forces n8n to re-register Telegram webhook on activate)
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${AGENT_ID}/deactivate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  sleep 2
  for attempt in 1 2 3; do
    AGENT_ACTIVATE=$(curl -s -X POST "${N8N_BASE}/api/v1/workflows/${AGENT_ID}/activate" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}")
    AGENT_ACT_ERR=$(echo "$AGENT_ACTIVATE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',''))" 2>/dev/null)
    if [ -z "$AGENT_ACT_ERR" ]; then
      echo -e "  ${GREEN}✅ n8n-claw Agent activated${NC}"
      break
    elif echo "$AGENT_ACT_ERR" | grep -qi "too many\|retry"; then
      sleep 2
    else
      echo -e "  ${YELLOW}⚠️  Agent activation: ${AGENT_ACT_ERR} — activate manually in n8n UI${NC}"
      break
    fi
  done
fi

# Activate Error Notification workflow (must be active for Error Trigger to fire)
ERROR_NOTIF_ID=${WF_IDS['error-notification']}
if [ -n "$ERROR_NOTIF_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${ERROR_NOTIF_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Error Notification workflow activated${NC}"
fi

# Activate Memory Consolidation
CONSOLID_ID=${WF_IDS['memory-consolidation']}
if [ -n "$CONSOLID_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${CONSOLID_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Memory Consolidation workflow activated${NC}"
fi

# Activate Credential Form (must be active for form URL to work)
CREDFORM_ID=${WF_IDS['credential-form']}
if [ -n "$CREDFORM_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${CREDFORM_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Credential Form workflow activated${NC}"
fi

# Activate OAuth Callback (must be active for Google OAuth redirect to work)
OAUTH_CB_ID=${WF_IDS['oauth-callback']}
if [ -n "$OAUTH_CB_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${OAUTH_CB_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ OAuth Callback workflow activated${NC}"
fi

# Activate Reminder Runner (polls DB every minute for due reminders)
REMINDER_RUNNER_ID=${WF_IDS['reminder-runner']}
if [ -n "$REMINDER_RUNNER_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${REMINDER_RUNNER_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Reminder Runner workflow activated${NC}"
fi

# Activate sub-workflows (required since n8n 2.x)
for SUB_WF in mcp-client mcp-builder mcp-library-manager agent-library-manager sub-agent-runner workflow-builder reminder-factory project-manager background-checker; do
  SUB_WF_ID=${WF_IDS[$SUB_WF]}
  if [ -n "$SUB_WF_ID" ]; then
    curl -s -X POST "${N8N_BASE}/api/v1/workflows/${SUB_WF_ID}/activate" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  fi
done
echo -e "  ${GREEN}✅ Sub-workflows activated${NC}"

# Activate Heartbeat AFTER sub-workflows (heartbeat references background-checker)
HEARTBEAT_ID=${WF_IDS['heartbeat']}
if [ -n "$HEARTBEAT_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${HEARTBEAT_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Heartbeat workflow activated${NC}"
fi

# Activate Webhook Adapter — safe regardless of chat channel choice.
# Slack/Teams triggers inside it are node-level disabled and stay dormant.
# The generic + custom webhooks are auth-protected via X-API-Key (WEBHOOK_SECRET).
ADAPTER_ID=${WF_IDS['webhook-adapter']}
if [ -n "$ADAPTER_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${ADAPTER_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Webhook Adapter workflow activated${NC}"
fi

# Final deactivate/activate cycle for agent — forces Telegram webhook re-registration
# (n8n sometimes skips webhook registration on first activate after API import)
if [ -n "$AGENT_ID" ]; then
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${AGENT_ID}/deactivate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  sleep 3
  curl -s -X POST "${N8N_BASE}/api/v1/workflows/${AGENT_ID}/activate" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" > /dev/null 2>&1
  echo -e "  ${GREEN}✅ Telegram webhook re-registered${NC}"
fi

# Helper for interactive prompts (used by both update and fresh install)
cli_ask() {
  local prompt="$1" default="$2"
  read -rp "  ${prompt} [${default}]: " val
  echo "${val:-$default}"
}

# ── Update mode: offer new feature configuration ─────────────
if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ] && [ -z "${EMBEDDING_API_KEY}" ]; then
  echo ""
  echo -e "${GREEN}🧠 New feature: Semantic memory search (RAG)${NC}"
  echo "  Provide an embedding API key to enable vector-based memory search."
  echo "  Supported providers: openai (default), voyage, ollama"
  echo "  Press Enter to skip."
  read -rp "  Embedding API Key [skip]: " EMBEDDING_API_KEY_INPUT
  if [ -n "$EMBEDDING_API_KEY_INPUT" ]; then
    EMBEDDING_API_KEY="$EMBEDDING_API_KEY_INPUT"
    EMBEDDING_PROVIDER=$(cli_ask "Embedding provider" "openai")
    EMBEDDING_MODEL_DEFAULT="text-embedding-3-small"
    [ "$EMBEDDING_PROVIDER" = "voyage" ] && EMBEDDING_MODEL_DEFAULT="voyage-3-lite"
    [ "$EMBEDDING_PROVIDER" = "ollama" ] && EMBEDDING_MODEL_DEFAULT="nomic-embed-text"
    EMBEDDING_MODEL=$(cli_ask "Embedding model" "$EMBEDDING_MODEL_DEFAULT")
    set_env EMBEDDING_API_KEY "$EMBEDDING_API_KEY"
    set_env EMBEDDING_PROVIDER "$EMBEDDING_PROVIDER"
    set_env EMBEDDING_MODEL "$EMBEDDING_MODEL"
    # Write embedding config to DB (tools_config table)
    LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
      INSERT INTO tools_config (tool_name, config, enabled)
      VALUES ('embedding', jsonb_build_object('provider','${EMBEDDING_PROVIDER:-openai}','api_key','${EMBEDDING_API_KEY}','model','${EMBEDDING_MODEL:-text-embedding-3-small}'), true)
      ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
    " > /dev/null 2>&1
    echo -e "  ${GREEN}✅ Embeddings configured (${EMBEDDING_PROVIDER}/${EMBEDDING_MODEL})${NC}"
    # Reuse OpenAI embedding key for voice transcription credential
    if [ "$EMBEDDING_PROVIDER" = "openai" ]; then
      OPENAI_API_KEY="$EMBEDDING_API_KEY"
      set_env OPENAI_API_KEY "$OPENAI_API_KEY"
      echo -e "  ${GREEN}ℹ️  Same key will be used for voice transcription (Whisper)${NC}"
    fi
  else
    echo -e "  ⏭️  Skipped — using keyword search"
  fi
  # Voice transcription: ask for OpenAI key if not already set
  if [ -z "$OPENAI_API_KEY" ] || [[ "$OPENAI_API_KEY" == "your_"* ]]; then
    echo ""
    echo -e "  ${GREEN}🎤 Voice Transcription (optional)${NC}"
    echo "  OpenAI API key enables voice message transcription via Whisper."
    read -rp "  OpenAI API Key [skip]: " OPENAI_API_KEY_INPUT
    if [ -n "$OPENAI_API_KEY_INPUT" ]; then
      OPENAI_API_KEY="$OPENAI_API_KEY_INPUT"
      set_env OPENAI_API_KEY "$OPENAI_API_KEY"
      echo -e "  ${GREEN}✅ Voice transcription enabled${NC}"
    else
      echo -e "  ⏭️  Skipped — voice messages disabled"
    fi
  fi
  # Write anthropic key to DB in update mode too (legacy compat)
  if [ -n "$ANTHROPIC_API_KEY" ] && [[ "$ANTHROPIC_API_KEY" != "your_"* ]]; then
    LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
      INSERT INTO tools_config (tool_name, config, enabled)
      VALUES ('anthropic', jsonb_build_object('api_key','${ANTHROPIC_API_KEY}'), true)
      ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
    " > /dev/null 2>&1
  fi
  # Write llm_provider config in update mode too (same logic as fresh install)
  _load_env
  LLM_PROVIDER_DB="${LLM_PROVIDER:-anthropic}"
  case "$LLM_PROVIDER_DB" in
    anthropic)        LLM_ENDPOINT="https://api.anthropic.com/v1/messages"; LLM_PROVIDER_FAMILY="anthropic"; LLM_DB_KEY="${ANTHROPIC_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL:-claude-haiku-4-5-20251001}" ;;
    openai)           LLM_ENDPOINT="https://api.openai.com/v1/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL:-gpt-5.4}" ;;
    openrouter)       LLM_ENDPOINT="https://openrouter.ai/api/v1/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL}" ;;
    ollama)           LLM_ENDPOINT="${LLM_BASE_URL:-http://172.17.0.1:11434}/v1/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY:-ollama}"; LLM_DB_MODEL="${LLM_MODEL:-glm-4.7-flash}" ;;
    deepseek)         LLM_ENDPOINT="https://api.deepseek.com/v1/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL:-deepseek-chat}" ;;
    gemini)           LLM_ENDPOINT="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL:-gemini-3-flash-preview}" ;;
    mistral)          LLM_ENDPOINT="https://api.mistral.ai/v1/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY}"; LLM_DB_MODEL="${LLM_MODEL:-mistral-large-latest}" ;;
    openai_compatible) LLM_ENDPOINT="${LLM_BASE_URL}/chat/completions"; LLM_PROVIDER_FAMILY="openai_compatible"; LLM_DB_KEY="${LLM_API_KEY:-not-needed}"; LLM_DB_MODEL="${LLM_MODEL}" ;;
  esac
  if [ -n "$LLM_DB_KEY" ]; then
    LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
      INSERT INTO tools_config (tool_name, config, enabled)
      VALUES ('llm_provider', jsonb_build_object('provider','${LLM_PROVIDER_FAMILY}','endpoint','${LLM_ENDPOINT}','model','${LLM_DB_MODEL}','api_key','${LLM_DB_KEY}'), true)
      ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
    " > /dev/null 2>&1
  fi
fi

# ── 12. Setup Wizard via CLI (no n8n workflow needed) ────────

# Load existing personalization from DB (needed for skip-question and defaults)
EXISTING_BOT_NAME=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT content FROM soul WHERE key='name' LIMIT 1" 2>/dev/null | xargs)
EXISTING_USER=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT display_name FROM user_profiles WHERE user_id = 'telegram:${TELEGRAM_CHAT_ID}' LIMIT 1" 2>/dev/null | xargs)
EXISTING_TZ=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT timezone FROM user_profiles WHERE user_id = 'telegram:${TELEGRAM_CHAT_ID}' LIMIT 1" 2>/dev/null | xargs)
EXISTING_CTX=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT context FROM user_profiles WHERE user_id = 'telegram:${TELEGRAM_CHAT_ID}' LIMIT 1" 2>/dev/null | xargs)
EXISTING_LANG=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT preferences->>'language' FROM user_profiles WHERE user_id = 'telegram:${TELEGRAM_CHAT_ID}' LIMIT 1" 2>/dev/null | xargs)
EXISTING_PERSONA=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT content FROM soul WHERE key='persona' LIMIT 1" 2>/dev/null | sed 's/^ *//;s/ *$//')
EXISTING_PROACTIVE=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c \
  "SELECT content FROM soul WHERE key='proactive' LIMIT 1" 2>/dev/null | sed 's/^ *//;s/ *$//')

SKIP_PERSONALITY=false
SKIP_EMBEDDING=false
SKIP_PERSONA_WRITE=false

if [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" != "--force" ]; then
  echo -e "\n${GREEN}🧙 Skipping personalization (update mode — use --force to reconfigure)${NC}"
  SKIP_PERSONALITY=true
  SKIP_PERSONA_WRITE=true
  SKIP_EMBEDDING=true
  # Use existing DB values so downstream DB writes (user_profiles, mcp_registry) don't blank
  BOT_NAME="${EXISTING_BOT_NAME:-Assistant}"
  USER_DISPLAY="${EXISTING_USER:-User}"
  PREFERRED_LANG="${EXISTING_LANG:-English}"
  CTX="${EXISTING_CTX:-Personal assistant and automation}"
  TIMEZONE="${EXISTING_TZ:-UTC}"
elif [ "$INSTALL_MODE" = "update" ] && [ "$FORCE_FLAG" = "--force" ] && [ -n "$EXISTING_BOT_NAME" ]; then
  # --force on existing install: ask before each block
  echo ""
  read -rp "  Change personality settings? (y/N): " CHANGE_PERSONALITY
  if [[ "${CHANGE_PERSONALITY,,}" =~ ^y ]]; then
    SKIP_PERSONALITY=false
  else
    SKIP_PERSONALITY=true
    # Use existing DB values so downstream DB writes don't blank them
    BOT_NAME="$EXISTING_BOT_NAME"
    USER_DISPLAY="$EXISTING_USER"
    PREFERRED_LANG="${EXISTING_LANG:-English}"
    CTX="${EXISTING_CTX:-Personal assistant and automation}"
    TIMEZONE="${EXISTING_TZ:-UTC}"
    # Preserve existing persona — extract style from it or keep as-is
    SKIP_PERSONA_WRITE=true
    echo -e "  ${GREEN}✅ Keeping current personality${NC}"
  fi
  echo ""
  read -rp "  Change embedding/RAG settings? (y/N): " CHANGE_EMBEDDING
  if [[ "${CHANGE_EMBEDDING,,}" =~ ^y ]]; then
    SKIP_EMBEDDING=false
  else
    SKIP_EMBEDDING=true
    echo -e "  ${GREEN}✅ Keeping current embedding config${NC}"
  fi
fi

if [ "$SKIP_PERSONALITY" = "false" ]; then

echo -e "\n${GREEN}🧙 Personalization setup${NC}"
echo "────────────────────────────"
echo "Let's configure your agent's personality."
if [ -n "$EXISTING_BOT_NAME" ]; then
  echo "  (Press Enter to keep current values)"
fi
echo ""

SYS_TZ=$(timedatectl show --property=Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo "UTC")
BOT_NAME=$(cli_ask "Agent name" "${EXISTING_BOT_NAME:-Assistant}")
USER_DISPLAY=$(cli_ask "Your name" "${EXISTING_USER:-User}")
PREFERRED_LANG=$(cli_ask "Preferred language" "${EXISTING_LANG:-English}")
CTX=$(cli_ask "What will you use this agent for" "${EXISTING_CTX:-Personal assistant and automation}")
TIMEZONE=$(cli_ask "Timezone" "${EXISTING_TZ:-$SYS_TZ}")

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
if [ -n "$EXISTING_PROACTIVE" ]; then
  echo "    Current: ${EXISTING_PROACTIVE:0:70}..."
fi
echo "    1) Proactive — reminds you of things, checks in, suggests next steps"
echo "    2) Reactive — only responds when you message first"
if [ -n "$EXISTING_PROACTIVE" ]; then
  read -rp "  Choose [keep current]: " PROACTIVE_CHOICE
else
  read -rp "  Choose [1]: " PROACTIVE_CHOICE
fi
if [ -z "$PROACTIVE_CHOICE" ] && [ -n "$EXISTING_PROACTIVE" ]; then
  PROACTIVE="$EXISTING_PROACTIVE"
else
  case "${PROACTIVE_CHOICE:-1}" in
    2) PROACTIVE="Only respond when the user initiates. Do not proactively reach out." ;;
    *) PROACTIVE="Be proactive: remind the user of upcoming events, suggest next steps, follow up on open tasks." ;;
  esac
fi

echo ""
echo "  Custom personality (optional — overrides the above):"
echo "  Describe exactly how the agent should behave, in your own words."

# Determine if there's an existing custom persona (differs from standard pattern)
EXISTING_CUSTOM_PERSONA=""
if [ -n "$EXISTING_PERSONA" ] && [[ "$EXISTING_PERSONA" != *"a helpful AI assistant"* ]]; then
  EXISTING_CUSTOM_PERSONA="$EXISTING_PERSONA"
fi

if [ -n "$EXISTING_CUSTOM_PERSONA" ]; then
  echo -e "  Current: ${EXISTING_CUSTOM_PERSONA:0:80}..."
  echo "  Press Enter to keep, type new text to replace, or type 'reset' to switch to preset above."
else
  echo "  Leave empty to use the settings above."
fi
read -rp "  Custom persona [${EXISTING_CUSTOM_PERSONA:+keep current}]: " CUSTOM_PERSONA
USE_FULL_PERSONA=""
if [ "$CUSTOM_PERSONA" = "reset" ] && [ -n "$EXISTING_CUSTOM_PERSONA" ]; then
  # User explicitly wants to drop the custom persona and use the preset from the Style menu above
  echo -e "  ${GREEN}✅ Resetting to preset persona${NC}"
elif [ -z "$CUSTOM_PERSONA" ] && [ -n "$EXISTING_CUSTOM_PERSONA" ]; then
  # Keep existing custom persona as-is (it's the full persona string from DB)
  USE_FULL_PERSONA="$EXISTING_CUSTOM_PERSONA"
  echo -e "  ${GREEN}✅ Keeping current custom persona${NC}"
elif [ -n "$CUSTOM_PERSONA" ]; then
  STYLE="$CUSTOM_PERSONA"
  echo -e "  ${GREEN}✅ Using custom persona${NC}"
fi

fi # end SKIP_PERSONALITY

if [ "$SKIP_EMBEDDING" = "false" ]; then

echo ""
echo -e "${GREEN}🧠 RAG / Vector Memory (optional)${NC}"
echo "  For semantic memory search, provide an embedding API key."
echo "  Supported providers: openai (default), voyage, ollama"
echo "  If you use OpenAI, the same key also enables voice transcription (Whisper)."
if [ -n "$EMBEDDING_API_KEY" ]; then
  echo "  Current key: ${EMBEDDING_API_KEY:0:8}...  (Enter to keep, or enter new key)"
  read -rp "  Embedding API Key [keep]: " EMBEDDING_API_KEY_INPUT
  [ -z "$EMBEDDING_API_KEY_INPUT" ] && EMBEDDING_API_KEY_INPUT="$EMBEDDING_API_KEY"
else
  echo "  Leave empty to skip — keyword search will be used instead."
  read -rp "  Embedding API Key [skip]: " EMBEDDING_API_KEY_INPUT
fi
if [ -n "$EMBEDDING_API_KEY_INPUT" ]; then
  EMBEDDING_API_KEY="$EMBEDDING_API_KEY_INPUT"
  EMBEDDING_PROVIDER=$(cli_ask "Embedding provider" "openai")
  EMBEDDING_MODEL_DEFAULT="text-embedding-3-small"
  [ "$EMBEDDING_PROVIDER" = "voyage" ] && EMBEDDING_MODEL_DEFAULT="voyage-3-lite"
  [ "$EMBEDDING_PROVIDER" = "ollama" ] && EMBEDDING_MODEL_DEFAULT="nomic-embed-text"
  EMBEDDING_MODEL=$(cli_ask "Embedding model" "$EMBEDDING_MODEL_DEFAULT")
  set_env EMBEDDING_API_KEY "$EMBEDDING_API_KEY"
  set_env EMBEDDING_PROVIDER "$EMBEDDING_PROVIDER"
  set_env EMBEDDING_MODEL "$EMBEDDING_MODEL"
  echo -e "  ${GREEN}✅ Embeddings configured (${EMBEDDING_PROVIDER}/${EMBEDDING_MODEL})${NC}"
  # Reuse OpenAI embedding key for voice transcription credential
  if [ "$EMBEDDING_PROVIDER" = "openai" ]; then
    OPENAI_API_KEY="$EMBEDDING_API_KEY"
    set_env OPENAI_API_KEY "$OPENAI_API_KEY"
    echo -e "  ${GREEN}ℹ️  Same key will be used for voice transcription (Whisper)${NC}"
  fi
else
  echo -e "  ⏭️  Skipped — using keyword search"
fi

# Voice transcription: ask for OpenAI key if not already set (non-openai embedding or no embedding)
if [ -z "$OPENAI_API_KEY" ] || [[ "$OPENAI_API_KEY" == "your_"* ]]; then
  echo ""
  echo -e "${GREEN}🎤 Voice Transcription (optional)${NC}"
  echo "  OpenAI API key enables voice message transcription via Whisper."
  echo "  Leave empty to skip — voice messages won't be supported."
  read -rp "  OpenAI API Key [skip]: " OPENAI_API_KEY_INPUT
  if [ -n "$OPENAI_API_KEY_INPUT" ]; then
    OPENAI_API_KEY="$OPENAI_API_KEY_INPUT"
    set_env OPENAI_API_KEY "$OPENAI_API_KEY"
    echo -e "  ${GREEN}✅ Voice transcription enabled${NC}"
  else
    echo -e "  ⏭️  Skipped — voice messages disabled"
  fi
fi

fi # end SKIP_EMBEDDING

# Write embedding + anthropic config to DB (tools_config table)
# Workflows read config from DB at runtime, not from env vars
if [ -n "$EMBEDDING_API_KEY" ]; then
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
    INSERT INTO tools_config (tool_name, config, enabled)
    VALUES ('embedding', jsonb_build_object('provider','${EMBEDDING_PROVIDER:-openai}','api_key','${EMBEDDING_API_KEY}','model','${EMBEDDING_MODEL:-text-embedding-3-small}'), true)
    ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
  " > /dev/null 2>&1
fi
# Write legacy anthropic config (backwards compat)
if [ -n "$ANTHROPIC_API_KEY" ] && [[ "$ANTHROPIC_API_KEY" != "your_"* ]]; then
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
    INSERT INTO tools_config (tool_name, config, enabled)
    VALUES ('anthropic', jsonb_build_object('api_key','${ANTHROPIC_API_KEY}'), true)
    ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
  " > /dev/null 2>&1
fi

# Write llm_provider config (used by memory-consolidation and future background workflows)
LLM_PROVIDER_DB="${LLM_PROVIDER:-anthropic}"
case "$LLM_PROVIDER_DB" in
  anthropic)
    LLM_ENDPOINT="https://api.anthropic.com/v1/messages"
    LLM_PROVIDER_FAMILY="anthropic"
    LLM_DB_KEY="${ANTHROPIC_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL:-claude-haiku-4-5-20251001}"
    ;;
  openai)
    LLM_ENDPOINT="https://api.openai.com/v1/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL:-gpt-5.4}"
    ;;
  openrouter)
    LLM_ENDPOINT="https://openrouter.ai/api/v1/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL}"
    ;;
  ollama)
    LLM_ENDPOINT="${LLM_BASE_URL:-http://172.17.0.1:11434}/v1/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY:-ollama}"
    LLM_DB_MODEL="${LLM_MODEL:-glm-4.7-flash}"
    ;;
  deepseek)
    LLM_ENDPOINT="https://api.deepseek.com/v1/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL:-deepseek-chat}"
    ;;
  gemini)
    LLM_ENDPOINT="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL:-gemini-3-flash-preview}"
    ;;
  mistral)
    LLM_ENDPOINT="https://api.mistral.ai/v1/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY}"
    LLM_DB_MODEL="${LLM_MODEL:-mistral-large-latest}"
    ;;
  openai_compatible)
    LLM_ENDPOINT="${LLM_BASE_URL}/chat/completions"
    LLM_PROVIDER_FAMILY="openai_compatible"
    LLM_DB_KEY="${LLM_API_KEY:-not-needed}"
    LLM_DB_MODEL="${LLM_MODEL}"
    ;;
esac

if [ -n "$LLM_DB_KEY" ]; then
  LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
    INSERT INTO tools_config (tool_name, config, enabled)
    VALUES ('llm_provider', jsonb_build_object(
      'provider','${LLM_PROVIDER_FAMILY}',
      'endpoint','${LLM_ENDPOINT}',
      'model','${LLM_DB_MODEL}',
      'api_key','${LLM_DB_KEY}'
    ), true)
    ON CONFLICT (tool_name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now();
  " > /dev/null 2>&1
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

skip_persona = '${SKIP_PERSONA_WRITE}' == 'true'
full_persona = esc('${USE_FULL_PERSONA}')
bot     = esc('${BOT_NAME}')
user    = esc('${USER_DISPLAY}')
lang    = esc('${PREFERRED_LANG}')
style   = esc('${STYLE}')
proact  = esc('${PROACTIVE}')
ctx     = esc('${CTX}')
chat_id = '${TELEGRAM_CHAT_ID}'
mcp_url = '${N8N_URL_FOR_MCP}'
tz      = esc('${TIMEZONE:-UTC}')
uname   = user.lower().replace(' ', '_')

# Build persona: use full persona from DB if keeping existing custom, otherwise build from template
if full_persona:
    persona_value = full_persona
    vibe_value = full_persona
else:
    persona_value = f'You are {bot}, a helpful AI assistant for {user}. Preferred language: {lang}. {style}'
    vibe_value = style

sql = ""

# Only write soul table if personality was changed
if not skip_persona:
    sql += f"""
INSERT INTO public.soul (key, content) VALUES
  ('name', '{bot}'),
  ('persona', '{persona_value}'),
  ('vibe', '{vibe_value}'),
  ('proactive', '{proact}'),
  ('boundaries', 'Keep private data private. Ask before external actions.'),
  ('communication', 'You communicate via Telegram. Reply directly.')
ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;
"""

# Always update user_profiles and mcp_registry (uses existing values when personality was skipped)
sql += f"""
INSERT INTO public.user_profiles (user_id, name, display_name, timezone, context, preferences, setup_done, setup_step)
VALUES ('telegram:{chat_id}', '{uname}', '{user}', '{tz}', '{ctx}', '{{"language": "{lang}"}}'::jsonb, false, 0)
ON CONFLICT (user_id) DO UPDATE SET
  display_name = EXCLUDED.display_name, context = EXCLUDED.context, timezone = EXCLUDED.timezone,
  preferences = COALESCE(user_profiles.preferences, '{{}}'::jsonb) || '{{"language": "{lang}"}}'::jsonb;

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
  ('mcp_instructions', 'You have MCP Skills — installable capabilities powered by the Model Context Protocol (MCP):

## MCP Client (mcp_client tool)
Call tools on MCP skill servers. Parameters:
- mcp_url: Server URL
- tool_name: Name of the tool
- arguments: JSON object with tool parameters

## Skills Library (library_manager tool)
Install/remove pre-built skills from the catalog.
Actions: list_templates, install_template, remove_template, add_credential
When the user asks about available skills, ALWAYS use this tool with list_templates.

## MCP Builder (mcp_builder tool)
Build custom skills from scratch for APIs not in the catalog.
Parameter: task (description of what the skill should do)

## Available MCP Skills
Loaded dynamically from the mcp_registry table at runtime.
ALWAYS prefer installed MCP skills over generic HTTP/Web Search when a matching skill exists.

## Registry
Query all active skills: SELECT * FROM mcp_registry WHERE active = true;'),

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

MEMORY (memory_search / memory_save / memory_update / memory_delete):

SAVE — Always save when the user reveals something about themselves:
- Preferences, dislikes, habits ("I like...", "I hate...")
- Personal facts (job, family, pets, hobbies, routines)
- Decisions and opinions ("I decided to go with X")
- Recurring topics and interests
- Tools, workflows, systems they use
- Explicit requests ("Remember that...", "Don''t forget...")
Category: preference, decision, contact, project, general
Importance: 8-10 for explicit requests, 5-7 for casual mentions

SEARCH — Always search BEFORE answering when:
- The user asks something they may have told you before
- You want to make a recommendation or suggestion
- The user asks "Do you remember...?" or "What do I like...?"
- You are unsure if the user has preferences on a topic
- A topic comes up that you have discussed before

UPDATE — Use when correcting or refining an existing memory:
- The user corrects previously saved information ("Actually, I prefer X not Y")
- Information has changed ("I moved to Berlin" when you saved Munich)
- You want to add detail to an existing memory
- ALWAYS search first to find the memory ID, then update by ID

DELETE — Use when a memory should be removed entirely:
- The user explicitly asks to forget something ("Forget that I...", "Delete that...")
- Information is completely obsolete and not worth updating
- Duplicate memories found during search
- The user says something is no longer relevant

RULE: When in doubt, search/save one time too many rather than too few.
RULE: Prefer UPDATE over DELETE+SAVE when correcting information.
RULE: ALWAYS search before updating or deleting to get the correct ID.
You are a personal assistant — the better you know the user, the better you can help.

ENTITY MANAGER (entity_manager):
- Tracks people, companies, projects, places, events and their relationships
- Use AUTOMATICALLY — do not wait for the user to ask
- When you notice a person, company, project, or event in conversation: check if the entity exists (search), create it if not (save), and add relationships (relate)
- Do this silently in the background — do NOT announce "I am creating an entity" unless the user asks
- Do NOT create entities for trivial one-off mentions — only for subjects that matter to the user
- GRAPH to explore connections around an entity when context would help your answer

HTTP (http_request):
- Use for: simple API calls without authentication'),

  ('memory_behavior', 'You have long-term memory with enriched tagging. Use it actively and AUTOMATICALLY.

CRITICAL — ALWAYS SEARCH BEFORE RESPONDING:
- BEFORE you write your reply, ask yourself: "Does the user reference something I might already know?" If yes, SEARCH MEMORY FIRST.
- This includes: personal status updates ("bin wieder gesund", "hab den Job gewechselt"), references to people/projects/places, follow-ups on past topics, preferences, opinions
- Use descriptive search queries with multiple keywords — NOT just 2 words. Example: instead of "Freddy krank", search "Freddy krank Erkältung Gesundheit"
- If you are unsure whether you know something: SEARCH. It costs nothing. Not searching costs trust.

SAVING — enrich automatically:
- ALWAYS include tags and entity_name when saving — extract them from context
- Tags: 2-5 lowercase keywords that describe the topic (e.g. ["restaurant", "berlin", "italian"])
- entity_name: the main person, company, place, or project the memory is about
- source: user_stated (user said it explicitly), conversation (inferred from chat), task_result (from a completed task)
- Do NOT ask the user for tags or entity names — infer them yourself

UPDATING AND CLEANING:
- Learn from corrections: search for the old memory and UPDATE it rather than creating a duplicate
- Remove obsolete memories: if clearly wrong or outdated, delete it
- Never ask for information you have already saved'),

  ('task_management', 'You can manage tasks for the user via the Task Manager tool.

IMPORTANT - REMINDERS AND TASKS:
- When the user says "remind me to..." or "don''t forget...", ALWAYS do BOTH:
  1. Create a Reminder (timed Telegram notification)
  2. Create a Task via Task Manager (so it shows up in task lists and briefings)
- This ensures nothing falls through the cracks.

WHEN TO CREATE TASKS:
- User says "remind me to...", "I need to...", "add a task...", "don''t forget..."
- User mentions a deadline or to-do item in conversation
- Proactively suggest creating a task when the user mentions something time-sensitive

WHEN TO CHECK TASKS:
- User asks "what do I have to do?", "my tasks", "what''s pending?"
- Before starting a conversation about planning or scheduling
- Use the "summary" action for quick overviews

WHEN TO UPDATE TASKS:
- User says "done with X", "finished X", "cancel X"
- Mark tasks as done when the user confirms completion

SUBTASKS:
- For complex tasks, create subtasks using parent_id
- Example: "Plan trip" with subtasks "Book flight", "Book hotel"

PRIORITIES:
- urgent: needs attention NOW (today)
- high: important, should be done soon (this week)
- medium: normal tasks (default)
- low: nice-to-have, no rush

PREFERENCES (set_preference action):
- Use to save user preferences like morning_briefing settings
- Example: {{"action":"set_preference","key":"morning_briefing","value":{{"enabled":true,"time":"08:00"}}}}'),

  ('onboarding', 'When setup_done is false (first contact with this user):
- Greet the user by their display_name
- Introduce yourself briefly (your name from the soul config, what you are)
- List your capabilities with one concrete example each:
  * Answer questions and web search ("Who won the last World Cup?")
  * Manage tasks ("Create a task: tax return by Friday")
  * Set reminders ("Remind me in 2 hours to check the oven")
  * Understand voice messages (just send one)
  * Analyze photos ("What do you see in this picture?")
  * Read and summarize PDFs (just send a document)
  * Recognize locations (share your location)
  * Remember things ("Remember: I take my coffee black")
  * Build new API integrations ("Build me a GitHub API connection")
- Respond in the user''s language (check their language preference)
- This introduction happens ONLY ONCE. If setup_done is true, skip this entirely and respond normally.
- setup_done will be set to true automatically after your first response — you do not need to do this yourself.'),

  ('file_storage', 'FILE STORAGE — Binary File Passthrough

When a user sends a document or photo via Telegram, the file is automatically stored in the File Bridge and a file_ref ID is included in the message:
  [Document: invoice.pdf | file_ref: <actual-id>]
  [Photo | file_ref: <actual-id>]

HOW TO USE file_ref IN TOOL CALLS:
- Skills that support file uploads accept a file_ref parameter
- Pass the EXACT file_ref ID string from the message — do NOT build URLs from it, do NOT use file_url for stored files
- CORRECT: file_ref="file-abc12345"
- WRONG: file_url="http://file-bridge:3200/files/file-abc12345"
- The file_ref is just the ID (e.g. file-abc12345), NOT a URL

SENDING FILES TO THE USER:
- To send a file back to the user in Telegram, include this marker in your response:
  [send_file: http://file-bridge:3200/files/<file_ref_id>]
- The marker is automatically detected and the file is sent as a Telegram document
- The marker text is stripped from the visible message
- Only ONE file per response is supported

DOWNLOADING FILES FROM THE INTERNET:
- You can send ANY publicly accessible file to the user by including its URL in [send_file: URL]
- Example: User asks for a PDF from a website → find the direct download URL → [send_file: https://example.com/report.pdf]
- This works for any public URL: PDFs, images, ZIP files, etc.

DOWNLOADING FILES FROM CLOUD SERVICES (Google Drive, Nextcloud, etc.):
- For services that require authentication, use the download_file tool (NOT read_file)
- download_file stores the file in File Bridge and returns a [send_file: ...] link you can include in your response
- Do NOT use direct Google Drive/Nextcloud URLs in [send_file:] — they require auth and will fail
- Auth-protected URLs will download an HTML login page instead of the actual file

IMPORTANT RULES:
- file_ref IDs expire after 24 hours — do not reference old file_refs
- Always mention the original filename when discussing stored files
- If a skill needs a file the user sent earlier in the conversation, use the file_ref from that message
- For skills that accept both file_ref and file_url: prefer file_ref for files the user sent, file_url for external URLs'),

  ('knowledge_graph', 'You have a Knowledge Graph for tracking entities and relationships. Use it PROACTIVELY and SILENTLY.

AUTOMATIC BEHAVIOR — do this without being asked:
- When the user mentions a person, company, project, place, or event that seems important: SEARCH the graph first, then SAVE if new, then RELATE if connections are apparent
- When you learn that person X works at company Y, or event A is organized by B: create the relation immediately
- When you save a memory with an entity_name: also ensure that entity exists in the knowledge graph
- Do all of this silently — do NOT tell the user "I created an entity" unless they specifically ask about the graph

WHEN TO SEARCH THE GRAPH (also automatic):
- Before answering questions about a person, company, or project: check the graph for context
- When the user mentions someone by name: search for existing connections that might be relevant
- Use graph context to give more informed, connected answers

TYPES are free text but auto-normalized (lowercase, snake_case). The tool returns existing_entity_types and existing_relation_types after save/relate — ALWAYS reuse these existing types when they fit instead of inventing new ones.
- Example: if existing_entity_types includes "person", use "person" — not "human" or "individual"
- Only create a new type when nothing existing fits
- Be descriptive: "mentored_by" is better than "related_to"

CONSISTENCY:
- Entity names must be consistent — always use full canonical names (e.g. "Bastian Hiller" not "Bastian")
- The tool auto-detects duplicate entities and relations — no need to search before every save
- The graph complements memory — memory stores facts and preferences, the graph stores relationships
- Do NOT create entities for trivial mentions — only for subjects the user cares about or that come up repeatedly'),

  ('error_log', 'WORKFLOW ERROR LOG — proactive failure awareness

A global Error Notification workflow catches failures in the main agent, background-checker, and sub-agent-runner. Every failure is logged to memory_long with:
- category = ''error''
- importance = 8
- tags include ''error'', ''workflow-failure'', and the workflow name
- entity_name = ''workflow:<workflow_name>''
- content = human-readable summary (workflow name, timestamp, error message, failing node, execution URL)
- metadata (jsonb) contains execution_id, execution_url, execution_mode, workflow_id, workflow_name, node_name, error_name, error_message and a truncated error_stack

WHEN TO CHECK PROACTIVELY:
- User asks "ist was schiefgelaufen?", "lief alles?", "hat X funktioniert?", "did anything fail?", "any errors today?"
- User references a workflow or system component in a doubtful tone ("was the background check ok?")
- User reports unexpected behavior ("I didn''t get my reminder")
- Before apologizing or guessing — first check if there''s a logged error that explains it

HOW TO RETRIEVE — CRITICAL, FOLLOW EXACTLY:
- ALWAYS call memory_search with JSON input and the category filter, NEVER with a free-text question.
- Correct call: memory_search with input {{"search_query": "error", "category": "error"}}
- The category filter narrows the search to error rows only. The search_query "error" then matches every error row via fulltext — you will see ALL recent failures.
- For a specific workflow, use: {{"search_query": "<workflow_name>", "category": "error"}} — e.g. {{"search_query": "background", "category": "error"}}.
- WHY this rule exists: the fulltext index uses AND-semantics with no stemming. A natural-language query like "error workflow failure recent" requires ALL four tokens to be present in the row — "failure" does NOT match "Failed", and "recent" matches nothing. You will get zero results and falsely conclude nothing failed. DO NOT make this mistake.
- Do NOT add time words like "today", "last night", "recent" to search_query — they break the match. Filter by created_at mentally after you get the results (they arrive sorted by recency via time decay).
- If the user asks about a specific period, just fetch errors with {{"search_query": "error", "category": "error"}} and look at created_at in the returned rows.

HOW TO REPORT:
- Summarize in the user''s language and your own tone — do not dump raw metadata
- Mention what failed (workflow + node), when (relative time like "heute Nacht um 03:12"), and the error message
- If the execution URL is present in the content, offer it as a clickable reference
- Do NOT invent errors — if memory_search returns nothing for the relevant window, say so plainly'),

  ('user_context', 'The user is {user}. Context: {ctx}')

ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content;
"""
result = subprocess.run(['psql','-h','localhost','-U','postgres','-d','postgres'],
  input=sql, capture_output=True, text=True, env=env)
if result.returncode != 0:
    print('agents SQL error:', result.stderr[:200])
PYEOF2

# Write user profile to DB (so --force picks up existing values next time)
LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
INSERT INTO public.user_profiles (user_id, display_name, timezone, context)
VALUES ('telegram:${TELEGRAM_CHAT_ID}', '$(echo "$USER_DISPLAY" | sed "s/'/''/g")', '${TIMEZONE:-UTC}', '$(echo "$CTX" | sed "s/'/''/g")')
ON CONFLICT (user_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  timezone = EXCLUDED.timezone,
  context = EXCLUDED.context,
  updated_at = now();
" > /dev/null 2>&1

# Verify soul was written
SOUL_COUNT=$(LANG=C LC_ALL=C PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -t -c "SELECT COUNT(*) FROM soul" 2>/dev/null | tr -d ' ')
if [ "${SOUL_COUNT:-0}" -gt 0 ]; then
  echo -e "  ${GREEN}✅ Agent configured as '${BOT_NAME}', user '${USER_DISPLAY}' (${SOUL_COUNT} soul rows)${NC}"
else
  echo -e "  ${RED}❌ Soul table empty — DB write failed. Check postgres connection.${NC}"
fi

# ── Seed heartbeat_config ──────────────────────────────────────
echo -e "${CYAN}Seeding heartbeat configuration...${NC}"
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
INSERT INTO public.heartbeat_config (check_name, config, interval_minutes, enabled)
VALUES
  ('heartbeat', '{\"min_interval_hours\": 2}', 15, false),
  ('morning_briefing', '{}', 1440, false)
ON CONFLICT (check_name) DO NOTHING;
" 2>/dev/null

# Enable heartbeat if user chose proactive behavior (only when personalization ran)
if [ -n "$PROACTIVE_CHOICE" ]; then
  if [ "$PROACTIVE_CHOICE" = "1" ]; then
    PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
    UPDATE public.heartbeat_config SET enabled = true WHERE check_name = 'heartbeat';
    " 2>/dev/null
    echo -e "  ${GREEN}✅ Heartbeat config seeded (proactive — heartbeat enabled)${NC}"
  else
    PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
    UPDATE public.heartbeat_config SET enabled = false WHERE check_name = 'heartbeat';
    " 2>/dev/null
    echo -e "  ${GREEN}✅ Heartbeat config seeded (reactive — heartbeat disabled)${NC}"
  fi
else
  echo -e "  ${GREEN}✅ Heartbeat config seeded${NC}"
fi

# ── Seed scheduled_actions (Morning Briefing as default) ──────
echo -e "${CYAN}Seeding scheduled actions...${NC}"
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U postgres -d postgres -c "
INSERT INTO public.scheduled_actions (user_id, chat_id, name, action_type, instruction, schedule, timezone, enabled)
VALUES (
  'telegram:${TELEGRAM_CHAT_ID}',
  '${TELEGRAM_CHAT_ID}',
  'Morning Briefing',
  'briefing',
  'Give me a morning briefing: summarize my pending and overdue tasks, any upcoming deadlines, and a motivating note for the day.',
  '{\"type\": \"daily\", \"time\": \"08:00\"}',
  'Europe/Berlin',
  false
)
ON CONFLICT DO NOTHING;
" 2>/dev/null
echo -e "  ${GREEN}✅ Scheduled actions seeded (Morning Briefing disabled by default)${NC}"

# ── Seed expert agents ────────────────────────────────────────
echo -e "${CYAN}Seeding expert agents...${NC}"
python3 - <<'PYEOF_AGENTS'
import subprocess, os
pw = os.environ.get('POSTGRES_PASSWORD', '')
env = {**os.environ, 'PGPASSWORD': pw, 'LANG': 'C', 'LC_ALL': 'C'}

sql = """
INSERT INTO public.agents (key, content) VALUES
  ('persona:research-expert', '# Research Expert

## Expertise
Web research, fact-checking, source evaluation, summarizing complex topics.

## Workflow
1. Analyze the topic and research question
2. Research multiple independent sources (Web Search + HTTP)
3. Cross-check facts and identify contradictions
4. Deliver structured results with source citations

## Quality Standards
- Always cite sources (URLs, titles)
- Transparently flag uncertainties and knowledge gaps
- Never present speculation as fact
- When sources contradict: present both sides
- Check and note the timeliness of information'),

  ('persona:content-creator', '# Content Creator

## Expertise
Copywriting, social media content, blog articles, marketing copy, creative writing.

## Workflow
1. Analyze target audience and channel
2. Adapt tone and style to platform (Instagram, LinkedIn, Blog, etc.)
3. Provide multiple variants or suggestions when useful
4. Consider SEO-relevant keywords for web content

## Quality Standards
- Texts are ready to use (correct length, format, hashtags)
- Tone matches the target audience and platform
- Clear call-to-actions when appropriate
- No generic filler — be specific and concrete
- For social media: platform-appropriate emoji use and formatting'),

  ('persona:data-analyst', '# Data Analyst

## Expertise
Data analysis, pattern recognition, structured reports, KPI interpretation.

## Workflow
1. Assess data availability and quality
2. Identify relevant metrics and KPIs
3. Analyze trends, patterns, and outliers
4. Present results in a structured, understandable format

## Quality Standards
- Always contextualize numbers (benchmarks, trends, comparisons)
- Suggest visualizations when helpful (tables, lists, charts)
- Transparently name methodological limitations
- Derive actionable recommendations when possible
- Distinguish between correlation and causation'),

  ('telegram_status', 'You have a Telegram Status tool. Use it for brief progress updates during longer tasks, e.g.:
- Before delegating to an expert agent: "🔍 Starting research expert..."
- For project actions: "💾 Saving project context..."
- For web research: "🌐 Searching for information..."
Not for every small action — only when the user would otherwise wait >10 seconds without feedback.'),

  ('expert_agents', 'You have Expert Agents — specialized sub-agents you can delegate tasks to.

## Expert Agent Tool (expert_agent)
Delegate a task to a specialized expert. Parameters:
- agent: Agent identifier (e.g. "research-expert")
- task: Detailed task description
- context: Relevant conversation context (optional)

The expert works independently and returns a structured result. You then rephrase it in your own tone.

## Agent Library (agent_library tool)
Install/remove expert agents from the catalog.
Actions: list_agents, install_agent, remove_agent, list_installed

## Currently installed Expert Agents (3 total):
- **research-expert**: Web research, fact-checking, source evaluation, summarizing complex topics.
- **content-creator**: Copywriting, social media content, blog articles, marketing copy, creative writing.
- **data-analyst**: Data analysis, pattern recognition, structured reports, KPI interpretation.')

ON CONFLICT (key) DO NOTHING;
"""

result = subprocess.run(['psql','-h','localhost','-U','postgres','-d','postgres'],
  input=sql, capture_output=True, text=True, env=env)
if result.returncode != 0:
    print('Expert agents SQL error:', result.stderr[:200])
else:
    print('  OK')
PYEOF_AGENTS
echo -e "  ${GREEN}✅ Expert agents seeded (research-expert, content-creator, data-analyst)${NC}"

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
  if [ -z "${EMBEDDING_API_KEY}" ]; then
    echo ""
    echo -e "  ${CYAN}💡 Tip: Run './setup.sh' again to configure semantic memory search (RAG)${NC}"
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
fi
if [ "${LLM_PROVIDER:-anthropic}" = "anthropic" ]; then
echo "    2. Add Anthropic API credential (if not auto-created):"
echo "       Settings → Credentials → New → Anthropic API"
echo "       Name: 'Anthropic API'  |  Key: your key"
else
echo ""
echo -e "  ${GREEN}🤖 LLM Provider: ${LLM_PROVIDER} (${LLM_MODEL})${NC}"
echo "    All workflows configured for ${LLM_PROVIDER}. No manual LLM setup needed. ✅"
echo ""
fi
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
echo "     → select '${LLM_CRED_NAME:-Anthropic API}' as the chat model"
echo "     (not set by default due to n8n credential linking)"
echo ""
echo "    5. Message your Telegram bot!"
echo ""
if [ -z "$DOMAIN" ] || [[ "$DOMAIN" == "your_"* ]]; then
echo -e "  ${YELLOW}HTTPS: Point a domain here → re-run: DOMAIN=n8n.yourdomain.com ./setup.sh${NC}"
fi
