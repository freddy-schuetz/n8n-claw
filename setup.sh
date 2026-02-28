#!/bin/bash
# ============================================================
# n8n-greg Setup Script
# Replaces {{PLACEHOLDERS}} in workflow JSONs with .env values
# ============================================================

set -e

if [ ! -f .env ]; then
  echo "❌ .env not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

source .env

echo "🔧 Replacing placeholders in workflows..."

for f in workflows/*.json; do
  out="workflows/deployed/$(basename $f)"
  mkdir -p workflows/deployed
  sed \
    -e "s|{{N8N_URL}}|${N8N_URL}|g" \
    -e "s|{{N8N_INTERNAL_URL}}|${N8N_INTERNAL_URL}|g" \
    -e "s|{{N8N_API_KEY}}|${N8N_API_KEY}|g" \
    -e "s|{{SUPABASE_URL}}|${SUPABASE_URL}|g" \
    -e "s|{{SUPABASE_SERVICE_KEY}}|${SUPABASE_SERVICE_KEY}|g" \
    -e "s|{{SUPABASE_ANON_KEY}}|${SUPABASE_ANON_KEY}|g" \
    -e "s|{{TELEGRAM_CHAT_ID}}|${TELEGRAM_CHAT_ID}|g" \
    -e "s|{{VPS_IP}}|${VPS_IP:-localhost}|g" \
    "$f" > "$out"
  echo "  ✅ $out"
done

echo ""
echo "🗄️  Running Supabase migrations..."
PGPASSWORD=${POSTGRES_PASSWORD:-postgres} psql \
  -h ${POSTGRES_HOST:-localhost} \
  -p ${POSTGRES_PORT:-5432} \
  -U ${POSTGRES_USER:-postgres} \
  -d ${POSTGRES_DB:-postgres} \
  -f supabase/migrations/001_schema.sql \
  -f supabase/migrations/002_seed.sql
echo "  ✅ Schema + seed applied"

echo ""
echo "📦 Importing workflows into n8n..."
for f in workflows/deployed/*.json; do
  name=$(cat "$f" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name','unknown'))")
  response=$(curl -s -X POST "${N8N_URL}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$f")
  wf_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERROR'))" 2>/dev/null)
  echo "  ✅ ${name} → ID: ${wf_id}"
done

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Open n8n UI at ${N8N_URL}"
echo "  2. Add credentials: Anthropic API, Telegram Bot"
echo "  3. Activate the '🤖 Greg AI Agent' workflow"
echo "  4. Start chatting with your bot on Telegram!"
