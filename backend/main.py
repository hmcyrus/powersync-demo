from fastapi import FastAPI, HTTPException
import psycopg

DSN = "postgresql://postgres:postgres@localhost:5432/postgres"

app = FastAPI()

ALLOWED_PATCH_FIELDS = ("title", "is_completed", "created_at", "tenant_id", "code")


def get_conn():
    return psycopg.connect(DSN, autocommit=True)


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
def create_todo(body: dict):
    if "title" not in body or body["title"] is None:
        raise HTTPException(status_code=500, detail="title is required")

    tenant_id = body.get("tenant_id") or "dev"

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO todos (id, tenant_id, title, is_completed, created_at, code)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      tenant_id = EXCLUDED.tenant_id,
                      title = EXCLUDED.title,
                      is_completed = EXCLUDED.is_completed,
                      created_at = EXCLUDED.created_at,
                      code = EXCLUDED.code
                    """,
                    (
                        body["id"],
                        tenant_id,
                        body["title"],
                        body.get("is_completed", 0),
                        body.get("created_at"),
                        body.get("code"),
                    ),
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@app.patch("/todos/{todo_id}")
def patch_todo(todo_id: str, body: dict):
    sets = []
    values = []
    for key in ALLOWED_PATCH_FIELDS:
        if key in body:
            sets.append(f"{key} = %s")
            values.append(body[key])

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                if sets:
                    sql = f"UPDATE todos SET {', '.join(sets)} WHERE id = %s"
                    values.append(todo_id)
                    cur.execute(sql, values)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}


@app.delete("/todos/{todo_id}")
def delete_todo(todo_id: str):
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM todos WHERE id = %s", (todo_id,))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"ok": True}
