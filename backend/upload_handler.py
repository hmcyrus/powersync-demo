import json
import uuid
from typing import Any

from db import get_conn

SYNCED_TABLES = {
    "todos": {"title", "is_completed", "created_at", "code"},
    "todo_items": {"todo_id", "text", "done", "seq"},
    "catalog": {"name", "kind"},
}


def apply_upload_batch(tenant_id: str, device_id: str, batch: list[dict[str, Any]]) -> tuple[bool, str | None]:
    if not batch:
        return True, None

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                for op in batch:
                    table = op.get("table")
                    row_id = op.get("id")
                    operation = op.get("op")
                    op_data = op.get("opData") or {}

                    if table not in SYNCED_TABLES:
                        raise ValueError(f"table not allowed: {table}")

                    extra_cols = set(op_data.keys()) - SYNCED_TABLES[table]
                    if extra_cols:
                        raise ValueError(f"columns not allowed on {table}: {', '.join(sorted(extra_cols))}")

                    if table == "catalog" and operation in ("PUT", "PATCH", "DELETE"):
                        if "tenant_id" in op_data and op_data.get("tenant_id") is None:
                            raise ValueError("shared catalog rows are read-only")
                        if operation == "PUT" and op_data.get("tenant_id") is None:
                            raise ValueError("cannot create shared catalog rows")

                    if operation == "PUT":
                        cols = ["id", "tenant_id", *op_data.keys()]
                        values = [row_id, tenant_id, *[op_data[c] for c in op_data.keys()]]
                        placeholders = ", ".join(["%s"] * len(cols))
                        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in op_data.keys())
                        sql = (
                            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) "
                            f"ON CONFLICT (id) DO UPDATE SET {updates}, tenant_id = EXCLUDED.tenant_id "
                            f"WHERE {table}.tenant_id = %s"
                        )
                        cur.execute(sql, [*values, tenant_id])
                        if cur.rowcount == 0:
                            raise ValueError(f"tenant conflict on PUT {table}/{row_id}")

                    elif operation == "PATCH":
                        if not op_data:
                            continue
                        sets = ", ".join(f"{c} = %s" for c in op_data.keys())
                        values = [op_data[c] for c in op_data.keys()]
                        sql = (
                            f"UPDATE {table} SET {sets}, tenant_id = %s "
                            f"WHERE id = %s AND tenant_id = %s"
                        )
                        cur.execute(sql, [*values, tenant_id, row_id, tenant_id])
                        if cur.rowcount == 0:
                            raise ValueError(f"tenant conflict on PATCH {table}/{row_id}")

                    elif operation == "DELETE":
                        sql = f"DELETE FROM {table} WHERE id = %s AND tenant_id = %s"
                        cur.execute(sql, (row_id, tenant_id))
                        if cur.rowcount == 0:
                            raise ValueError(f"tenant conflict on DELETE {table}/{row_id}")

                    else:
                        raise ValueError(f"unknown op: {operation}")

            conn.commit()
        return True, None
    except Exception as exc:
        reason = str(exc)
        drop_id = str(uuid.uuid4())
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO upload_drops (id, tenant_id, device_id, reason, payload)
                    VALUES (%s, %s, %s, %s, %s::jsonb)
                    """,
                    (drop_id, tenant_id, device_id, reason, json.dumps({"batch": batch})),
                )
            conn.commit()
        return False, reason
