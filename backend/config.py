import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

DSN = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres")
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-session-secret-change-me")
JWT_PRIVATE_KEY_PEM = os.getenv("JWT_PRIVATE_KEY_PEM", "")
JWT_KID = os.getenv("JWT_KID", "poc-key-1")
SYNC_TOKEN_TTL_SECONDS = int(os.getenv("SYNC_TOKEN_TTL_SECONDS", "300"))
SYNC_AUDIENCE = os.getenv("SYNC_AUDIENCE", "http://sync.localhost")
SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "poc_session")
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "86400"))
OIDC_CLIENT_ID = os.getenv("OIDC_CLIENT_ID", "poc-client")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://app.localhost")
