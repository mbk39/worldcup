"""Scoring: 3 points for an exact score, 1 point for the correct result.

Group stage scoring (knockout scoring is added in a later stage). A "result"
means the same outcome — home win / away win / draw — even if the scoreline
differs.
"""


def _outcome(h, a):
    return (h > a) - (h < a)   # 1 home win, -1 away win, 0 draw


def score_match(pred, actual):
    """pred/actual are (home, away) tuples or None. Returns (points, kind)."""
    if pred is None or actual is None:
        return 0, "none"
    if pred == actual:
        return 3, "exact"
    if _outcome(*pred) == _outcome(*actual):
        return 1, "result"
    return 0, "miss"


def _pred_score(group_scores, mid):
    s = group_scores.get(mid) or {}
    if isinstance(s.get("home"), int) and isinstance(s.get("away"), int):
        return (s["home"], s["away"])
    return None


def compute_points(state, results):
    """Total + per-match points for one prediction state against results.

    Only group matches with a recorded score (status live/ft) are scored.
    Returns {"total": int, "perMatch": {match_id: pts}, "scored": int}.
    """
    group_scores = (state or {}).get("groupScores", {}) or {}
    per = {}
    total = 0
    scored = 0
    for mid, res in results.items():
        if not mid.startswith("G-"):
            continue
        if not isinstance(res.get("home"), int) or not isinstance(res.get("away"), int):
            continue
        scored += 1
        pts, _ = score_match(_pred_score(group_scores, mid), (res["home"], res["away"]))
        per[mid] = pts
        total += pts
    return {"total": total, "perMatch": per, "scored": scored}
