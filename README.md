# Battle Arena Infrastructure

Central Docker Compose development environment for sibling repositories.

## Repository responsibilities

| Repository | Role |
|------------|------|
| `battle-arena-api` | Laravel 13 modular monolith REST API |
| `battle-arena-web` | React + Vite + Tailwind web client |
| `battle-arena-mobile` | Expo React Native client (runs outside Docker) |
| `battle-arena-infra` | Local Compose orchestration only |

## Architecture

```mermaid
flowchart LR
  subgraph clients [Clients]
    Web[battle-arena-web<br/>localhost:3000]
    Mobile[battle-arena-mobile<br/>Expo]
  end

  subgraph compose [battle-arena-infra Compose]
    API[battle-arena-api<br/>:8000]
    PG[(PostgreSQL)]
    Redis[(Redis)]
    S3[RustFS S3<br/>profile: storage]
  end

  Web -->|HTTP REST /api| API
  Mobile -->|HTTP REST /api| API
  API --> PG
  API --> Redis
  API -.->|optional profile photos| S3
```

Web and mobile consume the **same** API. Creature catalog data is served from PostgreSQL. PokéAPI is used only by the Artisan import command.

## Services and ports

By default published ports bind to `127.0.0.1` only (see [Network security](#network-security-and-mobile-lan-access) for per-service bind variables).

| Service | Port | Purpose | Default bind |
|---------|------|---------|--------------|
| `web` | 3000 | Vite React app | localhost |
| `api` | 8000 | Laravel REST API | localhost |
| `postgres` | 5432 | Database | localhost |
| `redis` | 6379 | Cache / session / queue | localhost |
| `minio` (RustFS) | 9000 / 9001 | Optional S3 (`--profile storage`) | localhost |

## First-time setup

```bash
cd battle-arena-api
cp .env.example .env
# APP_KEY is generated safely on first API container start (never force-rotated)

cd ../battle-arena-web
cp .env.example .env

cd ../battle-arena-infra
cp .env.example .env
docker compose up --build -d
docker compose exec api php artisan migrate
docker compose exec api php artisan creatures:import
```

## Day-to-day commands

```bash
cd battle-arena-infra

docker compose up --build -d
docker compose down
docker compose logs -f api web postgres redis

docker compose exec api php artisan migrate
docker compose exec api php artisan creatures:import
docker compose exec api php artisan test

docker compose exec web npm run lint
docker compose exec web npm run typecheck
docker compose exec web npm test
```

## Network security and mobile LAN access

Each published port has its own bind variable. They are **independent**: changing one never affects the others.

| Variable | Service | Default | May be `0.0.0.0`? |
|----------|---------|---------|-------------------|
| `API_BIND_ADDRESS` | `api` | `127.0.0.1` | Yes, for physical mobile device testing |
| `WEB_BIND_ADDRESS` | `web` | `127.0.0.1` | Optional (LAN browser access) |
| `POSTGRES_BIND_ADDRESS` | `postgres` | `127.0.0.1` | **No** |
| `REDIS_BIND_ADDRESS` | `redis` | `127.0.0.1` | **No** |
| `MINIO_BIND_ADDRESS` | `minio` (profile `storage`) | `127.0.0.1` | **No** (use signed URLs through the API) |

> The legacy shared `BIND_ADDRESS` variable is no longer read by `compose.yaml`. Remove it from your local `.env` if present.

Physical mobile device on the LAN — set **only** the API (and optionally Web):

```env
# battle-arena-infra/.env
API_BIND_ADDRESS=0.0.0.0
# WEB_BIND_ADDRESS=0.0.0.0   # optional
```

Then refresh the port bindings (does not touch volumes) and point the mobile app at `http://<your-LAN-IP>:8000`:

```bash
docker compose up -d
docker compose ps   # postgres/redis must still show 127.0.0.1
```

Allow inbound TCP 8000 in your OS firewall for the private network only. Revert to `API_BIND_ADDRESS=127.0.0.1` when you are done.

Simulators:

- Android emulator: `http://10.0.2.2:8000`
- iOS simulator: `http://localhost:8000`

## Application key policy

The API entrypoint (`battle-arena-api/scripts/docker-entrypoint.sh`):

1. Runs `composer install`
2. Generates `APP_KEY` **only** when missing
3. Never uses `key:generate --force`
4. Refuses to start if the key is still missing/invalid
5. Does not hide initialization failures with `|| true`

### First-time blank `APP_KEY`

`battle-arena-api/.env.example` ships with `APP_KEY=` (blank). On the first container start:

1. `cp .env.example .env` (done by you, or by the entrypoint if `.env` is absent).
2. The entrypoint sees no valid `base64:...` key in the environment or `.env`, runs `php artisan key:generate --no-interaction`, and writes the key to `battle-arena-api/.env` (bind-mounted, so it lives on the host).
3. The key is validated by booting Laravel; the container exits if it is still invalid.

On every later restart (`docker compose restart`, `up -d`, `down` + `up`) the key is already in `.env`, so the entrypoint logs `APP_KEY already present` and **keeps it**. Do not rotate it by hand unless you accept invalidating encrypted data and sessions. Never run `key:generate --force`.

## Optional local S3 (RustFS)

Storage is **not** required for health checks, readiness, or the creature catalog.

```bash
docker compose --profile storage up -d minio minio-init
```

| Item | Value |
|------|--------|
| Console | [http://localhost:9001/rustfs/console/](http://localhost:9001/rustfs/console/) |
| S3 API | [http://localhost:9000](http://localhost:9000) |
| Bucket | `battle-arena-profiles` (**private**) |

### Public avatars later (without exposing unrelated files)

Keep the bucket private by default. Prefer one of:

1. Short-lived signed `GetObject` URLs for authenticated profile photo delivery
2. A dedicated public prefix such as `public-avatars/*` with a **scoped** bucket policy that grants anonymous read only under that prefix — never `bucket/*`

## ADR: Independent repositories + central Compose

We use four Git repositories so API, web, mobile, and infra remain independently deployable and versioned. A single Compose file in `battle-arena-infra` references sibling build contexts for local developer experience without creating a monorepo.
