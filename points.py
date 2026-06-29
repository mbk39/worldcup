"""Scoring across three tracks.

  * Group / rolling: 3 for an exact score, 1 for the correct result (W/D/L).
  * Tournament (locked bracket): group points + points for each team correctly
    predicted to REACH each knockout round, plus a champion bonus.
  * Knockout (live): 3 for an exact full-time score, 1 for the correct advancer.

A "result" means the same outcome even if the scoreline differs.
"""

import engine
from data import R16, QF, SF, FINAL

# Points for each of YOUR teams that actually reaches a given knockout round.
KO_ROUND_POINTS = {"Round of 16": 1, "Quarter-finals": 2, "Semi-finals": 3, "Final": 5}
CHAMPION_BONUS = 10


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
    """Group/rolling track: 3 exact / 1 result over group matches with a score.

    Returns {"total", "perMatch", "scored"}.
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


# --------------------------------------------------------------- bracket helpers
def _real_group_scores(results):
    return {mid: {"home": r["home"], "away": r["away"]}
            for mid, r in results.items()
            if mid.startswith("G-") and isinstance(r.get("home"), int)
            and isinstance(r.get("away"), int)}


def _actual_advancers(results):
    """Knockout advancers (by match number) from results' winner field."""
    return {mid[2:]: r["winner"] for mid, r in results.items()
            if mid.startswith("K-") and r.get("winner")}


def resolve_actual_bracket(results):
    gs = _real_group_scores(results)
    standings = engine.compute_all_groups(gs)
    bracket, _, _ = engine.resolve_bracket(standings, gs, _actual_advancers(results))
    return bracket


def _reached_sets(bracket):
    """Teams that are participants in each knockout round's matches."""
    out = {}
    for name, table in (("Round of 16", R16), ("Quarter-finals", QF),
                        ("Semi-finals", SF), ("Final", FINAL)):
        teams = set()
        for mid in table:
            m = bracket.get(mid, {})
            teams.update(t for t in (m.get("teamA"), m.get("teamB")) if t)
        out[name] = teams
    return out


def compute_tournament_ko_points(user_state, results):
    """Points for each of the user's teams that actually reached each KO round."""
    actual = resolve_actual_bracket(results)
    actual_reached = _reached_sets(actual)
    actual_champ = actual.get(104, {}).get("winner")

    gs = (user_state or {}).get("groupScores", {}) or {}
    ko = (user_state or {}).get("koPicks", {}) or {}
    u_bracket, _, _ = engine.resolve_bracket(engine.compute_all_groups(gs), gs, ko)
    u_reached = _reached_sets(u_bracket)
    u_champ = u_bracket.get(104, {}).get("winner")

    breakdown, total = {}, 0
    for rnd, pts in KO_ROUND_POINTS.items():
        hit = len(u_reached[rnd] & actual_reached[rnd])
        breakdown[rnd] = hit * pts
        total += hit * pts
    champ = CHAMPION_BONUS if (u_champ and u_champ == actual_champ) else 0
    breakdown["champion"] = champ
    return {"total": total + champ, "breakdown": breakdown}


def compute_tournament_points(user_state, results):
    """Locked-bracket track: group points + knockout advancer/champion points."""
    g = compute_points(user_state, results)
    ko = compute_tournament_ko_points(user_state, results)
    return {"total": g["total"] + ko["total"], "group": g["total"], "ko": ko["total"],
            "perMatch": g["perMatch"], "koBreakdown": ko["breakdown"]}


# --------------------------------------------------------------- KO bracket track
# Classic bracket scoring: more points the deeper the round.
KO_BRACKET_ROUND_POINTS = {"Round of 32": 1, "Round of 16": 2, "Quarter-finals": 4,
                           "Semi-finals": 8, "Third place": 4, "Final": 16}


def _ko_round_name(mid):
    if 73 <= mid <= 88:
        return "Round of 32"
    if 89 <= mid <= 96:
        return "Round of 16"
    if 97 <= mid <= 100:
        return "Quarter-finals"
    if mid in (101, 102):
        return "Semi-finals"
    if mid == 103:
        return "Third place"
    if mid == 104:
        return "Final"
    return None


def compute_ko_bracket_points(picks, results):
    """Click-winner bracket: award the round's points for each match where the
    user's predicted winner matches the team that actually advanced.

    picks: {match_num(str|int): team}. Returns {total, perMatch}.
    """
    picks = picks or {}
    actual = resolve_actual_bracket(results)   # actual {mid: {teamA,teamB,winner}}
    per, total = {}, 0
    for k, team in picks.items():
        try:
            mid = int(k)
        except (TypeError, ValueError):
            continue
        rnd = _ko_round_name(mid)
        if not rnd:
            continue
        aw = actual.get(mid, {}).get("winner")
        pts = KO_BRACKET_ROUND_POINTS[rnd] if (team and aw and team == aw) else 0
        per[str(mid)] = pts
        total += pts
    return {"total": total, "perMatch": per}


def compute_knockout_live_points(ko_scores, results):
    """Knockout-live track: 3 for exact full-time score, 1 for correct advancer."""
    ko_scores = ko_scores or {}
    per, total = {}, 0
    for mid, r in results.items():
        if not mid.startswith("K-"):
            continue
        if not (isinstance(r.get("home"), int) and isinstance(r.get("away"), int)):
            continue
        pred = ko_scores.get(mid) or {}
        ph, pa = pred.get("home"), pred.get("away")
        pts = 0
        if isinstance(ph, int) and isinstance(pa, int):
            if (ph, pa) == (r["home"], r["away"]):
                pts = 3
            elif r.get("winner") and pred.get("adv") and r["winner"] == pred["adv"]:
                pts = 1
        per[mid] = pts
        total += pts
    return {"total": total, "perMatch": per}
