#!/bin/sh
set -eu

KEY_FILE=/data/jwt.pem
mkdir -p /data
if [ ! -s "$KEY_FILE" ]; then
  openssl genrsa -out "$KEY_FILE" 2048
fi

export JWT_PRIVATE_KEY_PEM="$(cat "$KEY_FILE")"
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@postgres:5432/postgres}"
export SYNC_AUDIENCE="${SYNC_AUDIENCE:-http://sync.localhost}"
export APP_BASE_URL="${APP_BASE_URL:-http://app.localhost}"

exec uvicorn main:app --host 0.0.0.0 --port 8000
