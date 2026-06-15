#!/usr/bin/env bash
# Prisms backup — pg_dump the Postgres source of truth (the only durable state;
# PowerSync storage + client SQLite are derived and rebuild from it). §5, §15.
#
#   ./scripts/backup.sh [output-dir]   # default: ./backups
set -euo pipefail

OUT_DIR="${1:-./backups}"
COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
DB_USER="${POSTGRES_USER:-prisms}"
DB_NAME="${POSTGRES_DB:-prisms}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/prisms-$DB_NAME-$STAMP.dump"

echo "→ dumping $DB_NAME to $OUT"
$COMPOSE exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$OUT"
echo "✓ backup complete: $OUT ($(du -h "$OUT" | cut -f1))"
