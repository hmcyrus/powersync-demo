# PowerSync Todos POC — Slice 1

Server-to-device sync only. Upload to FastAPI is **not** in this slice.

## Run (PowerShell)

```powershell
docker compose up -d
docker compose logs -f powersync
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** (not 127.0.0.1).

## Seed Postgres

```powershell
docker compose exec postgres psql -U postgres -d postgres -c "INSERT INTO todos (id, title, is_completed, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 'synced from postgres', 0, now());"
```

## Pass checks

1. PowerSync logs show the service up and replication running (no repeating auth or publication fatal error).
2. Add, toggle, and delete update the list immediately. Reload the page. Those local rows are still there.
3. `#status` becomes `connected: true`.
4. The seeded row appears in the UI without reload.
5. The same seeded row appears in a private window or a second browser. Two tabs of one profile share one client (SharedWorker); use a private window or a different browser for a second client.
6. A todo added in the UI stays visible locally. It may be absent from Postgres until a later slice adds the upload API.
