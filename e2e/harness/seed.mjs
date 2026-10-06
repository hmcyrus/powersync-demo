import { runPsql, psqlQuery } from './api-client.mjs';

const SYNC_TABLES = ['todos', 'todo_items', 'catalog'];

export const SERVER_ONLY_TABLES = ['users', 'allowed_emails', 'devices', 'refresh_tokens'];

export const H14_LEAK_EMAIL = 'h14-leak-test@example.com';
export const H14_LEAK_TENANT = 'h14-leak-tenant';
export const H14_LEAK_DEVICE = 'h14-leak-device';
export const H14_LEAK_RT = 'h14-leak-rt';

export function clearSyncedTables() {
  for (const table of SYNC_TABLES) {
    runPsql(`DELETE FROM ${table}`);
  }
}

export function allowEmail(email) {
  runPsql(
    `INSERT INTO allowed_emails (email) VALUES ('${email.replace(/'/g, "''")}') ON CONFLICT (email) DO NOTHING`,
  );
}

export const TODO_A_ID = 'aaaaaaaa-1111-4111-8111-000000000001';
export const TODO_B_ID = 'bbbbbbbb-1111-4111-8111-000000000002';

export function seedIsolationFixtures(tenantA, tenantB) {
  runPsql(
    `INSERT INTO catalog (id, tenant_id, name, kind) VALUES ` +
      `('h11-shared', NULL, 'Shared catalog row', 'drug'), ` +
      `('h11-catalog-a', '${tenantA}', 'Private tenant-a', 'custom'), ` +
      `('h11-catalog-b', '${tenantB}', 'Private tenant-b', 'custom') ` +
      `ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, kind = EXCLUDED.kind`,
  );
  runPsql(
    `INSERT INTO todos (id, tenant_id, title, is_completed, created_at, code) VALUES ` +
      `('${TODO_A_ID}', '${tenantA}', 'Todo tenant A', 0, '2026-01-01T00:00:00Z', '26010111'), ` +
      `('${TODO_B_ID}', '${tenantB}', 'Todo tenant B', 1, '2026-01-02T00:00:00Z', '26010221') ` +
      `ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, title = EXCLUDED.title, is_completed = EXCLUDED.is_completed, created_at = EXCLUDED.created_at, code = EXCLUDED.code`,
  );
  runPsql(
    `INSERT INTO todo_items (id, tenant_id, todo_id, text, done, seq) VALUES ` +
      `('h11-item-a1', '${tenantA}', '${TODO_A_ID}', 'Item A1', 0, 1), ` +
      `('h11-item-a2', '${tenantA}', '${TODO_A_ID}', 'Item A2', 1, 2), ` +
      `('h11-item-b1', '${tenantB}', '${TODO_B_ID}', 'Item B1', 0, 1) ` +
      `ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, todo_id = EXCLUDED.todo_id, text = EXCLUDED.text, done = EXCLUDED.done, seq = EXCLUDED.seq`,
  );
}

export function expectedServerRows(tenantId) {
  const catalog = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json) FROM (` +
      `SELECT id, tenant_id, name, kind FROM catalog ` +
      `WHERE tenant_id IS NULL OR tenant_id = '${tenantId}' ORDER BY id` +
      `) t`,
  );
  const todos = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json) FROM (` +
      `SELECT id, tenant_id, title, is_completed, created_at, code FROM todos ` +
      `WHERE tenant_id = '${tenantId}' ORDER BY id` +
      `) t`,
  );
  const todoItems = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json) FROM (` +
      `SELECT id, tenant_id, todo_id, text, done, seq FROM todo_items ` +
      `WHERE tenant_id = '${tenantId}' ORDER BY id` +
      `) t`,
  );
  return { catalog, todos, todo_items: todoItems };
}

export function clearServerOnlyLeakMarkers() {
  runPsql(`DELETE FROM refresh_tokens WHERE id = '${H14_LEAK_RT}'`);
  runPsql(`DELETE FROM devices WHERE id = '${H14_LEAK_DEVICE}'`);
  runPsql(`DELETE FROM users WHERE tenant_id = '${H14_LEAK_TENANT}'`);
  runPsql(`DELETE FROM allowed_emails WHERE email = '${H14_LEAK_EMAIL}'`);
}

/** Distinctive rows in all four server-only tables (test 1.4). */
export function seedServerOnlyLeakMarkers() {
  clearServerOnlyLeakMarkers();
  runPsql(
    `INSERT INTO allowed_emails (email) VALUES ('${H14_LEAK_EMAIL}')`,
  );
  runPsql(
    `INSERT INTO users (tenant_id, google_sub, email) VALUES ` +
      `('${H14_LEAK_TENANT}', 'h14-google-sub', '${H14_LEAK_EMAIL}')`,
  );
  runPsql(
    `INSERT INTO devices (id, tenant_id, slot, name) VALUES ` +
      `('${H14_LEAK_DEVICE}', '${H14_LEAK_TENANT}', 1, 'h14-leak-device')`,
  );
  runPsql(
    `INSERT INTO refresh_tokens (id, tenant_id, token_hash, expires_at) VALUES ` +
      `('${H14_LEAK_RT}', '${H14_LEAK_TENANT}', 'h14-fake-hash', now() + interval '1 year')`,
  );
}

export function verifyServerOnlyLeakMarkersOnServer() {
  const allowed = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
      `SELECT email FROM allowed_emails WHERE email = '${H14_LEAK_EMAIL}'` +
      `) t`,
  );
  const users = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
      `SELECT tenant_id, google_sub, email FROM users WHERE tenant_id = '${H14_LEAK_TENANT}'` +
      `) t`,
  );
  const devices = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
      `SELECT id, tenant_id, slot, name FROM devices WHERE id = '${H14_LEAK_DEVICE}'` +
      `) t`,
  );
  const refreshTokens = psqlQuery(
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
      `SELECT id, tenant_id, token_hash FROM refresh_tokens WHERE id = '${H14_LEAK_RT}'` +
      `) t`,
  );
  if (allowed.length !== 1 || users.length !== 1 || devices.length !== 1 || refreshTokens.length !== 1) {
    throw new Error(
      `server-only marker rows missing on Postgres: ` +
        `allowed=${allowed.length} users=${users.length} devices=${devices.length} refresh_tokens=${refreshTokens.length}`,
    );
  }
  return { allowed, users, devices, refresh_tokens: refreshTokens };
}
