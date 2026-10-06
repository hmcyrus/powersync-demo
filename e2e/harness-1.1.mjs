import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowEmail,
  assertNoForeignTenantRows,
  clearSyncedTables,
  createIdentity,
  ensureFreeSlots,
  expectedServerRows,
  openDevice,
  readAllLocalRows,
  rowsEqual,
  seedIsolationFixtures,
  signIn,
  TODO_A_ID,
  TODO_B_ID,
  waitForLocalRows,
} from './harness/index.mjs';

const EMAIL_A = 'doctor-a@example.com';
const EMAIL_B = 'doctor-b@example.com';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powersync-harness-1.1-'));

try {
  allowEmail(EMAIL_A);
  allowEmail(EMAIL_B);
  clearSyncedTables();

  const sessionA = await signIn(EMAIL_A);
  const sessionB = await signIn(EMAIL_B);
  await ensureFreeSlots(sessionA, 1);
  await ensureFreeSlots(sessionB, 1);

  const identityA = await createIdentity({
    email: EMAIL_A,
    sessionCookie: sessionA,
    deviceId: `harness-1.1-a-${Date.now()}`,
    name: 'harness-1.1-a',
  });
  const identityB = await createIdentity({
    email: EMAIL_B,
    sessionCookie: sessionB,
    deviceId: `harness-1.1-b-${Date.now()}`,
    name: 'harness-1.1-b',
  });

  if (identityA.tenantId === identityB.tenantId) {
    fail('tenants must be distinct');
  }
  pass(`two tenants provisioned (${identityA.tenantId}, ${identityB.tenantId})`);

  seedIsolationFixtures(identityA.tenantId, identityB.tenantId);
  const expectedA = expectedServerRows(identityA.tenantId);
  const expectedB = expectedServerRows(identityB.tenantId);

  if (expectedA.todos.length === 0 || expectedB.todos.length === 0) {
    fail('seed data missing todos for one or both tenants');
  }
  if (expectedA.todo_items.length < 2 || expectedB.todo_items.length < 1) {
    fail('seed data missing todo_items for one or both tenants');
  }
  pass('server seeded with todos, todo_items, and catalog rows for both tenants');

  const deviceA = await openDevice({ identity: identityA, dbDir });
  const deviceB = await openDevice({ identity: identityB, dbDir });
  await deviceA.connect();
  await deviceB.connect();

  const localA = await waitForLocalRows(deviceA, expectedA);
  const localB = await waitForLocalRows(deviceB, expectedB);
  pass('both devices synced full expected row sets');

  for (const table of ['catalog', 'todos', 'todo_items']) {
    if (!rowsEqual(expectedA[table], localA[table])) {
      fail(`tenant A ${table}: local rows do not match expected set`);
    }
    if (!rowsEqual(expectedB[table], localB[table])) {
      fail(`tenant B ${table}: local rows do not match expected set`);
    }
  }
  pass('full local table contents match expected sets (catalog, todos, todo_items)');

  assertNoForeignTenantRows(localA, identityA.tenantId, identityB.tenantId);
  assertNoForeignTenantRows(localB, identityB.tenantId, identityA.tenantId);
  pass('no cross-tenant rows in either local DB');

  const fullA = await readAllLocalRows(deviceA.db);
  const fullB = await readAllLocalRows(deviceB.db);
  const foreignInA = fullA.todos.some((r) => r.id === TODO_B_ID) ||
    fullA.todo_items.some((r) => r.id === 'h11-item-b1') ||
    fullA.catalog.some((r) => r.id === 'h11-catalog-b');
  const foreignInB = fullB.todos.some((r) => r.id === TODO_A_ID) ||
    fullB.todo_items.some((r) => r.id?.startsWith('h11-item-a')) ||
    fullB.catalog.some((r) => r.id === 'h11-catalog-a');
  if (foreignInA || foreignInB) {
    fail('other tenant fixture ids present in local DB');
  }
  pass('tenant B data absent from tenant A device and vice versa');

  await deviceA.disconnect();
  await deviceB.disconnect();
  await deviceA.close();
  await deviceB.close();

  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('harness-1.1: all checks passed');
  process.exit(0);
} catch (err) {
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors on failure path
  }
  fail(err instanceof Error ? err.message : String(err));
}
