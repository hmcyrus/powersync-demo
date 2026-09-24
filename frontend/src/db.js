import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';

const todos = new Table({
  title: column.text,
  is_completed: column.integer,
  created_at: column.text,
});

export const AppSchema = new Schema({ todos });

export const db = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: 'todos.db' },
});
