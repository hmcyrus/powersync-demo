## Check [Executive Summary](EXECUTIVE-SUMMARY.md) to get a clear mental model of what this demo is trying to achieve, and [POC Plan](POC-PLAN.md) for where it goes next

# PowerSync Todos POC — Slice 1 & 2

Slice 1: server-to-device sync. Slice 2: device-to-server upload queue via FastAPI.

This is the starting point (Phase 0 baseline) of [POC-PLAN.md](POC-PLAN.md), which extends it to validate the Digital RX deployment: tenant isolation, real auth, offline PWA, Postgres bucket storage, and SDK 2.3.1. The run steps below describe the current stack (Mongo bucket store, `@powersync/web` 1.x, dev token minted in the browser) and will change as Phase 0 lands.

## Run (PowerShell)

```powershell
docker compose up -d
docker compose logs -f powersync
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (not 127.0.0.1).

Second terminal, PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --port 8000
```

Postgres and PowerSync from slice 1 stay up.

## Seed Postgres

```powershell
docker compose exec postgres psql -U postgres -d postgres -c "INSERT INTO todos (id, title, is_completed, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 'synced from postgres', 0, now());"
```

## Pass checks (Slice 1)

1. PowerSync logs show the service up and replication running (no repeating auth or publication fatal error).
2. Add, toggle, and delete update the list immediately. Reload the page. Those local rows are still there.
3. `#status` becomes `connected: true`.
4. The seeded row appears in the UI without reload.
5. The same seeded row appears in a private window or a second browser. Two tabs of one profile share one client (SharedWorker); use a private window or a different browser for a second client.
6. A todo added in the UI stays visible locally. Without the backend running it is absent from Postgres; Slice 2 uploads it.

## Pass checks (Slice 2)

1. Online. Add a todo. It is in the UI and GET http://localhost:8000/todos shows the same id.
2. Toggle Offline. Toggle and delete. The UI updates. GET /todos does not change. `#status` shows an upload error. `connected` stays true.
3. Toggle Online. Within about 2 seconds, GET /todos matches the UI.
4. Private window (second client), online: a todo added there appears in the first window through watch, with no reload and no GET polling in the UI.
5. Reload does not duplicate rows.

Use a private window or another browser for a second client — not a second tab in the same browser profile.

## Automated checks

`e2e/pass-checks.mjs` runs the checks above as 14 Playwright checks against the running stack (`cd e2e; npm ci; npx playwright install chromium; npm test`). The GitHub workflow `.github/workflows/pass-checks.yml` runs them on manual dispatch only. A green run is not yet confirmed (POC-PLAN test 0.1).
