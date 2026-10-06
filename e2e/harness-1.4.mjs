import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowEmail,
  assertServerOnlyAbsentFromClient,
  clearServerOnlyLeakMarkers,
  clearSyncedTables,
  createIdentity,
  ensureFreeSlots,
  expectedServerRows,
  H14_LEAK_DEVICE,
  H14_LEAK_EMAIL,
  H14_LEAK_RT,
  H14_LEAK_TENANT,
  openDevice,
  seedIsolationFixtures,
  seedServerOnlyLeakMarkers,
  signIn,
  verifyServerOnlyLeakMarkersOnServer,
  waitForLocalRows,
} from './harness/index.mjs';

const EMAIL_A = 'doctor-a@example.com';
const EMAIL_B = 'doctor-b@example.com';
const SYNC_WAIT_MS = 8000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const leakMarkers = {
  email: H14_LEAK_EMAIL,
  tenantId: H14_LEAK_TENANT,
  deviceId: H14_LEAK_DEVICE,
  refreshTokenId: H14_LEAK_RT,
  googleSub: 'h14-google-sub',
  tokenHash: 'h14-fake-hash',
};

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powersync-harness-1.4-'));

try {
  allowEmail(EMAIL_A);
  allowEmail(EMAIL_B);
  clearSyncedTables();
  clearServerOnlyLeakMarkers();

  seedServerOnlyLeakMarkers();
  verifyServerOnlyLeakMarkersOnServer();
  pass('server-only marker rows present on Postgres (users, allowed_emails, devices, refresh_tokens)');

  const sessionA = await signIn(EMAIL_A);
  const sessionB = await signIn(EMAIL_B);
  await ensureFreeSlots(sessionA, 1);
  await ensureFreeSlots(sessionB, 1);

  const identityA = await createIdentity({
    email: EMAIL_A,
    sessionCookie: sessionA,
    deviceId: `harness-1.4-a-${Date.now()}`,
    name: 'harness-1.4-a',
  });
  const identityB = await createIdentity({
    email: EMAIL_B,
    sessionCookie: sessionB,
    deviceId: `harness-1.4-b-${Date.now()}`,
    name: 'harness-1.4-b',
  });

  seedIsolationFixtures(identityA.tenantId, identityB.tenantId);
  const expectedA = expectedServerRows(identityA.tenantId);
  const expectedB = expectedServerRows(identityB.tenantId);

  const deviceA = await openDevice({ identity: identityA, dbDir });
  const deviceB = await openDevice({ identity: identityB, dbDir });
  await deviceA.connect();
  await deviceB.connect();

  await waitForLocalRows(deviceA, expectedA);
  await waitForLocalRows(deviceB, expectedB);
  pass('both clients synced published tables (todos, todo_items, catalog)');

  await sleep(SYNC_WAIT_MS);

  await assertServerOnlyAbsentFromClient(deviceA.db, leakMarkers);
  pass('tenant A local DB: no server-only tables or marker values');
  await assertServerOnlyAbsentFromClient(deviceB.db, leakMarkers);
  pass('tenant B local DB: no server-only tables or marker values');

  await deviceA.disconnect();
  await deviceB.disconnect();
  await deviceA.close();
  await deviceB.close();

  clearServerOnlyLeakMarkers();
  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('harness-1.4: all checks passed');
  process.exit(0);
} catch (err) {
  try {
    clearServerOnlyLeakMarkers();
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors on failure path
  }
  fail(err instanceof Error ? err.message : String(err));
}
