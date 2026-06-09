"""Tournament resolution engine.

Pure functions that take the user's predicted group scores + knockout picks and
return computed standings, qualifiers and a fully-populated knockout bracket.
"""

from data import GROUPS, R32, R16, QF, SF, FINAL, build_group_fixtures

_FIXTURES = build_group_fixtures()
_FIXTURES_BY_GROUP = {}
for f in _FIXTURES:
    _FIXTURES_BY_GROUP.setdefault(f["group"], []).append(f)


def _blank_row(team):
    return {
        "team": team, "played": 0, "won": 0, "drawn": 0, "lost": 0,
        "gf": 0, "ga": 0, "gd": 0, "points": 0,
    }


def _played(score):
    """A match counts only when both integer scores are present."""
    return (
        score is not None
        and isinstance(score.get("home"), int)
        and isinstance(score.get("away"), int)
    )


def compute_group(letter, group_scores):
    """Return (sorted_rows, complete) for one group.

    sorted_rows is ordered 1st..4th. complete is True when all 6 matches scored.
    """
    teams = GROUPS[letter]
    rows = {t: _blank_row(t) for t in teams}
    fixtures = _FIXTURES_BY_GROUP[letter]
    n_played = 0

    for fx in fixtures:
        score = group_scores.get(fx["id"])
        if not _played(score):
            continue
        n_played += 1
        h, a = fx["home"], fx["away"]
        hs, as_ = score["home"], score["away"]
        rh, ra = rows[h], rows[a]
        rh["played"] += 1; ra["played"] += 1
        rh["gf"] += hs; rh["ga"] += as_
        ra["gf"] += as_; ra["ga"] += hs
        if hs > as_:
            rh["won"] += 1; rh["points"] += 3; ra["lost"] += 1
        elif hs < as_:
            ra["won"] += 1; ra["points"] += 3; rh["lost"] += 1
        else:
            rh["drawn"] += 1; ra["drawn"] += 1
            rh["points"] += 1; ra["points"] += 1

    for r in rows.values():
        r["gd"] = r["gf"] - r["ga"]

    seed = {t: i for i, t in enumerate(teams)}  # draw order = final fallback
    ordered = _rank(list(rows.values()), group_scores, seed)
    return ordered, (n_played == len(fixtures))


def _h2h_metrics(tied_teams, group_scores):
    """Mini-table (points, gd, gf) among the tied teams only."""
    m = {t: {"points": 0, "gd": 0, "gf": 0} for t in tied_teams}
    tied = set(tied_teams)
    for fx in _FIXTURES:
        if fx["home"] not in tied or fx["away"] not in tied:
            continue
        score = group_scores.get(fx["id"])
        if not _played(score):
            continue
        h, a, hs, as_ = fx["home"], fx["away"], score["home"], score["away"]
        m[h]["gf"] += hs; m[h]["gd"] += hs - as_
        m[a]["gf"] += as_; m[a]["gd"] += as_ - hs
        if hs > as_:
            m[h]["points"] += 3
        elif hs < as_:
            m[a]["points"] += 3
        else:
            m[h]["points"] += 1; m[a]["points"] += 1
    return m


def _rank(rows, group_scores, seed):
    """Sort rows applying FIFA-style tiebreakers.

    Order: points, GD, GF; then head-to-head (points/GD/GF among the tied set);
    then draw-order seed as a deterministic final fallback.
    """
    # Group by the primary triple to find tied clusters for head-to-head.
    def primary(r):
        return (r["points"], r["gd"], r["gf"])

    rows = sorted(rows, key=lambda r: (primary(r), -seed[r["team"]]), reverse=True)

    # Resolve head-to-head within equal-primary clusters.
    result = []
    i = 0
    while i < len(rows):
        j = i
        while j < len(rows) and primary(rows[j]) == primary(rows[i]):
            j += 1
        cluster = rows[i:j]
        if len(cluster) > 1:
            h2h = _h2h_metrics([r["team"] for r in cluster], group_scores)
            cluster.sort(
                key=lambda r: (
                    h2h[r["team"]]["points"], h2h[r["team"]]["gd"],
                    h2h[r["team"]]["gf"], -seed[r["team"]],
                ),
                reverse=True,
            )
        result.extend(cluster)
        i = j
    return result


def compute_all_groups(group_scores):
    """Return dict letter -> {rows, complete}."""
    return {
        letter: dict(zip(("rows", "complete"),
                         compute_group(letter, group_scores)))
        for letter in GROUPS
    }


def rank_third_place(standings):
    """Rank the 12 third-placed teams; return the 8 qualifiers.

    Returns (qualifiers, all_ranked). qualifiers maps group-letter -> team for
    the 8 best 3rd places. Only meaningful when every group is complete.
    """
    thirds = []
    for letter, data in standings.items():
        if len(data["rows"]) >= 3:
            r = data["rows"][2]
            thirds.append({"group": letter, **r})
    thirds.sort(key=lambda r: (r["points"], r["gd"], r["gf"], r["group"]),
                reverse=False)
    thirds.sort(key=lambda r: (r["points"], r["gd"], r["gf"]), reverse=True)
    qualifiers = {t["group"]: t["team"] for t in thirds[:8]}
    return qualifiers, thirds


def _assign_third_slots(qualifier_groups):
    """Bipartite-match the qualifying 3rd-place groups to R32 third slots.

    qualifier_groups: set of 8 group letters whose 3rd team qualified.
    Returns dict (match_id, side) -> group_letter, or None if no perfect match.
    """
    slots = []  # (match_id, side, allowed_set)
    for mid, sides in R32.items():
        for side, ref in enumerate(sides):
            if ref["type"] == "third":
                slots.append((mid, side, set(ref["groups"])))

    # Match slots (left) to groups (right) via augmenting paths.
    match_for_group = {}  # group -> (mid, side)

    def try_assign(slot, seen):
        mid, side, allowed = slot
        for g in sorted(qualifier_groups):
            if g in allowed and g not in seen:
                seen.add(g)
                if g not in match_for_group or try_assign(
                    _slot_lookup[match_for_group[g]], seen
                ):
                    match_for_group[g] = (mid, side)
                    return True
        return False

    _slot_lookup = {(m, s): (m, s, a) for (m, s, a) in slots}

    for slot in slots:
        if not try_assign(slot, set()):
            return None  # infeasible (shouldn't happen with valid data)

    return {pos: g for g, pos in match_for_group.items()}


def resolve_bracket(standings, group_scores, ko_picks):
    """Build the full knockout bracket.

    Returns dict match_id -> {round, teamA, teamB, winner} where teams may be
    None until enough is decided. ko_picks maps str(match_id) -> team name.
    """
    all_complete = all(d["complete"] for d in standings.values())

    winners = {l: (d["rows"][0]["team"] if all_complete else None)
               for l, d in standings.items()}
    runners = {l: (d["rows"][1]["team"] if all_complete else None)
               for l, d in standings.items()}

    third_slot_group = None
    third_team = {}  # group -> team
    if all_complete:
        qualifiers, _ = rank_third_place(standings)
        third_team = qualifiers
        third_slot_group = _assign_third_slots(set(qualifiers.keys()))

    bracket = {}
    match_winner = {}  # match_id -> team (user pick, validated)

    def resolve_ref(ref, mid=None, side=None):
        t = ref["type"]
        if t == "winner":
            return winners.get(ref["group"])
        if t == "runner":
            return runners.get(ref["group"])
        if t == "third":
            if third_slot_group is None:
                return None
            g = third_slot_group.get((mid, side))
            return third_team.get(g) if g else None
        if t == "match":
            return match_winner.get(ref["match"])
        return None

    # Process rounds in order so match-winner refs are available downstream.
    order = [("Round of 32", R32), ("Round of 16", R16),
             ("Quarter-finals", QF), ("Semi-finals", SF), ("Final", FINAL)]

    for round_name, table in order:
        for mid in sorted(table):
            sides = table[mid]
            if round_name == "Round of 32":
                a = resolve_ref(sides[0], mid, 0)
                b = resolve_ref(sides[1], mid, 1)
            else:
                a = match_winner.get(sides[0])
                b = match_winner.get(sides[1])

            pick = ko_picks.get(str(mid))
            winner = pick if (pick and pick in (a, b)) else None
            if winner:
                match_winner[mid] = winner

            bracket[mid] = {
                "round": round_name, "teamA": a, "teamB": b, "winner": winner,
            }

    # Third-place play-off (match 103): the two losing semi-finalists.
    def _loser(m):
        w = m.get("winner")
        if not w:
            return None
        return m["teamA"] if w == m["teamB"] else m["teamB"]

    a103, b103 = _loser(bracket.get(101, {})), _loser(bracket.get(102, {}))
    pick = ko_picks.get("103")
    winner = pick if (pick and pick in (a103, b103)) else None
    if winner:
        match_winner[103] = winner
    bracket[103] = {"round": "Third place", "teamA": a103, "teamB": b103, "winner": winner}

    return bracket, (third_slot_group or {}), third_team


def simulate(state):
    """Top-level: state = {groupScores, koPicks} -> full computed payload."""
    group_scores = state.get("groupScores", {}) or {}
    ko_picks = state.get("koPicks", {}) or {}

    standings = compute_all_groups(group_scores)
    all_complete = all(d["complete"] for d in standings.values())
    qualifiers, thirds_ranked = ({}, [])
    if all_complete:
        qualifiers, thirds_ranked = rank_third_place(standings)

    bracket, third_slots, third_team = resolve_bracket(
        standings, group_scores, ko_picks
    )

    champion = bracket.get(104, {}).get("winner")

    # Serialize standings (rows already JSON-friendly dicts).
    out_standings = {
        l: {
            "complete": d["complete"],
            "rows": [
                {**r, "pos": i + 1} for i, r in enumerate(d["rows"])
            ],
        }
        for l, d in standings.items()
    }

    return {
        "groupsComplete": all_complete,
        "standings": out_standings,
        "thirdPlaceRanked": [
            {"group": t["group"], "team": t["team"], "points": t["points"],
             "gd": t["gd"], "gf": t["gf"],
             "qualified": t["team"] in qualifiers.values()}
            for t in thirds_ranked
        ],
        "bracket": bracket,
        "champion": champion,
    }
