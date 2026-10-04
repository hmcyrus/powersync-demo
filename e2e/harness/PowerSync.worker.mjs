import Database from 'better-sqlite3';
import { startPowerSyncWorker } from '@powersync/node/worker.js';

async function resolveBetterSqlite3() {
  return Database;
}

startPowerSyncWorker({ loadBetterSqlite3: resolveBetterSqlite3 });
