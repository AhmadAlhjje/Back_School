#!/usr/bin/env bash
# MySQL logical backup with rotation (daily / weekly / monthly) and integrity checksums.
#
# Usage:   backup.sh
# Env:     DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME   (required: DB_USER, DB_PASSWORD, DB_NAME)
#          BACKUP_DIR            default /var/backups/edu-platform
#          KEEP_DAILY            default 14   (days)
#          KEEP_WEEKLY           default 8    (weeks, taken on Sundays)
#          KEEP_MONTHLY          default 12   (months, taken on the 1st)
#          MYSQLDUMP             default mysqldump
#          MYSQLDUMP_EXTRA_ARGS  e.g. "--set-gtid-purged=OFF" on MySQL 8 with GTIDs
#
# Consistency: --single-transaction gives a consistent InnoDB snapshot without locking tables.
# The password is passed through a private temporary option file, never on the command line.
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${DB_NAME:?DB_NAME is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/edu-platform}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
MYSQLDUMP="${MYSQLDUMP:-mysqldump}"

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"

OPTS_FILE="$(mktemp)"
trap 'rm -f "$OPTS_FILE"' EXIT
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" > "$OPTS_FILE"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/daily/${DB_NAME}_${STAMP}.sql.gz"
TMP_FILE="$FILE.partial"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "Backing up database '$DB_NAME' → $FILE"
# shellcheck disable=SC2086
"$MYSQLDUMP" --defaults-extra-file="$OPTS_FILE" \
  --single-transaction --quick --routines --triggers --events \
  --default-character-set=utf8mb4 --hex-blob --no-tablespaces \
  ${MYSQLDUMP_EXTRA_ARGS:-} \
  --databases "$DB_NAME" | gzip -9 > "$TMP_FILE"

# A dump that did not finish lacks the completion marker — never keep it.
if ! gzip -dc "$TMP_FILE" | tail -n 5 | grep -q -- '-- Dump completed'; then
  rm -f "$TMP_FILE"
  log "ERROR: dump is incomplete"
  exit 1
fi
mv "$TMP_FILE" "$FILE"
( cd "$(dirname "$FILE")" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
log "Backup written ($(du -h "$FILE" | cut -f1))"

# Promote to weekly (Sunday) and monthly (1st) tiers.
if [ "$(date -u +%u)" = "7" ]; then
  cp "$FILE" "$FILE.sha256" "$BACKUP_DIR/weekly/"
  log "Promoted to weekly"
fi
if [ "$(date -u +%d)" = "01" ]; then
  cp "$FILE" "$FILE.sha256" "$BACKUP_DIR/monthly/"
  log "Promoted to monthly"
fi

# Retention.
find "$BACKUP_DIR/daily" -name "*.sql.gz*" -type f -mtime +"$KEEP_DAILY" -delete
find "$BACKUP_DIR/weekly" -name "*.sql.gz*" -type f -mtime +"$((KEEP_WEEKLY * 7))" -delete
find "$BACKUP_DIR/monthly" -name "*.sql.gz*" -type f -mtime +"$((KEEP_MONTHLY * 31))" -delete
log "Retention applied (daily ${KEEP_DAILY}d, weekly ${KEEP_WEEKLY}w, monthly ${KEEP_MONTHLY}m)"
