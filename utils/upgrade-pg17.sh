#!/usr/bin/env bash
#
# n8n-claw Postgres 15 → 17 Upgrade (v3 — pg_dump + restore)
#
# How this works:
#   1. Dump from the running PG15 container.
#   2. Backup the named Docker volume to a host bind dir for rollback.
#   3. Wipe the named volume.
#   4. Start a fresh PG17 container as a STANDALONE (docker run, not compose).
#      Critical: we do NOT mount our supabase/migrations into
#      /docker-entrypoint-initdb.d. That keeps the supabase/postgres:17
#      image's BAKED-IN init scripts visible — those create the standard
#      roles (supabase_admin, anon, authenticated, service_role,
#      authenticator, dashboard_user, supabase_*_admin, ...) that our
#      dump's CREATE statements implicitly depend on.
#   5. Restore the dump into the fresh PG17 cluster.
#   6. Apply 007_pg17_compat.sql for forward-compat (safe search_path on
#      immutable_unaccent).
#   7. Stop the standalone container, write a docker-compose.override.yml
#      with the PG17 image tag, and bring up the full stack via compose.
#   8. Verify.
#
# Why NOT in-place pg_upgrade with Supabase's official upgrade-pg17.sh:
#   That script hard-requires a `db-config` Docker volume + a pgsodium_root.key
#   inside it — both only exist in Supabase's full self-host stack
#   (auth/realtime/vault). n8n-claw doesn't ship those, so the upstream
#   tool can't run for us.
#
# Why dump-restore is fine for n8n-claw:
#   - Typical n8n-claw DB is small (< 1 GB)
#   - Simple schema (no cross-schema triggers, no vault encryption)
#   - All extensions (uuid-ossp, vector, unaccent) ship in
#     supabase/postgres:17, so CREATE EXTENSION in the dump just works
#   - Original PG15 data is preserved as a host-side backup for instant
#     rollback
#
# Usage (must be run as root or with sudo):
#   sudo ./utils/upgrade-pg17.sh           # interactive
#   sudo ./utils/upgrade-pg17.sh --yes     # auto-confirm
#
# Run from the n8n-claw repository root.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
DB_CONTAINER="n8n-claw-db"
DB_TMP_CONTAINER="n8n-claw-db-pg17-init"
DB_VOLUME="n8n-claw_db_data"
COMPOSE_NETWORK="n8n-claw_n8n-claw-net"
PG17_IMAGE="supabase/postgres:17.6.1.063"
BACKUP_DIR="./volumes/db/data.bak.pg15"
DUMP_FILE="./volumes/db/dump_pg15.sql"
RESTORE_LOG="./volumes/db/upgrade-pg17-restore.log"
OVERRIDE_FILE="docker-compose.override.yml"
LEGACY_DATA_DIR="./volumes/db/data"   # leftover from earlier wrapper versions

AUTO_CONFIRM=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_CONFIRM=true ;;
    esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Sanity ────────────────────────────────────────────────────
[ "$(id -u)" = "0" ] || { echo -e "${RED}Run as root or with sudo${NC}" >&2; exit 1; }

for cmd in docker; do
    command -v "$cmd" >/dev/null 2>&1 || { echo -e "${RED}$cmd is required${NC}" >&2; exit 1; }
done

[ -f docker-compose.yml ] || { echo -e "${RED}Run from n8n-claw repo root${NC}" >&2; exit 1; }
[ -f .env ] || { echo -e "${RED}.env not found${NC}" >&2; exit 1; }

# Read POSTGRES_PASSWORD from .env, strip surrounding quotes if any
POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | head -n 1 | cut -d= -f2- | sed -E 's/^["'\''](.*)["'\'']$/\1/')
[ -n "$POSTGRES_PASSWORD" ] || { echo -e "${RED}POSTGRES_PASSWORD not set in .env${NC}" >&2; exit 1; }

confirm() {
    [ "$AUTO_CONFIRM" = "true" ] && return 0
    read -rp "$1 (y/N): " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
}

cleanup_tmp_container() {
    docker rm -f "$DB_TMP_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup_tmp_container EXIT

echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  n8n-claw Postgres 15 → 17 Upgrade            ║${NC}"
echo -e "${CYAN}║  (pg_dump + restore via docker run)            ║${NC}"
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
[ "$STATUS" = "running" ] || { echo -e "${RED}  ✘ '$DB_CONTAINER' status: $STATUS${NC}"; exit 1; }
echo "  ✓ $DB_CONTAINER is running"

PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U postgres -At -c "SHOW server_version_num;" 2>/dev/null | head -c 2)
[ -n "$PG_VERSION" ] || { echo -e "${RED}  ✘ Could not query PG version${NC}"; exit 1; }
if [ "$PG_VERSION" -ge "17" ]; then
    echo -e "${GREEN}  ✓ Already on PG${PG_VERSION}+. Nothing to do.${NC}"
    exit 0
fi
echo "  ✓ Current PG major: $PG_VERSION (will upgrade to 17)"

# Check named volume exists
docker volume inspect "$DB_VOLUME" >/dev/null 2>&1 || {
    echo -e "${RED}  ✘ Docker volume '$DB_VOLUME' not found${NC}"
    exit 1
}
echo "  ✓ Named volume $DB_VOLUME present"

# Disk: dump file + backup dir + buffer = 3× DB size + 2 GB
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

# Ensure compose network exists (needed for tmp container if we ever want services)
docker network inspect "$COMPOSE_NETWORK" >/dev/null 2>&1 || {
    echo -e "${YELLOW}  ⚠ Network $COMPOSE_NETWORK not found (will work but is unusual)${NC}"
}

# Detect & offer to clean up leftovers from earlier wrapper attempts
LEFTOVERS=()
[ -d "$LEGACY_DATA_DIR" ] && LEFTOVERS+=("$LEGACY_DATA_DIR (stale bind dir from earlier wrapper version)")
[ -f "$DUMP_FILE" ] && LEFTOVERS+=("$DUMP_FILE (stale dump from prior attempt)")
[ -f "$RESTORE_LOG" ] && LEFTOVERS+=("$RESTORE_LOG (stale restore log)")
[ -f "$OVERRIDE_FILE" ] && LEFTOVERS+=("$OVERRIDE_FILE (will be regenerated)")

if [ "${#LEFTOVERS[@]}" -gt 0 ]; then
    echo -e "${YELLOW}  ⚠ Leftover artefacts from previous attempts:${NC}"
    for item in "${LEFTOVERS[@]}"; do echo "      - $item"; done
    echo ""
    confirm "  Delete these and proceed?" || { echo "Aborted."; exit 0; }
    [ -d "$LEGACY_DATA_DIR" ] && rm -rf "$LEGACY_DATA_DIR"
    [ -f "$DUMP_FILE" ] && rm -f "$DUMP_FILE"
    [ -f "$RESTORE_LOG" ] && rm -f "$RESTORE_LOG"
    [ -f "$OVERRIDE_FILE" ] && rm -f "$OVERRIDE_FILE"
fi

# Refuse if a backup from a previous attempt already exists
if [ -d "$BACKUP_DIR" ]; then
    echo -e "${YELLOW}  ⚠ $BACKUP_DIR exists (from previous attempt)${NC}"
    echo "    To roll back to PG15 using that backup:"
    echo "      docker compose down"
    echo "      docker run --rm -v $DB_VOLUME:/dst -v \$(pwd)/$BACKUP_DIR:/src:ro alpine \\"
    echo "         sh -c 'rm -rf /dst/* /dst/.[!.]* 2>/dev/null; cp -a /src/. /dst/'"
    echo "      sudo rm -rf $BACKUP_DIR"
    echo "      rm -f $OVERRIDE_FILE"
    echo "      docker compose up -d"
    echo ""
    confirm "  Delete existing $BACKUP_DIR and start a fresh upgrade?" || exit 0
    rm -rf "$BACKUP_DIR"
fi

mkdir -p ./volumes/db

echo ""

# ── 2. User confirmation ────────────────────────────────────
echo -e "${YELLOW}⚠️  This upgrade uses pg_dump + restore (not in-place pg_upgrade).${NC}"
echo -e "${YELLOW}    A VM-level snapshot is STRONGLY recommended.${NC}"
echo ""
echo "    Method:    dump from PG15 → fresh PG17 (standalone) → restore → switch to compose"
echo "    Disk use:  ${NEEDED_MB}MB during upgrade"
echo "    Backup:    $BACKUP_DIR (preserved, delete after ~3 days)"
echo "    Dump:      $DUMP_FILE (preserved, delete after ~3 days)"
echo "    Downtime:  ~3-5 minutes"
echo ""
confirm "Continue with upgrade?" || { echo "Aborted."; exit 0; }

# ── 3. Dump PG15 ─────────────────────────────────────────────
echo -e "${GREEN}==> Dumping PG15 database${NC}"
# Use Unix socket (no -h) — always available regardless of TCP-listening state
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_CONTAINER" \
    pg_dump -U postgres -d postgres \
            --no-owner --no-privileges --clean --if-exists \
    > "$DUMP_FILE"

DUMP_BYTES=$(stat -c %s "$DUMP_FILE" 2>/dev/null || echo "0")
DUMP_HUMAN=$(du -h "$DUMP_FILE" 2>/dev/null | cut -f1)
[ "$DUMP_BYTES" -gt 1000 ] || {
    echo -e "${RED}  ✘ Dump file too small ($DUMP_BYTES bytes)${NC}"
    exit 1
}
echo "  ✓ Dump complete: $DUMP_HUMAN ($DUMP_BYTES bytes)"

# ── 4. Stop dependent services + db ──────────────────────────
echo -e "${GREEN}==> Stopping services${NC}"
docker compose stop n8n rest kong studio meta >/dev/null 2>&1 || true
docker compose stop db >/dev/null
echo "  ✓ db + dependent services stopped"

# ── 5. Backup named volume to host bind dir ──────────────────
echo -e "${GREEN}==> Backing up PG15 data → $BACKUP_DIR${NC}"
docker run --rm \
    -v "$DB_VOLUME:/from:ro" \
    -v "$(pwd)/volumes/db:/dst" \
    alpine sh -c "cp -a /from /dst/data.bak.pg15"
echo "  ✓ Backup written"

# ── 6. Wipe named volume ─────────────────────────────────────
echo -e "${GREEN}==> Wiping named volume for fresh PG17 init${NC}"
docker run --rm -v "$DB_VOLUME:/data" alpine sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null || true"
echo "  ✓ Volume wiped"

# ── 7. Start fresh PG17 standalone ───────────────────────────
# Critical setup choices:
#   - Mount our supabase/migrations into /docker-entrypoint-initdb.d so OUR
#     000_extensions.sql + 001_schema.sql etc. run during init. This builds
#     the same role/schema layout the live PG15 has (postgres + supabase_admin
#     + anon + authenticated + service_role + uuid-ossp + vector + unaccent),
#     and CRUCIALLY HIDES the supabase/postgres image's own baked-in init at
#     /docker-entrypoint-initdb.d/init-scripts/ + migrate.sh + migrations/.
#     The baked-in init creates pg_graphql with an event trigger that fires
#     on every DDL statement — during a 277 MB restore that means tens of
#     thousands of trigger fires, and supautils eventually pg_terminate_backend's
#     the restore session. By suppressing the baked-in init we get a minimal
#     cluster matching the source PG15 exactly: 4 extensions, 0 event triggers,
#     only public schema.
#   - POSTGRES_USER=postgres so that the Docker entrypoint creates `postgres`
#     as the initdb superuser (matches docker-compose.yml). Without this, the
#     image defaults to `supabase_admin` as superuser and our migrations'
#     ALTER FUNCTION ... OWNER TO postgres clauses would fail.
echo -e "${GREEN}==> Starting fresh PG17 cluster (standalone with our migrations)${NC}"
docker run -d --name "$DB_TMP_CONTAINER" \
    --network "$COMPOSE_NETWORK" \
    -v "$DB_VOLUME:/var/lib/postgresql/data" \
    -v "$(pwd)/supabase/migrations:/docker-entrypoint-initdb.d:ro" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -e POSTGRES_DB=postgres \
    "$PG17_IMAGE" >/dev/null

echo "    Waiting for init to complete (initdb + our migrations 000-007)..."

# Readiness signal: pg_isready accepts connections + supabase_admin role
# exists (created by 000_extensions.sql, very early in our migration chain).
# In testing this typically takes ~5s.
READY=0
for i in $(seq 1 120); do
    if docker exec "$DB_TMP_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
        ROLE_COUNT=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
            psql -U postgres -At -c "SELECT count(*) FROM pg_roles WHERE rolname='supabase_admin';" 2>/dev/null || echo "0")
        if [ "$ROLE_COUNT" = "1" ]; then
            READY=1; break
        fi
    fi
    sleep 2
done

if [ "$READY" != "1" ]; then
    echo -e "${RED}  ✘ Fresh PG17 didn't become ready in 240s${NC}"
    echo "    Check: docker logs $DB_TMP_CONTAINER"
    exit 1
fi

NEW_VERSION=$(docker exec "$DB_TMP_CONTAINER" psql -U postgres -At -c "SHOW server_version_num;" 2>/dev/null | head -c 2)
[ "$NEW_VERSION" = "17" ] || {
    echo -e "${RED}  ✘ Expected PG17, got PG$NEW_VERSION${NC}"
    exit 1
}

# Sanity check the cluster matches what we expect: no event triggers (pg_graphql)
# and only the schemas/extensions our migrations create.
EVT_COUNT=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
    psql -U postgres -d postgres -At -c "SELECT count(*) FROM pg_event_trigger;" 2>/dev/null || echo "?")
if [ "$EVT_COUNT" != "0" ]; then
    echo -e "${YELLOW}  ⚠ Unexpected event triggers in fresh cluster ($EVT_COUNT). The supabase baked-in init may have leaked through and could interfere with restore.${NC}"
    confirm "  Continue anyway?" || { docker stop "$DB_TMP_CONTAINER" >/dev/null; exit 1; }
fi
echo "  ✓ Fresh PG17 cluster ready (postgres superuser, $EVT_COUNT event triggers)"

# ── 8. Restore dump ──────────────────────────────────────────
echo -e "${GREEN}==> Restoring dump into PG17${NC}"
# Use Unix socket (no -h) — connection-refused on TCP during the brief
# window between socket-ready and TCP-ready was the bug in v3.
docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=0 \
    < "$DUMP_FILE" > "$RESTORE_LOG" 2>&1 || true

# Hard-fail on connection issues — these indicate the restore never ran.
if grep -qE 'connection.*refused|server.*not.*running|could not connect' "$RESTORE_LOG"; then
    echo -e "${RED}  ✘ Restore failed to connect to PG17 — dump never applied.${NC}"
    echo "    Log excerpt:"
    grep -iE 'error|refused|fail' "$RESTORE_LOG" | head -10 | sed 's/^/      /'
    echo ""
    echo "    Original PG15 data is preserved at $BACKUP_DIR."
    echo "    Roll back to PG15:"
    echo "      docker stop $DB_TMP_CONTAINER && docker rm $DB_TMP_CONTAINER"
    echo "      docker run --rm -v $DB_VOLUME:/dst -v \$(pwd)/$BACKUP_DIR:/src:ro alpine \\"
    echo "         sh -c 'rm -rf /dst/* /dst/.[!.]* 2>/dev/null; cp -a /src/. /dst/'"
    echo "      rm -f $OVERRIDE_FILE"
    echo "      docker compose up -d"
    exit 1
fi

# Surface other errors (filter out benign "already exists" / "does not exist, skipping")
REAL_ERRORS=$(grep -E '^(ERROR|FATAL):' "$RESTORE_LOG" \
    | grep -vE 'already exists|does not exist, skipping' \
    | head -20 || true)
if [ -n "$REAL_ERRORS" ]; then
    echo -e "${YELLOW}  ⚠ Errors during restore (full log: $RESTORE_LOG):${NC}"
    echo "$REAL_ERRORS" | sed 's/^/      /'
    echo ""
    confirm "  Continue despite errors?" || {
        echo ""
        echo "Aborted. Roll back to PG15:"
        echo "  docker stop $DB_TMP_CONTAINER && docker rm $DB_TMP_CONTAINER"
        echo "  docker run --rm -v $DB_VOLUME:/dst -v \$(pwd)/$BACKUP_DIR:/src:ro alpine \\"
        echo "     sh -c 'rm -rf /dst/* /dst/.[!.]* 2>/dev/null; cp -a /src/. /dst/'"
        echo "  rm -f $OVERRIDE_FILE"
        echo "  docker compose up -d"
        exit 1
    }
else
    echo "  ✓ Restore completed without serious errors"
fi

# Sanity check: verify our app tables actually got data restored.
# If the restore silently failed (e.g. transaction abort, connection loss),
# the cluster would have only baked-in tables → row count below threshold.
SOUL_COUNT=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
    psql -U postgres -d postgres -At -c "SELECT count(*) FROM public.soul;" 2>/dev/null || echo "0")
MEM_COUNT=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
    psql -U postgres -d postgres -At -c "SELECT count(*) FROM public.memory_long;" 2>/dev/null || echo "0")

if [ "$SOUL_COUNT" = "0" ] || [ -z "$SOUL_COUNT" ]; then
    echo -e "${RED}  ✘ Sanity check failed: public.soul has 0 rows after restore.${NC}"
    echo "    The restore did not apply your app data. PG15 backup is intact."
    echo "    Inspect $RESTORE_LOG, then roll back as above."
    exit 1
fi
echo "  ✓ Sanity check passed: soul=$SOUL_COUNT rows, memory_long=$MEM_COUNT rows"

# ── 9. Apply 007 compat migration ────────────────────────────
echo -e "${GREEN}==> Applying 007_pg17_compat.sql${NC}"
if [ -f supabase/migrations/007_pg17_compat.sql ]; then
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$DB_TMP_CONTAINER" \
        psql -U postgres -d postgres < supabase/migrations/007_pg17_compat.sql
    echo "  ✓ Applied"
else
    echo -e "${YELLOW}  ⚠ Migration not found, skipped${NC}"
fi

# ── 10. Stop standalone, switch to compose with PG17 image ───
echo -e "${GREEN}==> Switching from standalone container to compose stack${NC}"
docker stop "$DB_TMP_CONTAINER" >/dev/null
docker rm "$DB_TMP_CONTAINER" >/dev/null
trap - EXIT

cat > "$OVERRIDE_FILE" <<EOF
services:
  db:
    image: $PG17_IMAGE
EOF
echo "  ✓ Wrote $OVERRIDE_FILE"

docker compose up -d >/dev/null

echo "    Waiting for db to be ready..."
for i in $(seq 1 60); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 2
done

# PostgREST schema cache reload
docker kill --signal=SIGUSR1 "$(docker ps -q --filter name=rest)" >/dev/null 2>&1 || true

# ── 11. Verify ──────────────────────────────────────────────
echo -e "${GREEN}==> Verification${NC}"
echo ""
docker exec "$DB_CONTAINER" psql -U postgres -c "SELECT version();" || true
echo ""
echo "Row counts:"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c "
    SELECT 'soul' as tbl, count(*) as rows FROM soul
    UNION ALL SELECT 'agents', count(*) FROM agents
    UNION ALL SELECT 'memory_long', count(*) FROM memory_long
    UNION ALL SELECT 'memory_daily', count(*) FROM memory_daily
    UNION ALL SELECT 'conversations', count(*) FROM conversations
    UNION ALL SELECT 'reminders', count(*) FROM reminders
    UNION ALL SELECT 'mcp_registry', count(*) FROM mcp_registry
    UNION ALL SELECT 'workflow_entity', count(*) FROM workflow_entity
    ORDER BY 1;
" 2>/dev/null || echo "  (check $RESTORE_LOG for issues)"

echo ""
echo "immutable_unaccent search_path config (007 fix):"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -At -c "
    SELECT proname || ' search_path=' || COALESCE(array_to_string(proconfig,','),'NONE')
    FROM pg_proc WHERE proname = 'immutable_unaccent';
" 2>/dev/null || true

# ── 12. Done ────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ Upgrade complete!                          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Backup:      $BACKUP_DIR"
echo "  Dump:        $DUMP_FILE"
echo "  Restore log: $RESTORE_LOG"
echo "  Override:    $OVERRIDE_FILE (gitignored, keeps PG17 active)"
echo ""
echo "  After 2-3 days of verified live operation, clean up:"
echo "    sudo rm -rf $BACKUP_DIR $DUMP_FILE $RESTORE_LOG"
echo ""
