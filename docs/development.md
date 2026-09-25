# Development guide

How to run each project is in its README. This page covers conventions, testing and
troubleshooting for the whole platform.

## Quality gates (must pass before any merge)

| Project             | Commands (inside the project folder)                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| backend             | `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`                      |
| institute_dashboard | `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`                      |
| super_admin_web     | `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`                      |
| flutter_app         | `dart run build_runner build` · `flutter analyze` · `flutter test` · `flutter build apk` |

Formatting: Prettier (single quotes, trailing commas, width 120) for TS/TSX; `dart format
--line-length 120` for Dart. LF line endings everywhere (`.gitattributes`).

## Backend conventions

- Declare endpoints only with `route()` / `openRoute()`; give every route an explicit `access`.
- Business rules in services; routes only map HTTP ↔ service. Throw `AppError('<CODE>')` — add
  new codes to `src/core/errors/error-codes.ts` with Arabic and English messages.
- Multi-step writes in `prisma.$transaction`, with `writeAudit(tx, ...)` inside the transaction.
- Never hard-delete business data: archive (`archivedAt`) and restore.
- Read configuration only through `config` (`src/config/env.ts`); add new variables to the Zod
  schema, `.env.example`, `.env.production.example` and `docker-compose.yml`.
- Schema changes: edit `database/schema.prisma`, run `npm run db:make-migration -- --name <change>`,
  commit the new folder in `database/migrations`, never edit a shipped migration.
- Background work goes through `src/core/queue/queues.ts` (works with and without Redis).

## Dashboards conventions

- Screens used by both dashboards live in `src/shared/` of **each** project; apply a change to
  both copies (they are intentionally independent projects).
- All text through i18next (`src/shared/i18n/locales/ar.ts` and `en.ts`); colors only through the
  theme tokens in `src/shared/styles/theme.css`.

## Tests

**Backend** (Vitest + Supertest, real MySQL/MariaDB — no mocks of the database): `.env.test`
points to `edu_platform_test` (created automatically), the global setup applies the migrations
and each test starts from empty tables. No Redis needed (jobs wait in the in-process queue).
The video test runs the real FFmpeg pipeline with small renditions and decrypts a segment with
the key obtained through the API.

**Dashboards** (Vitest + Testing Library + jsdom): validation schemas, the API client's refresh
logic, shared components, the portal's navigation and login; admin: settings save and the
read-only audit view.

**Flutter** (`flutter test`): route guards (`redirectFor`), error mapping, `.env` parsing, the
auth interceptor against a scripted HTTP adapter (single-flight refresh, session end events),
HLS playlist handling, the offline store end to end (download → encrypted at rest → loopback
playback with nonce → sync/revocation), and widget tests for login, home, offline reconnect,
locked content, error states, RTL/LTR.

**Flutter against the live API** (opt-in): runs the app's real repositories, interceptor and
offline store against a running backend — catalog parsing, playback grant + signed playlist, PDF
download, profile/notifications/search, offline download → loopback playback with the key,
second device refused, session restore.

```bash
cd backend                      # backend running (npm run dev) in another terminal
E2E_OWNER_PHONE=0911111111 E2E_OWNER_PASSWORD=Owner12345 npm run e2e            # a READY video
E2E_OWNER_PHONE=0911111111 E2E_OWNER_PASSWORD=Owner12345 npm run app:live-setup -- ../flutter_app/build/live-config.json
cd ../flutter_app
LIVE_API_CONFIG=build/live-config.json flutter test test/live      # PowerShell: $env:LIVE_API_CONFIG=...
```

Without `LIVE_API_CONFIG` the group is skipped, so `flutter test` stays self-contained.

**End-to-end** (`npm run e2e` in `backend`, against the running API): super admin and owner sign
in, the owner builds grade → subject → teacher → topic → session, uploads a real video in chunks,
it is processed to READY, the owner creates a student and opens the subject and teacher; the
student signs in (device bound), sees the open content and plays the video: master playlist →
variant → key → a segment decrypted with that key. Refusal cases (other device, closed access,
expired tokens) are covered by the automated suite.

## Flutter notes

- Code generation after changing Freezed/JSON classes: `dart run build_runner build`.
- Strings: edit `lib/core/l10n/app_ar.arb` and `app_en.arb`, then `flutter gen-l10n`.
- API URL: `API_BASE_URL` in `flutter_app/.env` (bundled with the app). With `localhost`, every
  debug build runs `adb reverse`, so a USB phone or an emulator reaches the backend on the
  computer. Release builds require an `https://` address.
- NDK: `edu.ndkVersion` in `android/gradle.properties`.
- The domain layer must not import Flutter, Dio, JSON annotations or Riverpod.

## Troubleshooting

| Symptom                                                                                                                            | Fix                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`: "MySQL is not reachable"                                                                                            | Start MySQL from the XAMPP Control Panel; check `DB_HOST` / `DB_PORT`                                                                                                              |
| `npm run dev`: "MySQL refused user"                                                                                                | Check `DB_USERNAME` / `DB_PASSWORD` in `backend/.env` (XAMPP: `root`, empty)                                                                                                       |
| Uploaded video stays "جاري الرفع"                                                                                                  | FFmpeg missing (`npm run dev` prints a warning) or, in production, the worker is not running                                                                                       |
| Production: requests that queue jobs hang                                                                                          | Redis is not reachable (BullMQ waits for it); check `REDIS_URL` and `/health/ready`                                                                                                |
| App: "تعذر الاتصال بالخادم" on a phone                                                                                             | Backend not running, or the phone was plugged in after the build: run `flutter run` again (it re-applies `adb reverse`) or `adb reverse tcp:4000 tcp:4000`                         |
| `Build was configured to prefer settings repositories over project repositories but repository 'maven' was added by settings file` | A global Gradle init script (`~/.gradle/init.d/*.gradle`) adds project repositories to every build, which Flutter's own Gradle build forbids. Use the mirror-friendly script below |
| `NDK at …\ndk\<version> did not have a source.properties file`                                                                     | An interrupted NDK download: delete that folder and build again                                                                                                                    |

Mirror-friendly Gradle init script (keeps the Alibaba mirrors working with Flutter 3.4x+):

```groovy
def mirrors = ['https://maven.aliyun.com/repository/google', 'https://maven.aliyun.com/repository/central']
settingsEvaluated { settings ->
    settings.pluginManagement.repositories {
        mirrors.each { url -> maven { setUrl(url) } }
        maven { setUrl('https://maven.aliyun.com/repository/gradle-plugin') }
        google(); mavenCentral(); gradlePluginPortal()
    }
    if (settings.dependencyResolutionManagement.repositoriesMode.get() == RepositoriesMode.PREFER_PROJECT) {
        settings.gradle.allprojects { repositories { mirrors.each { url -> maven { setUrl(url) } } } }
    } else {
        settings.dependencyResolutionManagement.repositories { mirrors.each { url -> maven { setUrl(url) } } }
    }
}
```
