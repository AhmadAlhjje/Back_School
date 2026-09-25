#!/usr/bin/env bash
# Proves the latest backup is restorable: restores it into a scratch database, compares row
# counts of key tables with the live database, then drops the scratch database.
# Schedule weekly; a non-zero exit code must alert the operator.
#
# Usage:   verify-backup.sh [backup.sql.gz]   (default: newest file in $BACKUP_DIR/daily)
# Env:     same as backup.sh / restore.sh;  VERIFY_DB (default ${DB_NAME}_restore_check)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/edu-platform}"
VERIFY_DB="${VERIFY_DB:-${DB_NAME}_restore_check}"
MYSQL="${MYSQL:-mysql}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

BACKUP_FILE="${1:-$(ls -1t "$BACKUP_DIR"/daily/*.sql.gz 2>/dev/null | head -n1 || true)}"
[ -n "$BACKUP_FILE" ] || { echo "No backup found in $BACKUP_DIR/daily"; exit 1; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

OPTS_FILE="$(mktemp)"
cleanup() {
  # Drop the scratch database first — it needs the credentials file — then remove the file.
  "$MYSQL" --defaults-extra-file="$OPTS_FILE" -e "DROP DATABASE IF EXISTS \`${VERIFY_DB}\`" 2>/dev/null || true
  rm -f "$OPTS_FILE"
}
trap cleanup EXIT
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" > "$OPTS_FILE"

"$SCRIPT_DIR/restore.sh" "$BACKUP_FILE" "$VERIFY_DB" --force

count() { "$MYSQL" --defaults-extra-file="$OPTS_FILE" -N -e "SELECT COUNT(*) FROM \`$1\`.\`$2\`"; }

FAILED=0
for table in users grades subjects teachers topics sessions videos files audit_logs _prisma_migrations; do
  restored="$(count "$VERIFY_DB" "$table")"
  live="$(count "$DB_NAME" "$table")"
  # The live database may have grown since the backup; it must never have fewer rows than the backup
  # for append-mostly tables (nothing is hard-deleted by the application).
  if [ "$restored" -gt "$live" ]; then
    log "MISMATCH $table: backup=$restored live=$live"
    FAILED=1
  else
    log "OK $table: backup=$restored live=$live"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  log "Backup verification FAILED for $BACKUP_FILE"
  exit 1
fi
log "Backup verification PASSED for $BACKUP_FILE"
