"""SQLite data layer: users, user-scoped predictions, and leagues.

Replaces the old name+PIN store. Predictions now belong to a logged-in user.
Pure stdlib. DB path overridable with WC_DB.
"""

import json
import os
import sqlite3
import threading

DB_PATH = os.environ.get(
    "WC_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "worldcup.db")
)
_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT UNIQUE NOT NULL,       -- lowercased
                display_name  TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                verified      INTEGER NOT NULL DEFAULT 0,
                verify_token  TEXT,
                created       INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS predictions (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                state   TEXT NOT NULL,
                summary TEXT NOT NULL,
                updated INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS leagues (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                code     TEXT UNIQUE NOT NULL,
                name     TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created  INTEGER NOT NULL,
                logo     TEXT NOT NULL DEFAULT '',
                sponsors TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS league_members (
                league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
                user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                joined    INTEGER NOT NULL,
                PRIMARY KEY (league_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS live_predictions (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                scores  TEXT NOT NULL,   -- JSON {match_id: {home, away}}
                updated INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS live_ko_predictions (
                user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                scores  TEXT NOT NULL,   -- JSON {'K-73': {home, away, adv}}
                updated INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS results (
                match_id TEXT PRIMARY KEY,   -- 'G-A-1' for groups, 'K-73' for knockout
                home     INTEGER,
                away     INTEGER,
                status   TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|live|ft
                scorers  TEXT NOT NULL DEFAULT '{}',          -- JSON {home:[],away:[]}
                winner   TEXT,                                -- knockout advancer (esp. on penalties)
                updated  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reminder_log (
                key   TEXT PRIMARY KEY,   -- e.g. 'rolling:2026-06-13', 'deadline:1h'
                sent  INTEGER NOT NULL
            );
            """
        )
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(results)")]
        if "winner" not in cols:
            conn.execute("ALTER TABLE results ADD COLUMN winner TEXT")
        lcols = [r["name"] for r in conn.execute("PRAGMA table_info(leagues)")]
        if "logo" not in lcols:
            conn.execute("ALTER TABLE leagues ADD COLUMN logo TEXT NOT NULL DEFAULT ''")
        if "sponsors" not in lcols:
            conn.execute("ALTER TABLE leagues ADD COLUMN sponsors TEXT NOT NULL DEFAULT '[]'")


# --------------------------------------------------------------- users
def create_user(email, display_name, password_hash, verified, verify_token, created):
    """Insert a user. Returns id, or None if the email already exists."""
    with _lock, _conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users(email,display_name,password_hash,verified,verify_token,created)"
                " VALUES(?,?,?,?,?,?)",
                (email.lower(), display_name, password_hash,
                 1 if verified else 0, verify_token, created),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None


def get_user_by_email(email):
    with _conn() as conn:
        r = conn.execute("SELECT * FROM users WHERE email=?", (email.lower(),)).fetchone()
    return dict(r) if r else None


def get_user_by_id(uid):
    with _conn() as conn:
        r = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return dict(r) if r else None


def verify_token(token):
    """Mark verified for a matching token. Returns the user id, or None."""
    if not token:
        return None
    with _lock, _conn() as conn:
        r = conn.execute("SELECT id FROM users WHERE verify_token=?", (token,)).fetchone()
        if not r:
            return None
        conn.execute(
            "UPDATE users SET verified=1, verify_token=NULL WHERE id=?", (r["id"],)
        )
        return r["id"]


# --------------------------------------------------------------- predictions
def save_prediction(user_id, state, summary, updated):
    with _lock, _conn() as conn:
        conn.execute(
            """INSERT INTO predictions(user_id,state,summary,updated)
               VALUES(?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                   state=excluded.state, summary=excluded.summary,
                   updated=excluded.updated""",
            (user_id, json.dumps(state), json.dumps(summary), updated),
        )


def get_prediction(user_id):
    with _conn() as conn:
        r = conn.execute(
            "SELECT state,summary,updated FROM predictions WHERE user_id=?", (user_id,)
        ).fetchone()
    if not r:
        return None
    return {"state": json.loads(r["state"]), "summary": json.loads(r["summary"]),
            "updated": r["updated"]}


# --------------------------------------------------------------- leagues
def code_exists(code):
    with _conn() as conn:
        return conn.execute(
            "SELECT 1 FROM leagues WHERE code=?", (code,)
        ).fetchone() is not None


def create_league(code, name, owner_id, created):
    with _lock, _conn() as conn:
        cur = conn.execute(
            "INSERT INTO leagues(code,name,owner_id,created) VALUES(?,?,?,?)",
            (code, name, owner_id, created),
        )
        lid = cur.lastrowid
        conn.execute(
            "INSERT OR IGNORE INTO league_members(league_id,user_id,joined) VALUES(?,?,?)",
            (lid, owner_id, created),
        )
        return lid


def get_league_by_code(code):
    with _conn() as conn:
        r = conn.execute("SELECT * FROM leagues WHERE code=?", (code.upper(),)).fetchone()
    return dict(r) if r else None


def add_member(league_id, user_id, joined):
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO league_members(league_id,user_id,joined) VALUES(?,?,?)",
            (league_id, user_id, joined),
        )


def is_member(league_id, user_id):
    with _conn() as conn:
        return conn.execute(
            "SELECT 1 FROM league_members WHERE league_id=? AND user_id=?",
            (league_id, user_id),
        ).fetchone() is not None


def remove_member(league_id, user_id):
    with _lock, _conn() as conn:
        conn.execute(
            "DELETE FROM league_members WHERE league_id=? AND user_id=?",
            (league_id, user_id),
        )


def delete_league(league_id):
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM leagues WHERE id=?", (league_id,))


def list_user_leagues(user_id):
    """Leagues the user belongs to, with member counts."""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT l.id, l.code, l.name, l.owner_id, l.created, l.logo,
                      (SELECT COUNT(*) FROM league_members m2 WHERE m2.league_id=l.id) AS members
               FROM leagues l
               JOIN league_members m ON m.league_id = l.id
               WHERE m.user_id = ?
               ORDER BY l.created DESC""",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_league_name(code, name):
    with _lock, _conn() as conn:
        conn.execute("UPDATE leagues SET name=? WHERE code=?", (name, code.upper()))


def update_league_branding(code, name, logo, sponsors_json):
    with _lock, _conn() as conn:
        conn.execute("UPDATE leagues SET name=?, logo=?, sponsors=? WHERE code=?",
                     (name, logo, sponsors_json, code.upper()))


# --------------------------------------------------------------- admin
def list_all_leagues():
    with _conn() as conn:
        rows = conn.execute(
            """SELECT l.id, l.code, l.name, l.created, l.owner_id,
                      u.display_name AS owner_name,
                      (SELECT COUNT(*) FROM league_members m WHERE m.league_id=l.id) AS members
               FROM leagues l JOIN users u ON u.id = l.owner_id
               ORDER BY l.created DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def list_all_users():
    with _conn() as conn:
        rows = conn.execute(
            """SELECT u.id, u.email, u.display_name, u.verified, u.created,
                      (SELECT COUNT(*) FROM league_members m WHERE m.user_id=u.id) AS leagues,
                      (SELECT COUNT(*) FROM predictions p WHERE p.user_id=u.id) AS has_pred
               FROM users u ORDER BY u.created DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def set_verified(user_id):
    with _lock, _conn() as conn:
        conn.execute("UPDATE users SET verified=1, verify_token=NULL WHERE id=?", (user_id,))


def set_verify_token(user_id, token):
    """Issue a fresh verification token (used to re-send a confirmation email)."""
    with _lock, _conn() as conn:
        conn.execute("UPDATE users SET verify_token=? WHERE id=?", (token, user_id))


def list_verified_users():
    """Email + name for every confirmed account (for reminder emails)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, email, display_name FROM users WHERE verified=1"
        ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------- reminder dedupe
def reminder_sent(key):
    with _conn() as conn:
        return conn.execute(
            "SELECT 1 FROM reminder_log WHERE key=?", (key,)
        ).fetchone() is not None


def mark_reminder_sent(key, when):
    with _lock, _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO reminder_log(key, sent) VALUES(?,?)", (key, when)
        )


def delete_user(user_id):
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))


# --------------------------------------------------------------- live predictions
def save_live(user_id, scores, updated):
    with _lock, _conn() as conn:
        conn.execute(
            """INSERT INTO live_predictions(user_id,scores,updated) VALUES(?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET scores=excluded.scores, updated=excluded.updated""",
            (user_id, json.dumps(scores), updated),
        )


def get_live(user_id):
    with _conn() as conn:
        r = conn.execute(
            "SELECT scores FROM live_predictions WHERE user_id=?", (user_id,)
        ).fetchone()
    return json.loads(r["scores"]) if r else {}


def get_league_member_live(league_id):
    """Map user_id -> live scores dict for everyone in the league."""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT m.user_id, l.scores AS scores
               FROM league_members m
               LEFT JOIN live_predictions l ON l.user_id = m.user_id
               WHERE m.league_id = ?""",
            (league_id,),
        ).fetchall()
    return {r["user_id"]: (json.loads(r["scores"]) if r["scores"] else {}) for r in rows}


def save_live_ko(user_id, scores, updated):
    with _lock, _conn() as conn:
        conn.execute(
            """INSERT INTO live_ko_predictions(user_id,scores,updated) VALUES(?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET scores=excluded.scores, updated=excluded.updated""",
            (user_id, json.dumps(scores), updated),
        )


def get_live_ko(user_id):
    with _conn() as conn:
        r = conn.execute(
            "SELECT scores FROM live_ko_predictions WHERE user_id=?", (user_id,)
        ).fetchone()
    return json.loads(r["scores"]) if r else {}


def get_league_member_live_ko(league_id):
    with _conn() as conn:
        rows = conn.execute(
            """SELECT m.user_id, l.scores AS scores
               FROM league_members m
               LEFT JOIN live_ko_predictions l ON l.user_id = m.user_id
               WHERE m.league_id = ?""",
            (league_id,),
        ).fetchall()
    return {r["user_id"]: (json.loads(r["scores"]) if r["scores"] else {}) for r in rows}


# --------------------------------------------------------------- results
def upsert_result(match_id, home, away, status, scorers, updated, winner=None):
    with _lock, _conn() as conn:
        conn.execute(
            """INSERT INTO results(match_id,home,away,status,scorers,winner,updated)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(match_id) DO UPDATE SET
                   home=excluded.home, away=excluded.away, status=excluded.status,
                   scorers=excluded.scorers, winner=excluded.winner, updated=excluded.updated""",
            (match_id, home, away, status, json.dumps(scorers), winner, updated),
        )


def delete_result(match_id):
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM results WHERE match_id=?", (match_id,))


def get_all_results():
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM results").fetchall()
    out = {}
    for r in rows:
        out[r["match_id"]] = {
            "home": r["home"], "away": r["away"], "status": r["status"],
            "scorers": json.loads(r["scorers"] or "{}"),
            "winner": r["winner"], "updated": r["updated"],
        }
    return out


def get_league_member_states(league_id):
    """Members with their full prediction state (for points calculation)."""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT u.id, u.display_name, p.state AS state
               FROM league_members m
               JOIN users u ON u.id = m.user_id
               LEFT JOIN predictions p ON p.user_id = u.id
               WHERE m.league_id = ?""",
            (league_id,),
        ).fetchall()
    out = []
    for r in rows:
        out.append({
            "userId": r["id"], "displayName": r["display_name"],
            "state": json.loads(r["state"]) if r["state"] else None,
        })
    return out


def league_members(league_id):
    """Members of a league with their prediction summary (no email leaked)."""
    with _conn() as conn:
        rows = conn.execute(
            """SELECT u.id, u.display_name, m.joined,
                      p.summary AS summary, p.updated AS pred_updated
               FROM league_members m
               JOIN users u ON u.id = m.user_id
               LEFT JOIN predictions p ON p.user_id = u.id
               WHERE m.league_id = ?
               ORDER BY u.display_name COLLATE NOCASE""",
            (league_id,),
        ).fetchall()
    out = []
    for r in rows:
        out.append({
            "userId": r["id"],
            "displayName": r["display_name"],
            "joined": r["joined"],
            "summary": json.loads(r["summary"]) if r["summary"] else None,
            "predUpdated": r["pred_updated"],
        })
    return out
