"""2026 World Cup Predictor — Flask backend.

Serves the single-page UI and exposes:
  GET  /api/data            -> static tournament data (groups, fixtures, bracket)
  POST /api/simulate        -> resolves standings + bracket from user picks
  GET  /api/predictions     -> list everyone's saved predictions (summaries)
  POST /api/predictions     -> save/update a named prediction
  GET  /api/predictions/<n> -> load one person's full prediction
  DELETE /api/predictions/<n> -> remove a prediction
"""

import time

from flask import Flask, jsonify, request, render_template

from werkzeug.security import check_password_hash, generate_password_hash

import store
from data import (
    GROUPS, FLAGS, FLAG_CODES, build_group_fixtures,
    R32, R16, QF, SF, FINAL,
)
from engine import simulate

app = Flask(__name__)

store.init_db()
_FIXTURE_IDS = [f["id"] for f in build_group_fixtures()]


# --------------------------------------------------------------- persistence
def _summarize(state):
    """Derive a compact summary (champion, finalists, etc.) from a prediction."""
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
    done = 0
    for fid in _FIXTURE_IDS:
        s = gs.get(fid) or {}
        if isinstance(s.get("home"), int) and isinstance(s.get("away"), int):
            done += 1

    return {
        "champion": champion,
        "runnerUp": runner_up,
        "finalists": [t for t in finalists if t],
        "semifinalists": [t for t in semifinalists if t],
        "groupsComplete": res["groupsComplete"],
        "predicted": done,
        "total": len(_FIXTURE_IDS),
    }


# --------------------------------------------------------------- bracket meta
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
            matches.append({"id": mid, "labelA": a_lbl, "labelB": b_lbl})
        rounds.append({"name": name, "matches": matches})
    return rounds


# --------------------------------------------------------------- routes
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/data")
def api_data():
    return jsonify({
        "groups": GROUPS,
        "flags": FLAGS,
        "flagCodes": FLAG_CODES,
        "fixtures": build_group_fixtures(),
        "bracket": _bracket_template(),
    })


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    state = request.get_json(force=True, silent=True) or {}
    return jsonify(simulate(state))


@app.route("/api/predictions", methods=["GET"])
def api_list_predictions():
    return jsonify(store.list_all())


@app.route("/api/predictions", methods=["POST"])
def api_save_prediction():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    pin = (body.get("pin") or "").strip()
    state = body.get("state") or {}
    if not name:
        return jsonify({"error": "A name is required."}), 400
    if len(name) > 40:
        return jsonify({"error": "Name too long (max 40 characters)."}), 400
    if not (3 <= len(pin) <= 20):
        return jsonify({"error": "Set a PIN of 3–20 characters."}), 400

    existing_hash = store.get_pin_hash(name)  # None=new, ''=unprotected, else hash
    if existing_hash:
        if not check_password_hash(existing_hash, pin):
            return jsonify({"error": "Wrong PIN — that name is taken by someone else."}), 403

    clean_state = {
        "groupScores": state.get("groupScores", {}) or {},
        "koPicks": state.get("koPicks", {}) or {},
    }
    summary = _summarize(state)
    store.upsert(name, clean_state, summary, int(time.time()),
                 generate_password_hash(pin))
    return jsonify({"ok": True, "name": name, "summary": summary})


@app.route("/api/predictions/<name>", methods=["GET"])
def api_get_prediction(name):
    rec = store.get(name.strip())
    if not rec:
        return jsonify({"error": "Not found."}), 404
    return jsonify(rec)


@app.route("/api/predictions/<name>", methods=["DELETE"])
def api_delete_prediction(name):
    name = name.strip()
    existing_hash = store.get_pin_hash(name)
    if existing_hash is None:
        return jsonify({"error": "Not found."}), 404
    pin = (request.args.get("pin") or "").strip()
    if existing_hash and not check_password_hash(existing_hash, pin):
        return jsonify({"error": "Wrong PIN — cannot delete."}), 403
    store.delete(name)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
