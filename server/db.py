import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

_ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT_DIR / ".env")

# Always an ABSOLUTE path, never a bare relative string like "sqlite:///ma_base.db".
# Path(__file__).resolve() already makes this absolute regardless of the current
# working directory the process was started from — required on hosts like
# PythonAnywhere, where the WSGI process's CWD is not guaranteed to be the
# project root. CCNA_DB_PATH (settable in .env) lets a deployment override the
# location (e.g. PythonAnywhere's /home/<user>/<project>/data/app.db) without
# editing code; any value supplied is itself resolved to an absolute path as a
# safety net.
_DEFAULT_DB_PATH = _ROOT_DIR / "data" / "app.db"
DB_PATH = Path(os.environ.get("CCNA_DB_PATH", _DEFAULT_DB_PATH)).resolve()
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_connection()
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()


@contextmanager
def transaction():
    """All statements inside the block commit together, or none do.

    Prevents partial writes (e.g. a page inserted without its questions, or
    an exam inserted without its per-question detail rows) from ever landing
    in the database, even if the process crashes or an error is raised
    mid-way through.
    """
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
