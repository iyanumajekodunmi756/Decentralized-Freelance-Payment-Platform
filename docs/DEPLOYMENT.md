# Deployment

How to put the three pieces of this project on the internet:

| Piece | Where | Why |
|-------|-------|-----|
| Contracts | Stellar **testnet** | Unaudited; the only network this project is meant for |
| Frontend | Vercel (or any static host) | Static Vite build, no server needed |
| Backend | A container host (Railway / Render / Fly / a VPS) | Long-running event indexer + PostgreSQL |

The backend **cannot** run as a Vercel serverless function: `startIndexer()`
(`backend/src/server.ts`) keeps a polling loop alive for the life of the
process, and Prisma needs a persistent PostgreSQL connection. Vercel functions
are short-lived and recycled, so the indexer would silently stop syncing.

Everything below assumes testnet. There is no mainnet path — see
[`../README.md`](../README.md) and [`SECURITY.md`](../SECURITY.md).

## What is deployed today

| Piece | Where | Status |
|-------|-------|--------|
| Contracts | Stellar testnet | ✅ Live — ids in [`../deployments/testnet.json`](../deployments/testnet.json) |
| Frontend | Vercel project `stellar-freelance-frontend` | ✅ <https://stellar-freelance-frontend.vercel.app> — all `VITE_*` contract vars set for Production and Preview |
| Backend API | — | ❌ Not deployed yet: `VITE_API_URL` is unset, so the job list falls back to `http://localhost:3000` and will fail in the browser until the API exists |

Deployment protection (Vercel Authentication) is **off** for the frontend project so the
demo is reachable without a Vercel login. Note that the Vercel project is not connected
to GitHub — deployments are pushed with the CLI, so a `git push` does not redeploy it:

```bash
cd frontend && vercel deploy --prod
```

---

## 1. Contracts → testnet

```bash
rustup target add wasm32v1-none
stellar keys generate deployer --network testnet --fund

XLM_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  scripts/deploy_testnet.sh
```

This builds the Wasm, deploys escrow/dispute/reputation, initializes them
(`escrow.init(admin, dispute)`,
`dispute.init(admin, arbitrators=[admin], threshold=1)`,
`reputation.init(admin, escrow)`), and writes:

- `deployments/testnet.json` — the machine-readable record (the source of truth)
- `frontend/.env` — the same ids as `VITE_*` vars (the previous file is backed up
  to `frontend/.env.bak`; set `KEEP_FRONTEND_ENV=1` to opt out)
- `backend/.env.contracts` — `ESCROW_/DISPUTE_/REPUTATION_CONTRACT_ID` (plus the
  XLM/USDC ids and `ARBITRATOR_ADDRESSES`) for the API

It also prints a **redeploy checklist**: the exact values to paste into the
Render dashboard, because [`../render.yaml`](../render.yaml) no longer hardcodes
contract ids. Updating only the frontend is what leaves the deployed backend
indexing the superseded contracts (issue #91) — see
[Redeploying the contracts](#redeploying-the-contracts).

Verify with an end-to-end run before touching the frontend:

```bash
scripts/demo_testnet.sh
```

It should print `status: "Completed"`, milestones with matching
`released_amount`, a `Rated` event carrying `count`/`total_score`, and a
weighted `get_aggregate` result.

Also exercise the frozen-escrow path (steps 1–4 of [`DISPUTES.md`](./DISPUTES.md)).
This one asserts its outcome — the escrow ends `Completed`, the dispute
`Resolved` — so a regression in `open_dispute`/`raise`/`approve`/`arbitrate`
fails the run instead of only printing something different:

```bash
scripts/demo_dispute_testnet.sh
```

**Contract ids change on every deploy.** Whatever is in `deployments/testnet.json`
is the only correct set; the ids in `README.md` and `docs/TESTNET.md` are a
snapshot for readers and must be updated when you redeploy. The full procedure
for keeping the three consumers in sync is in
[Redeploying the contracts](#redeploying-the-contracts).

## 2. Frontend → Vercel

Point a Vercel project at this repository with **Root Directory = `frontend`**.
`frontend/vercel.json` sets the Vite preset, the `dist` output, and the rewrite
that lets React Router handle deep links (`/jobs/123` would otherwise 404).

Set these environment variables in the project (Production *and* Preview). Vite
inlines them at build time, so **changing any of them requires a redeploy**:

| Variable | Value |
|----------|-------|
| `VITE_NETWORK` | `testnet` |
| `VITE_ESCROW_CONTRACT_ID` | from `deployments/testnet.json` |
| `VITE_DISPUTE_CONTRACT_ID` | from `deployments/testnet.json` |
| `VITE_REPUTATION_CONTRACT_ID` | from `deployments/testnet.json` |
| `VITE_XLM_CONTRACT_ID` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `VITE_USDC_CONTRACT_ID` | empty until a USDC SAC is configured |
| `VITE_API_URL` | the backend origin from step 3, e.g. `https://api.example.com` |
| `VITE_READONLY_SOURCE` | optional — see *Read-only source* below; leave empty in the normal case |

Without `VITE_API_URL` the app falls back to `http://localhost:3000`
(`frontend/src/lib/api.ts`) and the job list will fail for every visitor.

### Read-only source (`VITE_READONLY_SOURCE`)

Escrow state and reputation are public contract views. The frontend reads them
from a **read-only source account** rather than from the visitor's wallet, so a
shared `/jobs/:id` or `/profile/:address` link renders before anyone connects
Freighter (issue #108). A read only *simulates* the call: the source never signs
and is never charged.

By default **no account is needed at all.** Soroban simulates the call without
requiring the source account to exist in the ledger, so
`frontend/src/lib/stellar.ts` builds the simulation from a built-in, secret-less
all-zero key and reads work with no wallet, no extension and no funded account.

Set `VITE_READONLY_SOURCE` to the public key of any **funded** account only if
the RPC provider you use rejects simulations from an unknown source. The frontend
then loads it with `getAccount` and uses its real sequence number. A throwaway
account is enough and no secret is needed anywhere, because the app never signs
with it:

```bash
stellar keys generate readonly --network testnet --fund
stellar keys address readonly   # put this G... value in VITE_READONLY_SOURCE
```

The same set (plus the optional `VITE_READONLY_SOURCE`) applies to the
**containerised** frontend. `frontend/Dockerfile` declares every one of these as
a build arg — `VITE_API_URL` and `VITE_XLM_CONTRACT_ID` included — and
`docker-compose.yml` forwards each from the shell, so a container can be pointed
at a non-local API and can offer XLM:

```bash
VITE_API_URL=https://api.example.com docker compose up --build
```

Vite inlines these at build time, so changing one requires rebuilding the image
(`docker compose build frontend`), exactly as on Vercel.

## 3. Backend → container host

[`../render.yaml`](../render.yaml) is a Render Blueprint for this service. In the
Render dashboard: **New → Blueprint**, pick this repository, and Render creates
the `stellar-freelance-api` web service from `backend/Dockerfile`.

Then set the variables the Blueprint deliberately leaves manual:

- `DATABASE_URL` — the Tiger Cloud (or any managed) PostgreSQL connection string.
  `JWT_SECRET` is generated by Render.
- `ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, `REPUTATION_CONTRACT_ID` and
  `ARBITRATOR_ADDRESSES` — the values `scripts/deploy_testnet.sh` printed. They
  are `sync: false` on purpose, so a committed file can never ship a stale id
  (see [Redeploying the contracts](#redeploying-the-contracts)). Everything else
  is pre-filled.

Once the API has an origin, set `VITE_API_URL` on the Vercel project to it and
redeploy the frontend (the value is inlined at build time), then set the
backend's `CORS_ORIGIN` to `https://stellar-freelance-frontend.vercel.app`.

### Render caveats

- **The free plan spins down when idle.** The indexer is in-process, so it pauses
  with the service. It resumes from the persisted `IndexerCursor` and catches up,
  but events raised while it was asleep are applied late rather than immediately.
- **`autoDeployTrigger` is `off`** so a `git push` does not ship to production without a
  green CI run. Deploy from the dashboard, or `render deploys create <service>`.
- **First request after a spin-down boots quickly** — database migrations are
  separated from web server container startup (issue #302). Migrations execute once during
  Render's `preDeployCommand` phase (or in a dedicated migration init container in docker compose)
  before web containers boot, preventing concurrency deadlocks during replica scaling.
- The Blueprint creates no database on purpose (the free Render Postgres tier
  expires). To use Render's Postgres instead, add a `databases:` block and point
  `DATABASE_URL` at it with `fromDatabase`.

Build is `backend/Dockerfile`; it executes `node dist/server.js`. Attach a PostgreSQL instance and set:

| Variable | Notes |
|----------|-------|
| `DATABASE_URL` | connection string for the managed Postgres |
| `DATABASE_POOL_SIZE` | optional Prisma connection pool limit (default `10`). Recommended setting: `num_physical_cores * 2 + 1` or sized to container memory/connections to prevent pool starvation (P2024 error) under high concurrency |
| `DATABASE_TIMEOUT_MS` | optional database query statement timeout and pool acquisition timeout in ms (default `10000`) |
| `REPLICA_URL` | optional PostgreSQL read replica connection string. When set, `/health` probes it with `pg_last_xact_replay_timestamp()` and reports lag metrics (issue #381). Unset leaves the health payload unchanged |
| `REPLICA_LAG_THRESHOLD_MS` | replication lag above this many milliseconds marks `/health` as `degraded` with HTTP 503 (default `30000`) |
| `JWT_SECRET` | **at least 32 characters** — the config schema exits the process otherwise |
| `NODE_ENV` | `production` |
| `STELLAR_NETWORK` | `testnet` |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `ESCROW_CONTRACT_ID` / `DISPUTE_CONTRACT_ID` / `REPUTATION_CONTRACT_ID` | from `deployments/testnet.json`. `render.yaml` does **not** set these — put them in the dashboard. Without them the indexer logs "No contract IDs configured" and does nothing; when they no longer match the record the API logs `[config] Contract IDs do not match the latest deploy` |
| `XLM_CONTRACT_ID` | the testnet XLM SAC (stable across contract deploys, so it is committed in `render.yaml`) |
| `ARBITRATOR_ADDRESSES` | comma-separated panel addresses allowed to call `POST /api/disputes/:id/resolve`. Set it alongside the contract ids; empty **disables** the route (it fails closed) |
| `DEPLOYMENTS_FILE` | optional path to the deploy record for the startup freshness check; defaults to `deployments/testnet.json` |
| `CORS_ORIGIN` | the Vercel origin, e.g. `https://your-app.vercel.app`. Required in production: an empty value or `*` stops the backend at startup (empty allows every origin only in development) |
| `INDEXER_POLL_INTERVAL_MS` | `5000` is fine; raise it to reduce RPC traffic |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | Per-IP budget for each wallet-auth route, counted separately (default `10` per `60000` ms). Raise it only if a shared NAT makes legitimate logins collide |

Any managed Postgres works. [Tiger Cloud](https://www.tigerdata.com/cloud) has a
free tier (two services, 750 MB each) and speaks plain PostgreSQL, so Prisma
needs no changes.

### Runtime users in the containers

Neither image runs as root (issue #112):

| Image | Runtime user | Notes |
|-------|--------------|-------|
| `backend/Dockerfile` | `node` (uid 1000, from `node:20-alpine`) | The process only reads the image (`dist`, `node_modules`, `prisma/`, `deployments/`) and writes to the database; `/tmp` and `/home/node` are the writable paths and are owned by `node`. Its build context is the repo root so `deployments/testnet.json` can be copied in (issue #91). Port 3000 (>1024) binds fine unprivileged. |
| `frontend/Dockerfile` | `nginx` (uid 101, from `nginxinc/nginx-unprivileged`) | Pid file and nginx temp paths live under `/tmp`. **Listens on 8080**, not 80 — a non-root process cannot bind a privileged port. |

Consequences for hosts:

- If you run the frontend container anywhere other than `docker-compose.yml`,
  map your host port to **8080** (`-p 8080:8080` or a proxy upstream of 8080).
- `docker compose exec backend id` / `docker compose exec frontend id` should
  report a non-root uid — use that as the smoke test after any Dockerfile change.
- Nothing in either container needs a writable image layer; if you add file
  logging or uploads, give the path an explicit owner (`COPY --chown=...`)
  rather than reverting to root.

### Health and sanity checks after deploying

The API now exposes two endpoints:

1. **GET /health** – Lightweight liveness probe for the container orchestration.
   - Probes PostgreSQL connectivity with `SELECT 1`.
   - Probes the indexer cursor: must have advanced beyond ledger 0.
   - Returns **200** `{ status: "ok", db: true, indexer: true }` when both are healthy.
   - Returns **503** `{ status: "unhealthy", db: false/indexer: false }` when either dependency is down.
   - Returns **200** `{ status: "degraded", db: true, indexer: false, message: "..." }` when the indexer has not advanced recently (stale cursor).

2. **GET /ready** – Readiness check for monitoring / platform flow control.
   - Same checks as `/health` but intended for orchestrators to gate traffic.
   - Platforms (Render, Railway, Fly) should use this as the `healthCheckPath` or `readinessProbe`.
   - Returns **200** when fully ready, **503** when any dependency is unhealthy.

#### After deploying, verify:

```bash
# Liveness – container orchestration knows if API is functional
curl -fsS "$API_URL/health"
# {"status":"ok","db":true,"indexer":true}

# Readiness – platform should use this to decide whether to route traffic
curl -fsS "$API_URL/ready"
# {"status":"ok","db":true,"indexer":true}
```

Then indexer progress — the cursor should be advancing past 0:

```sql
SELECT "lastLedger", "updatedAt" FROM "IndexerCursor";
```

Events the indexer could not apply are recorded rather than dropped. Check this
table after a redeploy that changed event payloads:

```sql
SELECT * FROM "IndexerDeadLetter" ORDER BY "lastSeenAt" DESC LIMIT 20;
```

Each row is state that is missing from the database; fix the handler, replay the
event, then delete the row.

## Redeploying the contracts

Contract ids change on **every** `scripts/deploy_testnet.sh` run, and the same
three ids are consumed from four places. Updating only some of them is the
failure this section exists to prevent (issue #91): the frontend points at the
new contracts while the deployed backend still filters Soroban RPC for the old
ones, so the indexer applies nothing while every health check stays green.

| Consumer | Updated by | Verify |
|----------|-----------|--------|
| `deployments/testnet.json` | the script (committed) | the source of truth |
| `frontend/.env` | the script (`VITE_*`) | baked in at build time — redeploy Vercel |
| `backend/.env.contracts` | the script (`ESCROW_*` etc.) | for a local / VPS checkout |
| Render dashboard env | **you** — the script prints the values | set them, then redeploy the service |

`render.yaml` deliberately no longer carries the ids, so a `git push` cannot
ship a stale one — the dashboard value is the only copy Render uses.

One procedure:

1. Run `scripts/deploy_testnet.sh`. It writes `deployments/testnet.json`,
   `frontend/.env` and `backend/.env.contracts`, and prints the exact values to
   set in the Render dashboard.
2. Commit `deployments/testnet.json` (the record).
3. Set the printed values in the Render dashboard and redeploy the backend, and
   rebuild/redeploy the frontend so the new `VITE_*` ids are inlined.
4. Restart the backend and confirm it does **not** log
   `[config] Contract IDs do not match the latest deploy`.

The API reads `deployments/testnet.json` at startup (the container carries the
committed copy; override the path with `DEPLOYMENTS_FILE`) and compares it with
`ESCROW_CONTRACT_ID` / `DISPUTE_CONTRACT_ID` / `REPUTATION_CONTRACT_ID`. A
non-empty but stale id used to index the wrong contracts silently; now it is a
loud warning. A missing record is not fatal — the API stays quiet — but it also
cannot check, so keep the file committed.

### Verifying the ids match after a redeploy

`deployments/testnet.json` is the source of truth; every other copy must equal
it.

```bash
# 1. The deployed ids (source of truth)
jq -r '.escrow_contract_id, .dispute_contract_id, .reputation_contract_id' \
  deployments/testnet.json

# 2. What the frontend build inlines
cat frontend/.env

# 3. What the API warns about, from its logs
#    (Render dashboard → stellar-freelance-api → Logs)
#    Look for: [config] Contract IDs do not match the latest deploy
```

Compare the three lists. If the warning appears, the backend is still following
the previous contracts: update the four dashboard variables from the script's
checklist, redeploy, and confirm the line is gone.

## 4. Order of operations

1. Deploy contracts (step 1) and run the demo.
2. Deploy the backend (step 3) with the new contract ids in its env, then check
   its logs for the stale-id warning (see
   [Redeploying the contracts](#redeploying-the-contracts)).
3. Deploy the frontend (step 2) with `VITE_API_URL` pointing at the backend.
4. Add `CORS_ORIGIN` = the frontend origin to the backend and restart it.
5. Smoke-test in the browser with Freighter or LOBSTR set to **Testnet**: pick
   the wallet, connect, post a job, fund it, release a milestone.

Contract ids and `VITE_*` values are baked in at build time, so if you redeploy
the contracts you must restart the backend and rebuild the frontend.

### Contract ids in the compose stack

`docker-compose.yml` passes the indexer's contract ids to the backend service:
`ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, `REPUTATION_CONTRACT_ID`, and the
`XLM_CONTRACT_ID` / `USDC_CONTRACT_ID` SACs. Each has a default read from the
deployment committed in [`deployments/testnet.json`](../deployments/testnet.json),
so `docker compose up --build` indexes testnet without any extra configuration.

To point the stack at another deployment — after redeploying the contracts, or at
a fresh testnet deploy — export the ids before starting it (a root `.env` file
works too):

```bash
ESCROW_CONTRACT_ID=$(jq -r .escrow_contract_id deployments/testnet.json) \
DISPUTE_CONTRACT_ID=$(jq -r .dispute_contract_id deployments/testnet.json) \
REPUTATION_CONTRACT_ID=$(jq -r .reputation_contract_id deployments/testnet.json) \
  docker compose up --build
```

The backend reads them at start-up, so changing one needs a restart
(`docker compose up -d backend`), not a rebuild. Check that the indexer picked
them up with `docker compose logs backend | grep -i indexer`; without them it
logs `No contract IDs configured` and does nothing. These are the same variables
the Render deployment sets in its dashboard — `render.yaml` deliberately leaves
them manual so a committed file cannot ship a stale id.

### Containerised API routing & reverse proxy

The containerised frontend image uses nginx as a reverse proxy for `/api/` traffic (`frontend/nginx.conf`):
- When built via `docker-compose.yml`, `VITE_API_URL` defaults to an empty string (`""`), configuring the application in `frontend/src/lib/api.ts` to make relative requests (`/api/...`).
- In the browser, API calls made to `/api/*` on port 5173 hit nginx on container port 8080, which reverse-proxies them directly to `http://backend:3000`.
- In local development (`npm run dev`), Vite's dev server proxy similarly forwards `/api` to `http://localhost:3000`.
- For external or custom deployments where the frontend and backend are hosted on separate domains, `VITE_API_URL` can be set to an absolute backend URL at build time.

---

## 5. Database Maintenance & Historical Archiving

As platform volume scales, operational tables (`Job`, `Milestone`, `Deliverable`, `Message`, `ChainEvent`, and `Proposal`) grow continuously. Unpruned historical records lead to PostgreSQL B-tree index bloat, increased buffer cache churn, and degraded performance for queries filtering live, active jobs (issue #272).

### Archiving Schema & Cold Storage (`ArchivedJob`)

Completed and refunded jobs past their operational retention window (default: 365 days) are moved to cold archive storage (`ArchivedJob` model). 

Each archive entry captures a full relational JSON snapshot (`archiveData`) containing:
- Root job attributes, client and freelancer IDs, asset, and total amount.
- Milestones with original amounts, descriptions, and release progress.
- Attached deliverables and off-chain file records.
- Participant communication history (`Message` records).
- Submitted freelancer proposals and proposed rates.
- Arbitrated dispute records and approved settlement shares.
- Mutual reputation ratings and scores.
- Associated on-chain transaction hashes and event logs (`ChainEvent`).

### Archival CLI Script (`scripts/archive_historical_jobs.ts`)

The maintenance CLI script scans for jobs with terminal statuses (`COMPLETED`, `REFUNDED`) whose `updatedAt` exceeds the retention cutoff date.

```bash
# Preview eligible jobs older than 365 days without making database changes
npx --prefix backend tsx ../scripts/archive_historical_jobs.ts --dry-run

# Archive completed/refunded jobs older than 180 days in batches of 100, saving JSON files to disk
npx --prefix backend tsx ../scripts/archive_historical_jobs.ts \
  --retention-days 180 \
  --batch-size 100 \
  --export-dir ./archives/2026
```

#### Foreign Key Pruning Order

PostgreSQL enforces relational foreign key constraints across jobs and dependent entities. To prevent foreign key constraint violations during deletion, each archived job is processed in an isolated transaction executing cascade deletions in the following strict dependency order:

1. `Deliverable` records (attached to milestone IDs)
2. `Milestone` records (attached to `jobId`)
3. `Message` records (conversation between participants)
4. `Proposal` records (submitted applications)
5. `Dispute` records (arbitration cases)
6. `Rating` records (job reputation feedback)
7. `SavedJob` records (bookmarks)
8. `Notification` records (job-specific alert records)
9. Root `Job` record

### Scheduled Archiving (Cron Job)

In production container environments (Render/Railway/VPS), run the archival script as a recurring cron job (e.g., weekly at 02:00 UTC on Sundays):

```cron
0 2 * * 0 cd /app && npx --prefix backend tsx ../scripts/archive_historical_jobs.ts --retention-days 365 --batch-size 250 >> /var/log/job-archiving.log 2>&1
```

### High-Volume Partitioning Strategy (`ChainEvent` & `Message`)

For large enterprise deployments processing millions of events per month, operational tables with monotonic chronological keys (`ChainEvent` by `ledger`/`createdAt` and `Message` by `createdAt`) should be partitioned using native PostgreSQL declarative range partitioning:

```sql
-- Example monthly partitioning strategy for ChainEvent
CREATE TABLE "ChainEvent_Partitioned" (
    "id" TEXT NOT NULL,
    "escrowId" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "amount" DECIMAL(36, 18),
    "txHash" TEXT,
    "ledger" INT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Monthly partition instances
CREATE TABLE "ChainEvent_2026_01" PARTITION OF "ChainEvent_Partitioned"
    FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2026-02-01 00:00:00');
```

Partition pruning allows operational queries to scan only active monthly partitions, while old partitions can be detached and archived into cold object storage (S3/GCS) without locking the active table.

