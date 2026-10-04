import { column, Schema, Table } from '@powersync/node';

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
