-- Migration for existing Postgres volumes (test 0.4+). Fresh installs use init.sql.

ALTER TABLE todos ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE todos SET tenant_id = 'dev' WHERE tenant_id IS NULL;
ALTER TABLE todos ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE todos ALTER COLUMN tenant_id SET DEFAULT 'dev';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS code text;

CREATE TABLE IF NOT EXISTS todo_items (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  todo_id text NOT NULL,
  text text NOT NULL,
  done integer NOT NULL DEFAULT 0,
  seq integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS catalog (
  id text PRIMARY KEY,
  tenant_id text,
  name text NOT NULL,
  kind text NOT NULL
);

DROP PUBLICATION IF EXISTS powersync;
CREATE PUBLICATION powersync FOR TABLE todos, todo_items, catalog;
