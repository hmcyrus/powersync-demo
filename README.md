# PowerSync Todos POC — Slice 1 & 2

Slice 1: server-to-device sync. Slice 2: device-to-server upload queue via FastAPI.

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
6. A todo added in the UI stays visible locally. It may be absent from Postgres until a later slice adds the upload API.

## Pass checks (Slice 2)

1. Online. Add a todo. It is in the UI and GET http://localhost:8000/todos shows the same id.
2. Toggle Offline. Toggle and delete. The UI updates. GET /todos does not change. `#status` shows an upload error. `connected` stays true.
3. Toggle Online. Within about 2 seconds, GET /todos matches the UI.
4. Private window (second client), online: a todo added there appears in the first window through watch, with no reload and no GET polling in the UI.
5. Reload does not duplicate rows.

Use a private window or another browser for a second client — not a second tab in the same browser profile.
