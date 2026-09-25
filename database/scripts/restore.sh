#!/usr/bin/env bash
# Restores a backup produced by backup.sh into a target database.
#
# Usage:   restore.sh <backup.sql.gz> <target_database> [--force]
# Env:     DB_HOST DB_PORT DB_USER DB_PASSWORD, MYSQL (default mysql)
#
# Safety:
#   - verifies the .sha256 checksum before touching anything;
#   - refuses to overwrite a database that already has tables unless --force is given;
#   - the dump's own CREATE DATABASE/USE statements are rewritten to the target name, so a
#     backup can be restored side-by-side (e.g. edu_platform_restored) for inspection.
set -euo pipefail

BACKUP_FILE="${1:?usage: restore.sh <backup.sql.gz> <target_database> [--force]}"
TARGET_DB="${2:?usage: restore.sh <backup.sql.gz> <target_database> [--force]}"
FORCE="${3:-}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
MYSQL="${MYSQL:-mysql}"

[[ "$TARGET_DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid target database name"; exit 1; }
[ -f "$BACKUP_FILE" ] || { echo "Backup not found: $BACKUP_FILE"; exit 1; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [ -f "$BACKUP_FILE.sha256" ]; then
  ( cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" >/dev/null ) \
    || { log "ERROR: checksum mismatch — backup is corrupted"; exit 1; }
  log "Checksum OK"
else
  log "WARNING: no checksum file next to the backup"
fi
gzip -t "$BACKUP_FILE"

OPTS_FILE="$(mktemp)"
trap 'rm -f "$OPTS_FILE"' EXIT
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" > "$OPTS_FILE"
sql() { "$MYSQL" --defaults-extra-file="$OPTS_FILE" --default-character-set=utf8mb4 "$@"; }

EXISTING_TABLES="$(sql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${TARGET_DB}'")"
if [ "$EXISTING_TABLES" != "0" ] && [ "$FORCE" != "--force" ]; then
  log "ERROR: '$TARGET_DB' already contains $EXISTING_TABLES tables. Re-run with --force to overwrite."
  exit 1
fi

SOURCE_DB="$(gzip -dc "$BACKUP_FILE" | grep -m1 -oE '^CREATE DATABASE /\*!32312 IF NOT EXISTS\*/ `[A-Za-z0-9_]+`' | grep -oE '`[A-Za-z0-9_]+`' | tr -d '`' || true)"
log "Restoring '${SOURCE_DB:-unknown}' from $BACKUP_FILE into '$TARGET_DB'"

sql -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`; CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gzip -dc "$BACKUP_FILE" \
  | sed -E '/^CREATE DATABASE /d; s/^USE `[A-Za-z0-9_]+`;/USE `'"$TARGET_DB"'`;/' \
  | sql "$TARGET_DB"

TABLES="$(sql -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${TARGET_DB}'")"
MIGRATIONS="$(sql -N -e "SELECT COUNT(*) FROM \`${TARGET_DB}\`._prisma_migrations WHERE finished_at IS NOT NULL")"
log "Restore complete: $TABLES tables, $MIGRATIONS applied migrations"
