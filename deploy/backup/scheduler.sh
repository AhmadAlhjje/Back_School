#!/usr/bin/env bash
# Runs database/scripts/backup.sh every day at BACKUP_TIME (UTC, HH:MM), and verifies
# the newest dump by restoring it into a scratch database every VERIFY_EVERY_DAYS days.
set -euo pipefail

BACKUP_TIME="${BACKUP_TIME:-02:30}"
VERIFY_EVERY_DAYS="${VERIFY_EVERY_DAYS:-7}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

seconds_until() {
  local target now next
  now=$(date -u +%s)
  target=$(date -u -d "today ${1}" +%s)
  if [ "$target" -le "$now" ]; then target=$(date -u -d "tomorrow ${1}" +%s); fi
  next=$((target - now))
  echo "$next"
}

if [ "${1:-}" = "now" ]; then
  exec /opt/edu/backup.sh
fi

log "Backup scheduler started: daily at ${BACKUP_TIME} UTC, verification every ${VERIFY_EVERY_DAYS} day(s)"
day=0
while true; do
  wait_for=$(seconds_until "$BACKUP_TIME")
  log "Next backup in ${wait_for}s"
  sleep "$wait_for"

  if /opt/edu/backup.sh; then
    day=$((day + 1))
    if [ $((day % VERIFY_EVERY_DAYS)) -eq 0 ]; then
      latest=$(ls -1t "$BACKUP_DIR"/daily/*.sql.gz 2>/dev/null | head -n 1 || true)
      if [ -n "$latest" ]; then
        /opt/edu/verify-backup.sh "$latest" || log "ERROR: backup verification failed for $latest"
      fi
    fi
  else
    log "ERROR: backup failed"
  fi
  # Avoid running twice within the same minute.
  sleep 61
done
