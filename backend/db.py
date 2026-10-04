import psycopg

from config import DSN


def get_conn():
    return psycopg.connect(DSN, autocommit=False)
