"""SQLite-backed storage for saved predictions.

Survives restarts/redeploys (unlike the old JSON file on ephemeral hosts) and
serialises concurrent writes safely. Pure stdlib — no extra dependency.

The DB path can be overridden with the WC_DB environment variable, which is
handy on hosts that give you a specific persistent directory.
"""

import json
import os
import sqlite3
import threading

DB_PATH = os.environ.get(
    "WC_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "predictions.db")
)
_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the table if needed, and migrate any legacy predictions.json."""
    with _conn() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS predictions (
                key      TEXT PRIMARY KEY,  -- lower(name), used for upsert
                name     TEXT NOT NULL,     -- display name as typed
                state    TEXT NOT NULL,     -- JSON {groupScores, koPicks}
                summary  TEXT NOT NULL,     -- JSON champion/finalists/etc.
                updated  INTEGER NOT NULL,  -- unix seconds
                pin_hash TEXT NOT NULL DEFAULT ''  -- salted hash; '' = unprotected
            )"""
        )
        # Add pin_hash to databases created before PINs existed.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(predictions)")]
        if "pin_hash" not in cols:
            conn.execute("ALTER TABLE predictions ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''")
    _migrate_legacy_json()


def _migrate_legacy_json():
    """One-time import of an old predictions.json sitting next to this file."""
    legacy = os.path.join(os.path.dirname(os.path.abspath(__file__)), "predictions.json")
    if not os.path.exists(legacy):
        return
    with _conn() as conn:
        already = conn.execute("SELECT COUNT(*) AS n FROM predictions").fetchone()["n"]
        if already:
            return
        try:
            with open(legacy, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError):
            return
        for rec in data.values():
            conn.execute(
                "INSERT OR REPLACE INTO predictions(key,name,state,summary,updated) "
                "VALUES(?,?,?,?,?)",
                (rec["name"].lower(), rec["name"], json.dumps(rec.get("state", {})),
                 json.dumps(rec.get("summary", {})), int(rec.get("updated", 0))),
            )
    # Leave the JSON in place as a backup; rename so we don't re-import.
    try:
        os.replace(legacy, legacy + ".imported")
    except OSError:
        pass


def upsert(name, state, summary, updated, pin_hash):
    with _lock, _conn() as conn:
        conn.execute(
            """INSERT INTO predictions(key,name,state,summary,updated,pin_hash)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(key) DO UPDATE SET
                   name=excluded.name, state=excluded.state,
                   summary=excluded.summary, updated=excluded.updated,
                   pin_hash=excluded.pin_hash""",
            (name.lower(), name, json.dumps(state), json.dumps(summary),
             updated, pin_hash),
        )


def get_pin_hash(name):
    """Return the stored pin hash ('' if unprotected) or None if name unknown."""
    with _conn() as conn:
        r = conn.execute(
            "SELECT pin_hash FROM predictions WHERE key=?", (name.lower(),)
        ).fetchone()
    return None if r is None else (r["pin_hash"] or "")


def list_all():
    with _conn() as conn:
        rows = conn.execute(
            "SELECT name, summary, updated FROM predictions ORDER BY updated DESC"
        ).fetchall()
    return [
        {"name": r["name"], "updated": r["updated"], **json.loads(r["summary"])}
        for r in rows
    ]


def get(name):
    with _conn() as conn:
        r = conn.execute(
            "SELECT name, state, summary, updated FROM predictions WHERE key=?",
            (name.lower(),),
        ).fetchone()
    if not r:
        return None
    return {
        "name": r["name"],
        "state": json.loads(r["state"]),
        "summary": json.loads(r["summary"]),
        "updated": r["updated"],
    }


def delete(name):
    with _lock, _conn() as conn:
        cur = conn.execute("DELETE FROM predictions WHERE key=?", (name.lower(),))
        return cur.rowcount > 0
