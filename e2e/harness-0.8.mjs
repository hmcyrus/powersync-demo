import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIdentity, ensureFreeSlots, openDevice, signIn } from './harness/index.mjs';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powersync-harness-0.8-'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const sessionCookie = await signIn();
  await ensureFreeSlots(sessionCookie, 2);

  const identityA = await createIdentity({
    sessionCookie,
    deviceId: `harness-0.8-a-${Date.now()}`,
    name: 'harness-0.8-a',
  });
  const identityB = await createIdentity({
    sessionCookie,
    deviceId: `harness-0.8-b-${Date.now()}`,
    name: 'harness-0.8-b',
  });

  if (identityA.deviceId === identityB.deviceId) {
    fail('device identities must be distinct');
  }
  pass('two distinct device identities registered via real API');

  const deviceA = await openDevice({ identity: identityA, dbDir });
  const deviceB = await openDevice({ identity: identityB, dbDir });

  const dbPathA = deviceA.dbFilePath();
  const dbPathB = deviceB.dbFilePath();
  if (dbPathA === dbPathB) {
    fail('devices must use separate DB files');
  }
  pass('each device targets a distinct SQLite DB filename');

  await deviceA.connect();
  await deviceB.connect();
  pass('two headless device clients connected with real connectors (no Playwright)');

  if (!fs.existsSync(dbPathA) || !fs.existsSync(dbPathB)) {
    fail('expected per-device SQLite files on disk after connect');
  }
  pass('each device created its own SQLite DB file');

  const versionA = await deviceA.db.get('SELECT powersync_rs_version() AS v');
  const versionB = await deviceB.db.get('SELECT powersync_rs_version() AS v');
  if (!versionA?.v || !versionB?.v) {
    fail('PowerSync SQLite extension not active in one or both device DBs');
  }
  pass('both device DBs run PowerSync locally');

  await deviceA.disconnect();
  await deviceB.disconnect();
  await deviceA.close();
  await deviceB.close();
  await sleep(500);
  pass('devices closed cleanly');

  fs.rmSync(dbDir, { recursive: true, force: true });
  console.log('harness-0.8: all checks passed');
  process.exit(0);
} catch (err) {
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors on failure path
  }
  fail(err instanceof Error ? err.message : String(err));
}
