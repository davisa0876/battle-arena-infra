# AWS Migration Checkpoint

**Date:** 2026-11-27 · **Status:** local production-parity environment complete; nothing provisioned in AWS; changes committed on branch `feat/aws-local-parity`, not yet merged into `main`.

There is **one** local development environment (`battle-arena-infra/compose.yaml`). It is both the daily dev environment and the simulation of the proposed AWS production architecture. There are no profiles, overlays or parallel environments.

```bash
cd battle-arena-infra
docker compose up -d --build
```

Full details: [`../README.md`](../README.md) · AWS spec §19a: [`../BATTLE_ARENA_AWS_INFRASTRUCTURE_SPEC_EN.md`](../BATTLE_ARENA_AWS_INFRASTRUCTURE_SPEC_EN.md).

---

## 1. Final local architecture

```
Browser ──► web (Nginx, React prod build)            :3000   ≈ CloudFront + S3
Browser/Expo ──► gateway :8000 (HTTP API, payload 2.0) ──► api (Bref fpm Lambda image)
Browser/Expo ──► gateway :3001/ws (WebSocket API) ──► realtime (Node Lambda image)
gateway scheduler (60 s) ──► console (Bref console Lambda) `schedule:run`   ≈ EventBridge
api ──async Invoke──► gateway ──► realtime ──@connections──► gateway ──► sockets
api/console/realtime ──► postgres · redis · minio (S3) · mailpit (SMTP)
```

- **Laravel is the only authority** for identity, authorization, game rules and battle state.
- **Node is transport only:** ticket redemption, room grants, fanout of hint-only envelopes. No combat logic.
- **Realtime is event-driven:** Laravel async-invokes the realtime Lambda (`PVP_REALTIME_DRIVER=lambda`). The connection registry lives in Redis sorted sets with TTL, and nothing subscribes to Redis Pub/Sub.
- **Lambda constraints are enforced:**
  - `api`, `console` and `realtime` run under the AWS Lambda Runtime Interface Emulator.
  - They have a read-only root filesystem, a writable `/tmp` only (512 MB tmpfs), run as user `993:990`, publish no ports, and handle one invocation at a time per container.
- **Mobile (Expo) is unchanged**, still targeting `:8000` and `ws://…:3001/ws`.

## 2. Docker services

| Service | Responsibility | Image / build | Host port |
|---|---|---|---|
| `gateway` | Emulates the API Gateway HTTP API (payload 2.0), the WebSocket API (`$connect`/`$default`/`$disconnect`, 410 until `$connect` returns), the Lambda Invoke API, the `@connections` Management API and EventBridge-style schedules | `docker/gateway` (Node 22 + `ws`) | 8000, 3001 |
| `api` | Laravel HTTP, as a Bref **fpm** Lambda; source bind-mounted for hot reload | `docker/api` target `fpm` (Bref v3, PHP 8.4 + GD + intl) | — |
| `console` | Laravel artisan, as a Bref **console** Lambda; runs `schedule:run` every 60 s (PvP turn timeouts); ~55 MB idle | `docker/api` target `console` | — |
| `realtime` | WebSocket transport Lambda (`dist/lambda/handler.handler`) | `docker/realtime` (`public.ecr.aws/lambda/nodejs:22`) | — |
| `web` | React production build behind Nginx, configured to behave like CloudFront: immutable assets, no-cache `index.html`, SPA fallback, security headers | `docker/web` (`nginx:1.28-alpine`) | 3000 |
| `postgres` | Database (existing volume `postgres_data` reused) | unchanged | 5432 |
| `redis` | Cache, sessions, WS tickets, presence, connection registry (single DB 0) | unchanged | 6379 |
| `minio` + `minio-init` | S3 stand-in (RustFS); `minio-init` creates the bucket, then exits | unchanged, now always on | 9000/9001 |
| `mailpit` | SMTP stand-in for SES | unchanged | 1025/8025 |

## 3. Production AWS equivalents

| Local | AWS production |
|---|---|
| `gateway` (HTTP) | API Gateway HTTP API |
| `gateway` (WS + `@connections`) | API Gateway WebSocket API + Management API |
| `gateway` scheduler | EventBridge Scheduler rule → console Lambda |
| `api` | Lambda (Bref `php-84` fpm layer/image) |
| `console` | Lambda (Bref console), 900 s timeout |
| `realtime` | Lambda (Node.js 22) |
| `web` | S3 + CloudFront |
| `postgres` | Neon Postgres |
| `redis` | Upstash Redis (single logical DB) |
| `minio` | S3 bucket for profile avatars |
| `mailpit` | SES / SMTP provider |
| — | SQS and DynamoDB **not used**. Queue stays `sync`; the registry lives in Redis. Add them only if a measured need appears. |

## 4. Modified files (all repositories)

### battle-arena-infra
- **Modified:**
  - `compose.yaml`: rewritten as the single environment.
  - `README.md`: rewritten.
  - `BATTLE_ARENA_AWS_INFRASTRUCTURE_SPEC_EN.md`: §19a.
  - `.env.example`
  - `.cursor/rules/00-project-standards.mdc`, `10-docker-standards.mdc`, `20-networking.mdc`, `30-secrets-and-keys.mdc`
- **New:**
  - `docker/api/Dockerfile`
  - `docker/api/php/conf.d/battle-arena.ini`
  - `docker/gateway/{Dockerfile,.dockerignore,package.json,package-lock.json,src/server.mjs,src/invoke.mjs}`
  - `docker/realtime/Dockerfile`
  - `docker/web/{Dockerfile,nginx.conf}`
  - `scripts/e2e-smoke.mjs`
  - `docs/AWS_MIGRATION_CHECKPOINT.md` (this file)
- **Local `.env` (untracked):** only the temporary `PRDSIM_APP_KEY` line, added during the migration, was removed.

### battle-arena-api
- **Modified:**
  - `app/Application/Pvp/PvpRealtimePublisher.php`: Lambda driver alongside the Redis publish.
  - `config/pvp.php`: `realtime.driver` and the `lambda` block.
  - `config/filesystems.php`: `AWS_SESSION_TOKEN` on the `s3`/`profiles` disks.
  - `config/l5-swagger.php`: docs path moved to `base_path('storage/api-docs')`.
  - `app/Console/Commands/SyncOpenApiDocsCommand.php`: uses the config path.
  - `bootstrap/app.php`: `telescope:prune` is scheduled only when Telescope is installed.
  - `tests/Feature/OpenApi/OpenApiDocsTest.php`: checks the configured docs path.
- **New:**
  - `app/Infrastructure/Realtime/LambdaRealtimeNotifier.php`
  - `tests/Unit/Application/Pvp/PvpRealtimePublisherTest.php`
  - `tests/Unit/Config/LambdaReadinessConfigTest.php`

### battle-arena-realtime
- **Modified:**
  - `package.json`, `package-lock.json`: dev dependencies `@aws-sdk/client-apigatewaymanagementapi` and `@aws-sdk/client-lambda` 3.1161.0.
  - `README.md`: Lambda adapter section.
- **New:**
  - `src/lambda/{config,registry,transport,core,handler}.ts`
  - `tests/unit/lambdaCore.test.ts`

### battle-arena-web
- `src/features/pvp/types.ts`, `src/features/creatures/types/index.ts`: type-only fixes so the production build compiles.

### battle-arena-mobile
- `README.md` only (how to reach the local environment). No code changes.

### Documentation updates
- **api:** `README.md`, `.env.example`, `docs/{README,PHASE3_AUTH_AND_DATA_MODEL,PHASE5B3_TWO_CLIENT_UI_SMOKE,PHASE5B4_TWO_PLAYER_RELEASE_SMOKE_EN,BATTLE_ARENA_AWS_INFRASTRUCTURE_SPEC_EN}.md`
- **realtime:** `README.md`, `.cursor/rules/{00,60,80}`
- **web:** `README.md`
- **infra:** `README.md`, AWS spec, this checkpoint

### Data changes (no volume deleted)
- **Avatars:** the 4 avatars on volume `api_profiles` were copied to `s3://battle-arena-profiles/profiles/avatars/`.
- **Database:** `player_profiles.avatar_disk` was changed from `profiles_local` to `profiles` for those 4 rows.
- **Redis:** the Laravel cache moved from DB 1 to DB 0, matching Upstash's single database.

## 5. Architectural decisions

1. **Single environment.** It replaces the earlier separate DEV/PRD-SIM setup and is the permanent daily dev environment, using the production-compatible implementations.
2. **Bref v3 + laravel-bridge ^3.1** (2.x lacks Laravel 13 support), with `bref/extra-gd-php-84` for GD.
3. **Real Lambda runtime locally.** RIE is inside the images. The gateway emulator is custom-built, so there is no LocalStack or SAM dependency; that keeps it free and lightweight.
4. **Hot reload despite read-only Lambdas.**
   - PHP source is bind-mounted into `/var/task`.
   - All Laravel caches, views and storage live in `/tmp` (`LARAVEL_STORAGE_PATH`, `VIEW_COMPILED_PATH`, `APP_*_CACHE`).
   - The image ships `vendor`; dev packages are included through the build argument `COMPOSER_DEV=1`.
5. **Event-driven realtime instead of Pub/Sub.** Laravel async-invokes the realtime Lambda with the existing envelope. `connection.ready` is sent by a deferred self-invoke, because API Gateway rejects posts until `$connect` returns. The Redis Pub/Sub path is kept as the non-Lambda driver.
6. **Console Lambda kept.** Bref cannot serve HTTP and console from one function, and EventBridge needs a target for `schedule:run`. `SCHEDULES=` in `.env` disables it.
7. **Avatars only in S3.** Lambda has no persistent disk, so the `profiles_local` disk is no longer used.
8. **No SQS or DynamoDB.** Queue work is synchronous today, and the registry fits in Redis with TTL.
9. **Bref packages are added during the image build, not in `composer.json`.** That file carried separate uncommitted work during the migration (see §8).

## 6. Tests and actual results

| Suite | Command | Result |
|---|---|---|
| API (PHPUnit, inside the Lambda image) | `docker compose exec api php artisan test` | **607 passed** |
| Realtime (Vitest) | `npm test` in battle-arena-realtime | **45 passed** (incl. 14 Lambda core tests) |
| End-to-end smoke | `node scripts/e2e-smoke.mjs` | **26/27 passed, 0 failed, 1 known pre-existing issue** |
| API static analysis | `docker compose exec api vendor/bin/phpstan analyse` | **No errors** |
| Web typecheck (host) | `npm run typecheck` | Clean |
| Web production build | `docker compose build web` | Builds and is served by Nginx on :3000 |

### Validated locally
- **Platform:**
  - The architecture checks: entrypoint is the Lambda RIE, `BREF_RUNTIME` is set, root filesystem is read-only, user is `993:990`, no ports are published, and the gateway reports all three functions.
  - Every API route and the PHP Lambda constraints, through the payload 2.0 gateway.
  - Hot reload: a controller edit was served on the next request.
  - CORS for origins :3000 and :5173.
  - Existing data: 541 creatures and the existing users.
- **Accounts and storage:**
  - Login, Sanctum cookie session, registration, Mailpit email.
  - Avatars served from S3.
- **Realtime:**
  - The WS ticket handshake, Origin allowlist, ticket reuse rejection.
  - Deferred `connection.ready`, presence and `/api/pvp/online`.
  - Room grants and hint fanout to both players.
  - The 410 cleanup path.
  - `PUBSUB NUMSUB` = 0.
- **Gameplay and scheduler:**
  - The full PvP flow: invitation, lobby, battle, turns.
  - The turn-timeout scenario, through `schedule:run` on the console Lambda.

### Requires real AWS testing (not validated)
- **Lambda runtime:** cold starts, freeze/thaw between invocations, concurrency scaling, memory and timeout limits under load, payload size limits.
- **API Gateway:** real routing, throttling, custom domains and TLS; WebSocket idle (10 min) and max-lifetime (2 h) limits; `@connections` latency.
- **Managed services:**
  - **Neon:** connection limits, pooling, cold resume.
  - **Upstash:** latency, command limits, TLS.
  - **S3:** IAM and presigned URLs.
  - **CloudFront:** caching and invalidation.
  - **SES:** delivery.
  - **EventBridge:** timing.
- **Identity and access:** IAM roles and least-privilege policies (Lambda→Lambda invoke, `execute-api:ManageConnections`, S3); Secrets Manager/SSM.
- **Cookie authentication across domains:** Sanctum needs the web app and the API on a shared parent domain.
- **Operations:** CloudWatch logs, metrics, alarms, cost.

## 7. Pending tasks and known limitations

- **Bugs:**
  - **Known e2e issue, pre-existing:** the `pvp.invitation.changed` hint drops its status because of the realtime schema.
  - A non-UUID PvP battle id returns 500 instead of 404 (pre-existing).
- **Web repository health, at HEAD:** 2 lint errors and 4 failing unit tests; they were already present before this work.
- **Before deploying to AWS:** add `bref/bref:^3.0.16` and `bref/laravel-bridge:^3.1` to `battle-arena-api/composer.json`.
- **Differences from AWS** (by design or emulated):
  - The containers run in development mode: source mounted, dev packages included, `APP_ENV=local`, `APP_DEBUG=true`.
  - The gateway is an emulator, not AWS.
  - Local containers are not frozen between invocations.
  - Scaling of the realtime function is approximated through DNS.
- **Developer environment:**
  - Web hot reload needs Vite on the host (`npm run dev -- --port 5173`), which requires Node ≥ 22.12; the host currently has 20.12.
  - Realtime and web changes need `docker compose up -d --build <service>`.
- **Unused leftovers, kept and not deleted** (cleanup commands are in the README):
  - volumes `api_vendor`, `web_node_modules`, `api_profiles`;
  - DB `battle_arena_prdsim`, Redis DB 2, bucket `battle-arena-prdsim-profiles`;
  - e2e users `*@e2e.battlearena.local`;
  - the legacy Dockerfiles in the api, web and realtime repos;
  - the persistent realtime server (`src/index.ts`).

## 8. Git state

All changes are on branch `feat/aws-local-parity` in each repository and pushed to `origin`. `main` is unchanged.

`battle-arena-api` has separate commits for:

1. CI and coverage work that was already uncommitted before the migration: the CI workflow, PHPStan, coverage scripts, unit tests, `composer.json`/`composer.lock`, `phpunit*.xml`, `docs/CI_BRANCH_PROTECTION.md`.
2. The Lambda-readiness code and its tests.
3. Documentation.

Not committed, on purpose:

- `battle-arena-api/NUL`: stray Windows redirect artifact; safe to delete.
- `battle-arena-mobile/node_modules_old/`: old dependency folder.
- All `.env` files.

Keep the repositories on matching branches: `compose.yaml` depends on the API and realtime changes.

## 9. Next steps for AWS deployment

1. **Prepare the code:**
   - Add the Bref packages to `composer.json`.
   - Fix the 2 known bugs and the web lint/test debt.
   - Review and merge the `feat/aws-local-parity` branches. The API CI gates run on the pull request.
2. **Production build:** build the API image with `COMPOSER_DEV=0` (`--no-dev`, classmap-authoritative) and verify it locally behind the gateway with `APP_ENV=production`.
3. **Provision with IaC:** Serverless Framework / Bref, SAM, or CDK.
   - API and console Lambdas (Bref), the realtime Lambda (Node 22).
   - HTTP and WebSocket APIs, the EventBridge rule.
   - The S3 buckets (avatars, web), CloudFront.
4. **Managed services:**
   - Create the Neon database and run migrations from the console Lambda.
   - Create the Upstash database with `REDIS_DB=0` and TLS.
   - Configure SES or another SMTP provider.
5. **Secrets and IAM:**
   - `APP_KEY`, DB/Redis credentials and SMTP in SSM/Secrets Manager.
   - Least-privilege roles: `lambda:InvokeFunction` on realtime, `execute-api:ManageConnections`, S3 access to the avatar bucket.
6. **Domains:**
   - A shared parent domain for the web app and the API (Sanctum cookies).
   - Set `SANCTUM_STATEFUL_DOMAINS`, `SESSION_DOMAIN`, `FRONTEND_URL`, `WS_ALLOWED_ORIGINS` and `PUBLIC_WS_URL` (`wss://`).
   - Build web with the production `VITE_API_BASE_URL`.
7. **Data:** migrate the avatars from local S3 to the real bucket if production should start with existing data.
8. **Staging validation:**
   - Run `scripts/e2e-smoke.mjs` against staging.
   - Load-test cold starts and WebSocket fanout.
   - Verify the timeout schedule.
   - Point a mobile build at the staging endpoints.
9. **Observability:** CloudWatch log retention, alarms on errors and throttles, budget alerts.
