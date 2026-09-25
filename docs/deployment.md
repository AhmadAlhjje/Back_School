# Deployment (single VPS, Docker Compose)

Everything runs on one Linux server with Docker, from `backend/deploy/`. Only Nginx is exposed;
MySQL, Redis, the API and the worker live on an internal network. The two dashboards are static
sites: each is built in its own project and its `dist/` content is copied to `deploy/sites/`.

```
Internet ──► edge (Nginx: TLS, dashboards, API proxy, X-Accel media)
                 │
                 ├──► api      (Express, port 4000, internal)
                 │      └── media volume (rw)
                 └── media volume (ro) ◄── worker (FFmpeg, BullMQ)
                                              │
                        mysql (8.4) ◄─────────┼──── redis (7.4, AOF)
                        backup (daily dump, weekly restore test)
                        certbot (renewals)
```

| Service | Image / build | Purpose |
|---|---|---|
| `edge` | `deploy/nginx/Dockerfile` | Nginx: TLS, API proxy, X-Accel media, dashboards from `deploy/sites/` |
| `api` | `Dockerfile` target `runtime` | REST API |
| `worker` | same image, `node dist/workers/index.js` | Video processing, notifications fan-out, maintenance |
| `migrate` | `Dockerfile` target `tools` (profile `tools`) | `npm run db:migrate`, `admin:create` |
| `mysql` | `mysql:8.4` | Database (`deploy/mysql/conf.d/edu.cnf`) |
| `redis` | `redis:7.4-alpine` | Queues and rate limits (password, AOF, `noeviction`) |
| `backup` | `deploy/backup/Dockerfile` | Nightly dump + rotation + weekly restore verification |
| `certbot` | `certbot/certbot` | Let's Encrypt renewals (webroot) |

## 1. Server requirements

- Ubuntu 22.04/24.04 (or any Linux with Docker Engine 24+ and the Compose plugin).
- 4 vCPU / 8 GB RAM is a comfortable start (FFmpeg is the heavy part). Disk: size it from a
  sample lesson (see [video-system.md](video-system.md) §7); videos are the dominant cost.
- DNS: three records pointing to the server, e.g. `api.example.com`, `dashboard.example.com`,
  `admin.example.com`.
- Firewall: allow 22, 80, 443 only.

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in
```

## 2. Configure

```bash
# copy the backend project to the server (git clone or upload), then:
cd backend/deploy
cp .env.example .env
nano .env
```

Fill every `CHANGE_ME`:

| Variable | How to generate |
|---|---|
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 24` (hex: safe inside URLs) |
| `JWT_ACCESS_SECRET`, `MEDIA_TOKEN_SECRET` | `openssl rand -hex 32` |
| `MEDIA_KEY_ENCRYPTION_KEY` | `openssl rand -base64 32` — **back this up** (see [backup.md](backup.md)) |
| `SEED_SUPER_ADMIN_PHONE/PASSWORD` | The first super admin (password: 8+ chars, letters and digits) |

The API refuses to start with example or short secrets.

## 3. Build and start

```bash
docker compose build                          # api/worker, edge (Nginx), backup
docker compose up -d mysql redis
docker compose run --rm migrate               # applies the database migrations
docker compose run --rm migrate npm run admin:create   # creates the super admin from .env
docker compose up -d
docker compose ps                             # all services "healthy"/"running"
```

On first boot the edge creates a temporary self-signed certificate so Nginx can start.
Replace it with a real one:

```bash
bash scripts/issue-certificate.sh --staging   # optional dry run against the staging CA
bash scripts/issue-certificate.sh
```

Renewals are automatic: the `certbot` service runs `certbot renew` twice a day and the edge
reloads Nginx every 6 hours.

Check:

```bash
curl -s https://api.example.com/health            # {"success":true,...}
curl -s https://api.example.com/health/ready      # database + redis status
```

## 4. Dashboards

Each dashboard is built on any machine with Node, in its own project, against the production API:

```bash
# institute_dashboard/.env  and  super_admin_web/.env
VITE_API_BASE_URL=https://api.example.com

cd institute_dashboard && npm install && npm run build   # → dist/
cd super_admin_web && npm install && npm run build       # → dist/
```

Copy the **content** of each `dist/` folder to the server:

| Project | Server folder | Domain |
|---|---|---|
| `institute_dashboard/dist/*` | `backend/deploy/sites/owner/` | `OWNER_DOMAIN` |
| `super_admin_web/dist/*` | `backend/deploy/sites/admin/` | `ADMIN_DOMAIN` |

e.g. `scp -r dist/* user@server:~/backend/deploy/sites/owner/`. Nginx serves the new files
immediately (no restart). Then open `https://admin.example.com`, sign in as the super admin,
create the institute owner account, and the owner signs in at `https://dashboard.example.com`.

## 5. Student app

Set the production API in `flutter_app/.env` (HTTPS is mandatory in release builds) and build:

```bash
# flutter_app/.env
API_BASE_URL=https://api.example.com

cd flutter_app
flutter build apk --release
# or an App Bundle for Google Play:
flutter build appbundle --release
```

A universal APK contains every CPU architecture (~80 MB). To hand out APKs directly, add
`--split-per-abi` and give most phones `app-arm64-v8a-release.apk`; Google Play builds from the
App Bundle serve each device only its own architecture.

Release signing uses `android/key.properties` (see the Flutter project's README).
iOS builds require macOS with Xcode (`flutter build ipa`).

## 6. Updating

```bash
# update the backend files on the server (git pull or upload), then:
cd backend/deploy
docker compose build
docker compose run --rm migrate               # new migrations, if any
docker compose up -d                          # recreates changed services
docker image prune -f
```

Migrations are forward-only and additive; take a backup first (`docker compose exec backup
/opt/edu/scheduler.sh now`) before upgrading. Dashboards are updated by copying a new `dist/`.

## 7. Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f api worker` (JSON, secrets redacted) |
| Restart the API | `docker compose restart api` |
| Backup now | `docker compose exec backup /opt/edu/scheduler.sh now` |
| Verify latest backup | `docker compose exec backup /opt/edu/verify-backup.sh` |
| MySQL shell | `docker compose exec mysql mysql -uroot -p` |
| Queue depth | `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning keys 'bull:*:wait'` |
| Swagger UI | set `ENABLE_API_DOCS=true`, `docker compose up -d api`, open `/api/docs` |

**Worker scaling.** `VIDEO_WORKER_CONCURRENCY` (parallel videos) and `WORKER_CPUS` bound
FFmpeg so uploads and playback stay responsive while videos are processed.

**Media delivery.** `MEDIA_ACCEL_REDIRECT=true` is set in compose: the API authorizes every
segment/file request and Nginx streams the bytes from the read-only media volume through the
`internal` `/protected-media/` location. Storage is never reachable directly.

**Monitoring.** Point an uptime monitor at `https://api.example.com/health/ready` (HTTP 200
when MySQL and Redis are reachable, 503 otherwise). Alert on backup failures in
`docker compose logs backup`.

## 8. Security checklist

- [ ] All `CHANGE_ME` values replaced; `deploy/.env` readable by root/deploy user only (`chmod 600`).
- [ ] `MEDIA_KEY_ENCRYPTION_KEY` stored in a password manager.
- [ ] `ENABLE_API_DOCS=false` in production (default).
- [ ] Optional: restrict `admin.example.com` to your IPs (`allow`/`deny` in
      `deploy/nginx/templates/edu.conf.template`).
- [ ] Backups copied off the server (see [backup.md](backup.md)).
- [ ] SSH: keys only, no root login; unattended security upgrades enabled.
