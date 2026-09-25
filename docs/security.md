# Security design

Threat model in one sentence: paying students must not be able to share accounts, extract
videos, or reach content that was not opened for them; staff accounts must not be hijacked;
and nothing an attacker does should go unnoticed in the audit trail.

Every control below is enforced **on the server**. Clients hide locked items and show friendly
screens, but they are never trusted.

## 1. Identity and sessions

| Control                                  | Implementation                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing                         | Argon2id (`core/security/password.ts`); policy 8–128 chars with letters and digits                                                                        |
| Separate portals                         | `/auth/admin/login`, `/auth/owner/login`, `/auth/student/login`; each checks the role                                                                     |
| Access token                             | JWT HS256, 15 min, claims `sub, role, sid, did`; secret ≥ 32 chars, example values rejected at boot                                                       |
| Refresh token                            | 256-bit random, stored as SHA-256, **rotated on every use**; replaying an old token after a 20 s grace window revokes the whole session (theft detection) |
| Web refresh cookie                       | `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, one cookie name per portal; the access token lives in memory only                                 |
| Mobile tokens                            | Access token in memory; refresh token in Keychain / Android Keystore (`flutter_secure_storage`)                                                           |
| Server-side sessions                     | Every authenticated request loads the session: revoked, expired, disabled or archived accounts stop working immediately                                   |
| Password change                          | Revokes every other session of the account                                                                                                                |
| Staff password reset / disable / archive | Revokes all sessions of that account                                                                                                                      |

## 2. Device binding (students)

- First successful login binds the device (identifier hash, platform, model, OS, app version).
- The database enforces **one active device per student** (unique nullable `active_student_id`).
- Login from another device → `DEVICE_ALREADY_BOUND`; requests carrying a different
  `X-Device-Id` → `DEVICE_MISMATCH`. The app shows a dedicated screen.
- Only the **super admin** can reset a device. Reset revokes the device's sessions, refresh
  tokens, playback links and offline licenses, and is audited.
- Device identifier: `ANDROID_ID` (stable across reinstalls) / Keychain-persisted UUID on iOS.
  It is one layer among several (tokens, server sessions, device-bound media tokens).

## 3. Authorization

- Every route is declared with an explicit access list (`route()` / `openRoute()`); a test fails
  if any route lacks one. Roles: `SUPER_ADMIN`, `OWNER`, `STUDENT`.
- Content access = active subject grant **and** active teacher grant, evaluated against the
  live hierarchy (nothing archived, video `READY`) on **every** content, playback, key and file
  request. See [architecture.md §5](architecture.md#5-access-model-the-core-business-rule).
- Students can only address their own data: student endpoints never take a student id.
- Input validation with Zod on params, query and body; ids are validated before any query.

## 4. Media protection

| Asset            | Protection                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage          | Private Docker volume, never served statically: every byte leaves through an API route that authorized the request (optionally handed to Nginx with `X-Accel-Redirect`)                                                                                                                                                                                                                                                                               |
| HLS video        | AES-128 segments, random key per video; keys stored sealed with AES-256-GCM (`MEDIA_KEY_ENCRYPTION_KEY`)                                                                                                                                                                                                                                                                                                                                              |
| Playback URL     | Signed media token bound to `(video, user, session, device)`; lifetime `clamp(2 × duration + 30 min, 30 min, 12 h)`; playlists are rewritten per request                                                                                                                                                                                                                                                                                              |
| Key endpoint     | Re-runs the full authorization (session alive, device bound, access still open) on every call and is rate-limited                                                                                                                                                                                                                                                                                                                                     |
| Files            | 5-minute single-file URLs after an access check; content sniffing blocks files whose bytes do not match the extension                                                                                                                                                                                                                                                                                                                                 |
| Offline copies   | Server-issued license (device-bound, expiring, revocable); segments stay encrypted at rest in app-private storage; the key only in Keychain/Keystore; playback through a loopback server on 127.0.0.1 with a random per-playback path; licenses re-synced when online and revoked copies deleted                                                                                                                                                      |
| Screen capture   | Android: `FLAG_SECURE` on the whole app (screenshots/recordings are black, hidden in recents) and the app's audio cannot be captured by any other app (`allowAudioPlaybackCapture=false`, capture policy NONE), so a recording has neither picture nor sound; Android 15+ also reports recording and the player stops. iOS: the OS cannot block screenshots; the app stops the video while recording/mirroring is active and warns after a screenshot |
| Camera recording | Cannot be prevented by any app                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Backups          | Android `allowBackup=false` + data-extraction rules: app data (tokens, offline videos, keys) never leaves the device through cloud/device transfer                                                                                                                                                                                                                                                                                                    |

This is **maximum practical protection, not DRM-grade protection.** A determined attacker with a
rooted/jailbroken device can still defeat client-side controls; the server-side controls
(per-request authorization, short-lived device-bound tokens, revocation, audit)
limit and expose that. Widevine/FairPlay DRM can be added later behind the same playback API.

## 5. Transport and web

- Current VPS setup: plain HTTP on the server's IP (ports 6000–6002) until a domain is set
  up — move to HTTPS as soon as possible ([deployment.md](deployment.md) §7). Android release
  builds allow cleartext only to the API host in `.env` (when it is `http://`) and loopback;
  iOS ATS allows only local networking (iOS builds need an `https://` API).
- Helmet security headers on the API; strict CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy` on the dashboards.
- CORS: explicit allowlist of the two dashboard origins, credentials only for them.
- Request size limits per route type (JSON, 8 MB upload chunks, file uploads).

## 6. Abuse controls

| Limiter                  | Limit        |
| ------------------------ | ------------ |
| Login per IP             | 50 / 15 min  |
| Login per account        | 10 / 15 min  |
| Registration per IP      | 10 / hour    |
| Refresh per IP           | 120 / 15 min |
| Password change per user | 10 / 15 min  |
| Playback grants per user | 30 / min     |
| File grants per user     | 60 / min     |
| Key requests per IP      | 60 / min     |

Limits are stored in Redis when configured (shared by all API processes), otherwise in the single API
process's memory. Behind the dashboards' Nginx the real client address is used
(`TRUST_PROXY=uniquelocal`: forwarded addresses are trusted only from private networks).
Login errors are identical for unknown phones and wrong passwords.

## 7. Audit and logging

- Security-relevant actions (logins and failures, device binding/rejection/reset, token reuse,
  access open/close, account changes, uploads, archives, settings, offline licenses) are written
  to `audit_logs` in the **same database transaction** as the change they describe (events
  without a data change, such as a failed login, are written on their own).
- `audit_logs` is **append-only in the database**: triggers reject `UPDATE` and `DELETE`
  whoever connects (migration `20260925010000_audit_log_append_only`, covered by a test).
- Structured logs (pino) redact authorization headers, cookies, passwords, tokens and keys;
  the dashboards' Nginx logs paths without query strings, so signed media tokens are never
  written to disk.

## 8. Data protection

- Soft delete (`archivedAt`) for everything that matters; nothing is hard-deleted by the app.
- UUIDv7 identifiers: not enumerable.
- Backups: nightly, checksummed, rotated, restore-tested weekly ([backup.md](backup.md)).
- Secrets only in environment variables; the app refuses to boot with weak/example values.

## 9. Verification

The backend suite includes the security scenarios of spec §90 (student isolation, locked
subject/teacher content requested directly, wrong device, expired/tampered/foreign-secret
tokens, archived content, non-READY videos, refresh-token replay, rate limiting, RBAC for every
role pair, audit immutability) and a real FFmpeg pipeline test that decrypts segments only with
an authorized key request. The Flutter suite covers the token refresh/session-ending logic, the
offline store (encrypted at rest, loopback nonce, revocation) and route guards.

Hardening options for larger deployments: separate MySQL users for migrations (DDL) and runtime
(DML only); admin dashboard IP allowlist in its Nginx; WAF/CDN in front of the server.

## Reporting a vulnerability

Please do not open a public issue: contact the platform administrator privately with the affected
component, reproduction steps and impact. Only the latest deployed version receives security fixes.
