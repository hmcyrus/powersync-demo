const SYNC_TABLES = ['catalog', 'todos', 'todo_items'];

export const SERVER_ONLY_TABLES = ['users', 'allowed_emails', 'devices', 'refresh_tokens'];

function normalizeValue(key, value) {
  if (value == null) return null;
  if (key === 'created_at') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return String(value);
}

export function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row).sort()) {
    out[key] = normalizeValue(key, row[key]);
  }
  return out;
}

export function canonicalRows(rows) {
  return rows.map(normalizeRow).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function rowsEqual(expected, actual) {
  const a = canonicalRows(expected);
  const b = canonicalRows(actual);
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function readLocalTable(db, table) {
  return db.getAll(`SELECT * FROM ${table} ORDER BY id`);
}

export async function readAllLocalRows(db) {
  const out = {};
  for (const table of SYNC_TABLES) {
    out[table] = await readLocalTable(db, table);
  }
  return out;
}

export async function waitForLocalRows(device, expectedByTable, { timeoutMs = 90000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const local = await readAllLocalRows(device.db);
    const allMatch = SYNC_TABLES.every((table) =>
      rowsEqual(expectedByTable[table], local[table]),
    );
    if (allMatch) return local;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const local = await readAllLocalRows(device.db);
  const mismatches = SYNC_TABLES.filter((table) => !rowsEqual(expectedByTable[table], local[table]));
  throw new Error(
    `sync timeout: tables still mismatched: ${mismatches.join(', ')}`,
  );
}

export async function listLocalTableNames(db) {
  const rows = await db.getAll(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

/** Server-only tables must not exist locally, and marker values must not appear anywhere. */
export async function assertServerOnlyAbsentFromClient(db, markers = {}) {
  const present = await db.getAll(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${SERVER_ONLY_TABLES.map((t) => `'${t}'`).join(', ')})`,
  );
  if (present.length > 0) {
    throw new Error(`server-only tables present in local DB: ${present.map((r) => r.name).join(', ')}`);
  }

  const needleValues = [
    markers.email,
    markers.tenantId,
    markers.deviceId,
    markers.refreshTokenId,
    markers.googleSub,
    markers.tokenHash,
  ].filter(Boolean);

  if (needleValues.length === 0) {
    return;
  }

  const tables = await listLocalTableNames(db);
  for (const table of tables) {
    const rows = await db.getAll(`SELECT * FROM ${table}`);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value == null) continue;
        const text = String(value);
        for (const needle of needleValues) {
          if (text.includes(needle)) {
            throw new Error(
              `server-only marker "${needle}" leaked into local ${table}: ${JSON.stringify(row)}`,
            );
          }
        }
      }
    }
  }
}

export function assertNoForeignTenantRows(localRows, ownTenantId, otherTenantId) {
  for (const table of ['todos', 'todo_items', 'catalog']) {
    for (const row of localRows[table]) {
      const tid = row.tenant_id;
      if (tid != null && tid !== ownTenantId && tid === otherTenantId) {
        throw new Error(`${table} leaked row for other tenant: ${JSON.stringify(row)}`);
      }
    }
  }
}
