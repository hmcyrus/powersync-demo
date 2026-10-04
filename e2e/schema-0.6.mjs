import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SYNCED_TABLES = ['todos', 'todo_items', 'catalog'];
const SERVER_ONLY_TABLES = ['users', 'allowed_emails', 'devices', 'refresh_tokens', 'upload_drops'];

function psql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execSync(`docker compose exec -T postgres psql -U postgres -d postgres -t -A -c "${oneLine}"`, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS: ${message}`);
}

const pubTables = psql(
  "SELECT tablename FROM pg_publication_tables WHERE pubname = 'powersync' ORDER BY tablename",
)
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const expectedPub = [...SYNCED_TABLES].sort();
const actualPub = [...pubTables].sort();
if (JSON.stringify(actualPub) !== JSON.stringify(expectedPub)) {
  fail(`publication powersync tables: expected ${expectedPub.join(', ')}, got ${actualPub.join(', ')}`);
}
pass(`publication powersync contains exactly ${expectedPub.join(', ')}`);

for (const table of SERVER_ONLY_TABLES) {
  if (pubTables.includes(table)) {
    fail(`${table} must not be in publication powersync`);
  }
}
pass(`server-only tables absent from publication: ${SERVER_ONLY_TABLES.join(', ')}`);

for (const table of [...SYNCED_TABLES, ...SERVER_ONLY_TABLES]) {
  const exists = psql(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${table}'`,
  );
  if (exists !== '1') {
    fail(`missing table public.${table}`);
  }
}
pass('all synced and server-only tables exist');

const todosTenant = psql(
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'tenant_id'",
);
const todoItemsTenant = psql(
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todo_items' AND column_name = 'tenant_id'",
);
const catalogTenant = psql(
  "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'catalog' AND column_name = 'tenant_id'",
);

if (todosTenant !== 'NO') fail(`todos.tenant_id must be NOT NULL, got is_nullable=${todosTenant}`);
if (todoItemsTenant !== 'NO') fail(`todo_items.tenant_id must be NOT NULL, got is_nullable=${todoItemsTenant}`);
if (catalogTenant !== 'YES') fail(`catalog.tenant_id must be nullable, got is_nullable=${catalogTenant}`);
pass('tenant_id nullability: todos NOT NULL, todo_items NOT NULL, catalog NULL');

console.log('schema-0.6: all checks passed');
process.exit(0);
