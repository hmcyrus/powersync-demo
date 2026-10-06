import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowEmail,
  assertNoForeignTenantRows,
  AttackConnector,
  clearSyncedTables,
  createIdentity,
  ensureFreeSlots,
  expectedServerRows,
  expiredToken,
  forgedClaimsToken,
  legitimateTokenForIdentity,
  openDevice,
  readAllLocalRows,
  seedIsolationFixtures,
  signIn,
  TODO_B_ID,
  waitForLocalRows,
  wrongKeyOtherTenantToken,
} from './harness/index.mjs';

const EMAIL_A = 'doctor-a@example.com';
const EMAIL_B = 'doctor-b@example.com';
const ATTACK_WAIT_MS = 8000;

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

function assertNoOtherTenantFixtureRows(localRows, ownTenantId, otherTenantId) {
  assertNoForeignTenantRows(localRows, ownTenantId, otherTenantId);
  const leaked =
    localRows.todos.some((r) => r.id === TODO_B_ID) ||
    localRows.todo_items.some((r) => r.id === 'h11-item-b1') ||
    localRows.catalog.some((r) => r.id === 'h11-catalog-b');
  if (leaked) {
    fail('other tenant fixture rows appeared in local DB after widen-scope attempt');
  }
}

async function assertAttackYieldsNoExtraData(device, ownTenantId, otherTenantId, label) {
  await sleep(ATTACK_WAIT_MS);
  const local = await readAllLocalRows(device.db);
  assertNoOtherTenantFixtureRows(local, ownTenantId, otherTenantId);
  pass(`${label}: no extra tenant data synced`);
}

async function runTokenAttack({ identity, otherTenantId, token, label, dbRoot }) {
  const attackDir = fs.mkdtempSync(path.join(dbRoot, 'attack-'));
  const device = await openDevice({
    identity,
    dbDir: attackDir,
    connector: new AttackConnector(token),
  });

  try {
    try {
      await device.connect();
    } catch {
      // rejected connect is acceptable
    }
    await assertAttackYieldsNoExtraData(device, identity.tenantId, otherTenantId, label);
  } finally {
    try {
      await device.disconnect();
      await device.close();
    } catch {
      // ignore cleanup errors
    }
    fs.rmSync(attackDir, { recursive: true, force: true });
  }
}

const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'powersync-harness-1.2-'));

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
    deviceId: `harness-1.2-a-${Date.now()}`,
    name: 'harness-1.2-a',
  });
  const identityB = await createIdentity({
    email: EMAIL_B,
    sessionCookie: sessionB,
    deviceId: `harness-1.2-b-${Date.now()}`,
    name: 'harness-1.2-b',
  });

  if (identityA.tenantId === identityB.tenantId) {
    fail('tenants must be distinct');
  }
  pass(`two tenants provisioned (${identityA.tenantId}, ${identityB.tenantId})`);

  seedIsolationFixtures(identityA.tenantId, identityB.tenantId);

  const expectedA = expectedServerRows(identityA.tenantId);
  const baselineDir = fs.mkdtempSync(path.join(dbRoot, 'baseline-'));
  const baselineDevice = await openDevice({ identity: identityA, dbDir: baselineDir });
  await baselineDevice.connect();
  await waitForLocalRows(baselineDevice, expectedA);
  await baselineDevice.disconnect();
  await baselineDevice.close();
  fs.rmSync(baselineDir, { recursive: true, force: true });
  pass('baseline legitimate sync path works for tenant A');

  const legitToken = await legitimateTokenForIdentity(identityA);
  const forgedToken = forgedClaimsToken(legitToken, { sub: identityB.tenantId });
  await runTokenAttack({
    identity: identityA,
    otherTenantId: identityB.tenantId,
    token: forgedToken,
    label: 'forged claims (tampered sub)',
    dbRoot,
  });

  const wrongKeyToken = wrongKeyOtherTenantToken(identityB.tenantId, identityA.deviceId);
  await runTokenAttack({
    identity: identityA,
    otherTenantId: identityB.tenantId,
    token: wrongKeyToken,
    label: 'wrong-key token for other tenant',
    dbRoot,
  });

  const expired = expiredToken(identityA.tenantId, identityA.deviceId);
  await runTokenAttack({
    identity: identityA,
    otherTenantId: identityB.tenantId,
    token: expired,
    label: 'expired token',
    dbRoot,
  });

  const paramsDir = fs.mkdtempSync(path.join(dbRoot, 'params-'));
  const paramsDevice = await openDevice({ identity: identityA, dbDir: paramsDir });
  try {
    try {
      await paramsDevice.connect({
        params: {
          user_id: identityB.tenantId,
          tenant_id: identityB.tenantId,
        },
      });
      const stream = paramsDevice.db.syncStream('todos', { tenant_id: identityB.tenantId });
      await stream.subscribe();
    } catch {
      // rejected subscription/connect is acceptable
    }
    await assertAttackYieldsNoExtraData(
      paramsDevice,
      identityA.tenantId,
      identityB.tenantId,
      'subscription/connection parameters',
    );
  } finally {
    try {
      await paramsDevice.disconnect();
      await paramsDevice.close();
    } catch {
      // ignore cleanup errors
    }
    fs.rmSync(paramsDir, { recursive: true, force: true });
  }

  fs.rmSync(dbRoot, { recursive: true, force: true });
  console.log('harness-1.2: all checks passed');
  process.exit(0);
} catch (err) {
  try {
    fs.rmSync(dbRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors on failure path
  }
  fail(err instanceof Error ? err.message : String(err));
}
