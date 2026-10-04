// Historical artifact from test 0.4: benchmark that compared single-stream vs two-stream by
// temporarily overwriting powersync/sync-config.yaml (including with sync-config-single-stream.yaml),
// restarting PowerSync, and seeding 1 / 50 / 100 tenants. Test 0.4 locked two-stream
// (sync-config.yaml: catalog_shared + catalog_own). Not the live configuration path; not part of
// normal setup. Do not run this script to apply a config. If interrupted, it can leave
// sync-config.yaml on the rejected single-stream form. sync-config-single-stream.yaml is also a
// historical artifact and must not be activated.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_CATALOG_ID = 'catalog-shared-0';

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function psql(sql, db = 'postgres') {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return run(`docker compose exec -T postgres psql -U postgres -d ${db} -t -A -c "${oneLine}"`);
}

function applyMigration() {
  const sql = fs.readFileSync(path.join(ROOT, 'powersync/03-tenant-schema.sql'), 'utf8');
  execSync('docker compose exec -T postgres psql -U postgres -d postgres', {
    cwd: ROOT,
    input: sql,
  });
}

function restartPowerSync() {
  run('docker compose restart powersync');
  for (let i = 0; i < 30; i++) {
    const logs = run('docker compose logs --tail=40 powersync 2>&1');
    if (logs.includes('Service started')) return;
    execSync('powershell -Command "Start-Sleep -Seconds 2"');
  }
  throw new Error('PowerSync did not restart in time');
}

function useSyncConfig(filename) {
  fs.copyFileSync(
    path.join(ROOT, 'powersync', filename),
    path.join(ROOT, 'powersync', 'sync-config.yaml'),
  );
  restartPowerSync();
}

function clearBucketStorage() {
  psql(
    'TRUNCATE powersync.bucket_data, powersync.bucket_parameters, powersync.current_data RESTART IDENTITY CASCADE',
    'powersync_storage',
  );
}

function seedTenants(count) {
  psql('DELETE FROM catalog');
  psql('DELETE FROM todo_items');
  psql("DELETE FROM todos WHERE title <> 'synced from postgres'");

  psql(
    `INSERT INTO catalog (id, tenant_id, name, kind) VALUES ('${SHARED_CATALOG_ID}', NULL, 'Shared catalog row', 'drug') ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, kind = EXCLUDED.kind`,
  );

  for (let i = 0; i < count; i++) {
    const tenant = `tenant-${String(i).padStart(3, '0')}`;
    const todoId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    psql(
      `INSERT INTO catalog (id, tenant_id, name, kind) VALUES ('catalog-${tenant}', '${tenant}', 'Private ${tenant}', 'custom') ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name`,
    );
    psql(
      `INSERT INTO todos (id, tenant_id, title, is_completed, created_at) VALUES ('${todoId}', '${tenant}', 'seed ${tenant}', 0, now()) ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, title = EXCLUDED.title`,
    );
  }

  execSync('powershell -Command "Start-Sleep -Seconds 10"');
}

function measureStorage(label) {
  const dbSize = psql(
    "SELECT pg_size_pretty(pg_database_size('powersync_storage'))",
    'powersync_storage',
  );
  const catalogBuckets = psql(
    "SELECT count(DISTINCT bucket_name) FROM powersync.bucket_data WHERE table_name = 'catalog'",
    'powersync_storage',
  );
  const sharedRowCopies = psql(
    `SELECT count(*) FROM powersync.bucket_data WHERE table_name = 'catalog' AND row_id = '${SHARED_CATALOG_ID}' AND op = 'PUT'`,
    'powersync_storage',
  );
  const sharedBuckets = psql(
    `SELECT count(DISTINCT bucket_name) FROM powersync.bucket_data WHERE table_name = 'catalog' AND row_id = '${SHARED_CATALOG_ID}' AND op = 'PUT'`,
    'powersync_storage',
  );
  const totalBuckets = psql(
    'SELECT count(DISTINCT bucket_name) FROM powersync.bucket_data',
    'powersync_storage',
  );

  return {
    label,
    dbSize,
    catalogBuckets: Number(catalogBuckets),
    sharedRowCopies: Number(sharedRowCopies),
    sharedBuckets: Number(sharedBuckets),
    totalBuckets: Number(totalBuckets),
  };
}

function serviceAcceptedConfig() {
  const logs = run('docker compose logs --tail=100 powersync 2>&1');
  const reject = /Could not load sync config|Invalid sync config|Error loading sync rules/i.test(logs);
  const started = logs.includes('Service started');
  return started && !reject;
}

export function runStreamFormSpike() {
  applyMigration();

  const results = {
    singleStreamAccepted: false,
    singleStreamError: null,
    measurements: [],
    chosenForm: 'two-stream',
  };

  for (const count of [1, 50, 100]) {
    clearBucketStorage();
    seedTenants(count);

    useSyncConfig('sync-config-single-stream.yaml');
    try {
      results.singleStreamAccepted = serviceAcceptedConfig();
      if (results.singleStreamAccepted) {
        results.measurements.push({
          form: 'single-stream',
          tenants: count,
          ...measureStorage(`single-${count}`),
        });
      } else {
        results.singleStreamError = 'service rejected or failed to start with single-stream config';
        break;
      }
    } catch (err) {
      results.singleStreamError = String(err.message ?? err);
      break;
    }

    clearBucketStorage();
    seedTenants(count);

    useSyncConfig('sync-config.yaml');
    results.measurements.push({
      form: 'two-stream',
      tenants: count,
      ...measureStorage(`two-${count}`),
    });
  }

  useSyncConfig('sync-config.yaml');

  const singleDuplicatesShared = results.measurements.some(
    (m) =>
      m.form === 'single-stream' && (m.sharedRowCopies > 1 || m.sharedBuckets > 1),
  );

  if (!results.singleStreamAccepted || singleDuplicatesShared) {
    results.chosenForm = 'two-stream';
  } else if (results.singleStreamAccepted) {
    results.chosenForm = 'single-stream';
  }

  results.bucketsPerClientTwoStream = 4;

  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = runStreamFormSpike();
  console.log(JSON.stringify(out, null, 2));
}
