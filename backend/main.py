import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import jwt
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from config import (
    APP_BASE_URL,
    JWT_KID,
    OIDC_CLIENT_ID,
    SYNC_AUDIENCE,
    SYNC_TOKEN_TTL_SECONDS,
)
from crypto_keys import jwks_document, signing_key
from db import get_conn
from session_util import (
    create_session_value,
    new_refresh_token,
    read_session_value,
    session_cookie_name,
)
from upload_handler import apply_upload_batch

app = FastAPI()

ALLOWED_PATCH_FIELDS = ("title", "is_completed", "created_at", "tenant_id", "code")

_pending_oidc_codes: dict[str, dict[str, Any]] = {}


def row_to_json(row):
    created_at = row[4]
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    else:
        created_at = str(created_at)
    return {
        "id": str(row[0]),
        "tenant_id": row[1],
        "title": row[2],
        "is_completed": int(row[3]),
        "created_at": created_at,
        "code": row[5],
    }


def require_session(session_raw: str | None = Cookie(default=None, alias=session_cookie_name())):
    session = read_session_value(session_raw)
    if not session:
        raise HTTPException(status_code=401, detail="session required")
    return session


def parse_bearer_token(authorization: str | None) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        return jwt.decode(
            token,
            signing_key().public_key(),
            algorithms=["RS256"],
            audience=SYNC_AUDIENCE,
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="invalid token") from exc


def device_is_active(cur, tenant_id: str, device_id: str) -> bool:
    cur.execute(
        """
        SELECT revoked_at FROM devices
        WHERE id = %s AND tenant_id = %s
        """,
        (device_id, tenant_id),
    )
    row = cur.fetchone()
    return row is not None and row[0] is None


@app.get("/.well-known/jwks.json")
def well_known_jwks():
    return jwks_document()


@app.get("/oidc/.well-known/openid-configuration")
def oidc_configuration():
    base = f"{APP_BASE_URL}/api/oidc"
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/authorize",
        "token_endpoint": f"{base}/token",
        "jwks_uri": f"{APP_BASE_URL}/api/.well-known/jwks.json",
        "response_types_supported": ["code"],
    }


@app.get("/auth/oidc/start")
def auth_oidc_start(email: str = "doctor@example.com"):
    state = secrets.token_urlsafe(16)
    redirect_uri = f"{APP_BASE_URL}/api/auth/oidc/callback"
    params = urlencode(
        {
            "client_id": OIDC_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "state": state,
            "email": email,
        }
    )
    return RedirectResponse(f"{APP_BASE_URL}/api/oidc/authorize?{params}")


@app.get("/oidc/authorize")
def oidc_authorize(
    email: str,
    redirect_uri: str,
    state: str,
    client_id: str = OIDC_CLIENT_ID,
    response_type: str = "code",
):
    if client_id != OIDC_CLIENT_ID or response_type != "code":
        raise HTTPException(status_code=400, detail="invalid authorize request")
    code = secrets.token_urlsafe(24)
    _pending_oidc_codes[code] = {"email": email, "redirect_uri": redirect_uri}
    target = f"{redirect_uri}?{urlencode({'code': code, 'state': state})}"
    return RedirectResponse(target)


@app.get("/auth/oidc/callback")
def auth_oidc_callback(code: str, state: str):
    pending = _pending_oidc_codes.pop(code, None)
    if not pending:
        raise HTTPException(status_code=400, detail="invalid or expired code")

    email = pending["email"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM allowed_emails WHERE email = %s", (email,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=403, detail="email not allowlisted")

            cur.execute("SELECT tenant_id FROM users WHERE email = %s", (email,))
            row = cur.fetchone()
            if row:
                tenant_id = row[0]
            else:
                tenant_id = str(uuid.uuid4())
                google_sub = f"stub-{tenant_id}"
                cur.execute(
                    "INSERT INTO users (tenant_id, google_sub, email) VALUES (%s, %s, %s)",
                    (tenant_id, google_sub, email),
                )

            refresh_id, refresh_raw, refresh_hash = new_refresh_token()
            expires_at = datetime.now(timezone.utc) + timedelta(days=365)
            cur.execute(
                """
                INSERT INTO refresh_tokens (id, tenant_id, token_hash, expires_at)
                VALUES (%s, %s, %s, %s)
                """,
                (refresh_id, tenant_id, refresh_hash, expires_at),
            )
        conn.commit()

    redirect = RedirectResponse(f"{APP_BASE_URL}/", status_code=302)
    redirect.set_cookie(
        key=session_cookie_name(),
        value=create_session_value(tenant_id, email),
        httponly=True,
        samesite="lax",
        path="/",
    )
    redirect.set_cookie(
        key="poc_refresh",
        value=refresh_raw,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=365 * 24 * 3600,
    )
    return redirect


@app.post("/devices/register")
def register_device(body: dict, session=Depends(require_session)):
    device_id = body.get("id")
    name = body.get("name") or "device"
    if not device_id:
        raise HTTPException(status_code=400, detail="id is required")

    tenant_id = session["tenant_id"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, tenant_id, slot, name, revoked_at
                FROM devices
                WHERE tenant_id = %s
                ORDER BY slot
                FOR UPDATE
                """,
                (tenant_id,),
            )
            rows = cur.fetchall()
            active = [r for r in rows if r[4] is None]
            existing = next((r for r in active if r[0] == device_id), None)
            if existing:
                conn.commit()
                return {
                    "id": existing[0],
                    "tenant_id": existing[1],
                    "slot": existing[2],
                    "name": existing[3],
                    "email": session["email"],
                }

            if len(active) >= 3:
                devices = [
                    {"id": r[0], "tenant_id": r[1], "slot": r[2], "name": r[3]}
                    for r in active
                ]
                raise HTTPException(status_code=409, detail={"devices": devices})

            used_slots = {r[2] for r in active}
            slot = next(s for s in (1, 2, 3) if s not in used_slots)
            cur.execute(
                """
                INSERT INTO devices (id, tenant_id, slot, name)
                VALUES (%s, %s, %s, %s)
                """,
                (device_id, tenant_id, slot, name),
            )
        conn.commit()
    return {
        "id": device_id,
        "tenant_id": tenant_id,
        "slot": slot,
        "name": name,
        "email": session["email"],
    }


@app.get("/devices")
def list_devices(session=Depends(require_session)):
    tenant_id = session["tenant_id"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, tenant_id, slot, name, revoked_at
                FROM devices
                WHERE tenant_id = %s AND revoked_at IS NULL
                ORDER BY slot
                """,
                (tenant_id,),
            )
            rows = cur.fetchall()
    return [
        {"id": r[0], "tenant_id": r[1], "slot": r[2], "name": r[3]}
        for r in rows
    ]


@app.delete("/devices/{device_id}")
def delete_device(device_id: str, session=Depends(require_session)):
    tenant_id = session["tenant_id"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE devices SET revoked_at = now()
                WHERE id = %s AND tenant_id = %s AND revoked_at IS NULL
                """,
                (device_id, tenant_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="device not found")
        conn.commit()
    return {"ok": True}


@app.get("/sync/token")
def sync_token(device_id: str, session=Depends(require_session)):
    tenant_id = session["tenant_id"]
    with get_conn() as conn:
        with conn.cursor() as cur:
            if not device_is_active(cur, tenant_id, device_id):
                raise HTTPException(status_code=403, detail="device missing or revoked")

    now = int(time.time())
    token = jwt.encode(
        {
            "sub": tenant_id,
            "device_id": device_id,
            "aud": SYNC_AUDIENCE,
            "iat": now,
            "exp": now + SYNC_TOKEN_TTL_SECONDS,
        },
        signing_key(),
        algorithm="RS256",
        headers={"kid": JWT_KID},
    )
    return {
        "token": token,
        "expires_at": now + SYNC_TOKEN_TTL_SECONDS,
        "endpoint": SYNC_AUDIENCE,
    }


@app.post("/sync/upload")
async def sync_upload(request: Request):
    claims = parse_bearer_token(request.headers.get("authorization"))
    tenant_id = claims["sub"]
    device_id = claims.get("device_id")
    if not device_id:
        raise HTTPException(status_code=401, detail="device_id claim required")

    with get_conn() as conn:
        with conn.cursor() as cur:
            if not device_is_active(cur, tenant_id, device_id):
                raise HTTPException(status_code=403, detail="device missing or revoked")

    body = await request.json()
    batch = body.get("batch") or body.get("crud") or []
    applied, reason = apply_upload_batch(tenant_id, device_id, batch)
    return {"ok": True, "applied": applied, "reason": reason}


@app.get("/todos")
def list_todos():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, tenant_id, title, is_completed, created_at, code
                FROM todos
                ORDER BY created_at
                """
            )
            rows = cur.fetchall()
    return [row_to_json(row) for row in rows]


@app.post("/todos")
def create_todo(body: dict, session=Depends(require_session)):
    if "title" not in body or body["title"] is None:
        raise HTTPException(status_code=500, detail="title is required")

    tenant_id = session["tenant_id"]

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO todos (id, tenant_id, title, is_completed, created_at, code)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      title = EXCLUDED.title,
                      is_completed = EXCLUDED.is_completed,
                      created_at = EXCLUDED.created_at,
                      code = EXCLUDED.code
                    WHERE todos.tenant_id = %s
                    """,
                    (
                        body["id"],
                        tenant_id,
                        body["title"],
                        body.get("is_completed", 0),
                        body.get("created_at"),
                        body.get("code"),
                        tenant_id,
                    ),
                )
            conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@app.patch("/todos/{todo_id}")
def patch_todo(todo_id: str, body: dict, session=Depends(require_session)):
    tenant_id = session["tenant_id"]
    sets = []
    values = []
    for key in ALLOWED_PATCH_FIELDS:
        if key in body and key != "tenant_id":
            sets.append(f"{key} = %s")
            values.append(body[key])

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                if sets:
                    sql = f"UPDATE todos SET {', '.join(sets)} WHERE id = %s AND tenant_id = %s"
                    values.extend([todo_id, tenant_id])
                    cur.execute(sql, values)
            conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@app.delete("/todos/{todo_id}")
def delete_todo(todo_id: str, session=Depends(require_session)):
    tenant_id = session["tenant_id"]
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM todos WHERE id = %s AND tenant_id = %s",
                    (todo_id, tenant_id),
                )
            conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}
