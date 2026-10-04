import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PowerSyncDatabase } from '@powersync/node';

import { registerDevice, signIn } from './api-client.mjs';
import { HarnessConnector } from './connector.mjs';
import { AppSchema } from './schema.mjs';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = pathToFileURL(path.join(HARNESS_DIR, 'PowerSync.worker.mjs'));

export function dbFilenameForIdentity(identity) {
  return `rx-${identity.tenantId}-${identity.deviceId}.db`;
}

export async function createIdentity({
  email = 'doctor@example.com',
  deviceId,
  name = 'harness-device',
  sessionCookie: existingSession,
} = {}) {
  const id = deviceId ?? `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionCookie = existingSession ?? (await signIn(email));
  const registered = await registerDevice(sessionCookie, { deviceId: id, name });
  return {
    tenantId: registered.tenant_id,
    deviceId: registered.id,
    slot: registered.slot,
    email,
    sessionCookie,
  };
}

export class SimulatedDevice {
  constructor({ identity, dbDir }) {
    this.identity = identity;
    this.dbDir = dbDir;
    this.db = null;
    this.connector = new HarnessConnector(identity);
  }

  async open() {
    const dbFilename = dbFilenameForIdentity(this.identity);
    this.db = new PowerSyncDatabase({
      schema: AppSchema,
      database: {
        dbFilename,
        dbLocation: this.dbDir,
        openWorker: (_, options) => new Worker(WORKER_URL, options),
      },
    });
    return this;
  }

  async connect() {
    if (!this.db) {
      throw new Error('call open() before connect()');
    }
    await this.db.connect(this.connector);
    return this;
  }

  async disconnect() {
    if (this.db) {
      await this.db.disconnect();
    }
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  dbFilePath() {
    return path.join(this.dbDir, dbFilenameForIdentity(this.identity));
  }
}

export async function openDevice(options) {
  const identity = options.identity ?? (await createIdentity(options));
  const device = new SimulatedDevice({
    identity,
    dbDir: options.dbDir,
  });
  await device.open();
  return device;
}
