-- Migration for existing Postgres volumes (test 0.6). Fresh installs use init.sql.

CREATE TABLE IF NOT EXISTS users (
  tenant_id text PRIMARY KEY,
  google_sub text NOT NULL UNIQUE,
  email text NOT NULL
);

CREATE TABLE IF NOT EXISTS allowed_emails (
  email text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  slot integer NOT NULL CHECK (slot >= 1 AND slot <= 3),
  name text,
  revoked_at timestamptz,
  UNIQUE (tenant_id, slot)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS upload_drops (
  id text PRIMARY KEY,
  tenant_id text,
  device_id text,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Narrowed publication: synced tables only (idempotent on existing volumes).
DROP PUBLICATION IF EXISTS powersync;
CREATE PUBLICATION powersync FOR TABLE todos, todo_items, catalog;
