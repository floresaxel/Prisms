#!/usr/bin/env bash
# Prisms restore — load a pg_dump (-Fc) back into Postgres, then PowerSync
# re-replicates and clients re-sync. §5, §15.
#
#   ./scripts/restore.sh <dump-file>
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file>}"
COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
DB_USER="${POSTGRES_USER:-prisms}"
DB_NAME="${POSTGRES_DB:-prisms}"

[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

echo "→ stopping api so no command applies mid-restore"
$COMPOSE stop api

echo "→ restoring $DUMP into $DB_NAME (existing objects are dropped + recreated)"
$COMPOSE exec -T postgres pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner < "$DUMP"

echo "→ starting api"
$COMPOSE start api
echo "✓ restore complete — PowerSync will re-replicate; restart it if needed:"
echo "  $COMPOSE restart powersync"
