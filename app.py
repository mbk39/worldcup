"""2026 World Cup Predictor — Flask backend.

Accounts (email + password, optional email verification), user-scoped
predictions, and private leagues with join codes.

Public:
  GET  /                      -> single-page UI
  GET  /api/data              -> static tournament data
  POST /api/simulate          -> resolve standings + bracket from posted picks
Auth:
  GET  /api/auth/me           -> current user or null
  POST /api/auth/signup       -> create account
  POST /api/auth/login        -> log in
  POST /api/auth/logout       -> log out
  GET  /verify?token=...      -> confirm email
Prediction (login required):
  GET/POST /api/prediction    -> load / save the logged-in user's bracket
Leagues (login required):
  GET  /api/leagues           -> my leagues
  POST /api/leagues           -> create (returns join code)
  POST /api/leagues/join      -> join by code
  GET  /api/leagues/<code>    -> league detail + members' predictions
  POST /api/leagues/<code>/leave
  DELETE /api/leagues/<code>  -> delete (owner only)
"""

import datetime
import json
import os
import re
import secrets
import time
from functools import wraps

from flask import (
    Flask, jsonify, request, render_template, session, redirect, url_for, abort,
    send_from_directory,
)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import emailer
import points as scoring
import schedule
from data import (
    GROUPS, FLAGS, FLAG_CODES, CODES3, build_group_fixtures,
    R32, R16, QF, SF, FINAL,
)
import engine
from engine import simulate

app = Flask(__name__)
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,  # 30 days
)

db.init_db()
_GROUP_FIXTURES = build_group_fixtures()
_FIXTURE_IDS = [f["id"] for f in _GROUP_FIXTURES]
_KO_IDS = [f"K-{n}" for n in (list(R32) + list(R16) + list(QF) + list(SF) + list(FINAL) + [103])]
_VALID_MATCH_IDS = set(_FIXTURE_IDS) | set(_KO_IDS)

_BST = datetime.timezone(datetime.timedelta(hours=1))   # UK summer time


def _kickoff_epoch(date_str, time_str):
    dt = datetime.datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
    return int(dt.replace(tzinfo=_BST).timestamp())


# match_id -> kickoff (unix seconds). Group fixtures + knockout matches.
_KICKOFFS = {f["id"]: _kickoff_epoch(f["date"], f["time"])
             for f in _GROUP_FIXTURES if f.get("date") and f.get("time")}
for _num, _raw in schedule.KO_KICKOFFS_UTC.items():
    _KICKOFFS[f"K-{_num}"] = schedule.ko_info(_num)["epoch"]
# Tournament bracket locks at the first match overall (the opening group game).
_TOURNAMENT_LOCK = min(
    f["id"] and _kickoff_epoch(f["date"], f["time"])
    for f in _GROUP_FIXTURES if f.get("date") and f.get("time")
)


def _now():
    """Current unix time, overridable with WC_NOW for testing locks."""
    override = os.environ.get("WC_NOW")
    return int(override) if override else int(time.time())


def _locked_match_ids(now=None):
    now = _now() if now is None else now
    return {mid for mid, ko in _KICKOFFS.items() if now >= ko}


def _tournament_locked(now=None):
    return (_now() if now is None else now) >= _TOURNAMENT_LOCK
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_ADMIN_EMAILS = {
    e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()
}
_FEED_TOKEN = os.environ.get("FEED_TOKEN", "")


def _parse_score(v):
    if v in (None, ""):
        return None
    try:
        return max(0, min(99, int(v)))
    except (TypeError, ValueError):
        return None
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous chars (0/O/1/I)


# --------------------------------------------------------------- secret key
def _load_secret_key():
    env = os.environ.get("WC_SECRET")
    if env:
        return env
    path = os.path.join(app.root_path, "secret_key.txt")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    key = secrets.token_hex(32)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(key)
    except OSError:
        pass
    return key


app.secret_key = _load_secret_key()

# Uploaded league logos / sponsor images.
UPLOAD_DIR = os.environ.get("WC_UPLOADS", os.path.join(app.root_path, "uploads"))
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024  # 3 MB per upload
_ALLOWED_IMG = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


# --------------------------------------------------------------- helpers
def current_user():
    uid = session.get("uid")
    return db.get_user_by_id(uid) if uid else None


def is_admin(u):
    return bool(u) and u["email"].lower() in _ADMIN_EMAILS


def public_user(u):
    if not u:
        return None
    return {"id": u["id"], "email": u["email"],
            "displayName": u["display_name"], "verified": bool(u["verified"]),
            "isAdmin": is_admin(u)}


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            return jsonify({"error": "Please log in."}), 401
        return fn(u, *args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            return jsonify({"error": "Please log in."}), 401
        if not is_admin(u):
            return jsonify({"error": "Admin access required."}), 403
        return fn(u, *args, **kwargs)
    return wrapper


def _gen_league_code():
    for _ in range(50):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if not db.code_exists(code):
            return code
    raise RuntimeError("could not allocate a unique league code")


def _summarize(state):
    res = simulate(state)
    b = res["bracket"]
    final = b.get(104, {})
    finalists = [final.get("teamA"), final.get("teamB")]
    champion = res["champion"]
    runner_up = None
    if champion and champion in finalists:
        runner_up = finalists[1] if finalists[0] == champion else finalists[0]
    semifinalists = []
    for mid in (101, 102):
        m = b.get(mid, {})
        semifinalists += [m.get("teamA"), m.get("teamB")]

    gs = state.get("groupScores", {}) or {}
    done = sum(
        1 for fid in _FIXTURE_IDS
        if isinstance((gs.get(fid) or {}).get("home"), int)
        and isinstance((gs.get(fid) or {}).get("away"), int)
    )
    return {
        "champion": champion,
        "runnerUp": runner_up,
        "finalists": [t for t in finalists if t],
        "semifinalists": [t for t in semifinalists if t],
        "groupsComplete": res["groupsComplete"],
        "predicted": done,
        "total": len(_FIXTURE_IDS),
    }


def _bracket_template():
    def label(ref):
        t = ref["type"]
        if t == "winner":
            return f"Winner {ref['group']}"
        if t == "runner":
            return f"Runner-up {ref['group']}"
        if t == "third":
            return "3rd " + "/".join(ref["groups"])
        if t == "match":
            return f"W{ref['match']}"
        return "?"

    rounds = []
    specs = [
        ("Round of 32", R32, True), ("Round of 16", R16, False),
        ("Quarter-finals", QF, False), ("Semi-finals", SF, False),
        ("Final", FINAL, False),
    ]
    for name, table, is_r32 in specs:
        matches = []
        for mid in sorted(table):
            sides = table[mid]
            if is_r32:
                a_lbl, b_lbl = label(sides[0]), label(sides[1])
            else:
                a_lbl, b_lbl = f"W{sides[0]}", f"W{sides[1]}"
            ko = schedule.ko_info(mid) or {}
            matches.append({"id": mid, "labelA": a_lbl, "labelB": b_lbl,
                            "date": ko.get("date"), "time": ko.get("time"),
                            "venue": ko.get("venue"), "city": ko.get("city"),
                            "localDate": ko.get("localDate"), "localTime": ko.get("localTime")})
        rounds.append({"name": name, "matches": matches})
    # Third-place play-off (match 103) — its own one-match round.
    ko103 = schedule.ko_info(103) or {}
    rounds.append({"name": "Third place", "matches": [{
        "id": 103, "labelA": "Loser SF1", "labelB": "Loser SF2",
        "date": ko103.get("date"), "time": ko103.get("time"),
        "venue": ko103.get("venue"), "city": ko103.get("city"),
        "localDate": ko103.get("localDate"), "localTime": ko103.get("localTime")}]})
    return rounds


# --------------------------------------------------------------- public
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/join/<code>")
def join_link(code):
    return redirect("/?join=" + re.sub(r"[^A-Za-z0-9]", "", code).upper()[:6])


@app.route("/uploads/<path:name>")
def serve_upload(name):
    return send_from_directory(UPLOAD_DIR, name)


@app.route("/api/upload", methods=["POST"])
@login_required
def api_upload(user):
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "No file provided."}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in _ALLOWED_IMG:
        return jsonify({"error": "Only PNG, JPG, GIF or WEBP images are allowed."}), 400
    name = secrets.token_hex(10) + ext
    f.save(os.path.join(UPLOAD_DIR, name))
    return jsonify({"ok": True, "url": "/uploads/" + name})


@app.route("/api/data")
def api_data():
    return jsonify({
        "groups": GROUPS,
        "flags": FLAGS,
        "flagCodes": FLAG_CODES,
        "codes3": CODES3,
        "fixtures": build_group_fixtures(),
        "bracket": _bracket_template(),
        "venues": schedule.VENUES,
    })


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    state = request.get_json(force=True, silent=True) or {}
    return jsonify(simulate(state))


@app.route("/api/locks")
def api_locks():
    now = _now()
    return jsonify({
        "now": now,
        "tournamentLocked": now >= _TOURNAMENT_LOCK,
        "tournamentLockTime": _TOURNAMENT_LOCK,
        "lockedMatches": sorted(_locked_match_ids(now)),
    })


# --------------------------------------------------------------- auth
@app.route("/api/auth/me")
def api_me():
    return jsonify({"user": public_user(current_user()),
                    "verificationEnforced": emailer.is_configured()})


@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    body = request.get_json(force=True, silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    name = (body.get("displayName") or "").strip()
    password = body.get("password") or ""

    if not _EMAIL_RE.match(email):
        return jsonify({"error": "Enter a valid email address."}), 400
    if not (1 <= len(name) <= 40):
        return jsonify({"error": "Display name must be 1–40 characters."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400
    if db.get_user_by_email(email):
        return jsonify({"error": "An account with that email already exists."}), 409

    enforce = emailer.is_configured()
    token = secrets.token_urlsafe(24)
    uid = db.create_user(
        email, name, generate_password_hash(password),
        verified=not enforce, verify_token=(token if enforce else None),
        created=int(time.time()),
    )
    if uid is None:
        return jsonify({"error": "An account with that email already exists."}), 409

    if enforce:
        verify_url = url_for("verify_email", token=token, _external=True)
        emailer.send_verification(email, name, verify_url)
        return jsonify({"needVerify": True,
                        "message": "Check your email for a confirmation link."})

    # Dev mode (no SMTP configured): auto-verified, log in immediately.
    session.permanent = True
    session["uid"] = uid
    return jsonify({"user": public_user(db.get_user_by_id(uid)), "devAutoVerified": True})


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    body = request.get_json(force=True, silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    u = db.get_user_by_email(email)
    if not u or not check_password_hash(u["password_hash"], password):
        return jsonify({"error": "Incorrect email or password."}), 401
    if emailer.is_configured() and not u["verified"]:
        return jsonify({"error": "Please confirm your email first — check your inbox.",
                        "needVerify": True}), 403
    session.permanent = True
    session["uid"] = u["id"]
    return jsonify({"user": public_user(u)})


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/verify")
def verify_email():
    token = request.args.get("token", "")
    uid = db.verify_token(token)
    if uid:
        session.permanent = True
        session["uid"] = uid
        return redirect("/?verified=1")
    return redirect("/?verified=0")


# --------------------------------------------------------------- prediction
@app.route("/api/prediction", methods=["GET"])
@login_required
def api_get_prediction(user):
    rec = db.get_prediction(user["id"])
    return jsonify(rec or {"state": None})


@app.route("/api/prediction", methods=["POST"])
@login_required
def api_save_prediction(user):
    if _tournament_locked():
        return jsonify({"error": "Tournament predictions locked — the tournament has started."}), 403
    body = request.get_json(force=True, silent=True) or {}
    state = body.get("state") or {}
    clean = {
        "groupScores": state.get("groupScores", {}) or {},
        "koPicks": state.get("koPicks", {}) or {},
    }
    summary = _summarize(clean)
    db.save_prediction(user["id"], clean, summary, int(time.time()))
    return jsonify({"ok": True, "summary": summary})


# --------------------------------------------------------------- results & points
@app.route("/api/results")
def api_results():
    return jsonify(db.get_all_results())


@app.route("/api/standings")
def api_standings():
    """Actual group standings computed from real results."""
    gs = {mid: {"home": r["home"], "away": r["away"]}
          for mid, r in db.get_all_results().items()
          if mid.startswith("G-") and isinstance(r.get("home"), int)
          and isinstance(r.get("away"), int)}
    standings = engine.compute_all_groups(gs)
    return jsonify({
        l: {"complete": d["complete"],
            "rows": [{**row, "pos": i + 1} for i, row in enumerate(d["rows"])]}
        for l, d in standings.items()
    })


@app.route("/api/me/points")
@login_required
def api_my_points(user):
    results = db.get_all_results()
    rec = db.get_prediction(user["id"])
    tournament = scoring.compute_tournament_points(rec["state"] if rec else None, results)
    group = scoring.compute_points({"groupScores": db.get_live(user["id"])}, results)
    knockout = scoring.compute_knockout_live_points(db.get_live_ko(user["id"]), results)
    return jsonify({"tournament": tournament, "group": group, "knockout": knockout})


@app.route("/api/bracket/actual")
def api_actual_bracket():
    results = db.get_all_results()
    bracket = scoring.resolve_actual_bracket(results)
    group_done = sum(1 for mid, r in results.items()
                     if mid.startswith("G-") and isinstance(r.get("home"), int))
    return jsonify({
        "bracket": {str(k): v for k, v in bracket.items()},
        "groupComplete": group_done >= len(_FIXTURE_IDS),
    })


@app.route("/api/live", methods=["GET"])
@login_required
def api_get_live(user):
    return jsonify({"scores": db.get_live(user["id"])})


@app.route("/api/live", methods=["POST"])
@login_required
def api_save_live(user):
    body = request.get_json(force=True, silent=True) or {}
    incoming = body.get("scores") or {}
    locked = _locked_match_ids()
    existing = db.get_live(user["id"])
    rejected = 0
    for mid, sc in incoming.items():
        if mid not in _KICKOFFS:        # group-stage matches only (for now)
            continue
        if mid in locked:               # match already kicked off — can't change
            rejected += 1
            continue
        h, a = _parse_score((sc or {}).get("home")), _parse_score((sc or {}).get("away"))
        if h is None and a is None:
            existing.pop(mid, None)
        else:
            existing[mid] = {"home": h, "away": a}
    db.save_live(user["id"], existing, int(time.time()))
    return jsonify({"ok": True, "scores": existing, "rejected": rejected})


@app.route("/api/live/ko", methods=["GET"])
@login_required
def api_get_live_ko(user):
    return jsonify({"scores": db.get_live_ko(user["id"])})


@app.route("/api/live/ko", methods=["POST"])
@login_required
def api_save_live_ko(user):
    body = request.get_json(force=True, silent=True) or {}
    incoming = body.get("scores") or {}
    locked = _locked_match_ids()
    existing = db.get_live_ko(user["id"])
    rejected = 0
    for mid, sc in incoming.items():
        if not mid.startswith("K-") or mid not in _KICKOFFS:
            continue
        if mid in locked:
            rejected += 1
            continue
        h, a = _parse_score((sc or {}).get("home")), _parse_score((sc or {}).get("away"))
        adv = ((sc or {}).get("adv") or "").strip()[:40] or None
        if h is None and a is None:
            existing.pop(mid, None)
        else:
            existing[mid] = {"home": h, "away": a, "adv": adv}
    db.save_live_ko(user["id"], existing, int(time.time()))
    return jsonify({"ok": True, "scores": existing, "rejected": rejected})


@app.route("/api/feed/results", methods=["POST"])
def api_feed_results():
    """Machine ingest for the external feeder (GitHub Actions). Token-auth via
    the X-Feed-Token header; disabled unless FEED_TOKEN is configured."""
    if not _FEED_TOKEN:
        return jsonify({"error": "Feed disabled (no FEED_TOKEN configured)."}), 503
    token = request.headers.get("X-Feed-Token", "")
    if not secrets.compare_digest(token, _FEED_TOKEN):
        return jsonify({"error": "Invalid feed token."}), 403

    body = request.get_json(force=True, silent=True) or {}
    items = body.get("results") or []
    now = int(time.time())
    updated = 0
    for it in items:
        mid = it.get("matchId")
        if mid not in _VALID_MATCH_IDS:
            continue
        status = it.get("status") if it.get("status") in ("scheduled", "live", "ft") else "live"
        db.upsert_result(mid, _parse_score(it.get("home")), _parse_score(it.get("away")),
                         status, _clean_scorers(it.get("scorers")), now)
        updated += 1
    return jsonify({"ok": True, "updated": updated})


# --------------------------------------------------------------- leagues
def _league_public(lg, user_id):
    return {"code": lg["code"], "name": lg["name"],
            "members": lg.get("members"),
            "isOwner": lg["owner_id"] == user_id}


@app.route("/api/leagues", methods=["GET"])
@login_required
def api_list_leagues(user):
    out = []
    for lg in db.list_user_leagues(user["id"]):
        out.append({"code": lg["code"], "name": lg["name"], "logo": lg.get("logo") or "",
                    "members": lg["members"], "isOwner": lg["owner_id"] == user["id"]})
    return jsonify(out)


@app.route("/api/leagues", methods=["POST"])
@login_required
def api_create_league(user):
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not (1 <= len(name) <= 50):
        return jsonify({"error": "League name must be 1–50 characters."}), 400
    code = _gen_league_code()
    db.create_league(code, name, user["id"], int(time.time()))
    return jsonify({"ok": True, "code": code, "name": name})


@app.route("/api/leagues/join", methods=["POST"])
@login_required
def api_join_league(user):
    body = request.get_json(force=True, silent=True) or {}
    code = (body.get("code") or "").strip().upper()
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    db.add_member(lg["id"], user["id"], int(time.time()))
    return jsonify({"ok": True, "code": lg["code"], "name": lg["name"]})


@app.route("/api/leagues/<code>", methods=["GET"])
@login_required
def api_league_detail(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    if not db.is_member(lg["id"], user["id"]):
        return jsonify({"error": "You're not a member of this league."}), 403
    results = db.get_all_results()
    members = db.league_members(lg["id"])
    tour_states = {m["userId"]: m["state"] for m in db.get_league_member_states(lg["id"])}
    live_states = db.get_league_member_live(lg["id"])
    ko_states = db.get_league_member_live_ko(lg["id"])
    for m in members:
        uid = m["userId"]
        t = scoring.compute_tournament_points(tour_states.get(uid), results)["total"]
        g = scoring.compute_points({"groupScores": live_states.get(uid, {})}, results)["total"]
        k = scoring.compute_knockout_live_points(ko_states.get(uid, {}), results)["total"]
        m["points"] = {"tournament": t, "group": g, "knockout": k}
    members.sort(key=lambda m: (-(m["points"]["tournament"] + m["points"]["group"]
                                  + m["points"]["knockout"]), m["displayName"].lower()))
    group_done = sum(1 for mid, r in results.items()
                     if mid.startswith("G-") and isinstance(r.get("home"), int))
    return jsonify({
        "code": lg["code"], "name": lg["name"],
        "isOwner": lg["owner_id"] == user["id"],
        "logo": lg["logo"] or "",
        "sponsors": json.loads(lg["sponsors"] or "[]"),
        "members": members,
        "resultsScored": group_done,
        "knockoutReady": group_done >= len(_FIXTURE_IDS),
    })


def _clean_img_url(v):
    v = (v or "").strip()
    return v[:600] if (re.match(r"^https?://", v) or v.startswith("/uploads/")) else ""


@app.route("/api/leagues/<code>/edit", methods=["POST"])
@login_required
def api_edit_league(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    if lg["owner_id"] != user["id"]:
        return jsonify({"error": "Only the owner can edit this league."}), 403
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()[:50] or lg["name"]
    logo = _clean_img_url(body.get("logo"))
    sponsors = []
    for s in (body.get("sponsors") or [])[:12]:
        img = _clean_img_url((s or {}).get("img"))
        if not img:
            continue
        sponsors.append({"img": img, "link": _clean_img_url(s.get("link")),
                         "name": (s.get("name") or "").strip()[:40]})
    db.update_league_branding(lg["code"], name, logo, json.dumps(sponsors))
    return jsonify({"ok": True})


@app.route("/api/leagues/<code>/member/<int:uid>")
@login_required
def api_league_member(user, code, uid):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    if not db.is_member(lg["id"], user["id"]) or not db.is_member(lg["id"], uid):
        return jsonify({"error": "Not allowed."}), 403
    target = db.get_user_by_id(uid)
    if not target:
        return jsonify({"error": "Not found."}), 404

    locked = _locked_match_ids()
    # Tournament bracket only becomes visible once it locks (first kick-off).
    tournament = None
    if _tournament_locked():
        rec = db.get_prediction(uid)
        tournament = rec["state"] if rec else {"groupScores": {}, "koPicks": {}}
    # Per-match picks only visible for matches that have kicked off.
    group = {mid: sc for mid, sc in db.get_live(uid).items() if mid in locked}
    knockout = {mid: sc for mid, sc in db.get_live_ko(uid).items() if mid in locked}
    return jsonify({"displayName": target["display_name"], "isYou": uid == user["id"],
                    "tournament": tournament, "group": group, "knockout": knockout})


@app.route("/api/leagues/<code>/leave", methods=["POST"])
@login_required
def api_leave_league(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    if lg["owner_id"] == user["id"]:
        return jsonify({"error": "The owner can't leave; delete the league instead."}), 400
    db.remove_member(lg["id"], user["id"])
    return jsonify({"ok": True})


@app.route("/api/leagues/<code>", methods=["DELETE"])
@login_required
def api_delete_league(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "No league found with that code."}), 404
    if lg["owner_id"] != user["id"]:
        return jsonify({"error": "Only the owner can delete this league."}), 403
    db.delete_league(lg["id"])
    return jsonify({"ok": True})


# --------------------------------------------------------------- admin
@app.route("/api/admin/leagues", methods=["GET"])
@admin_required
def api_admin_leagues(user):
    return jsonify(db.list_all_leagues())


@app.route("/api/admin/leagues/<code>", methods=["GET"])
@admin_required
def api_admin_league_detail(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "Not found."}), 404
    return jsonify({"code": lg["code"], "name": lg["name"],
                    "members": db.league_members(lg["id"])})


@app.route("/api/admin/leagues/<code>", methods=["PATCH"])
@admin_required
def api_admin_rename_league(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "Not found."}), 404
    name = ((request.get_json(force=True, silent=True) or {}).get("name") or "").strip()
    if not (1 <= len(name) <= 50):
        return jsonify({"error": "Name must be 1–50 characters."}), 400
    db.update_league_name(lg["code"], name)
    return jsonify({"ok": True, "name": name})


@app.route("/api/admin/leagues/<code>", methods=["DELETE"])
@admin_required
def api_admin_delete_league(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "Not found."}), 404
    db.delete_league(lg["id"])
    return jsonify({"ok": True})


@app.route("/api/admin/leagues/<code>/remove-member", methods=["POST"])
@admin_required
def api_admin_remove_member(user, code):
    lg = db.get_league_by_code(code)
    if not lg:
        return jsonify({"error": "Not found."}), 404
    uid = (request.get_json(force=True, silent=True) or {}).get("userId")
    if not uid:
        return jsonify({"error": "userId required."}), 400
    db.remove_member(lg["id"], uid)
    return jsonify({"ok": True})


def _clean_scorers(raw):
    out = {"home": [], "away": []}
    if isinstance(raw, dict):
        for side in ("home", "away"):
            vals = raw.get(side) or []
            if isinstance(vals, str):
                vals = [v.strip() for v in vals.split(",")]
            out[side] = [str(v).strip()[:60] for v in vals if str(v).strip()][:15]
    return out


@app.route("/api/admin/results/<match_id>", methods=["PUT"])
@admin_required
def api_admin_put_result(user, match_id):
    if match_id not in _VALID_MATCH_IDS:
        return jsonify({"error": "Unknown match id."}), 404
    body = request.get_json(force=True, silent=True) or {}

    def _score(v):
        if v in (None, ""):
            return None
        try:
            return max(0, min(99, int(v)))
        except (TypeError, ValueError):
            return None

    home, away = _score(body.get("home")), _score(body.get("away"))
    status = body.get("status") if body.get("status") in ("scheduled", "live", "ft") else "scheduled"
    scorers = _clean_scorers(body.get("scorers"))
    winner = (body.get("winner") or "").strip()[:40] or None
    db.upsert_result(match_id, home, away, status, scorers, int(time.time()), winner)
    return jsonify({"ok": True})


@app.route("/api/admin/results/<match_id>", methods=["DELETE"])
@admin_required
def api_admin_delete_result(user, match_id):
    db.delete_result(match_id)
    return jsonify({"ok": True})


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def api_admin_users(user):
    return jsonify(db.list_all_users())


@app.route("/api/admin/users/<int:uid>/verify", methods=["POST"])
@admin_required
def api_admin_verify_user(user, uid):
    if not db.get_user_by_id(uid):
        return jsonify({"error": "Not found."}), 404
    db.set_verified(uid)
    return jsonify({"ok": True})


@app.route("/api/admin/users/<int:uid>", methods=["DELETE"])
@admin_required
def api_admin_delete_user(user, uid):
    if not db.get_user_by_id(uid):
        return jsonify({"error": "Not found."}), 404
    db.delete_user(uid)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
