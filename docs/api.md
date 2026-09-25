# API reference

REST API under `/api/v1`. The authoritative, always-current contract is the OpenAPI 3.1
document generated from the route registry: `GET /api/docs/openapi.json` and Swagger UI at
`/api/docs` (enabled with `ENABLE_API_DOCS=true`; on by default outside production). A test
fails if any route is missing from it or lacks an explicit access list.

## Conventions

**Envelope.** Every JSON response:

```json
{ "success": true, "data": { }, "message": null, "meta": null }
{ "success": false, "data": null, "message": "هذا المحتوى مقفل", "error": { "code": "ACCESS_DENIED", "details": null } }
```

**Lists** return `data = { items, page, limit, total, totalPages }` (`?page=1&limit=20`, max 100).

**Language.** Messages are Arabic by default; send `Accept-Language: en` for English. Clients
should branch on `error.code`, never on the message.

**Authentication.** `Authorization: Bearer <accessToken>` (15 min). Refresh:
`POST /auth/refresh` — dashboards use the portal's httpOnly cookie, the app sends
`{ "refreshToken" }`. The student app must also send `X-Device-Id` on every request.

**Access column** below: `public` (no token), role list (bearer token with one of the roles),
`media-token` (signed `?token=` from a playback/file grant — used by players, not called directly).

**IDs** are UUIDv7 strings. Dates are ISO-8601 UTC.

## Error codes

| Code                                                                            | HTTP    | Meaning                                                                     |
| ------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                                                              | 400     | Invalid params/query/body (`details` lists the fields)                      |
| `DEVICE_REQUIRED`                                                               | 400     | Student login/refresh without device information                            |
| `INVALID_CREDENTIALS`                                                           | 401     | Wrong phone or password (same answer for unknown phones)                    |
| `UNAUTHENTICATED` / `TOKEN_INVALID`                                             | 401     | Missing or invalid access token                                             |
| `TOKEN_EXPIRED`                                                                 | 401     | Access token expired — refresh and retry once                               |
| `SESSION_REVOKED` / `REFRESH_TOKEN_INVALID`                                     | 401     | Session ended (logout, password change, reset, token reuse) — sign in again |
| `ACCOUNT_DISABLED`                                                              | 403     | Account disabled by the institute                                           |
| `DEVICE_ALREADY_BOUND` / `DEVICE_MISMATCH`                                      | 403     | Student account bound to another device                                     |
| `REGISTRATION_DISABLED`                                                         | 403     | Self-registration is off                                                    |
| `FORBIDDEN`                                                                     | 403     | Role not allowed on this route                                              |
| `ACCESS_DENIED`                                                                 | 403     | Content is locked for this student                                          |
| `NOT_FOUND` / `FILE_NOT_FOUND` / `VIDEO_NOT_FOUND` / `ROUTE_NOT_FOUND`          | 404     | Not found                                                                   |
| `VIDEO_NOT_READY` / `CONTENT_NOT_READY`                                         | 409     | Video still processing or failed                                            |
| `CONFLICT` / `PHONE_ALREADY_EXISTS` / `OWNER_ALREADY_EXISTS`                    | 409     | Uniqueness conflicts                                                        |
| `PARENT_ARCHIVED` / `ITEM_ARCHIVED`                                             | 409     | Operation on archived content                                               |
| `WEAK_PASSWORD` / `INVALID_CURRENT_PASSWORD` / `PASSWORD_CONFIRMATION_MISMATCH` | 400     | Password rules                                                              |
| `INVALID_FILE_TYPE`                                                             | 415     | File type not allowed or content does not match the extension               |
| `FILE_TOO_LARGE` / `PAYLOAD_TOO_LARGE`                                          | 413     | Size limits                                                                 |
| `UPLOAD_FAILED`                                                                 | 400     | Chunk rejected (size/index)                                                 |
| `UPLOAD_INCOMPLETE` / `INVALID_UPLOAD_STATE`                                    | 409     | Completing with missing chunks / wrong state                                |
| `MEDIA_TOKEN_INVALID`                                                           | 403     | Expired/foreign signed media token                                          |
| `OFFLINE_DISABLED`                                                              | 403     | Offline downloads are turned off in settings                                |
| `RATE_LIMITED`                                                                  | 429     | Too many requests (`RateLimit` headers tell when to retry)                  |
| `SERVICE_UNAVAILABLE` / `INTERNAL_ERROR`                                        | 503/500 | Server problem (details only in server logs)                                |

Exact statuses: `src/core/errors/error-codes.ts`.

## Health

| Method | Path            | Purpose                                                                  |
| ------ | --------------- | ------------------------------------------------------------------------ |
| GET    | `/health`       | Liveness                                                                 |
| GET    | `/health/ready` | Readiness: database reachable, and Redis when configured (503 otherwise) |

## Endpoints

### Authentication

| Method | Path                            | Access                    | Purpose                                                                                       |
| ------ | ------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/auth/admin/login`      | public                    | Super admin login (sets the admin refresh cookie)                                             |
| POST   | `/api/v1/auth/owner/login`      | public                    | Institute owner login (sets the owner refresh cookie)                                         |
| POST   | `/api/v1/auth/student/login`    | public                    | Student login from the app; binds the device on first login                                   |
| POST   | `/api/v1/auth/student/register` | public                    | Student self-registration (on by default; the super admin can turn it off in system settings) |
| POST   | `/api/v1/auth/refresh`          | public                    | Rotate the refresh token and get a new access token                                           |
| POST   | `/api/v1/auth/logout`           | SUPER_ADMIN/OWNER/STUDENT | Revoke the current session                                                                    |
| GET    | `/api/v1/auth/me`               | SUPER_ADMIN/OWNER/STUDENT | Current account                                                                               |
| POST   | `/api/v1/auth/change-password`  | SUPER_ADMIN/OWNER/STUDENT | Change own password (revokes all other sessions)                                              |

### Public

| Method | Path                    | Access | Purpose                                                                 |
| ------ | ----------------------- | ------ | ----------------------------------------------------------------------- |
| GET    | `/api/v1/public/config` | public | Public client configuration (institute name, registration availability) |

### Super admin: settings and owner account

| Method | Path                                      | Access      | Purpose                                                                  |
| ------ | ----------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| GET    | `/api/v1/admin/settings`                  | SUPER_ADMIN | Get system settings                                                      |
| PATCH  | `/api/v1/admin/settings`                  | SUPER_ADMIN | Update system settings                                                   |
| GET    | `/api/v1/admin/owners`                    | SUPER_ADMIN | List owner accounts                                                      |
| POST   | `/api/v1/admin/owners`                    | SUPER_ADMIN | Create the institute owner account                                       |
| GET    | `/api/v1/admin/owners/:id`                | SUPER_ADMIN | Get the owner account                                                    |
| PATCH  | `/api/v1/admin/owners/:id`                | SUPER_ADMIN | Change the owner's name or phone (owners cannot do this themselves)      |
| POST   | `/api/v1/admin/owners/:id/reset-password` | SUPER_ADMIN | Set a new password for the owner (ends the owner's sessions)             |
| POST   | `/api/v1/admin/owners/:id/disable`        | SUPER_ADMIN | Disable the owner account                                                |
| POST   | `/api/v1/admin/owners/:id/enable`         | SUPER_ADMIN | Enable the owner account                                                 |
| POST   | `/api/v1/admin/owners/:id/archive`        | SUPER_ADMIN | Archive the owner account                                                |
| POST   | `/api/v1/admin/owners/:id/restore`        | SUPER_ADMIN | Restore an archived owner account (only if no other active owner exists) |

### Super admin: devices and audit

| Method | Path                         | Access      | Purpose                                                            |
| ------ | ---------------------------- | ----------- | ------------------------------------------------------------------ |
| GET    | `/api/v1/devices`            | SUPER_ADMIN | List device bindings                                               |
| POST   | `/api/v1/devices/:id/reset`  | SUPER_ADMIN | Reset a device binding (revokes its sessions and offline licenses) |
| GET    | `/api/v1/audit-logs`         | SUPER_ADMIN | Search audit logs                                                  |
| GET    | `/api/v1/audit-logs/actions` | SUPER_ADMIN | All audit action names (for filters)                               |

### Dashboard statistics

| Method | Path                       | Access            | Purpose                                                                         |
| ------ | -------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/v1/dashboard/stats`  | SUPER_ADMIN/OWNER | Institute statistics (counts, recent uploads, recent students)                  |
| GET    | `/api/v1/dashboard/system` | SUPER_ADMIN       | System statistics: storage, devices, sessions, processing jobs, recent activity |

### Students (staff)

| Method | Path                                  | Access            | Purpose                                                                      |
| ------ | ------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| GET    | `/api/v1/students`                    | SUPER_ADMIN/OWNER | List students (search by name/phone, filter by status/grade, sort, paginate) |
| POST   | `/api/v1/students`                    | SUPER_ADMIN/OWNER | Create a student account                                                     |
| GET    | `/api/v1/students/:id`                | SUPER_ADMIN/OWNER | Student profile: account, device, opened subjects and teachers               |
| PATCH  | `/api/v1/students/:id`                | SUPER_ADMIN/OWNER | Update a student                                                             |
| POST   | `/api/v1/students/:id/disable`        | SUPER_ADMIN/OWNER | Disable a student (ends all sessions)                                        |
| POST   | `/api/v1/students/:id/enable`         | SUPER_ADMIN/OWNER | Activate a disabled student                                                  |
| POST   | `/api/v1/students/:id/archive`        | SUPER_ADMIN/OWNER | Archive a student (soft delete, ends all sessions)                           |
| POST   | `/api/v1/students/:id/restore`        | SUPER_ADMIN/OWNER | Restore an archived student                                                  |
| POST   | `/api/v1/students/:id/reset-password` | SUPER_ADMIN       | Set a new password for a student (ends all sessions) — super admin only      |
| POST   | `/api/v1/students/:id/device/reset`   | SUPER_ADMIN       | Reset the student's bound device (super admin only)                          |
| GET    | `/api/v1/students/:id/activity`       | SUPER_ADMIN       | Login history and audit events of a student (super admin only)               |

### Teachers

| Method | Path                           | Access            | Purpose                                                              |
| ------ | ------------------------------ | ----------------- | -------------------------------------------------------------------- |
| GET    | `/api/v1/teachers`             | SUPER_ADMIN/OWNER | List teachers (search by name or phone)                              |
| POST   | `/api/v1/teachers`             | SUPER_ADMIN/OWNER | Create a teacher and optionally assign subjects (single transaction) |
| GET    | `/api/v1/teachers/:id`         | SUPER_ADMIN/OWNER | Get a teacher with subject assignments                               |
| PATCH  | `/api/v1/teachers/:id`         | SUPER_ADMIN/OWNER | Update a teacher                                                     |
| POST   | `/api/v1/teachers/:id/archive` | SUPER_ADMIN/OWNER | Archive a teacher                                                    |
| POST   | `/api/v1/teachers/:id/restore` | SUPER_ADMIN/OWNER | Restore a teacher                                                    |
| POST   | `/api/v1/teachers/:id/image`   | SUPER_ADMIN/OWNER | Upload or replace the teacher photo (PNG/JPEG/WebP, max 5 MB)        |
| DELETE | `/api/v1/teachers/:id/image`   | SUPER_ADMIN/OWNER | Remove the teacher photo                                             |

### Grades

| Method | Path                         | Access            | Purpose                       |
| ------ | ---------------------------- | ----------------- | ----------------------------- |
| GET    | `/api/v1/grades`             | SUPER_ADMIN/OWNER | List grades                   |
| POST   | `/api/v1/grades`             | SUPER_ADMIN/OWNER | Create a grade                |
| PUT    | `/api/v1/grades/reorder`     | SUPER_ADMIN/OWNER | Reorder active grades         |
| GET    | `/api/v1/grades/:id`         | SUPER_ADMIN/OWNER | Get a grade with its subjects |
| PATCH  | `/api/v1/grades/:id`         | SUPER_ADMIN/OWNER | Update a grade                |
| POST   | `/api/v1/grades/:id/archive` | SUPER_ADMIN/OWNER | Archive a grade (soft delete) |
| POST   | `/api/v1/grades/:id/restore` | SUPER_ADMIN/OWNER | Restore an archived grade     |

### Subjects and teacher assignments

| Method | Path                                    | Access            | Purpose                                                               |
| ------ | --------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| GET    | `/api/v1/subjects`                      | SUPER_ADMIN/OWNER | List subjects (search, grade filter, pagination)                      |
| POST   | `/api/v1/subjects`                      | SUPER_ADMIN/OWNER | Create a subject in a grade                                           |
| PUT    | `/api/v1/subjects/reorder`              | SUPER_ADMIN/OWNER | Reorder the active subjects of a grade                                |
| GET    | `/api/v1/subjects/:id`                  | SUPER_ADMIN/OWNER | Get a subject with its teachers                                       |
| PATCH  | `/api/v1/subjects/:id`                  | SUPER_ADMIN/OWNER | Update a subject                                                      |
| POST   | `/api/v1/subjects/:id/archive`          | SUPER_ADMIN/OWNER | Archive a subject                                                     |
| POST   | `/api/v1/subjects/:id/restore`          | SUPER_ADMIN/OWNER | Restore a subject                                                     |
| POST   | `/api/v1/subjects/:id/teachers`         | SUPER_ADMIN/OWNER | Assign a teacher to the subject (creates the teacher's content space) |
| PUT    | `/api/v1/subjects/:id/teachers/reorder` | SUPER_ADMIN/OWNER | Reorder the teachers of a subject                                     |
| GET    | `/api/v1/subject-teachers/:id`          | SUPER_ADMIN/OWNER | Get a teacher's content space in a subject (with topics)              |
| POST   | `/api/v1/subject-teachers/:id/archive`  | SUPER_ADMIN/OWNER | Unassign the teacher from the subject (content is kept)               |
| POST   | `/api/v1/subject-teachers/:id/restore`  | SUPER_ADMIN/OWNER | Re-assign a previously unassigned teacher                             |

### Topics

| Method | Path                         | Access            | Purpose                                                |
| ------ | ---------------------------- | ----------------- | ------------------------------------------------------ |
| GET    | `/api/v1/topics`             | SUPER_ADMIN/OWNER | List the topics of a teacher's content space           |
| POST   | `/api/v1/topics`             | SUPER_ADMIN/OWNER | Create a topic (research) under a teacher in a subject |
| PUT    | `/api/v1/topics/reorder`     | SUPER_ADMIN/OWNER | Reorder topics                                         |
| GET    | `/api/v1/topics/:id`         | SUPER_ADMIN/OWNER | Get a topic with its sessions                          |
| PATCH  | `/api/v1/topics/:id`         | SUPER_ADMIN/OWNER | Rename / update a topic                                |
| POST   | `/api/v1/topics/:id/archive` | SUPER_ADMIN/OWNER | Archive a topic                                        |
| POST   | `/api/v1/topics/:id/restore` | SUPER_ADMIN/OWNER | Restore a topic                                        |

### Sessions

| Method | Path                           | Access            | Purpose                                 |
| ------ | ------------------------------ | ----------------- | --------------------------------------- |
| GET    | `/api/v1/sessions`             | SUPER_ADMIN/OWNER | List the sessions of a topic            |
| POST   | `/api/v1/sessions`             | SUPER_ADMIN/OWNER | Create a session in a topic             |
| PUT    | `/api/v1/sessions/reorder`     | SUPER_ADMIN/OWNER | Reorder the sessions of a topic         |
| GET    | `/api/v1/sessions/:id`         | SUPER_ADMIN/OWNER | Get a session with its videos and files |
| PATCH  | `/api/v1/sessions/:id`         | SUPER_ADMIN/OWNER | Rename / update a session               |
| POST   | `/api/v1/sessions/:id/archive` | SUPER_ADMIN/OWNER | Archive a session                       |
| POST   | `/api/v1/sessions/:id/restore` | SUPER_ADMIN/OWNER | Restore a session                       |

### Videos and uploads

| Method | Path                                      | Access            | Purpose                                                 |
| ------ | ----------------------------------------- | ----------------- | ------------------------------------------------------- |
| GET    | `/api/v1/videos`                          | SUPER_ADMIN/OWNER | List the videos of a session                            |
| POST   | `/api/v1/videos`                          | SUPER_ADMIN/OWNER | Create a video and start a chunked upload               |
| PUT    | `/api/v1/videos/reorder`                  | SUPER_ADMIN/OWNER | Reorder the videos of a session                         |
| GET    | `/api/v1/videos/:id`                      | SUPER_ADMIN/OWNER | Get a video                                             |
| PATCH  | `/api/v1/videos/:id`                      | SUPER_ADMIN/OWNER | Rename / update a video                                 |
| POST   | `/api/v1/videos/:id/archive`              | SUPER_ADMIN/OWNER | Archive a video                                         |
| POST   | `/api/v1/videos/:id/restore`              | SUPER_ADMIN/OWNER | Restore a video                                         |
| GET    | `/api/v1/videos/:id/upload`               | SUPER_ADMIN/OWNER | Upload status and received chunk indexes (for resuming) |
| PUT    | `/api/v1/videos/:id/upload/chunks/:index` | SUPER_ADMIN/OWNER | Upload one chunk (raw bytes, application/octet-stream)  |
| POST   | `/api/v1/videos/:id/upload/complete`      | SUPER_ADMIN/OWNER | Finish the upload and queue processing                  |
| POST   | `/api/v1/videos/:id/upload/restart`       | SUPER_ADMIN/OWNER | Start a new upload for a failed or abandoned video      |
| POST   | `/api/v1/videos/:id/preview`              | SUPER_ADMIN/OWNER | Temporary playback URL for staff preview                |

### Files

| Method | Path                         | Access            | Purpose                                                                |
| ------ | ---------------------------- | ----------------- | ---------------------------------------------------------------------- |
| GET    | `/api/v1/files`              | SUPER_ADMIN/OWNER | List the files attached to a subject / teacher space / topic / session |
| POST   | `/api/v1/files`              | SUPER_ADMIN/OWNER | Upload a file (multipart field `file`, optional field `title`)         |
| PUT    | `/api/v1/files/reorder`      | SUPER_ADMIN/OWNER | Reorder files of one parent                                            |
| GET    | `/api/v1/files/:id`          | SUPER_ADMIN/OWNER | Get file metadata                                                      |
| PATCH  | `/api/v1/files/:id`          | SUPER_ADMIN/OWNER | Rename a file                                                          |
| POST   | `/api/v1/files/:id/archive`  | SUPER_ADMIN/OWNER | Delete (archive) a file — recoverable                                  |
| POST   | `/api/v1/files/:id/restore`  | SUPER_ADMIN/OWNER | Restore an archived file                                               |
| GET    | `/api/v1/files/:id/download` | SUPER_ADMIN/OWNER | Download a file (staff)                                                |

### Access control

| Method | Path                                                                    | Access            | Purpose                                                                      |
| ------ | ----------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| GET    | `/api/v1/access/students/:studentId`                                    | SUPER_ADMIN/OWNER | A student's access tree: grades → subjects → teachers with open/locked state |
| PUT    | `/api/v1/access/students/:studentId/subjects/:subjectId`                | SUPER_ADMIN/OWNER | Open or close a subject for a student                                        |
| PUT    | `/api/v1/access/students/:studentId/subject-teachers/:subjectTeacherId` | SUPER_ADMIN/OWNER | Open or close a teacher (within a subject) for a student                     |
| POST   | `/api/v1/access/bulk`                                                   | SUPER_ADMIN/OWNER | Open or close a subject / teacher for many students                          |

### Notifications (staff)

| Method | Path                    | Access            | Purpose                                                                               |
| ------ | ----------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/v1/notifications` | SUPER_ADMIN/OWNER | Sent notifications with delivery and read counts                                      |
| POST   | `/api/v1/notifications` | SUPER_ADMIN/OWNER | Send an announcement to students (all, grade, subject, teacher, or selected students) |

### Student app

| Method | Path                                                 | Access  | Purpose                                                                      |
| ------ | ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| GET    | `/api/v1/student/home`                               | STUDENT | Home: greeting, subjects (with lock state), grades, unread notifications     |
| GET    | `/api/v1/student/profile`                            | STUDENT | Student profile with bound device                                            |
| GET    | `/api/v1/student/grades`                             | STUDENT | All grades                                                                   |
| GET    | `/api/v1/student/grades/:gradeId/subjects`           | STUDENT | Subjects of a grade with lock state                                          |
| GET    | `/api/v1/student/subjects/:subjectId`                | STUDENT | Subject with its teachers (each with lock state) and subject files when open |
| GET    | `/api/v1/student/subject-teachers/:subjectTeacherId` | STUDENT | A teacher's topics in a subject (403 ACCESS_DENIED when locked)              |
| GET    | `/api/v1/student/topics/:topicId`                    | STUDENT | Topic sessions (requires access)                                             |
| GET    | `/api/v1/student/sessions/:sessionId`                | STUDENT | Session videos and files (requires access)                                   |
| POST   | `/api/v1/student/videos/:videoId/playback`           | STUDENT | Get a temporary, device-bound HLS playback URL                               |
| POST   | `/api/v1/student/files/:fileId/access`               | STUDENT | Get a 5-minute download URL for a file                                       |
| GET    | `/api/v1/student/search`                             | STUDENT | Search subjects, teachers and (accessible) lessons                           |
| GET    | `/api/v1/student/notifications`                      | STUDENT | Notification inbox                                                           |
| GET    | `/api/v1/student/notifications/unread-count`         | STUDENT | Unread notifications count                                                   |
| POST   | `/api/v1/student/notifications/read-all`             | STUDENT | Mark all notifications as read                                               |
| POST   | `/api/v1/student/notifications/:notificationId/read` | STUDENT | Mark one notification as read                                                |
| POST   | `/api/v1/student/videos/:videoId/offline-license`    | STUDENT | Issue an offline license and download URLs for encrypted segments            |
| GET    | `/api/v1/student/offline-licenses`                   | STUDENT | Valid offline licenses of this device (the app purges anything not listed)   |
| DELETE | `/api/v1/student/offline-licenses/:licenseId`        | STUDENT | Delete an offline download                                                   |

### Media delivery (signed tokens)

| Method | Path                                                | Access      | Purpose                                                            |
| ------ | --------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| GET    | `/api/v1/media/videos/:videoId/master.m3u8`         | media-token | HLS master playlist (rewritten with the caller token)              |
| GET    | `/api/v1/media/videos/:videoId/key`                 | media-token | AES-128 content key (full authorization on every call)             |
| GET    | `/api/v1/media/videos/:videoId/:variant/index.m3u8` | media-token | HLS variant playlist (rewritten with the caller token and key URI) |
| GET    | `/api/v1/media/videos/:videoId/:variant/:segment`   | media-token | Encrypted HLS segment                                              |
| GET    | `/api/v1/media/files/:fileId`                       | media-token | Download an educational file with a short-lived file token         |
| GET    | `/api/v1/media/teachers/:teacherId/image`           | public      | Teacher photo (non-sensitive, cacheable)                           |
