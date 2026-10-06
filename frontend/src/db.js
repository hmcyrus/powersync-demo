import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';

const todos = new Table({
  tenant_id: column.text,
  title: column.text,
  is_completed: column.integer,
  created_at: column.text,
  code: column.text,
});

const catalog = new Table({
  tenant_id: column.text,
  name: column.text,
  kind: column.text,
});

const todoItems = new Table({
  tenant_id: column.text,
  todo_id: column.text,
  text: column.text,
  done: column.integer,
  seq: column.integer,
});

export const AppSchema = new Schema({ todos, catalog, todo_items: todoItems });

const POWERSYNC_WORKER = '/@powersync/worker.js';

let dbInstance = null;

export function initDb(tenantId) {
  if (dbInstance) return dbInstance;
  dbInstance = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: `todos-${tenantId}.db`,
      worker: POWERSYNC_WORKER,
    },
    sync: {
      worker: POWERSYNC_WORKER,
    },
  });
  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized');
  }
  return dbInstance;
}
