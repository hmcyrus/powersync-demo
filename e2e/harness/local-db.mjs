const SYNC_TABLES = ['catalog', 'todos', 'todo_items'];

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
