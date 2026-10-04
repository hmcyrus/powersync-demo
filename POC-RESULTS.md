# POC results

Living log of [POC-PLAN.md](POC-PLAN.md) section 6. One row per test. Phase 4 fills the go/no-go table from these rows.

Versions below are what actually ran.

| Test | Result | Evidence |
|---|---|---|
| 0.1 | Pass locally. CI not re-run. | 2026-10-04, Windows, `cd e2e; npm test`: 14 passed, 0 failed. Slice 1.1 included, so `checkPowerSyncLogs()` with `cwd: ROOT` works. PowerSync Open Edition **v1.26.1** (`journeyapps/powersync-service:latest` at pull time). Frontend `@powersync/web` **1.39.1** (lockfile range `^1.24.0`). `ci-debug/` is gitignored. |
| 0.2 | Pass locally. | Same 14 checks, 14 passed, after pinning `@powersync/web` **2.3.1**, `@journeyapps/wa-sqlite` **2.0.4** (no ranges), and `journeyapps/powersync-service:1.26.1`. Service log: `Booting PowerSync Service v1.26.1`. Client user agent: `powersync-js/1.2.0 powersync-web`. Sync requests use HTTP (`rid` prefix `h/`, `route: /sync/stream`, `bson: true`). SDK 2.3.1 did not require a newer service. |
| 0.3 | Pass locally. | 2026-10-04, Windows, `cd e2e; npm test`: 14 passed, 0 failed. Mongo and `mongo-rs-init` removed. `storage.type: postgresql` → `powersync_storage` DB on same Postgres 16 instance. See 0.3 notes for startup/WAL evidence. |
| 0.4 | Pass locally. | 2026-10-04, Windows, `cd e2e; npm test`: **18 passed**, 0 failed (14 baseline + 4 stream-form checks). Two tenants via `?tenant=tenant-a|tenant-b` and hand-minted HS256 dev tokens (`sub` = tenant). **Active config: two-stream** (`catalog_shared` + `catalog_own` per POC-PLAN 5.3). Single-stream (`IS NULL OR auth.user_id()`) also accepted by v1.26.1. Shared catalog row: **1 bucket** at 1/50/100 tenants (both forms; `sharedRowCopies=1`, `sharedBuckets=1`). Tenant isolation: each client sees shared + own catalog only. Buckets per client (two-stream): 4 (shared catalog, own catalog, todos, todo_items). See 0.4 notes. |

## 0.1 notes

- Stack: `docker compose up -d`, Postgres seed of the `synced from postgres` row, FastAPI on `127.0.0.1:8000`, Vite on `127.0.0.1:5173`, checks opened `http://localhost:5173`.
- CI: the wait-on GET fix is already on `main` (PR #4, `7e8b965`). The only recorded Actions run is still the failed one (ID 36235697185). This session could not dispatch a new run: `gh` returned HTTP 401. A green CI run is still unconfirmed. The Windows `cwd` fix is local-only and does not affect the Ubuntu workflow.

## 0.2 notes (API changes that affect section 10)

These are the v2 differences the existing to-do client actually hit. Later chunks should follow them.

- `SyncStatus.uploadError` (also `uploading`, `downloading`, `downloadError`) is on the status object. `dataFlowStatus.*` still works and is deprecated. The status line now reads `status.uploadError`. Slice 2.2 still shows `upload: offline`, so the error is still an object with `message`.
- Database open and connect already matched v2: `new PowerSyncDatabase({ schema, database: { dbFilename } })`, sync options only on `connect()`. `getNextCrudTransaction()` and `transaction.complete()` are unchanged. Schema object syntax (`column.text`) is unchanged; the v1 `new Column(...)` form is gone.
- Default sync transport is HTTP to `/sync/stream`, not a WebSocket. Caddy (test 0.7) must proxy that HTTP stream. Vite's default worker needed no path change. If a later chunk copies workers for the PWA, the file is `/@powersync/worker.js` (the two old UMD workers are gone).
- `@powersync/web@2.3.1` already depends on `@journeyapps/wa-sqlite@2.0.4`. It is also a direct exact pin. Vite `optimizeDeps.exclude` lists both packages. No COOP/COEP headers were added. Reload persistence in these checks is the same browser context, not the offline cold start in test 0.5.

## 0.3 notes (Postgres bucket storage spike)

- **Startup:** PowerSync v1.26.1 started cleanly with `Successfully activated storage: postgresql`, storage migrations ran (8 migrations), `Successfully started Storage Engine`, `Successfully started Replication Engine`, `Service started`. No permission or replication-role errors.
- **Permissions:** Source and storage both use the existing `postgres` superuser (no dedicated replication role yet). PowerSync auto-created `powersync` schema in `powersync_storage` (11 tables). No grant failures.
- **Replication role:** Not introduced in this spike; superuser `postgres` used for both `replication.connections` (database `postgres`) and `storage` (database `powersync_storage`). Same-server source + storage accepted on Postgres 16 without blocking.
- **Replication slot:** Active logical slot `powersync_1_c1b2` (`pgoutput`, active). One stale inactive slot `powersync_1_9dc3` left from prior Mongo-era run (harmless).
- **Postgres settings:** `wal_level=logical`, `max_wal_senders=10`, `max_replication_slots=10` (set explicitly in compose command).
- **Baseline WAL:** `pg_wal` directory **16 MB**; total WAL generated since cluster init **26 MB** (`pg_wal_lsn_diff` vs `0/0`). Slot `confirmed_flush_lsn` at `0/19E36C0`.

## 0.4 notes (stream forms spike, Q2)

- **Forms tested:** (a) single-stream `catalog` with `tenant_id IS NULL OR tenant_id = auth.user_id()`; (b) two-stream `catalog_shared` + `catalog_own` (POC-PLAN 5.3).
- **Acceptance:** Both accepted; PowerSync v1.26.1 started cleanly with each config.
- **Correctness:** E2e with two-stream config — both tenants receive null-tenant shared row; tenant-a/b each see only their private catalog rows.
- **Shared-bucket dedup:** `powersync.bucket_data` for shared row `catalog-shared-0` (spike) / `e2e-shared` (e2e): `sharedBuckets=1`, `sharedRowCopies=1` at 1, 50, and 100 seeded tenants (single- and two-stream).
- **Storage size (`powersync_storage`):** single-stream 8799 kB / 8951 kB / 9095 kB; two-stream 8799 kB / 8967 kB / 9135 kB (1 / 50 / 100 tenants). No per-tenant duplication of shared rows in either form.
- **Chosen form:** **two-stream** kept as active `sync-config.yaml` (explicit shared vs own bucket boundary per POC-PLAN 5.3). Single-stream experiment lives in `sync-config-single-stream.yaml` only. Single-stream is viable (same dedup) but not selected as canonical. `sync-config-single-stream.yaml` is retained as a historical artifact and must not be activated or copied over the active config. `scripts/stream-form-spike.mjs` is retained as a historical artifact and must not be run as setup or as the way to choose the sync config.
- **2026-10-04 config drift fix:** On-disk YAML had drifted to single-stream in both files; restored active two-stream form and moved single-stream to the experiment file only.
- Local tag `latest` is the same image id as `1.26.1` (`sha256:413a0c813e96…`), so the existing pin `journeyapps/powersync-service:1.26.1` already is the pulled image.
