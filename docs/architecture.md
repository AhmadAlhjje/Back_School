# Architecture — Educational Institute Platform

Single-institute learning platform: content management, secure video streaming,
per-student access control, device binding, and administration.

This document is the top-level plan and the record of architectural decisions. The other
documents in this folder are the detailed references (API, database, video system, security,
deployment, backup, development, internals).

---

## 1. Phase 0 — Workspace analysis (2026-09-24)

| Item           | Finding                                          | Decision                                                                    |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Workspace      | Empty except the spec file                       | Build from scratch in `education_platform/`                                 |
| Node.js        | v24.11.0, npm 11.6                               | Node 24 LTS for backend and web tooling                                     |
| Flutter / Dart | 3.47.2 / 3.13.2 (stable)                         | Dart 3 null-safe, Material 3                                                |
| Android        | SDK 36, JDK 17                                   | Android build verified with `flutter build apk`                             |
| iOS            | Windows host — no Xcode                          | iOS code is written but can only be compiled on macOS                       |
| MySQL          | XAMPP MariaDB 10.4 on :3306                      | Dev database. Production: **MariaDB 11.4** (Docker)                         |
| Redis          | Not on Windows                                   | Optional in development (jobs run inside the API without it). Prod: Redis 7 |
| FFmpeg         | 7.1.1 on PATH                                    | Used by the video worker (also installed in the prod image)                 |
| Docker         | Installed, **not used locally** (owner's choice) | Docker files are deliverables for the VPS only                              |

Pinned toolchain (stable majors with full ecosystem support):
TypeScript 6.0 (typescript-eslint supports `<6.1`), Prisma 7.10 (8.x is still RC),
Express 5, Zod 4, BullMQ 5, ESLint 9, Vite 7, React 19, React Router 7,
TanStack Query 5, Tailwind CSS 4, Vitest 4.

---

## 2. System overview

```
                 ┌────────────────────┐   ┌────────────────────┐   ┌──────────────────┐
                 │ Flutter student app │   │ institute_dashboard │   │ super_admin_web  │
                 │ (Android / iOS)     │   │ (React, OWNER)      │   │ (React, ADMIN)   │
                 └─────────┬──────────┘   └─────────┬──────────┘   └────────┬─────────┘
                           │ :6003 (JSON + HLS)      │ :6001                   │ :6002
                           │                ┌─────────┴──────────┐   ┌────────┴─────────┐
                           │                │ Nginx: site + /api │   │ Nginx: site + /api│
                           │                └─────────┬──────────┘   └────────┬─────────┘
                           ▼                          ▼                        ▼
                 ┌──────────────────────────┐  enqueue  ┌──────────────────────────────┐
                 │ Backend API (Express 5)  │──────────▶│ Worker (BullMQ)              │
                 │ auth · RBAC · content ·  │   Redis   │ FFmpeg → HLS → AES-128       │
                 │ access · media gateway   │◀──────────│ notifications · cleanup      │
                 └────────────┬─────────────┘           └──────────────┬───────────────┘
                              │ Prisma                                  │
                              ▼                                         ▼
                        ┌──────────┐                        ┌────────────────────────┐
                        │ MariaDB  │                        │ Private media storage  │
                        └──────────┘                        │ (never publicly served)│
                                                            └────────────────────────┘
```

Rules:

- No client talks to MySQL, Redis or storage directly. Everything goes through the API.
- The API and the worker are two entrypoints of one codebase (`backend`), deployed as two processes
  in production. Without Redis (local development) the API runs the background jobs itself, so
  MySQL is the only service needed.
- Each project is independent: its own dependencies, configuration (`.env`), build and deployment.

---

## 3. Repository layout

Four independent projects:

```
education_platform/
├── backend/                  API + background jobs (Node, TS, Express, Prisma, BullMQ)
│   ├── database/             schema.prisma, migrations/, seeders/, backup scripts, cli.ts
│   ├── docker/               VPS: init-env.sh, MariaDB config, backup image (docker-compose.yml at the root)
│   └── docs/                 this documentation
├── institute_dashboard/      OWNER dashboard (React + Vite)
├── super_admin_web/          SUPER_ADMIN dashboard (React + Vite)
└── flutter_app/              Student app (Riverpod, clean architecture, feature-first)
```

### Decisions about the layout

1. **The database lives inside the backend** (`backend/database`): schema, migrations,
   seeders and backup/restore scripts. The backend is the only runtime that touches MySQL,
   and `npm run dev` creates the database named in `.env`, applies the migrations and runs
   the seeders when it is empty. Seeders use the backend's own services (password hashing,
   upload pipeline), so there is exactly one implementation of each rule.
2. **Each dashboard is self-contained.** The owner and admin dashboards share most of their
   screens (students, teachers, grades, subjects, content tree, uploads, access); each keeps
   its own copy of that layer in `src/shared/` with its own dependencies, so either one can be
   changed, built and deployed without the other. Changes to shared screens are applied to both.

---

## 4. Domain model

```
Grade 1─* Subject *─* Teacher          (via SubjectTeacher = the teacher's content space in a subject)
SubjectTeacher 1─* Topic 1─* Session 1─* Video (1─1 VideoAsset, 1─* UploadJob)
Files attach to exactly one of: Subject | SubjectTeacher | Topic | Session
```

- **SubjectTeacher** is the central idea: "Ahmad in Mathematics" is a row. Topics belong to
  it, so Ahmad's Mathematics content never mixes with Mohammad's, and Ahmad's Physics
  content is separate from his Mathematics content.
- **Users**: one `users` table (identity + credentials + role: `SUPER_ADMIN | OWNER | STUDENT`),
  with `student_profiles` for student-only data. A student account is app-wide, not
  institute-scoped; a future `institute_memberships` table can attach it to many institutes.
- **Soft delete everywhere that matters**: `archivedAt/archivedById` on grades, subjects,
  teachers, subject-teachers, topics, sessions, videos, files, users. Nothing important is
  hard-deleted by the application.
- **IDs**: UUIDv7 (`CHAR(36)`) — globally unique, time-ordered (good index locality),
  non-enumerable in URLs.

Full schema reference: [database.md](database.md).

---

## 5. Access model (the core business rule)

Two independent grants per student:

| Table                                              | Grants                                |
| -------------------------------------------------- | ------------------------------------- |
| `student_subject_access (student, subject)`        | Subject is open                       |
| `student_teacher_access (student, subjectTeacher)` | Teacher is open _within that subject_ |

Effective access to any teacher content (topic/session/video/file):

```
subjectAccess.active AND teacherAccess.active
AND grade, subject, teacher, subjectTeacher, topic, session, item NOT archived
AND (item is a video → status = READY)
```

- Opening a teacher opens **everything under that teacher in that subject — current and
  future** — because access is evaluated against the hierarchy at request time, never copied
  onto sessions or videos.
- Opening a teacher whose subject is closed also opens the subject (same transaction,
  both audited); closing a subject leaves teacher grants intact but ineffective, so
  re-opening restores the previous state.
- "Active" = `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)`. `expiresAt`
  and `source (MANUAL)` exist so future subscriptions can issue grants without schema rewrites.
- Locked items are **listed** to the student (with `locked: true`) but every content,
  playback and file endpoint re-evaluates access on the server.

---

## 6. Authentication, sessions and devices

- **Portals**: separate login endpoints for admin, owner and student; a token issued for
  one portal is rejected by the others' role checks.
- **Access token**: JWT HS256, 15 min, claims `sub, role, sid (auth session), did (device)`.
- **Refresh token**: 256-bit opaque value, stored as SHA-256 hash, **rotated on every use**.
  Presenting an already-rotated token revokes the whole session (theft detection).
  Web: `httpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`, one cookie name
  per portal. Mobile: body field, kept in Keychain/Keystore.
- **Auth sessions** are rows; every authenticated request checks the session is not revoked
  or expired and (students) that its device binding is still active.
- **Passwords**: Argon2id. Changing a password revokes all other sessions.
- **Device binding** (students): the first successful login binds a device
  (`identifierHash`, platform, model, OS, app version, first/last seen). DB-enforced
  "one active device per student" via a unique nullable `activeStudentId` column.
  A different device gets `DEVICE_MISMATCH`. Only `SUPER_ADMIN` can reset a device; reset
  revokes the device's sessions, refresh tokens and offline licenses, and is audited.
- The app's device identifier is ANDROID_ID on Android (stable across reinstalls) and a
  Keychain-persisted UUID on iOS. It is one layer among many, never the only control.

---

## 7. Media system

Upload → storage → queue → FFmpeg → HLS → AES-128 → READY. Details in
[video-system.md](video-system.md).

- **Chunked, resumable uploads** (default 8 MB chunks) stream straight to disk — large
  multi-hour videos never sit in memory or in one giant request.
- The **worker** assembles chunks, probes with `ffprobe`, transcodes to up to three renditions
  (never above source resolution), segments to HLS with a per-video random AES-128 key,
  and atomically publishes the output. Keys are stored encrypted (AES-256-GCM, key from env).
- Dashboard shows only **جاري الرفع / جاهز / فشل**; internal stages stay internal.
- **Playback**: the app asks the API for a playback grant. The API validates token →
  session → device → student status → access → video READY, then returns a manifest URL
  carrying a signed media token bound to `(video, student, device, session)` with a
  duration-based expiry. Playlists are rewritten per request; the key endpoint re-runs the
  full authorization; segments are useless without the key. The API streams segments itself
  (optionally Nginx `X-Accel-Redirect` behind an Nginx that shares the media volume).
- **Files** (PDF, Office, ZIP, images): private storage, 5-minute signed download tokens
  issued only after an access check. PDFs/images render in-app from memory.
- **Offline**: encrypted HLS segments are downloaded to app-private storage; the key is
  kept only in Keystore/Keychain under a server-issued, device-bound, expiring,
  revocable offline license. Playback goes through an in-app loopback server bound to
  127.0.0.1 with a per-playback nonce. The app syncs licenses and purges revoked content.
- **Capture protection**: Android `FLAG_SECURE`; iOS capture detection hides the video while
  recording/mirroring is active. Android: the app's sound cannot be captured by other apps, and on
  Android 15+ playback stops while the screen is recorded.
  This is maximum practical protection, not a guarantee (see [security.md](security.md)).

---

## 8. Backend structure

```
backend/src/
├── app.ts / server.ts              Express app factory / HTTP entrypoint
├── config/                         Env parsing (zod) — the only place that reads process.env
├── core/
│   ├── http/                       Route definition helper (validation + RBAC + OpenAPI), envelope
│   ├── errors/                     AppError + error codes + error middleware
│   ├── logger/                     pino with secret redaction
│   ├── auth/                       JWT, authenticate/authorize middleware, request context
│   ├── security/                   Argon2, token hashing, rate limiters, AES-GCM helpers
│   ├── database/                   Prisma client (MariaDB driver adapter)
│   ├── queue/                      Job queues: BullMQ (Redis) or in-process (no Redis)
│   ├── storage/                    Private storage paths, safe path resolution
│   └── audit/                      Audit writer (append-only)
├── modules/<feature>/              routes · controller · service · repository · schema
├── workers/                        Worker entrypoint + processors (video, notifications, cleanup)
└── docs/openapi.ts                 OpenAPI document built from the route registry
```

Every route is declared with `defineRoute({ method, path, roles, body/query/params schemas, handler })`.
The same declaration drives validation, authorization, and the OpenAPI document, so an
endpoint cannot exist without an explicit role list.

API: REST under `/api/v1`, uniform envelope `{ success, data, message, meta | error }`,
uniform pagination `{ items, page, limit, total, totalPages }`, explicit error codes.
See [api.md](api.md); live Swagger UI at `/api/docs` (non-production by default).

---

## 9. Frontends

**Dashboards** (`institute_dashboard`, `super_admin_web`, each with its own `src/shared/` layer):
React 19 + Vite + TypeScript, React Router route guards, TanStack Query, Axios with
single-flight refresh, React Hook Form + Zod, Tailwind CSS 4 tokens for the design system,
i18next (Arabic RTL first, English-ready), Recharts. Access token in memory only.

**Student app** (`flutter_app`): Clean Architecture + feature-first + Riverpod.
`presentation → domain ← data`; domain is pure Dart (no Flutter, Dio, JSON or Riverpod).
Dio with auth/device interceptors and refresh lock, go_router guards (auth, device error,
account disabled), Freezed + json_serializable DTOs, flutter_secure_storage,
gen-l10n (ar/en), native channel for FLAG_SECURE / capture detection / device id.

**Design system**: Light educational SaaS — Background `#F8FAFC`, Surface `#FFFFFF`,
Primary `#2563EB`/`#1D4ED8`, Text `#0F172A`, Secondary `#64748B`, Success `#16A34A`,
Warning `#F59E0B`, Danger `#DC2626`, Border `#E2E8F0`. Font: **Cairo** everywhere.

---

## 10. Roles

| Capability                                                          | SUPER_ADMIN |       OWNER       | STUDENT |
| ------------------------------------------------------------------- | :---------: | :---------------: | :-----: |
| Manage owner account (create, rename, change phone, reset password) |      ✓      |                   |         |
| Reset student device, list devices                                  |      ✓      |                   |         |
| Audit logs (read-only), system settings, system stats               |      ✓      |                   |         |
| Students, teachers, grades, subjects, content, uploads, access      |      ✓      |         ✓         |         |
| Change own password                                                 |      ✓      |         ✓         |    ✓    |
| Change own name/phone                                               |             | ✗ (admin does it) |         |
| Browse catalog, play authorized videos, open authorized files       |             |                   |    ✓    |

---

## 11. Future-ready, not future-built

- **Multi-tenant**: all institute-owned tables hang off `Grade`/`SubjectTeacher`; adding
  `institutes` + `institute_id` on the roots and an `institute_memberships` table is additive.
  Nothing is implemented now.
- **Subscriptions**: access grants already carry `source` and `expiresAt`. A future
  `plans/subscriptions` module issues grants with `source = SUBSCRIPTION`. No billing now.
- **Languages**: all UI strings live in translation files (web: i18next, app: ARB).

---

## 12. Implementation phases

| Phase | Scope                                                            | Exit criteria                            |
| ----- | ---------------------------------------------------------------- | ---------------------------------------- |
| 0     | Workspace analysis, this document                                | ✓                                        |
| 1     | Foundation: projects, lint/format, env, git                      | lint + typecheck pass everywhere         |
| 2     | Database: schema, migration, seed                                | migrate + seed on MariaDB; restore test  |
| 3     | Auth: portals, refresh rotation, sessions, device binding        | auth test suite green                    |
| 4–5   | Admin + owner APIs and dashboards                                | API tests + dashboard tests/builds green |
| 6     | Flutter app                                                      | analyze + tests + `build apk` green      |
| 7     | Media: chunked upload, worker, HLS-AES, playback, files, offline | real FFmpeg pipeline test green          |
| 8     | Security test suite (see spec §90)                               | all green                                |
| 9     | Full test/lint/build sweep                                       | zero errors                              |
| 10    | Production: Docker (one command per project), backups, docs      | documented, backup restore tested ✓      |
