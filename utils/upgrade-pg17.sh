#!/usr/bin/env bash
#
# n8n-claw Postgres 15 → 17 Upgrade Wrapper (pg_dump + restore method)
#
# Why dump-restore instead of pg_upgrade:
# Supabase's official upgrade-pg17.sh assumes a full Supabase self-host stack
# (auth, realtime, storage, vault) with a `db-config` Docker volume holding a
# pgsodium_root.key. n8n-claw doesn't ship those services and has no such
# volume — the upstream script's preflight hard-fails for us.
#
# pg_dump + restore is well-suited to n8n-claw:
#   - Small DB (typical n8n-claw < 1 GB)
#   - Simple schema (no cross-schema triggers, no vault encryption)
#   - All extensions (uuid-ossp, vector, unaccent) are present in
#     supabase/postgres:17 image
#   - Original PG15 data is preserved untouched as ./volumes/db/data.bak.pg15
#     for instant rollback
#
# Usage (must be run as root or with sudo):
#   sudo ./utils/upgrade-pg17.sh           # interactive
#   sudo ./utils/upgrade-pg17.sh --yes     # auto-confirm
#
# Run from the n8n-claw repository root.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
DB_CONTAINER="n8n-claw-db"
DB_VOLUME="n8n-claw_db_data"
PG17_IMAGE="supabase/postgres:17.6.1.063"
DATA_DIR="./volumes/db/data"
BACKUP_DIR="./volumes/db/data.bak.pg15"
DUMP_FILE="./volumes/db/dump_pg15.sql"
OVERRIDE_FILE="docker-compose.override.yml"
MIGRATIONS_DIR="./supabase/migrations"
MIGRATIONS_TMP="./supabase/migrations.upgrade-tmp"
RESTORE_LOG="./volumes/db/upgrade-pg17-restore.log"
LEFTOVER_OVERLAY="docker-compose.pg17.yml"

AUTO_CONFIRM=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_CONFIRM=true ;;
    esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Sanity checks ────────────────────────────────────────────
[ "$(id -u)" = "0" ] || { echo -e "${RED}Error: Run as root or with sudo${NC}" >&2; exit 1; }

for cmd in docker; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo -e "${RED}Error: $cmd is required${NC}" >&2; exit 1;
    }
done

[ -f docker-compose.yml ] || {
    echo -e "${RED}Error: Run from the n8n-claw repository root${NC}" >&2; exit 1;
}

[ -f .env ] || {
    echo -e "${RED}Error: .env file not found${NC}" >&2; exit 1;
}

# Load POSTGRES_PASSWORD from .env (strip surrounding quotes if any)
POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | head -n 1 | cut -d= -f2- | sed -E 's/^["'\''](.*)["'\'']$/\1/')
[ -n "$POSTGRES_PASSWORD" ] || {
    echo -e "${RED}Error: POSTGRES_PASSWORD not set in .env${NC}" >&2; exit 1;
}

confirm() {
    [ "$AUTO_CONFIRM" = "true" ] && return 0
    read -rp "$1 (y/N): " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# Tidy up leftover overlay from any prior failed attempt
[ -f "$LEFTOVER_OVERLAY" ] && rm -f "$LEFTOVER_OVERLAY"

echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  n8n-claw Postgres 15 → 17 Upgrade            ║${NC}"
echo -e "${CYAN}║  (pg_dump + restore method)                    ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Pre-flight ────────────────────────────────────────────
echo -e "${GREEN}==> Pre-flight checks${NC}"

if ! docker inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    echo -e "${RED}  ✘ Container '$DB_CONTAINER' not found.${NC}"
    echo "    Start the stack first: docker compose up -d"
    exit 1
fi

STATUS=$(docker inspect "$DB_CONTAINER" --format '{{.State.Status}}')
if [ "$STATUS" != "running" ]; then
    echo -e "${RED}  ✘ Container '$DB_CONTAINER' status: $STATUS${NC}"
    exit 1
fi
echo "  ✓ Container $DB_CONTAINER is running"

PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SHOW server_version_num;" 2>/dev/null | head -c 2)
[ -n "$PG_VERSION" ] || { echo -e "${RED}  ✘ Could not query PG version${NC}"; exit 1; }
if [ "$PG_VERSION" -ge "17" ]; then
    echo -e "${GREEN}  ✓ Already on PG${PG_VERSION}+. Nothing to do.${NC}"
    exit 0
fi
echo "  ✓ Current PG major: $PG_VERSION (will upgrade to 17)"

# Disk space: dump file + backup + new cluster + buffer = 3× data + 2 GB
DB_SIZE_KB=$(docker exec "$DB_CONTAINER" du -sk /var/lib/postgresql/data 2>/dev/null | cut -f1)
[ -n "$DB_SIZE_KB" ] || { echo -e "${RED}  ✘ Could not measure DB size${NC}"; exit 1; }
NEEDED_KB=$((DB_SIZE_KB * 3 + 2 * 1024 * 1024))
AVAILABLE_KB=$(df -k . | awk 'NR==2 {print $4}')
DB_SIZE_MB=$((DB_SIZE_KB / 1024))
NEEDED_MB=$((NEEDED_KB / 1024))
AVAILABLE_MB=$((AVAILABLE_KB / 1024))
if [ "$AVAILABLE_KB" -lt "$NEEDED_KB" ]; then
    echo -e "${RED}  ✘ Insufficient disk: need ${NEEDED_MB}MB, have ${AVAILABLE_MB}MB${NC}"
    exit 1
fi
echo "  ✓ Disk: ${AVAILABLE_MB}MB available, ${NEEDED_MB}MB needed (DB ${DB_SIZE_MB}MB)"

INCOMPAT=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "
    SELECT extname FROM pg_extension
    WHERE extname IN ('timescaledb','plv8','plls','plcoffee','pgjwt');
" 2>/dev/null || true)
if [ -n "$INCOMPAT" ]; then
    echo -e "${RED}  ✘ Incompatible extensions present:${NC}"
    echo "$INCOMPAT" | sed 's/^/      /'
    exit 1
fi
echo "  ✓ No incompatible extensions"

SLOT_COUNT=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SELECT count(*) FROM pg_replication_slots;" 2>/dev/null || echo "0")
echo "  ✓ Replication slots: $SLOT_COUNT"

[ -d "$DATA_DIR" ] || {
    echo -e "${RED}  ✘ Bind-mount data dir not found at $DATA_DIR${NC}"
    echo "    The volume migration step (named → bind) must have run."
    echo "    If your data is still in the named volume only, re-run a previous"
    echo "    version of this script that performs the volume migration."
    exit 1
}
echo "  ✓ Bind-mount data dir present at $DATA_DIR"

# Recover from prior partial run
if [ -d "$MIGRATIONS_TMP" ]; then
    echo -e "${YELLOW}  ⚠ Found leftover $MIGRATIONS_TMP from previous attempt${NC}"
    if [ -d "$MIGRATIONS_DIR" ] && [ -z "$(ls -A "$MIGRATIONS_DIR" 2>/dev/null)" ]; then
        rm -rf "$MIGRATIONS_DIR"
        mv "$MIGRATIONS_TMP" "$MIGRATIONS_DIR"
        echo "    Restored migrations dir from previous attempt"
    fi
fi

if [ -d "$BACKUP_DIR" ]; then
    echo -e "${YELLOW}  ⚠ $BACKUP_DIR already exists${NC}"
    echo "    This is from a previous upgrade attempt. To roll back to PG15"
    echo "    using that backup:"
    echo "      docker compose down"
    echo "      sudo rm -rf $DATA_DIR"
    echo "      sudo mv $BACKUP_DIR $DATA_DIR"
    echo "      sudo rm -f $OVERRIDE_FILE"
    echo "      docker compose up -d"
    echo ""
    confirm "Delete existing $BACKUP_DIR and start a fresh upgrade?" || exit 0
    rm -rf "$BACKUP_DIR"
fi

[ -f "$DUMP_FILE" ] && rm -f "$DUMP_FILE"

echo ""

# ── 2. User confirmation ────────────────────────────────────
echo -e "${YELLOW}⚠️  This upgrade uses pg_dump + restore (not in-place pg_upgrade).${NC}"
echo -e "${YELLOW}    A VM-level snapshot is STRONGLY recommended.${NC}"
echo ""
echo "    Method:    dump from PG15 → fresh PG17 cluster → restore"
echo "    Disk use:  ${NEEDED_MB}MB during upgrade"
echo "    Backup:    $BACKUP_DIR (preserved, delete after ~3 days)"
echo "    Dump:      $DUMP_FILE (preserved, delete after ~3 days)"
echo "    Downtime:  ~3-5 minutes (DB; n8n + others slightly longer)"
echo ""
confirm "Continue with upgrade?" || { echo "Aborted."; exit 0; }

# ── 3. Dump PG15 database ────────────────────────────────────
echo -e "${GREEN}==> Dumping PG15 database to $DUMP_FILE${NC}"
mkdir -p "$(dirname "$DUMP_FILE")"

# Use pg_dump on `postgres` database (where all our app schemas live).
# --no-owner / --no-privileges: roles will be re-created by PG17's own
# init scripts (supabase/postgres entrypoint creates the standard
# anon/authenticated/service_role/supabase_admin), so we don't need
# to dump role definitions or owner mappings.
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_CONTAINER" \
    pg_dump -U postgres -h localhost -d postgres \
            --no-owner --no-privileges --clean --if-exists \
    > "$DUMP_FILE"

DUMP_BYTES=$(stat -c %s "$DUMP_FILE" 2>/dev/null || echo "0")
DUMP_HUMAN=$(du -h "$DUMP_FILE" 2>/dev/null | cut -f1)
[ "$DUMP_BYTES" -gt 1000 ] || {
    echo -e "${RED}  ✘ Dump file is suspiciously small ($DUMP_BYTES bytes). Aborting.${NC}"
    exit 1
}
echo "  ✓ Dump complete: $DUMP_HUMAN ($DUMP_BYTES bytes)"

# ── 4. Stop dependent services first (clean disconnects) ────
echo -e "${GREEN}==> Stopping dependent services${NC}"
docker compose stop n8n rest kong studio meta >/dev/null 2>&1 || true
echo "  ✓ Dependent services stopped"

# ── 5. Stop db, swap data dir, suppress auto-init ──────────
echo -e "${GREEN}==> Swapping PG15 → PG17 data directory${NC}"
docker compose stop db >/dev/null
mv "$DATA_DIR" "$BACKUP_DIR"
mkdir -p "$DATA_DIR"
echo "  ✓ Old data → $BACKUP_DIR"

# Move the migrations dir aside so the fresh PG17 cluster's
# docker-entrypoint-initdb.d sees an empty directory and runs initdb only.
# We restore it after the dump-restore is complete.
mv "$MIGRATIONS_DIR" "$MIGRATIONS_TMP"
mkdir -p "$MIGRATIONS_DIR"
echo "  ✓ Migrations dir aside (suppresses auto-init)"

# ── 6. Update override file with PG17 image + bind mount ────
echo -e "${GREEN}==> Writing $OVERRIDE_FILE with PG17 image${NC}"
cat > "$OVERRIDE_FILE" <<EOF
services:
  db:
    image: $PG17_IMAGE
    volumes:
      - ./volumes/db/data:/var/lib/postgresql/data
      - ./supabase/migrations:/docker-entrypoint-initdb.d
EOF
echo "  ✓ Override file updated"

# ── 7. Start fresh PG17 ─────────────────────────────────────
echo -e "${GREEN}==> Starting fresh PG17 cluster (initdb runs on empty data dir)${NC}"
docker compose up -d db >/dev/null

echo "    Waiting for PG17 to be ready..."
READY=0
for i in $(seq 1 120); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
        READY=1; break
    fi
    sleep 2
done
[ "$READY" = "1" ] || {
    echo -e "${RED}  ✘ PG17 didn't become ready in 240s${NC}"
    echo "    Check: docker logs $DB_CONTAINER"
    exit 1
}

NEW_VERSION=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SHOW server_version_num;" 2>/dev/null | head -c 2)
[ "$NEW_VERSION" = "17" ] || {
    echo -e "${RED}  ✘ Expected PG17, got PG$NEW_VERSION${NC}"
    exit 1
}
echo "  ✓ PG17 cluster initialized and running"

# ── 8. Restore dump ─────────────────────────────────────────
echo -e "${GREEN}==> Restoring dump into PG17${NC}"
echo "    (errors are logged to $RESTORE_LOG; many are harmless"
echo "     like 'extension already exists' or 'role already exists')"

# ON_ERROR_STOP=0 because the fresh PG17 cluster already has some
# Supabase-shipped roles/extensions and the restore will encounter
# benign "already exists" notices on a few CREATE statements.
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_CONTAINER" \
    psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=0 \
    < "$DUMP_FILE" > "$RESTORE_LOG" 2>&1 || true

# Surface error/fatal lines (filter out noisy NOTICE/INFO)
SERIOUS_ERRORS=$(grep -E '^(ERROR|FATAL):' "$RESTORE_LOG" \
    | grep -vE 'already exists|does not exist, skipping' \
    | head -20 || true)
if [ -n "$SERIOUS_ERRORS" ]; then
    echo -e "${YELLOW}  ⚠ Non-trivial errors during restore:${NC}"
    echo "$SERIOUS_ERRORS" | sed 's/^/      /'
    echo ""
    echo "    Full log: $RESTORE_LOG"
    echo "    Inspect, then either continue (data may be incomplete) or roll back."
    confirm "Continue despite these errors?" || {
        echo "Aborted. To roll back to PG15:"
        echo "  docker compose down"
        echo "  sudo rm -rf $DATA_DIR"
        echo "  sudo mv $BACKUP_DIR $DATA_DIR"
        echo "  rm -rf $MIGRATIONS_DIR && mv $MIGRATIONS_TMP $MIGRATIONS_DIR"
        echo "  sudo rm -f $OVERRIDE_FILE"
        echo "  docker compose up -d"
        exit 1
    }
else
    echo "  ✓ Restore completed without serious errors"
fi

# ── 9. Restore migrations dir ──────────────────────────────
rm -rf "$MIGRATIONS_DIR"
mv "$MIGRATIONS_TMP" "$MIGRATIONS_DIR"
echo "  ✓ Migrations dir restored"

# ── 10. Apply 007_pg17_compat.sql ──────────────────────────
echo -e "${GREEN}==> Applying 007_pg17_compat.sql${NC}"
if [ -f supabase/migrations/007_pg17_compat.sql ]; then
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_CONTAINER" \
        psql -U postgres -h localhost -d postgres \
        < supabase/migrations/007_pg17_compat.sql
    echo "  ✓ Applied"
else
    echo -e "${YELLOW}  ⚠ Migration file not found, skipping${NC}"
fi

# ── 11. Restart full stack + reload PostgREST ──────────────
echo -e "${GREEN}==> Starting full stack${NC}"
docker compose up -d >/dev/null

echo "    Waiting for db to settle..."
for i in $(seq 1 30); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 2
done

# PostgREST schema cache reload (sees the restored tables/functions)
docker kill --signal=SIGUSR1 "$(docker ps -q --filter name=rest)" >/dev/null 2>&1 || true

# ── 12. Verify ─────────────────────────────────────────────
echo -e "${GREEN}==> Verification${NC}"
echo ""
docker exec "$DB_CONTAINER" psql -U postgres -c "SELECT version();" || true
echo ""
echo "Row counts (compare to your pre-upgrade values):"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c "
    SELECT 'soul' as table_name, count(*) as rows FROM soul
    UNION ALL SELECT 'agents', count(*) FROM agents
    UNION ALL SELECT 'memory_long', count(*) FROM memory_long
    UNION ALL SELECT 'memory_daily', count(*) FROM memory_daily
    UNION ALL SELECT 'conversations', count(*) FROM conversations
    UNION ALL SELECT 'reminders', count(*) FROM reminders
    UNION ALL SELECT 'mcp_registry', count(*) FROM mcp_registry
    ORDER BY 1;
" 2>/dev/null || echo "  (some tables missing — check $RESTORE_LOG)"

echo ""
echo "Verify search_path fix on immutable_unaccent:"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -At -c "
    SELECT proname || ' search_path=' || COALESCE(array_to_string(proconfig, ','), 'NONE')
    FROM pg_proc WHERE proname = 'immutable_unaccent';
" 2>/dev/null || true

# ── 13. Done ───────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Upgrade complete!                          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Backup data dir: $BACKUP_DIR"
echo "  Backup dump:     $DUMP_FILE"
echo "  Restore log:     $RESTORE_LOG"
echo ""
echo "  After 2-3 days of verified live operation, clean up with:"
echo "    sudo rm -rf $BACKUP_DIR $DUMP_FILE $RESTORE_LOG"
echo ""
echo "  Override file:   $OVERRIDE_FILE (gitignored — keeps PG17 active)"
echo ""
