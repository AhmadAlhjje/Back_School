# Architecture — runtime internals

The decisions, domain model, access rule and roles are in the top-level
[architecture.md](architecture.md). This page explains how the code behaves at runtime.

## 1. Request lifecycle (API)

```
Nginx ─► Express
  1. request id (x-request-id) + pino-http logger (secrets redacted, media tokens stripped)
  2. helmet, CORS allowlist, cookie-parser, express.json({ limit: 1 MB })
  3. route(): rate limiter (if declared) → authenticate (JWT → auth session → user → device)
              → role check → Zod validation of params / query / body
  4. handler → service (business rules, Prisma transactions, audit in the same transaction)
  5. envelope { success, data, message, meta } — or the error middleware:
     AppError → { success:false, error:{ code, details } } with the code's HTTP status and
     a localized message (Accept-Language); unknown errors → INTERNAL_ERROR, stack only in logs
```

`route({ method, path, access, params, query, body, rateLimit, handler })` is the only way to
declare an endpoint. The registry drives Express mounting, authorization, validation, the
OpenAPI document and a test asserting every route has explicit access.

## 2. Modules

Each feature in `src/modules/<feature>` owns its routes, service, DTO mappers and
(where useful) repository. Cross-cutting rules live in shared services:

| Module                                                                             | Responsibility                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `auth`                                                                             | Portals, login, refresh rotation, sessions, device binding, password change   |
| `access`                                                                           | Access policy (`assertVideoAccess`, `assertFileAccess`, tree view) and grants |
| `catalog`, `grades`, `subjects`, `teachers`, `topics`, `sessions`                  | Content hierarchy, ordering, archive/restore                                  |
| `videos`, `files`                                                                  | Upload flows, metadata; `media` delivers bytes behind signed tokens           |
| `student-portal`                                                                   | Read models for the app (lock state, search, offline licenses)                |
| `students`, `owners`, `devices`, `settings`, `audit`, `dashboard`, `notifications` | Administration                                                                |

## 3. Background work

Three queues, with the same handlers (`src/workers/handlers.ts`) in both modes:

- **Production (`REDIS_URL` set):** BullMQ queues in Redis, consumed by a separate worker process
  (`npm run worker` → `dist/workers/index.js`).
- **Local development (no `REDIS_URL`):** in-process queues (`src/core/queue/memory-queue.ts`) run
  by the API itself (`src/workers/embedded.ts`) with the same concurrency, retries/backoff and
  job-id de-duplication; uploads left `QUEUED`/`PROCESSING` by a restart are resumed from the
  database on startup.

| Queue           | Jobs                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `video`         | chunk assembly → ffprobe → FFmpeg HLS + AES-128 → atomic publish ([video-system.md](video-system.md))       |
| `notifications` | fan-out of a notification to its audience (all / grade / subject / teacher / selected students), in batches |
| `maintenance`   | scheduled: auth cleanup (6 h), stale uploads (1 h), offline licenses (12 h)                                 |

Jobs are idempotent (keyed by id) so retries and re-queues are safe. SIGTERM stops taking new
jobs and waits for the running ones.

## 4. Clients

**Dashboards** (two independent Vite apps, each with its own `src/shared/` layer). Route guards per portal; access token in memory,
refresh through the portal's httpOnly cookie with a single-flight refresh shared across tabs
(Web Locks); TanStack Query caches server state; forms with React Hook Form + Zod; all text via
i18next (Arabic RTL default, English LTR). The upload manager survives navigation within the app
and warns before the page is closed.

**Student app** (`flutter_app`), Clean Architecture per feature:

```
features/<feature>/
  domain/        entities (Freezed) + repository contracts — pure Dart
  data/          DTOs (json_serializable) + repository implementations (ApiClient)
  presentation/  pages/widgets + Riverpod providers/notifiers
core/            network (Dio + AuthInterceptor), router (go_router guards), storage,
                 security (device id, screen protection), theme, l10n, utils
```

- `catalog_repositories.dart` is the composition root binding contracts to implementations;
  tests override those providers instead of mocking layers.
- `AuthController` (Riverpod `Notifier`) owns the session state; the router's pure
  `redirectFor(state, location)` sends the user to splash / login / device error / disabled /
  home. Session-ending API errors reach the controller through `SessionEvents`.
- `AuthInterceptor` adds `Authorization`, `X-Device-Id`, `Accept-Language`, refreshes once on
  `TOKEN_EXPIRED` for any number of concurrent requests and replays them.
- Screens render `AsyncValueView` (loading / error with retry / locked / data) — never blank.

## 5. Data flow examples

**Owner opens a teacher for a student:** `PUT /access/students/:id/subject-teachers/:stId`
→ transaction: upsert teacher grant (+ subject grant if closed) + audits → response is the new
access tree → the student's next request sees everything under that teacher, including content
added later (nothing is copied per video).

**Student plays a video:** app → playback grant (full check) → player fetches playlists with the
signed token → key endpoint re-checks everything → segments via X-Accel. Closing access or
resetting the device stops the key endpoint immediately.
