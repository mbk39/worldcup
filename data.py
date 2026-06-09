"""Static tournament data for the 2026 FIFA World Cup (Canada / Mexico / USA).

Groups, fixtures and the knockout bracket template. Source: FIFA final draw
(5 Dec 2025) and the published 104-match schedule. Knockout slot/flow mapping
matches the official Round-of-32 layout.
"""

# ---------------------------------------------------------------------------
# Teams & groups
# ---------------------------------------------------------------------------
# Each group is a list of 4 teams, in draw (pot) order. Flags are emoji.

FLAGS = {
    "Mexico": "🇲🇽", "South Africa": "🇿🇦", "Korea Republic": "🇰🇷", "Czechia": "🇨🇿",
    "Canada": "🇨🇦", "Bosnia & Herzegovina": "🇧🇦", "Qatar": "🇶🇦", "Switzerland": "🇨🇭",
    "Brazil": "🇧🇷", "Morocco": "🇲🇦", "Haiti": "🇭🇹", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    "USA": "🇺🇸", "Paraguay": "🇵🇾", "Australia": "🇦🇺", "Türkiye": "🇹🇷",
    "Germany": "🇩🇪", "Curaçao": "🇨🇼", "Côte d'Ivoire": "🇨🇮", "Ecuador": "🇪🇨",
    "Netherlands": "🇳🇱", "Japan": "🇯🇵", "Sweden": "🇸🇪", "Tunisia": "🇹🇳",
    "Belgium": "🇧🇪", "Egypt": "🇪🇬", "IR Iran": "🇮🇷", "New Zealand": "🇳🇿",
    "Spain": "🇪🇸", "Cape Verde": "🇨🇻", "Saudi Arabia": "🇸🇦", "Uruguay": "🇺🇾",
    "France": "🇫🇷", "Senegal": "🇸🇳", "Iraq": "🇮🇶", "Norway": "🇳🇴",
    "Argentina": "🇦🇷", "Algeria": "🇩🇿", "Austria": "🇦🇹", "Jordan": "🇯🇴",
    "Portugal": "🇵🇹", "DR Congo": "🇨🇩", "Uzbekistan": "🇺🇿", "Colombia": "🇨🇴",
    "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Croatia": "🇭🇷", "Ghana": "🇬🇭", "Panama": "🇵🇦",
}

# ISO 3166-1 alpha-2 codes (with GB subdivisions) for flagcdn.com image flags.
FLAG_CODES = {
    "Mexico": "mx", "South Africa": "za", "Korea Republic": "kr", "Czechia": "cz",
    "Canada": "ca", "Bosnia & Herzegovina": "ba", "Qatar": "qa", "Switzerland": "ch",
    "Brazil": "br", "Morocco": "ma", "Haiti": "ht", "Scotland": "gb-sct",
    "USA": "us", "Paraguay": "py", "Australia": "au", "Türkiye": "tr",
    "Germany": "de", "Curaçao": "cw", "Côte d'Ivoire": "ci", "Ecuador": "ec",
    "Netherlands": "nl", "Japan": "jp", "Sweden": "se", "Tunisia": "tn",
    "Belgium": "be", "Egypt": "eg", "IR Iran": "ir", "New Zealand": "nz",
    "Spain": "es", "Cape Verde": "cv", "Saudi Arabia": "sa", "Uruguay": "uy",
    "France": "fr", "Senegal": "sn", "Iraq": "iq", "Norway": "no",
    "Argentina": "ar", "Algeria": "dz", "Austria": "at", "Jordan": "jo",
    "Portugal": "pt", "DR Congo": "cd", "Uzbekistan": "uz", "Colombia": "co",
    "England": "gb-eng", "Croatia": "hr", "Ghana": "gh", "Panama": "pa",
}

GROUPS = {
    "A": ["Mexico", "South Africa", "Korea Republic", "Czechia"],
    "B": ["Canada", "Bosnia & Herzegovina", "Qatar", "Switzerland"],
    "C": ["Brazil", "Morocco", "Haiti", "Scotland"],
    "D": ["USA", "Paraguay", "Australia", "Türkiye"],
    "E": ["Germany", "Curaçao", "Côte d'Ivoire", "Ecuador"],
    "F": ["Netherlands", "Japan", "Sweden", "Tunisia"],
    "G": ["Belgium", "Egypt", "IR Iran", "New Zealand"],
    "H": ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
    "I": ["France", "Senegal", "Iraq", "Norway"],
    "J": ["Argentina", "Algeria", "Austria", "Jordan"],
    "K": ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    "L": ["England", "Croatia", "Ghana", "Panama"],
}

# Standard FIFA 4-team round-robin matchday pairings (0-indexed team positions).
# Covers all 6 pairings across 3 matchdays.
_MATCHDAY_PAIRS = [
    [(0, 1), (2, 3)],   # Matchday 1
    [(0, 2), (3, 1)],   # Matchday 2
    [(3, 0), (1, 2)],   # Matchday 3
]


def build_group_fixtures():
    """Return list of group-stage matches.

    Each: {id, stage, group, matchday, home, away, date, time, channel}.
    id like 'G-A-1' (stable — used as the key for saved predictions, so the
    generation order must not change). date/time(BST)/channel come from
    schedule.py; matchday is derived from the real kickoff dates.
    """
    import schedule  # local module; standalone data, no circular import

    fixtures = []
    for letter, teams in GROUPS.items():
        n = 0
        group_fx = []
        for pairs in _MATCHDAY_PAIRS:
            for (i, j) in pairs:
                n += 1
                home, away = teams[i], teams[j]
                sched = schedule.for_match(home, away) or {}
                group_fx.append({
                    "id": f"G-{letter}-{n}",
                    "stage": "group",
                    "group": letter,
                    "home": home,
                    "away": away,
                    "date": sched.get("date"),
                    "time": sched.get("time"),
                    "channel": sched.get("channel"),
                })

        # A 4-team group has 3 matchdays of 2 matches. The schedule always
        # finishes a full matchday before the next starts, so sorting by
        # kick-off and pairing off gives the correct matchday (robust to late
        # kick-offs that roll past UK midnight).
        group_fx.sort(key=lambda fx: (fx["date"] or "", fx["time"] or ""))
        for idx, fx in enumerate(group_fx):
            fx["matchday"] = idx // 2 + 1

        fixtures.extend(group_fx)
    return fixtures


# ---------------------------------------------------------------------------
# Knockout bracket template (official 2026 layout)
# ---------------------------------------------------------------------------
# Slot references:
#   {"type": "winner", "group": "A"}      -> Group A winner (1A)
#   {"type": "runner", "group": "B"}      -> Group B runner-up (2B)
#   {"type": "third", "groups": [...]}    -> a 3rd-placed team from one of groups
#   {"type": "match", "match": 73}        -> winner of match 73

R32 = {
    73: ({"type": "winner", "group": "A"}, {"type": "third", "groups": list("CEFHI")}),
    74: ({"type": "winner", "group": "C"}, {"type": "runner", "group": "F"}),
    75: ({"type": "winner", "group": "E"}, {"type": "third", "groups": list("ABCDF")}),
    76: ({"type": "winner", "group": "F"}, {"type": "runner", "group": "C"}),
    77: ({"type": "runner", "group": "E"}, {"type": "runner", "group": "I"}),
    78: ({"type": "winner", "group": "I"}, {"type": "third", "groups": list("CDFGH")}),
    79: ({"type": "runner", "group": "A"}, {"type": "runner", "group": "B"}),
    80: ({"type": "winner", "group": "L"}, {"type": "third", "groups": list("EHIJK")}),
    81: ({"type": "winner", "group": "G"}, {"type": "third", "groups": list("AEHIJ")}),
    82: ({"type": "winner", "group": "D"}, {"type": "third", "groups": list("BEFIJ")}),
    83: ({"type": "winner", "group": "H"}, {"type": "runner", "group": "J"}),
    84: ({"type": "runner", "group": "K"}, {"type": "runner", "group": "L"}),
    85: ({"type": "winner", "group": "B"}, {"type": "third", "groups": list("EFGIJ")}),
    86: ({"type": "runner", "group": "D"}, {"type": "runner", "group": "G"}),
    87: ({"type": "winner", "group": "J"}, {"type": "runner", "group": "H"}),
    88: ({"type": "winner", "group": "K"}, {"type": "third", "groups": list("DEIJL")}),
}

# Round of 16 .. Final: (matchA, matchB) -> winners meet.
R16 = {
    89: (73, 79), 90: (74, 77), 91: (75, 78), 92: (76, 81),
    93: (82, 86), 94: (87, 83), 95: (80, 84), 96: (85, 88),
}
QF = {97: (89, 90), 98: (91, 92), 99: (93, 94), 100: (95, 96)}
SF = {101: (97, 98), 102: (99, 100)}
FINAL = {104: (101, 102)}
THIRD_PLACE_PLAYOFF = {103: (101, 102)}  # losers of the semis

# Human-readable round labels & ordering.
KNOCKOUT_ROUNDS = [
    ("Round of 32", R32, sorted(R32)),
    ("Round of 16", R16, sorted(R16)),
    ("Quarter-finals", QF, sorted(QF)),
    ("Semi-finals", SF, sorted(SF)),
    ("Final", FINAL, sorted(FINAL)),
]
