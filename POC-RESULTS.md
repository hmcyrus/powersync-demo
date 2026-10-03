# POC results

Living log of [POC-PLAN.md](POC-PLAN.md) section 6. One row per test. Phase 4 fills the go/no-go table from these rows.

Versions below are what actually ran.

| Test | Result | Evidence |
|---|---|---|
| 0.1 | Pass locally. CI not re-run. | 2026-10-04, Windows, `cd e2e; npm test`: 14 passed, 0 failed. Slice 1.1 included, so `checkPowerSyncLogs()` with `cwd: ROOT` works. PowerSync Open Edition **v1.26.1** (`journeyapps/powersync-service:latest` at pull time). Frontend `@powersync/web` **1.39.1** (lockfile range `^1.24.0`). `ci-debug/` is gitignored. |
| 0.2 | Pass locally. | Same 14 checks, 14 passed, after pinning `@powersync/web` **2.3.1**, `@journeyapps/wa-sqlite` **2.0.4** (no ranges), and `journeyapps/powersync-service:1.26.1`. Service log: `Booting PowerSync Service v1.26.1`. Client user agent: `powersync-js/1.2.0 powersync-web`. Sync requests use HTTP (`rid` prefix `h/`, `route: /sync/stream`, `bson: true`). SDK 2.3.1 did not require a newer service. |

## 0.1 notes

- Stack: `docker compose up -d`, Postgres seed of the `synced from postgres` row, FastAPI on `127.0.0.1:8000`, Vite on `127.0.0.1:5173`, checks opened `http://localhost:5173`.
- CI: the wait-on GET fix is already on `main` (PR #4, `7e8b965`). The only recorded Actions run is still the failed one (ID 36235697185). This session could not dispatch a new run: `gh` returned HTTP 401. A green CI run is still unconfirmed. The Windows `cwd` fix is local-only and does not affect the Ubuntu workflow.

## 0.2 notes (API changes that affect section 10)

These are the v2 differences the existing to-do client actually hit. Later chunks should follow them.

- `SyncStatus.uploadError` (also `uploading`, `downloading`, `downloadError`) is on the status object. `dataFlowStatus.*` still works and is deprecated. The status line now reads `status.uploadError`. Slice 2.2 still shows `upload: offline`, so the error is still an object with `message`.
- Database open and connect already matched v2: `new PowerSyncDatabase({ schema, database: { dbFilename } })`, sync options only on `connect()`. `getNextCrudTransaction()` and `transaction.complete()` are unchanged. Schema object syntax (`column.text`) is unchanged; the v1 `new Column(...)` form is gone.
- Default sync transport is HTTP to `/sync/stream`, not a WebSocket. Caddy (test 0.7) must proxy that HTTP stream. Vite's default worker needed no path change. If a later chunk copies workers for the PWA, the file is `/@powersync/worker.js` (the two old UMD workers are gone).
- `@powersync/web@2.3.1` already depends on `@journeyapps/wa-sqlite@2.0.4`. It is also a direct exact pin. Vite `optimizeDeps.exclude` lists both packages. No COOP/COEP headers were added. Reload persistence in these checks is the same browser context, not the offline cold start in test 0.5.
