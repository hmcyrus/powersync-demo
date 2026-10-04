import hashlib
import secrets
import time
import uuid
from typing import Any

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from config import SESSION_COOKIE_NAME, SESSION_SECRET, SESSION_TTL_SECONDS

serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="poc-session")


def create_session_value(tenant_id: str, email: str) -> str:
    return serializer.dumps({"tenant_id": tenant_id, "email": email})


def read_session_value(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        return serializer.loads(raw, max_age=SESSION_TTL_SECONDS)
    except (BadSignature, SignatureExpired):
        return None


def session_cookie_name() -> str:
    return SESSION_COOKIE_NAME


def new_refresh_token() -> tuple[str, str, str]:
    token_id = str(uuid.uuid4())
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return token_id, raw, token_hash
