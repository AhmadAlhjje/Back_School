# Backup and restore

What must be protected, and how:

| Data                                                  | Where                                   | Backed up by                                                       |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Database (accounts, catalog, access, audit, settings) | MySQL volume                            | Nightly `mysqldump` (this document) + binlogs                      |
| Media (HLS videos, files, teacher photos)             | `media` volume (`/var/lib/edu/storage`) | File-level sync (section 4)                                        |
| `MEDIA_KEY_ENCRYPTION_KEY`                            | `deploy/.env`                           | Password manager — **without it no processed video can be played** |
| Other secrets (`deploy/.env`)                         | Server                                  | Password manager                                                   |

## 1. Database backups

`database/scripts/backup.sh` (used by the `backup` container and usable on any host):

- `mysqldump --single-transaction` — consistent InnoDB snapshot without locking the site;
  includes routines, triggers (the append-only audit triggers) and events.
- gzip + SHA-256 checksum; incomplete dumps (no `-- Dump completed` marker) are discarded.
- Rotation: 14 daily, 8 weekly (Sundays), 12 monthly (1st of the month) — configurable.
- The password goes through a temporary `0600` option file, never the command line.

In Docker the `backup` service runs it every day at `BACKUP_TIME` (UTC) into
`deploy/backups/` on the host and, every `VERIFY_EVERY_DAYS` days, **restores the newest dump
into a scratch database and compares row counts** with the live database
(`verify-backup.sh`). A failure is logged as `ERROR` in `docker compose logs backup`.

Manual run:

```bash
docker compose exec backup /opt/edu/scheduler.sh now
docker compose exec backup /opt/edu/verify-backup.sh
ls -lh backups/daily
```

Binary logs are enabled (`log_bin`, 7 days) so a DBA can replay changes between the last dump
and an incident (point-in-time recovery).

## 2. Restore

`restore.sh <backup.sql.gz> <target_database> [--force]`:

1. verifies the `.sha256` checksum before touching anything;
2. refuses to overwrite a database that has tables unless `--force` is given;
3. rewrites the dump's database name, so you can restore **side by side** first.

Recommended procedure:

```bash
cd backend/deploy
# 1. Restore next to production and inspect
docker compose exec backup /opt/edu/restore.sh /backups/daily/<file>.sql.gz edu_platform_restored
docker compose exec mysql mysql -uroot -p -e "SELECT COUNT(*) FROM edu_platform_restored.users"

# 2. Replace production (stop writers first)
docker compose stop api worker
docker compose exec backup /opt/edu/restore.sh /backups/daily/<file>.sql.gz edu_platform --force
docker compose up -d api worker
```

The API/worker must use the same `MEDIA_KEY_ENCRYPTION_KEY` as when the videos were processed.

## 3. Tested

Last exercised 2026-09-25 against a real server (MariaDB 10.4 on the development machine; the
production image uses the same scripts with MySQL 8.4's own `mysqldump`):

| Scenario                                                 | Result                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `backup.sh`                                              | dump + `.sha256` written; the dump contains both append-only audit triggers |
| `restore.sh` into an empty side-by-side database         | 23 tables, same row counts, triggers restored                               |
| `restore.sh` into a non-empty database without `--force` | refused                                                                     |
| `restore.sh` of a file with one modified byte            | refused: checksum mismatch                                                  |
| `verify-backup.sh`                                       | row counts match the live database; scratch database dropped afterwards     |

## 4. Media files and off-site copies

Media is large and changes by addition, so copy it incrementally rather than dumping it.
With [restic](https://restic.net) (encrypted, deduplicated) to any S3-compatible bucket:

```bash
# once
export RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/edu RESTIC_PASSWORD=<strong>
restic init
# nightly (cron on the host), after the database dump
MEDIA=$(docker volume inspect edu-platform_media -f '{{ .Mountpoint }}')
restic backup "$MEDIA" /path/to/backend/deploy/backups --exclude "$MEDIA/tmp"
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

`tmp/` (upload chunks, work directories) is transient and excluded. Test a restore of a few
videos periodically (`restic restore latest --target /tmp/check --include ...`).

## 5. Disaster recovery (new server)

1. Provision the server and Docker ([deployment.md](deployment.md) §1).
2. Restore `deploy/.env` from the password manager (same `MEDIA_KEY_ENCRYPTION_KEY`!).
3. `docker compose up -d mysql redis`, restore the database (section 2), then
   `docker compose run --rm migrate` (no-op if the dump is current).
4. Restore the media volume content from restic into the new `media` volume.
5. `docker compose up -d`, issue certificates, verify playback of a video and a file.

Students keep their accounts and device bindings; their access tokens are simply refreshed.
