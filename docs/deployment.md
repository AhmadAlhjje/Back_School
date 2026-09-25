# Deployment (one VPS, Docker Compose)

The three server projects are separate Git repositories. Each has its own `Dockerfile` and
`docker-compose.yml` and starts with one command. On the server they sit side by side:

```
/opt/edu/
├── backend/              docker compose up -d --build  → API on port 6003
├── institute_dashboard/  docker compose up -d --build  → owner dashboard on port 6001
└── super_admin_web/      docker compose up -d --build  → super admin dashboard on port 6002
```

```
Student app ───────────────► :6003  api (Express) ──┬── mariadb (11.4)   ◄── migrate (one-shot)
                                    ▲    │ media vol │── redis (7.4, AOF)
Browser ──► :6001 owner  (Nginx) ───┤    ▼           └── backup (daily dump → ./backups)
Browser ──► :6002 admin  (Nginx) ───┘  worker (FFmpeg, BullMQ)
            each serves its site and forwards /api to edu-api:6003 on the "edu-platform" network
```

| Project / service                           | Purpose                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| backend `mariadb`                           | Database, created on first start (`docker/mariadb/conf.d/edu.cnf`)                   |
| backend `migrate`                           | Runs on every `up`, then exits: creates/migrates the database, first super admin     |
| backend `api`                               | REST API on port 6003; waits for `migrate` to finish                                 |
| backend `worker`                            | Video processing (FFmpeg), notifications, maintenance — lower CPU priority           |
| backend `redis`                             | Queues and rate limits (password, AOF, `noeviction`)                                 |
| backend `backup`                            | Daily dump into `backend/backups/`, weekly restore test (see [backup.md](backup.md)) |
| institute_dashboard / super_admin_web `web` | Nginx: the built site + `/api` forwarded to the backend                              |

Why the dashboards forward `/api` instead of calling port 6003: one origin per dashboard means
no CORS and a first-party login cookie, and no API address has to be built into the sites.
The app calls `http://SERVER:6003` directly. The database and Redis are
never published.

## 1. Server

- Ubuntu 22.04/24.04 with Docker Engine and the Compose plugin. 2 vCPU / 4 GB RAM is the
  minimum; video processing (FFmpeg) is the heavy part, so more CPU means faster processing.
  Disk: videos dominate (see [video-system.md](video-system.md) §7).
- Open ports: 22 (SSH), 6001, 6002, 6003 — also in the provider's firewall panel, if it has one.

```bash
apt-get update && apt-get install -y git curl openssl
curl -fsSL https://get.docker.com | sh
docker compose version
ufw allow 22/tcp && ufw allow 6001:6003/tcp && ufw --force enable
```

## 2. Backend (first)

```bash
mkdir -p /opt/edu && cd /opt/edu
git clone https://github.com/<account>/<backend-repo>.git backend
cd backend
bash docker/init-env.sh          # writes .env: random passwords/secrets + asks for the super admin
docker compose up -d --build     # first build takes several minutes
docker compose ps                # api "healthy"; migrate "exited (0)"
curl http://localhost:6003/health
```

`.env` (from [`.env.production.example`](../.env.production.example)) holds the server address
(`SERVER_ADDRESS`, preset to the VPS IP), the ports, the generated secrets and the first super
admin. The first start creates the database, applies every migration and creates the super
admin; later starts apply only new migrations and never change existing accounts.

**Keep a copy of `.env` off the server** (password manager): `MEDIA_KEY_ENCRYPTION_KEY` decrypts
every processed video, and the database passwords are fixed when the database is created.

## 3. Dashboards

```bash
cd /opt/edu
git clone https://github.com/<account>/<owner-dashboard-repo>.git institute_dashboard
git clone https://github.com/<account>/<admin-dashboard-repo>.git super_admin_web
(cd institute_dashboard && docker compose up -d --build)
(cd super_admin_web && docker compose up -d --build)
```

They join the `edu-platform` network created by the backend (start the backend first).
Optional `.env` next to each `docker-compose.yml`: `DASHBOARD_PORT` (6001 / 6002) and
`API_UPSTREAM` (default `http://edu-api:6003`).

Then open `http://SERVER:6002`, sign in as the super admin, create the institute owner, and the
owner signs in at `http://SERVER:6001`.

## 4. Student app

`flutter_app/.env` holds the API address (`API_BASE_URL=http://SERVER:6003`), built into the app.
Android release builds allow plain HTTP only to that host (the network security config is
generated from `.env`, see `android/app/build.gradle.kts`). Build and signing: the Flutter
project's README.

## 5. Updating

```bash
cd /opt/edu/backend && git pull && docker compose up -d --build   # new migrations run first
cd /opt/edu/institute_dashboard && git pull && docker compose up -d --build
cd /opt/edu/super_admin_web && git pull && docker compose up -d --build
docker image prune -f
```

Migrations are forward-only and additive; for a large upgrade take a backup first
(`docker compose exec backup /opt/edu/scheduler.sh now`).

## 6. Operations (in `/opt/edu/backend`)

| Task                 | Command                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Status               | `docker compose ps`                                                                                     |
| Logs                 | `docker compose logs -f api worker` (JSON, secrets redacted); first start: `logs migrate`               |
| Restart              | `docker compose restart api worker`                                                                     |
| Stop / start         | `docker compose down` / `docker compose up -d` (data stays in the volumes)                              |
| Backup now           | `docker compose exec backup /opt/edu/scheduler.sh now`                                                  |
| Verify latest backup | `docker compose exec backup /opt/edu/verify-backup.sh`                                                  |
| Database shell       | `docker compose exec mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" edu_institute'`           |
| Queue depth          | `docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning keys "bull:*:wait"'` |

Never run `docker compose down -v`: `-v` deletes the database and media volumes.

**Video processing.** `VIDEO_WORKER_CONCURRENCY` (parallel videos) and `HLS_RENDITIONS`
(qualities produced) in `.env` set the load; the worker runs at a lower CPU priority so the API
stays responsive while videos are processed.

**Monitoring.** Point an uptime monitor at `http://SERVER:6003/health/ready` (HTTP 200 when the
database and Redis are reachable, 503 otherwise). Backup failures appear as `ERROR` in
`docker compose logs backup`.

## 7. Moving to a domain with HTTPS (recommended)

With a bare IP everything travels as plain HTTP, including passwords. With a domain, put a TLS
reverse proxy (e.g. Caddy or Nginx + Let's Encrypt) in front of ports 6001–6003, then:
in `backend/docker-compose.yml` set `API_BASE_URL` / `CORS_ORIGINS` to the `https://` addresses
and `COOKIE_SECURE=true` in `.env`; set `API_BASE_URL=https://…` in `flutter_app/.env` and
publish a new app build (release builds then allow no plain HTTP except the offline player's
loopback).

## 8. Security checklist

- [ ] `.env` created by `docker/init-env.sh` (random secrets, mode 600) and copied to a password manager.
- [ ] SSH: keys only, no password login; unattended security upgrades enabled.
- [ ] Only 22 and 6001–6003 open; the database is never published.
- [ ] Backups copied off the server (see [backup.md](backup.md)).
- [ ] A domain with HTTPS as soon as possible (section 7).
