CREATE TABLE IF NOT EXISTS todos (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  is_completed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE PUBLICATION powersync FOR ALL TABLES;
