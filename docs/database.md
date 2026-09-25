# Database

MySQL 8 in production (MariaDB 10.4+ works for development). Schema, migrations, seeds and
operational scripts live in [`database/`](../database) inside the backend; the Prisma 7 toolchain
runs them (`prisma.config.ts`).

- Character set `utf8mb4`, collation `utf8mb4_unicode_ci` (Arabic text, emoji).
- IDs: UUIDv7 in `CHAR(36)` — time-ordered for index locality, not enumerable.
- Timestamps in UTC. Soft delete via `archived_at` (+ `archived_by_id`) on all content and accounts.
- Foreign keys use `RESTRICT` (nothing important disappears through a cascade), except purely
  technical children (e.g. refresh tokens of a session).

## Tables

### Identity and security

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Every account: role `SUPER_ADMIN / OWNER / STUDENT`, status `ACTIVE / DISABLED`, Argon2id hash, `password_changed_at`, archive columns | unique `phone` |
| `student_profiles` | Student-only data: grade, source (`STAFF_CREATED / SELF_REGISTERED`) | 1–1 with `users` |
| `devices` | Bound student devices: identifier **hash**, platform, model, OS, app version, first/last seen, last IP, `status ACTIVE/RESET` | unique nullable `active_student_id` → **one active device per student** |
| `auth_sessions` | One row per login: portal, device, IP, user agent, `expires_at`, `revoked_at` + reason | checked on every request |
| `refresh_tokens` | SHA-256 of each refresh token, `rotated_at` for reuse detection | unique `token_hash` |
| `audit_logs` | Actor, role, action, entity, IP, user agent, JSON metadata | **append-only** (DB triggers block UPDATE/DELETE) |
| `system_settings` | Key/value settings validated by the API (institute name, registration, watermark, offline downloads, offline license days) | |

### Catalog

```
grades 1─* subjects *─* teachers   (subject_teachers = a teacher's content space in a subject)
subject_teachers 1─* topics 1─* sessions 1─* videos (1─1 video_assets, 1─* upload_jobs)
files → exactly one of: subject | subject_teacher | topic | session
```

| Table | Notes |
|---|---|
| `grades` | `sort_order`; archived grades hide their subtree |
| `subjects` | belongs to a grade; unique active name per grade (service rule) |
| `teachers` | name, phone, description, photo key |
| `subject_teachers` | unique `(subject_id, teacher_id)`; archiving = unassigning (content kept) |
| `topics` | lesson / research topic under a subject-teacher |
| `sessions` | class session under a topic |
| `videos` | status `UPLOADING / PROCESSING / READY / FAILED`, duration, `ready_at`, failure reason |
| `video_assets` | HLS location, renditions, **sealed AES key** (AES-256-GCM), IV |
| `upload_jobs` | chunked upload state: size, chunk size/count, status, attempts, timings |
| `files` | kind, extension, MIME, size, storage key, scope + one parent column; CHECK constraint `files_scope_parent_check` guarantees exactly one parent matching `scope` |

### Access, notifications, offline

| Table | Notes |
|---|---|
| `student_subject_access` | unique `(student_id, subject_id)`; `source`, `granted_by`, `expires_at`, `revoked_at` |
| `student_teacher_access` | unique `(student_id, subject_teacher_id)`; same columns |
| `offline_licenses` | student, device, video, `expires_at`, `revoked_at` — device-bound offline copies |
| `notifications` | type (`NEW_LESSON / NEW_VIDEO / NEW_FILE / ACCOUNT / SYSTEM`), title, body, JSON data |
| `notification_recipients` | unique `(notification_id, user_id)`, `read_at` |

A grant is **active** when `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`.
Revoking keeps the row (history); re-opening clears `revoked_at`.

## Indexes

Chosen for the actual queries: children by `(parent_id, archived_at, sort_order)`, users by
`(role, archived_at, created_at)` and `(role, status)`, sessions by `(user_id, revoked_at)` and
`(device_id, revoked_at)`, audit by `created_at`, `(actor_id, created_at)`,
`(entity_type, entity_id)`, `(action, created_at)`, inbox by `(user_id, read_at, created_at)`,
name/title indexes for search. See `schema.prisma` for the full list.

## Migrations

| Migration | Content |
|---|---|
| `20260923225929_init` | Full schema + `files_scope_parent_check` |
| `20260925010000_audit_log_append_only` | Triggers `audit_logs_block_update` / `audit_logs_block_delete` |

```bash
npm run dev             # creates DB_DATABASE if missing, applies migrations, seeds an empty database
npm run db:migrate      # create the database if needed + apply pending migrations (production: `docker compose run --rm migrate`)
npm run db:fresh        # development only: drop, recreate, migrate and seed (also clears ./storage)
npm run db:make-migration -- --name <change>   # after editing schema.prisma: generate + apply a new migration
npm run db:status
npm run db:seed         # super admin from SEED_SUPER_ADMIN_*; demo data when SEED_DEMO_DATA=true
npm run admin:create    # create/repair only the super admin (production bootstrap)
```

Rules: migrations are committed and never edited after they ship; changes are additive
(expand → migrate data → contract in a later release). Prisma does not model triggers or CHECK
constraints, so they live in hand-written SQL migrations and survive later diffs.

MySQL 8 with binary logging needs `log_bin_trust_function_creators=1` for a non-SUPER user to
create the triggers (set in `deploy/mysql/conf.d/edu.cnf`).

## Seeds

- `seeds/super-admin.ts` — idempotent super admin from environment variables.
- `seeds/demo-data.ts` — development catalog: grades, subjects, teachers (Ahmad/Mohammad),
  topics, sessions, an owner and two students with sample grants. Never enabled in production.

## Backups

See [backup.md](backup.md) (scripts in `database/scripts`).
