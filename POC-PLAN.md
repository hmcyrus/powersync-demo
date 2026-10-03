# PowerSync POC — Plan to validate the Digital RX deployment (curtailed MVP)

**Status:** plan, not yet executed. Written 2026-10-04, revised the same day after an assessment and owner decisions
(section 4).
**Audience:** any engineer or agent who will assess, extend, or execute this POC without prior context.
**Nature of this POC:** disposable evidence. Its job is to answer go/no-go questions about using PowerSync for the
offline-first browser client of Digital RX (repo `D:\cyrus\gigs\prescription-buddy`). Its code is not the production
server. Only a few artifacts are meant to be copied over (see section 10).

---

## 1. Why this POC exists

The real product ("Digital RX", repo `D:\cyrus\gigs\prescription-buddy`) is an offline-first prescription app for
doctors in Bangladesh. The next release is described in
`D:\cyrus\gigs\prescription-buddy\docs\overhaul\08-deploy-plan.md` ("curtailed MVP"). That document is the source
of truth for the target. In short:

- Take the existing browser client (`client/`, React + Vite + `@powersync/web` 2.3.1, currently **local-only**: all
  33 tables are `localOnly: true` and `connect()` is never called) to a real deployment for about **100 alpha
  doctors**.
- **Tenant = one doctor = one Google account.** Each account may register at most **3 devices** (a device is a
  registered browser install). Google OAuth is the only sign-in, restricted to a pre-approved email allowlist.
- **Full offline use.** After one online load and one completed first sync, the doctor can use the app offline
  indefinitely. Changes upload when a connection returns. Delivered as an installed **PWA** on **Chrome and Edge
  desktop only** (Safari and iPad are explicitly out because Safari evicts idle site data). No Electron, no Capacitor.
- A server that supports exactly: Google sign-in, device registration and the 3-device limit, PowerSync token issuing,
  the upload endpoint, and tenant-scoped storage.
- Hosting: one VPS (Singapore), Docker Compose, **one Postgres 16** (source of truth **and** PowerSync bucket
  storage, in a second database on the same server), self-hosted PowerSync Open Edition, FastAPI, Caddy for HTTPS.
- Explicitly deferred (do **not** test): sign/amend immutability, audit log, telemetry, CSV export, pads/chambers,
  encryption/PIN, update channels, staleness rules beyond a sync indicator, merge logic, roles, soft delete.

Other context documents (read only if needed): `docs/overhaul/02-architecture.md` (full architecture),
`docs/overhaul/04-mvp-plan.md` (the larger MVP that 08 supersedes), `docs/overhaul/05-pre-mvp.md` (the built client).
An earlier plan (and `sonnet-5.5-assessment-of-next-step.md` in this repo) targeted 04 (Electron/Capacitor/conflict
merge/signed visits); it is superseded because 08 is a different, narrower release.

## 2. Questions this POC must answer (go/no-go)

| ID | Question | Why it matters for 08 |
|---|---|---|
| Q1 | Can sync streams guarantee that doctor A never receives doctor B's rows, and can `/sync/upload` guarantee A never writes B's rows or system rows? | Tenant isolation is the first in-scope item. |
| Q2 | Does the `catalog` stream shape (shared rows with null `tenant_id` plus per-tenant rows) work, without storing the shared rows once per tenant? | 08 Step 3 uses `tenant_id IS NULL OR tenant_id = auth.user_id()`. Docs show no example of this form. |
| Q3 | Does PowerSync run stably with **Postgres bucket storage** in a second database on the same Postgres instance as the source? | 08 section 3 hosting plan. The POC currently uses MongoDB. |
| Q4 | Does a signed asymmetric JWT (JWKS, short expiry, `sub`=tenant, `device_id` claim) work end to end, including refresh, expiry, and revocation? | 08 Step 2.4. |
| Q5 | Does the app boot and work fully offline after a browser restart (service worker + IndexedDB-backed SQLite, without COOP/COEP headers) **on the same SDK version as the real client**, and recover on reconnect? | The headline requirement. |
| Q6 | What happens when the session or token expires while offline? | 08 section 2 and Step 4.5. |
| Q7 | Does the 3-device limit hold under concurrency, and does remove/revoke lead to the "show unsynced count, then wipe" flow? Does a removed device stop receiving data, and how soon? | 08 Step 2 and 4.8. |
| Q8 | What exactly happens to a doctor's local data when the server drops a bad write ("complete the batch and log the drop")? Does the queue keep moving? | 08 Step 3.3 design choice. |
| Q9 | Do client-generated patient codes (`YYMMDD` + device slot + counter) collide after slot reuse, and what does the upload path do on a collision? | 08 Step 4.4 requires slot-based codes; slot reuse is an unexamined hole. |
| Q10 | Do parent/child writes (no foreign keys) arrive atomically, and what happens to orphans after a delete on another device? | 08 Step 1.3 (no FKs) and section 1 (hard deletes stay). |
| Q11 | Can schema changes (additive column) and a Postgres restore be done safely with live clients? | 08 section 3 (additive-only, restore drill). |

Capacity (about 300 connections, onboarding burst, reconnect storm) is **not** a POC question; it is planned and
measured for the real app (section 9).

## 3. Current state of this repo (starting point)

Repo: `D:\cyrus\lab\powersync-poc` (remote `https://github.com/hmcyrus/powersync-demo.git`, branch `main`).
Untracked: `ci-debug/` (artifacts of one failed CI run), `sonnet-5.5-assessment-of-next-step.md` (superseded), this
file.

**What exists** (a single shared to-do list on the web, two slices):

```
docker-compose.yml          postgres:16 (only -c wal_level=logical), mongo:7.0 (replica set rs0, PowerSync bucket
                            store), mongo-rs-init, journeyapps/powersync-service:latest (unified mode, port 8080;
                            CI logs show it resolved to v1.26.1)
powersync/init.sql          CREATE TABLE todos(id uuid PK, title text, is_completed int, created_at timestamptz);
                            CREATE PUBLICATION powersync FOR ALL TABLES;   <-- must be narrowed (section 5.2)
powersync/service.yaml      Postgres replication URI, Mongo storage, port 8080, HS256 shared-secret JWKS (kid
                            dev-key-1), audiences http://localhost:8080 and http://127.0.0.1:8080
powersync/sync-config.yaml  edition 3; stream `todos`, auto_subscribe, `SELECT * FROM todos` (no filtering)
backend/main.py             FastAPI + psycopg3, hardcoded DSN; GET /todos, POST /todos (idempotent upsert),
                            PATCH /todos/{id} (partial), DELETE /todos/{id}. No auth, no CORS (Vite proxies /api).
frontend/                   Vite 6 + @powersync/web ^1.24.0 (lockfile resolves 1.39.1); src/{main,db,connector,
                            devToken,style}.js; dbFilename 'todos.db'; default storage options; no COOP/COEP; no PWA
                            devToken.js mints an HS256 JWT in the browser (dev only, sub='dev', aud=http://localhost:8080)
                            connector.js: fetchCredentials = dev token; uploadData maps PUT/PATCH/DELETE to the API;
                            an in-app "network" switch makes uploadData throw while the sync connection stays up.
e2e/pass-checks.mjs         14 Playwright checks (Slice 1.1-1.6 with 1.2 split into four, Slice 2.1-2.5), run
                            against the Docker stack
.github/workflows/pass-checks.yml   manual-only (workflow_dispatch) run of the above
README.md, EXECUTIVE-SUMMARY.md     how to run; what the todo POC does and does not prove (aligned with this plan)
```

**What it already proves** (and no more), on SDK 1.x only: the screen can read only local SQLite; server-to-device
feed works on web including a second client profile; the upload queue holds writes while the API fails and flushes
later; the upload API works as an idempotent upsert with partial PATCH.

**Known state and gaps:**
- **SDK mismatch:** this POC runs `@powersync/web` 1.39.1; the real client runs `@powersync/web` 2.3.1 with
  `@journeyapps/wa-sqlite` 2.0.4. Offline and storage behaviour must be re-proven on 2.3.1 (test 0.2).
- No local run has ever been recorded (Docker was not running on the author's machine). CI: one run (ID
  36235697185) failed at the "wait for services" step: `wait-on` sent HEAD to the GET-only `/todos` and got 405
  (confirmed in `ci-debug/backend-failure.log`; PowerSync itself started fine). PRs #2 (liveness probe), #3 (process
  handling, log upload) and #4 (`http-get://` for wait-on) were merged, but a green run has **not** been confirmed.
- Everything the target needs is untested: tenancy, real auth, real offline, rejected writes, multi-table
  transactions, schema change, revocation, Postgres bucket storage, PWA.
- Windows path quirk: `checkPowerSyncLogs()` in `e2e/pass-checks.mjs` uses `new URL('..', import.meta.url).pathname`
  (yields `/D:/...` on Windows) instead of the already-defined `ROOT`.
- App must be opened at `http://localhost:5173`. The service accepts both `localhost` and `127.0.0.1` audiences, but
  the dev token is minted only for `http://localhost:8080`; the exact cause of the `127.0.0.1` failure is unverified
  and does not matter once Caddy is in place.

## 4. Scope decisions (agreed with the project owner)

- **Disposable evidence.** Optimise for the speed and clarity of answers, not production structure. Reusable
  artifacts are listed in section 10.
- **Minimal increment of the existing to-do app**, not a copy of the Digital RX schema. The to-do app extended as in
  section 5 is sufficient. Keep 4 synced tables; do not pad with dummy tables to mimic the real app's ~33 streams
  (rebuild and per-device costs at real scale are measured on the real app).
- **Same SDK as the real client.** Upgrade the POC frontend to exactly `@powersync/web` 2.3.1 and
  `@journeyapps/wa-sqlite` 2.0.4 (exact pins, no `^`). Pin the PowerSync service image to a specific version
  (start from v1.26.1; move up only if SDK 2.3.1 requires it, and record the version used). Use a `@powersync/node`
  version that matches for the headless harness.
- **Atomic uploads.** The client uploads one local transaction at a time (`getNextCrudTransaction`), and
  `/sync/upload` applies it in a single Postgres transaction. If any operation in it is invalid, the **whole
  transaction is dropped and logged**; the server never holds a partial save.
- **Dropped writes may be lost in the POC.** The POC uses drop-and-log only and documents what the doctor's device
  shows (test 1.9). The production "never lose anything" requirement (quarantine plus client-side retry) is deferred
  to the real app (section 9).
- **Token expiry is configurable** (environment variable). Tests use short values (for example 2-5 minutes) so expiry
  and revocation scenarios run quickly. The results recommend a production value.
- **Same-browser account switching is out of scope** for the POC (production requirement in section 9).
- **No migration of existing local data:** alpha doctors start fresh.
- **Google sign-in is stubbed** with a local OIDC-like provider. The real Google flow and consent screen are tested
  at deploy time (08 Step 6), not here.
- **Local Docker only.** Caddy runs in Docker with `*.localhost` names. No real VPS, no real domain, no network
  throttling, no load or capacity testing.
- **Volume:** use an assumed per-doctor set of 2,000 parent rows and 10,000 child rows for the standard runs, plus
  **one stress pass** at the larger ceiling from `04-mvp-plan.md` NF-7 (5,000 patients, 15,000 visits, 75,000 rx lines
  per doctor) mapped onto the POC tables, reported as an upper bound.
- **Thresholds:** use the soft defaults in section 7; numbers are reported, not optimised. Real targets are set for
  the actual app.
- **Built-in behaviour gets quick checks only:** publication exclusion (1.4), multi-tab (2.6), and last write wins
  (3.4) are single quick checks, not full scenarios.

## 5. Target POC architecture and schema

### 5.1 Topology (Docker Compose)

- `postgres` 16, logical replication on (`wal_level=logical`; set `max_wal_senders` and `max_replication_slots`
  explicitly). Databases: `app` (source of truth) and `powersync_storage` (bucket storage). PowerSync
  `storage.type: postgresql` (supported since service 1.3.8; Postgres 14+ may host source and storage on the same
  server). A dedicated replication role limited to the published tables. Note: WAL is shared by the whole server, so
  bucket-storage writes add to the WAL the replication slot must read and retain; track WAL size in 0.3, 3.7, 3.8,
  and 3.10.
- `powersync` (journeyapps/powersync-service, **pinned version**), sync config edition 3, JWT verification via
  **JWKS URL** served by the API (asymmetric key), not a shared secret. CORS must allow `http://app.localhost`
  because the service is on a different origin.
- `api` (FastAPI): stub OIDC login, session cookie, device registration, token endpoint, `/sync/upload`, `/devices`.
- `oidc-stub`: tiny provider that issues an authorization code for a configurable email (can be part of `api`).
- `caddy`: serves the built frontend and `/api` on one origin (`app.localhost`), proxies PowerSync on
  `sync.localhost`. Serves `sw.js` uncached. **No COOP/COEP headers.**
- Remove `mongo` and `mongo-rs-init` once Q3 passes.
- Chromium resolves `*.localhost` to loopback by itself; Node on Windows may not. The headless harness should call
  the services by `localhost:<port>` or set explicit host mappings.

### 5.2 Tables (Postgres `app` database, text primary keys, **no foreign keys** on synced tables)

Synced (published):

| Table | Columns (beyond `id text PK`) | Purpose |
|---|---|---|
| `todos` | `tenant_id text NOT NULL`, `title`, `is_completed int`, `created_at`, `code text` | Basic tenant-scoped rows; `code` = `YYMMDD` + device slot + counter (Q9). |
| `todo_items` | `tenant_id text NOT NULL`, `todo_id text`, `text`, `done int`, `seq int` | Child rows with no FK: atomic parent+child save, orphans (Q10). |
| `catalog` | `tenant_id text NULL`, `name`, `kind` | Null `tenant_id` = shared system rows; non-null = that doctor's custom rows (Q2). |

Server-only (**must not** be published or synced): `users` (google subject, email, tenant id), `allowed_emails`,
`devices` (tenant, slot 1-3, name, `revoked_at`), `refresh_tokens`, `upload_drops` (log of dropped transactions,
with the full original payload and the reason).

Publication: `CREATE PUBLICATION powersync FOR TABLE todos, todo_items, catalog;` (not `FOR ALL TABLES`).
Tenant id = the doctor's user id; it is the JWT `sub`. (08 also stamps `doctor_id` and `created_by_doctor_id`; with
tenant = doctor these equal `sub`, so the POC stamps `tenant_id` only and the pattern extends directly.)

### 5.3 Sync config (edition 3, all auto-subscribed)

```yaml
config:
  edition: 3
streams:
  catalog_shared:      # shared rows: no parameter, should be one bucket for everyone
    auto_subscribe: true
    query: SELECT * FROM catalog WHERE tenant_id IS NULL
  catalog_own:
    auto_subscribe: true
    query: SELECT * FROM catalog WHERE tenant_id = auth.user_id()
  todos:
    auto_subscribe: true
    query: SELECT * FROM todos WHERE tenant_id = auth.user_id()
  todo_items:
    auto_subscribe: true
    query: SELECT * FROM todo_items WHERE tenant_id = auth.user_id()
```

Also test the single-stream form from 08 (`WHERE tenant_id IS NULL OR tenant_id = auth.user_id()`). If the service
rejects it or it stores shared rows per tenant, record that and keep the two-stream form (test 0.4).

### 5.4 API contracts to implement (stub-grade, but with the real shape)

- `GET /auth/oidc/start`, `GET /auth/oidc/callback`: only allowlisted emails; sets an httpOnly session cookie and a
  refresh token (about one year, sliding).
- `POST /devices/register` (client-generated device id): assigns the **lowest free slot 1-3**, else **409** with the
  three devices listed. Must be race-safe.
- `GET /devices`, `DELETE /devices/{id}`: list and free a slot (sets `revoked_at`).
- `GET /sync/token`: requires session; checks the device exists and is not revoked; returns a JWT signed with an
  asymmetric key (kid published at `/.well-known/jwks.json`): `sub`=tenant id, `device_id` claim, `aud` matching
  the PowerSync service, expiry from configuration (section 4). **401** expired session, **403** revoked device.
- `POST /sync/upload`: receives **one client transaction** per request. Validates the token; checks the device is not
  revoked (a revoked device's token stays valid until expiry, so this check is mandatory); whitelists tables and
  columns; **stamps `tenant_id` from the token, never from the client**; upserts with
  `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE <table>.tenant_id = :t`; never writes rows whose `tenant_id` is null
  (shared `catalog` rows are read-only for devices); deletes and updates are tenant-scoped. All operations run in one
  Postgres transaction. If any operation is malformed, disallowed, or would touch another tenant's row, the **whole
  transaction is rolled back, logged in `upload_drops`, and the request still returns 2xx** so the queue is not
  blocked.

### 5.5 Client changes (frontend, minimal)

- `@powersync/web` 2.3.1 and `@journeyapps/wa-sqlite` 2.0.4, exact pins (test 0.2).
- Identity record in `localStorage` (tenant, device id, slot, email); DB filename `rx-<tenant>.db`.
- Boot order: known identity -> open local DB and render immediately, connect in the background; no identity ->
  sign-in, device registration, "preparing your offline copy" until first sync completes.
- Connector: `fetchCredentials` calls `/sync/token`, must never block rendering when offline; `uploadData` takes one
  transaction with `getNextCrudTransaction()`, posts it to `/sync/upload`, then calls `complete()`.
- UI: sync status with unsynced-change count (`getUploadQueueStats` or equivalent), "device removed" screen offering
  wipe (`disconnectAndClear`), device list with remove buttons, a todo list with child items and a `code` field.
- PWA: `vite-plugin-pwa`, precache app shell plus PowerSync wasm and worker files, never cache `/api` or sync
  traffic, `navigator.storage.persist()`, "reload to update" prompt (never auto-reload mid-edit).
- No COOP/COEP in the Vite dev config or Caddy; confirm the default IndexedDB-based storage works on SDK 2.3.1.

## 6. Phased test plan

Effort tags: S small, M medium, L large. Each test has an ID so results can be tabulated in the final report.
Order is risk-first: the spikes in Phase 0 can change the design, so they run before more is built on them.

### Phase 0 - Foundation and design spikes (M)

0.1 Baseline: run the existing 14 checks locally and in CI; record the result. Fix whatever blocks a green run,
including the Windows path in `checkPowerSyncLogs()` (use `ROOT`). Add `ci-debug/` to `.gitignore`.
0.2 SDK alignment: upgrade the frontend to exactly `@powersync/web` 2.3.1 and `@journeyapps/wa-sqlite` 2.0.4; pin
the PowerSync service image; re-run the 14 checks and fix anything the major-version change breaks. Record API
changes that affect section 10 artifacts.
0.3 Spike, Postgres bucket storage (Q3): second database for bucket storage, PowerSync `storage.type: postgresql`,
remove Mongo. Record startup, permission, replication-role, and replication-slot issues, and baseline WAL size.
0.4 Spike, stream forms (Q2; was 1.3): with two tenants and hand-minted dev tokens (before real auth exists),
evaluate (a) the single stream with `IS NULL OR = auth.user_id()` and (b) the two-stream form. For each, record
whether it is accepted, correct, and whether shared rows are stored once or per tenant (measure bucket storage size
with 1 vs 50 vs 100 tenants of seeded data). Also record bucket count per client. Pick the form used from here on.
0.5 Spike, offline cold start (Q5, early version of 2.2): on the current to-do app with SDK 2.3.1, add
`vite-plugin-pwa`, no COOP/COEP; in a Playwright persistent context, sync once, go offline, close and reopen the
context, load the app offline. It must boot from cache and show local data. Record what had to be precached.
0.6 Introduce `tenant_id`, the three tables, the narrowed publication, and the server-only tables.
0.7 Add Caddy, the stub OIDC provider, the FastAPI auth/device/token/upload endpoints, JWKS, and service CORS.
0.8 Build a headless multi-device harness using `@powersync/node` (each simulated device has its own DB file,
identity, and connector that talks to the real API). All Phase 1 and Phase 3 scenarios run through it; only Phase 2
needs a browser (Playwright Chromium). Use `node:test` or vitest.
0.9 Make CI run the new suite automatically on push or PR (the current workflow is manual-only), after it is stable.

### Phase 1 - Security core (M)

Isolation (Q1, Q2):
- 1.1 Two tenants, each with data: each device's local DB contains only its tenant's rows plus shared catalog rows,
  checked by comparing full local table contents to the expected set. Include `todo_items`.
- 1.2 A device tries to widen scope: forged claims, subscription/connection parameters, a token for another tenant
  signed with a wrong key, an expired token. All must fail or yield no extra data.
- 1.3 (moved to 0.4.)
- 1.4 Quick check: insert into `users`, `allowed_emails`, `devices`, `refresh_tokens`; confirm nothing reaches any
  client.

Upload hardening (Q1, Q8):
- 1.5 Tenant spoof: client sends `tenant_id` of another tenant in PUT/PATCH; server stamps from the token and the
  stored row is correct.
- 1.6 Id collision attack: tenant A PUTs/PATCHes/DELETEs an `id` owned by tenant B. Row B unchanged, no leak of its
  existence in the response, and the drop is logged.
- 1.7 Shared catalog protection: a device cannot create, update, or delete a null-tenant `catalog` row; it can create
  and modify its own custom rows.
- 1.8 Non-whitelisted table or column, malformed payload, oversized transaction: the whole transaction is dropped and
  logged, the request returns 2xx, and later transactions still apply.
- 1.9 Bad-write visibility (Q8): after a dropped transaction, record exactly what the originating device shows (does
  the local row revert or disappear after the next checkpoint? does anything tell the doctor?), confirm that
  `upload_drops` holds the full payload, and verify that later queued writes still upload. Compare with "return 4xx"
  (expected: queue stall). Document the result as input for the production quarantine-and-retry design (section 9).
- 1.10 Idempotency: replay the same transaction (simulate a lost response) with no duplicates; PATCH with a subset of
  columns leaves other columns untouched.

Devices and tokens (Q4, Q7):
- 1.11 Register 3 devices, the 4th gets 409 with the list. Run 10 concurrent registrations for a tenant with 2
  free slots; never more than 3 total, slots unique.
- 1.12 Remove a device; slot is freed; the removed device's next `/sync/token` returns 403 and its `/sync/upload`
  is rejected even with a still-valid JWT. Measure how long its open sync connection keeps receiving new rows after
  removal (expected: until token expiry) and record it against the configured expiry.
- 1.13 Removed-device client flow: the client detects 403, shows the unsynced count (from the upload queue stats),
  then wipes via `disconnectAndClear`; after wipe nothing remains in the DB file.
- 1.14 Token lifecycle: refresh before expiry while online; an expired token while offline does not block local
  reads or writes; on reconnect the client fetches a new token and continues. JWKS key rotation (add a second kid,
  retire the first) does not break connected clients.
- 1.15 Sessions: allowlist enforcement (non-allowlisted email rejected), session expiry returns 401 and the client
  shows "sign in to sync" without wiping.

### Phase 2 - Offline PWA (M/L, the headline; Playwright Chromium)

Use real network removal, not the in-app switch. Options: Playwright `context.setOffline(true)`, blocking routes,
and stopping the `sync`/`api` containers. Use at least two contexts as two devices of the same tenant.

- 2.1 Install flow: sign in, register device, "preparing your offline copy" until first sync; then the service worker
  is active and all app assets (including PowerSync wasm and workers) are precached. Verify no COOP/COEP is needed.
- 2.2 After first sync, go offline, **close and reopen the browser context** (persistent context, same user data
  dir), load the app URL offline: it boots from cache and local DB, shows data, no blocking spinner, no error beyond
  a status banner.
- 2.3 Offline edit session: create, edit, toggle, delete, parent+child saves; unsynced counter rises; restart the
  browser again; counter and data persist.
- 2.4 Reconnect: without any user action the queue uploads, and the second device receives everything.
- 2.5 Expired token/session while offline (Q6): force expiry, keep editing offline, then reconnect with an expired
  session: UI says "sign in to sync", data and queue intact, after sign-in everything uploads.
- 2.6 Quick check, multi-tab: two tabs of one profile; an edit in one appears in the other; closing the first tab
  does not stop uploads.
- 2.7 Update flow: deploy a new build that adds a nullable column (additive). A client on the old cached build while
  offline keeps working; after reconnect it syncs without error and shows the "reload to update" prompt; the new
  build then reads the new column. No auto-reload during an edit.
- 2.8 First-load failure modes: offline before first sync completes (the app must say it needs a connection, not
  crash); interrupted first sync resumes.
- 2.9 Manual checklist (cannot be automated reliably): `storage.persist()` result in real Chrome and Edge, installed
  vs not installed PWA, behaviour after "clear site data" (unsynced count warning), low-disk eviction. Record as
  "to verify on the deployed site".

### Phase 3 - Data lifecycle and operations (M/L)

Run 3.9 (restore drill) and 3.3 (code collisions) first; they are gates.

Codes, orphans, and transactions (Q9, Q10):
- 3.1 Atomic multi-table save: write a todo plus N items in one `writeTransaction` offline; confirm it uploads as one
  request and one Postgres transaction, and that other devices never observe a partial set (poll the second device's
  DB during the sync). Also make one item invalid and confirm the whole save is dropped, not half of it.
- 3.2 Orphans: device A deletes a parent; device B, offline, adds a child to it; after sync check the result in
  Postgres and on both clients. Decide whether the client must tolerate orphans (probably yes, since there are no
  FKs).
- 3.3 Code collisions: two devices of one tenant offline on the same day each create many `todos` with
  `YYMMDD`+slot+counter codes. Then: remove a device, register a new one into the freed slot (counter restarts), and
  create codes on the same day. Record whether duplicates occur, and what the upload path does if a unique
  constraint exists (with whole-transaction drop, a violation drops the save rather than jamming the queue; verify).
  Recommend either deriving the counter from existing data, adding a per-device random suffix, or avoiding a unique
  constraint.
- 3.4 Quick check, same-row edits from two devices: last upload wins (08's accepted rule) and the losing device
  converges without errors. No merge logic to build.

Volume (single tenant, not fleet capacity):
- 3.5 Seed one tenant with the standard dataset (section 4) and measure: first-sync time (cold device),
  time-to-first-usable if priorities are used, local DB size, a prefix query latency, `watch` re-render cost during
  sync. Repeat with the stress dataset and report as an upper bound.
- 3.6 Long offline catch-up: a device offline while the server accumulates changes, and another device offline with
  500 queued rows; both reconnect; verify convergence and time.
- 3.7 Replication slot: stop PowerSync for a long period while writing; record Postgres WAL retention growth and
  recovery (small-VPS disk risk).

Schema and operations (Q11):
- 3.8 Additive migration with live clients: add a nullable column in Postgres, update the sync config/streams, ship
  a new client. Old and new client builds both keep syncing. Record the sync-config deploy procedure, how long
  reprocessing takes with 100 tenants of seeded data, WAL growth during it, and what clients experience.
- 3.9 Restore drill: take a `pg_dump`, make further changes that some clients sync, restore the older dump, and
  observe PowerSync (replication slot state, bucket storage rebuild) and clients (do they re-sync to the restored
  state? what happens to a client's unsynced offline changes and to changes it already had that the restored DB
  lacks?). Write the recovery procedure and its data-loss implications. Confirm bucket storage can be rebuilt from
  Postgres alone.
- 3.10 Wiping bucket storage (drop `powersync_storage`) and rebuilding: confirm clients recover without losing
  local unsynced changes; record rebuild time and WAL growth.

### Phase 4 - Decision document (S)

Produce `POC-RESULTS.md`: a table of tests 0.x-3.x with pass/fail/inconclusive, measured numbers (sync times,
sizes, rebuild times, WAL growth, removed-device exposure window), the SDK and service versions used, every deviation
from 08's assumptions, open risks, and a go/no-go per gate in section 7. Include the reusable artifacts list
(section 10), the production requirements list (section 9) with anything the POC learned about them, and corrections
to 08 where the POC contradicts it.

## 7. Go/no-go gates

| Gate | Pass | Rethink / no-go |
|---|---|---|
| SDK parity (0.2) | The POC runs on the client's exact SDK versions | Cannot run 2.3.1 against a self-hosted service version that works (blocks every other result) |
| Isolation and upload spoofing (1.1-1.8) | Zero leaks; writes only ever land in the caller's tenant | Any cross-tenant read or write |
| Postgres bucket storage (0.3, 3.10) | Stable on one Postgres instance, rebuildable | Unstable or unsupported, which forces Mongo or PowerSync Cloud (changes hosting cost and plan) |
| Offline cold start (0.5, 2.2-2.4) | Boots and works after a browser restart with the network cut, then syncs without user action | Requires a connection to boot or loses data |
| Token/session offline (1.14, 2.5) | No wipe, no block | Any data loss or forced sign-out of local data |
| Bad-write handling (1.8, 1.9, 3.1) | Queue keeps moving; bad transactions are dropped whole and logged with full payload; client-side outcome documented | Queue jams, or partial transactions reach the server |
| Device limit/revoke (1.11-1.13) | Exactly 3, revoke effective, removed device's exposure window bounded by token expiry, unsynced count shown, wipe works | Race lets a 4th device in; revoked device can still write; data keeps flowing after expiry |
| Restore drill (3.9) | A documented recovery that does not silently destroy unsynced client data | No safe procedure |
| Code collisions (3.3) | A recommended scheme with no duplicates and no queue jam | Unavoidable collisions |

Soft reporting defaults (report against them, do not optimise for them; real targets are set for the actual app):
standard-dataset first sync under 60 s on localhost; stress-dataset first sync under 5 minutes; long-offline catch-up
(3.6) under 2 minutes; bucket rebuild for 100 seeded tenants under 10 minutes.

The overall conclusion is "confident to use PowerSync for the offline-first browser client" only if all gates pass
or have a documented, acceptable mitigation.

## 8. Explicitly out of scope

- The real Google OAuth flow, consent screen, and verification: tested at deploy (08 Step 6).
- A real VPS, real domain, TLS certificates, and whether Chrome/Edge actually grants `persist()` on the production
  origin: manual checks on the deployed site (test 2.9).
- Capacity and load (about 300 connections, onboarding burst, reconnect storm), container resource limits, and
  slow-network (throttled) testing.
- Padding the POC to the real app's ~33 streams.
- Same-browser account switching, recovery and retry of rejected writes, and migration of existing local data
  (section 9).
- Safari, iPad, Firefox, mobile browsers, Electron, Capacitor.
- Any Digital RX clinical feature or schema (patients, visits, prescriptions, pads, printing).
- Roles, signing/amending, audit log, telemetry, merge logic, encryption, soft delete, attachments/files.
- Postgres row-level security (optional extra only if time permits).
- Production code quality, migrations tooling (Alembic), packaging.

## 9. Production requirements surfaced by this plan (not built in the POC)

These came out of the assessment and owner decisions. The POC does not build them, but `POC-RESULTS.md` must carry
them forward with anything the POC learned.

1. **Never lose a doctor's write.** A rejected write must not silently disappear. Expected design: the server keeps
   the full payload in a quarantine table and tells the client which writes were rejected and why; the client keeps a
   local-only copy that sync cannot overwrite, shows a count, and can retry (manually or after an update); a
   successful retry clears it; the queue never jams. Test 1.9 provides the baseline behaviour this must fix.
2. **Account switch guard.** Before a different account signs in on a browser that already has an identity, the app
   checks that identity's unsynced changes and asks the user to sync them first, because otherwise they are lost.
3. **Capacity planning** for about 100 doctors x 3 devices, onboarding burst, reconnect storm, slow networks between
   Bangladesh and Singapore, and the real ~33-stream sync config.
4. **Production token lifetime**, chosen from the removed-device exposure window measured in 1.12.
5. **Full upload stamping** of `tenant_id`, `doctor_id`, and `created_by_doctor_id` from the token (08 Step 3.3).
6. **Client conversion** of the real app's 33 `localOnly` tables to synced tables, the per-tenant DB filename, and
   removal of COOP/COEP from `client/vite.config.ts` (08 Steps 4.1 and 4.5).

## 10. Reusable artifacts (meant to be copied into the real implementation)

1. The final sync config (stream YAML) and the finding for the `IS NULL OR` form.
2. The `/sync/upload` pattern: one transaction per request, whitelist, tenant stamping, conflict-safe tenant-scoped
   upsert, whole-transaction drop-and-log policy.
3. The token contract: claims, JWKS setup, expiry, client refresh behaviour, revocation checks, measured exposure
   window.
4. The PowerSync `service.yaml` with Postgres source plus Postgres storage on one server, pinned version, replication
   role/publication SQL, CORS.
5. Client patterns on SDK 2.3.1: identity record, per-tenant DB filename, boot order, offline-safe
   `fetchCredentials`, transaction-based `uploadData`, unsynced indicator, wipe flow, PWA/service-worker precache list
   and update prompt.
6. The restore and migration runbooks from tests 3.8-3.10.
7. The test harness (headless multi-device) as a basis for the real project's CI isolation tests.

## 11. Prerequisites and conventions

- Docker Desktop running (it was not running on this machine earlier). Node 20+, Python 3.11+.
- Playwright Chromium for browser tests; one manual pass in real Edge at the end.
- Open the app at `http://app.localhost` (Caddy) or `http://localhost:5173` for dev, and keep the JWT `aud` consistent
  with the sync URL actually used.
- Keep secrets (JWKS private key, session secret) in env files that are gitignored; the current repo hardcodes a dev
  secret, which is acceptable only until test 0.7 and must not remain after it.
- Record all results in `POC-RESULTS.md` with test IDs from section 6.

## 12. Known unknowns to resolve early (cheap to check first)

1. Does SDK 2.3.1 work against a pinned self-hosted service version, and what changed from 1.x? (Test 0.2.)
2. Does PowerSync with Postgres storage on the same server work, and what settings does it need (replication role
   privileges, `max_wal_senders`, `max_replication_slots`)? (Tests 0.3, 3.7, 3.10.)
3. Is `tenant_id IS NULL OR tenant_id = auth.user_id()` accepted in a sync stream, and how is the shared data stored?
   (Test 0.4.)
4. Does the SDK 2.3.1 default IndexedDB storage work without COOP/COEP in Chromium and Edge, and what does the service
   worker need to precache (wasm, shared worker script, sync worker)? (Tests 0.5, 2.1.)
5. Exactly what the client does to local state after an upload transaction is completed but the server dropped it.
   (Test 1.9.)

## 13. Execution order (risk-first)

1. Phase 0 baseline and SDK alignment (0.1, 0.2).
2. Design spikes (0.3 Postgres storage, 0.4 stream forms, 0.5 offline cold start). A failure here changes the design
   or the hosting plan, so stop and report before continuing.
3. Build-out (0.6-0.8), then the security gates (Phase 1).
4. Offline PWA (Phase 2), then the restore drill (3.9) and code collisions (3.3).
5. The rest of Phase 3, CI automation (0.9), then the decision document (Phase 4).
