#!/usr/bin/env bash
#
# n8n-claw Postgres 15 → 17 Upgrade Wrapper
#
# Delegates the heavy lifting (PG17 binary extraction, pg_upgrade orchestration,
# data-dir swap) to Supabase's official upgrade-pg17.sh, fetched at runtime
# from a pinned commit. This wrapper handles the n8n-claw-specific bits:
#   - Container name (n8n-claw-db, not the upstream supabase-db)
#   - Volume layout migration (named volume → bind mount)
#   - docker-compose.pg17.yml + docker-compose.override.yml management
#   - Post-upgrade migration application (007_pg17_compat.sql)
#   - PostgREST schema cache reload
#
# Usage (must be run as root or with sudo):
#   sudo ./utils/upgrade-pg17.sh           # interactive
#   sudo ./utils/upgrade-pg17.sh --yes     # auto-confirm
#
# Run from the n8n-claw repository root.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
# Pinned Supabase commit hash for upstream upgrade-pg17.sh.
# Bump this after testing a newer version against this wrapper.
SUPABASE_COMMIT="cf9d88700d9753308068982224e991de5f0dd1c1"
SUPABASE_SCRIPT_URL="https://raw.githubusercontent.com/supabase/supabase/${SUPABASE_COMMIT}/docker/utils/upgrade-pg17.sh"

DB_CONTAINER="n8n-claw-db"
DB_VOLUME="n8n-claw_db_data"
PG17_IMAGE="supabase/postgres:17.6.1.063"
DATA_DIR="./volumes/db/data"
BACKUP_DIR="./volumes/db/data.bak.pg15"
PG17_OVERLAY="docker-compose.pg17.yml"
PERMANENT_OVERRIDE="docker-compose.override.yml"

AUTO_CONFIRM=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_CONFIRM=true ;;
    esac
done

# ── Colors ──────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Sanity checks ───────────────────────────────────────────
if [ "$(id -u)" != "0" ]; then
    echo -e "${RED}Error: Run as root or with sudo${NC}" >&2
    exit 1
fi

for cmd in docker curl sed; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${RED}Error: $cmd is required${NC}" >&2
        exit 1
    fi
done

[ -f docker-compose.yml ] || {
    echo -e "${RED}Error: Run from the n8n-claw repository root${NC}" >&2
    exit 1
}

confirm() {
    [ "$AUTO_CONFIRM" = "true" ] && return 0
    read -rp "$1 (y/N): " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  n8n-claw Postgres 15 → 17 Upgrade            ║${NC}"
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
    echo -e "${RED}  ✘ Container '$DB_CONTAINER' is not running (status: $STATUS).${NC}"
    exit 1
fi
echo "  ✓ Container $DB_CONTAINER is running"

PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SHOW server_version_num;" 2>/dev/null | head -c 2)
if [ -z "$PG_VERSION" ]; then
    echo -e "${RED}  ✘ Could not query PG version from container${NC}"
    exit 1
fi
if [ "$PG_VERSION" -ge "17" ]; then
    echo -e "${GREEN}  ✓ Already on PostgreSQL ${PG_VERSION}+. Nothing to do.${NC}"
    exit 0
fi
echo "  ✓ Current PG major version: $PG_VERSION (will upgrade to 17)"

# Disk space: 2× DB size + 5 GB
DB_SIZE_KB=$(docker exec "$DB_CONTAINER" du -sk /var/lib/postgresql/data 2>/dev/null | cut -f1)
[ -n "$DB_SIZE_KB" ] || { echo -e "${RED}  ✘ Could not measure DB size${NC}"; exit 1; }
REQUIRED_KB=$((DB_SIZE_KB * 2 + 5 * 1024 * 1024))
AVAILABLE_KB=$(df -k . | awk 'NR==2 {print $4}')
DB_SIZE_MB=$((DB_SIZE_KB / 1024))
REQUIRED_MB=$((REQUIRED_KB / 1024))
AVAILABLE_MB=$((AVAILABLE_KB / 1024))
if [ "$AVAILABLE_KB" -lt "$REQUIRED_KB" ]; then
    echo -e "${RED}  ✘ Insufficient disk space: need ${REQUIRED_MB}MB, have ${AVAILABLE_MB}MB${NC}"
    exit 1
fi
echo "  ✓ Disk: ${AVAILABLE_MB}MB available, ${REQUIRED_MB}MB needed (DB size ${DB_SIZE_MB}MB)"

# Incompatible extensions (Supabase strips these from PG17 image)
INCOMPAT=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "
    SELECT extname FROM pg_extension
    WHERE extname IN ('timescaledb','plv8','plls','plcoffee','pgjwt');
" 2>/dev/null || true)
if [ -n "$INCOMPAT" ]; then
    echo -e "${RED}  ✘ Incompatible extensions found (must be removed first):${NC}"
    echo "$INCOMPAT" | sed 's/^/      /'
    exit 1
fi
echo "  ✓ No incompatible extensions"

SLOT_COUNT=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SELECT count(*) FROM pg_replication_slots;" 2>/dev/null || echo "0")
echo "  ✓ Replication slots: $SLOT_COUNT (will be dropped)"

VOLUME_FOUND=""
if docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
    VOLUME_FOUND="$DB_VOLUME"
fi

echo ""

# ── 2. User confirmation ────────────────────────────────────
echo -e "${YELLOW}⚠️  This will upgrade your database from PG15 to PG17.${NC}"
echo -e "${YELLOW}    A VM-level snapshot (Hetzner / similar) is STRONGLY recommended.${NC}"
echo ""
echo "    Disk space: ${REQUIRED_MB}MB will be used during upgrade"
echo "    Backup location: $BACKUP_DIR (preserved, delete after ~3 days verified)"
echo "    Downtime: ~2-5 minutes"
echo ""
confirm "Continue with upgrade?" || { echo "Aborted."; exit 0; }

# ── 3. Volume migration: named → bind mount ─────────────────
if [ -n "$VOLUME_FOUND" ] && [ ! -d "$DATA_DIR" ]; then
    echo -e "${GREEN}==> Migrating named volume → bind mount${NC}"
    echo "    From: $DB_VOLUME (Docker named volume)"
    echo "    To:   $DATA_DIR (host bind mount)"

    docker compose stop db >/dev/null
    mkdir -p volumes/db
    docker run --rm \
        -v "$DB_VOLUME:/from:ro" \
        -v "$(pwd)/volumes/db/data:/to" \
        alpine sh -c "cp -a /from/. /to/"

    # Override that bind-mounts the new path. Other db-service config
    # (image, env, healthcheck) stays in docker-compose.yml.
    cat > "$PERMANENT_OVERRIDE" <<EOF
services:
  db:
    volumes:
      - ./volumes/db/data:/var/lib/postgresql/data
      - ./supabase/migrations:/docker-entrypoint-initdb.d
EOF

    docker compose up -d db >/dev/null
    echo "    Waiting for db to be ready..."
    for i in {1..30}; do
        if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
        sleep 2
    done
    echo "  ✓ Volume migrated"
fi

# ── 4. Drop replication slots (defensive) ───────────────────
if [ "$SLOT_COUNT" -gt "0" ]; then
    echo -e "${GREEN}==> Dropping replication slots${NC}"
    docker exec "$DB_CONTAINER" psql -U postgres -c "
        SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots;
    " >/dev/null
    echo "  ✓ Slots dropped"
fi

# ── 5. Generate docker-compose.pg17.yml (Supabase script expects this) ──
echo -e "${GREEN}==> Generating $PG17_OVERLAY${NC}"
cat > "$PG17_OVERLAY" <<EOF
# Generated by utils/upgrade-pg17.sh — temporary overlay used during upgrade.
# After successful upgrade, contents are merged into $PERMANENT_OVERRIDE
# and this file is removed.
services:
  db:
    image: $PG17_IMAGE
EOF
echo "  ✓ Wrote $PG17_OVERLAY"

# ── 6. Fetch and patch Supabase upgrade-pg17.sh ─────────────
echo -e "${GREEN}==> Fetching Supabase upgrade-pg17.sh (commit ${SUPABASE_COMMIT:0:8})${NC}"
TMP_SCRIPT=$(mktemp /tmp/supabase-upgrade-pg17-XXXXXX.sh)
trap "rm -f $TMP_SCRIPT" EXIT

if ! curl -fsSL "$SUPABASE_SCRIPT_URL" > "$TMP_SCRIPT"; then
    echo -e "${RED}  ✘ Failed to download script from $SUPABASE_SCRIPT_URL${NC}"
    exit 1
fi

# Patch container name for n8n-claw
sed -i 's/DB_CONTAINER="supabase-db"/DB_CONTAINER="n8n-claw-db"/' "$TMP_SCRIPT"

# Sanity check: did the patch land?
if ! grep -q 'DB_CONTAINER="n8n-claw-db"' "$TMP_SCRIPT"; then
    echo -e "${RED}  ✘ Script patch failed — Supabase upstream may have changed.${NC}"
    echo "    Inspect $TMP_SCRIPT manually and adjust the sed pattern in this wrapper."
    exit 1
fi
echo "  ✓ Script downloaded and patched ($(wc -l < "$TMP_SCRIPT") lines)"

echo ""
echo -e "${YELLOW}    Patched script: $TMP_SCRIPT${NC}"
echo -e "${YELLOW}    Inspect it before continuing if you want.${NC}"
confirm "Run the patched Supabase upgrade script now?" || {
    echo "Aborted. Original DB unchanged. Cleaning up overlay file."
    rm -f "$PG17_OVERLAY"
    exit 0
}

# ── 7. Run Supabase script ──────────────────────────────────
echo -e "${GREEN}==> Running Supabase upgrade-pg17.sh${NC}"
if ! bash "$TMP_SCRIPT" --yes; then
    echo -e "${RED}  ✘ Supabase script failed.${NC}"
    echo "    Original data preserved at $BACKUP_DIR if the script reached the swap step."
    echo "    For rollback, see the comments at the top of $TMP_SCRIPT."
    exit 1
fi

# ── 8. Finalize override file ───────────────────────────────
echo -e "${GREEN}==> Finalizing override file${NC}"
if [ -f "$PERMANENT_OVERRIDE" ]; then
    if grep -qE "^[[:space:]]+image:" "$PERMANENT_OVERRIDE"; then
        sed -i "s|^\([[:space:]]*\)image:.*|\1image: $PG17_IMAGE|" "$PERMANENT_OVERRIDE"
    else
        # Insert image: line right after `db:` heading
        sed -i "/^  db:/a\    image: $PG17_IMAGE" "$PERMANENT_OVERRIDE"
    fi
else
    cat > "$PERMANENT_OVERRIDE" <<EOF
services:
  db:
    image: $PG17_IMAGE
EOF
fi
rm -f "$PG17_OVERLAY"
echo "  ✓ $PERMANENT_OVERRIDE updated, $PG17_OVERLAY removed"

# ── 9. Restart and apply post-upgrade migration ─────────────
echo -e "${GREEN}==> Restarting stack with PG17 image${NC}"
docker compose down >/dev/null
docker compose up -d >/dev/null

echo "    Waiting for db to be ready..."
for i in {1..60}; do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 2
done

echo -e "${GREEN}==> Applying 007_pg17_compat.sql${NC}"
if [ -f supabase/migrations/007_pg17_compat.sql ]; then
    docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres < supabase/migrations/007_pg17_compat.sql
    echo "  ✓ Migration applied"
else
    echo -e "${YELLOW}  ⚠ supabase/migrations/007_pg17_compat.sql not found, skipped${NC}"
fi

# Reload PostgREST schema cache
docker kill --signal=SIGUSR1 $(docker ps -q --filter name=rest) >/dev/null 2>&1 || true

# ── 10. Verify ──────────────────────────────────────────────
echo -e "${GREEN}==> Verification${NC}"
docker exec "$DB_CONTAINER" psql -U postgres -c "SELECT version();" || true

# ── 11. Done ────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Upgrade complete!                          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Backup preserved at: $BACKUP_DIR"
echo "  After 2-3 days of verified live operation, delete with:"
echo "    sudo rm -rf $BACKUP_DIR"
echo ""
echo "  Override file:       $PERMANENT_OVERRIDE (gitignored, do not delete)"
echo ""
