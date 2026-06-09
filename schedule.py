"""Group-stage schedule: UK kick-off date/time (BST) and UK TV channel.

Times are UK local (BST = UTC+1 in June/July). Channels are the UK broadcaster
split between the BBC and ITV families. Sourced from published UK TV guides
(cross-checked across two listings, June 2026); broadcasters occasionally adjust
channel picks, so treat the specific BBC/ITV channel as indicative.

Keyed by the unordered pair of teams, so it maps onto fixtures regardless of
which side we list as "home".
"""

# Source team names -> our canonical names used in data.py.
_NORMALISE = {
    "South Korea": "Korea Republic",
    "Czech Republic": "Czechia",
    "Bosnia-Herzegovina": "Bosnia & Herzegovina",
    "Turkey": "Türkiye",
    "Ivory Coast": "Côte d'Ivoire",
    "Curacao": "Curaçao",
    "Iran": "IR Iran",
}

# (teamA, teamB, date, kickoff BST HH:MM, UK channel)
_RAW = [
    ("Mexico", "South Africa", "2026-06-11", "20:00", "ITV1"),
    ("South Korea", "Czech Republic", "2026-06-12", "03:00", "ITV1"),
    ("Canada", "Bosnia-Herzegovina", "2026-06-12", "20:00", "BBC One"),
    ("USA", "Paraguay", "2026-06-13", "02:00", "BBC One"),
    ("Qatar", "Switzerland", "2026-06-13", "20:00", "ITV1"),
    ("Brazil", "Morocco", "2026-06-13", "23:00", "BBC One"),
    ("Haiti", "Scotland", "2026-06-14", "02:00", "BBC One"),
    ("Australia", "Turkey", "2026-06-14", "05:00", "ITV1"),
    ("Germany", "Curacao", "2026-06-14", "18:00", "ITV1"),
    ("Netherlands", "Japan", "2026-06-14", "21:00", "ITV1"),
    ("Ivory Coast", "Ecuador", "2026-06-15", "00:00", "BBC One"),
    ("Sweden", "Tunisia", "2026-06-15", "03:00", "ITV1"),
    ("Spain", "Cape Verde", "2026-06-15", "17:00", "ITV1"),
    ("Belgium", "Egypt", "2026-06-15", "20:00", "BBC One"),
    ("Saudi Arabia", "Uruguay", "2026-06-15", "23:00", "ITV1"),
    ("Iran", "New Zealand", "2026-06-16", "02:00", "BBC One"),
    ("France", "Senegal", "2026-06-16", "20:00", "BBC One"),
    ("Iraq", "Norway", "2026-06-16", "23:00", "BBC One"),
    ("Argentina", "Algeria", "2026-06-17", "02:00", "ITV1"),
    ("Austria", "Jordan", "2026-06-17", "05:00", "BBC One"),
    ("Portugal", "DR Congo", "2026-06-17", "18:00", "BBC One"),
    ("England", "Croatia", "2026-06-17", "21:00", "ITV1"),
    ("Ghana", "Panama", "2026-06-18", "00:00", "ITV1"),
    ("Uzbekistan", "Colombia", "2026-06-18", "03:00", "BBC One"),
    ("Czech Republic", "South Africa", "2026-06-18", "17:00", "BBC One"),
    ("Switzerland", "Bosnia-Herzegovina", "2026-06-18", "20:00", "ITV1"),
    ("Canada", "Qatar", "2026-06-18", "23:00", "ITV1"),
    ("Mexico", "South Korea", "2026-06-19", "02:00", "BBC One"),
    ("USA", "Australia", "2026-06-19", "20:00", "BBC One"),
    ("Scotland", "Morocco", "2026-06-19", "23:00", "ITV1"),
    ("Brazil", "Haiti", "2026-06-20", "02:00", "ITV1"),
    ("Turkey", "Paraguay", "2026-06-20", "05:00", "ITV1"),
    ("Netherlands", "Sweden", "2026-06-20", "18:00", "BBC One"),
    ("Germany", "Ivory Coast", "2026-06-20", "21:00", "ITV1"),
    ("Ecuador", "Curacao", "2026-06-21", "01:00", "BBC One"),
    ("Tunisia", "Japan", "2026-06-21", "05:00", "BBC One"),
    ("Spain", "Saudi Arabia", "2026-06-21", "17:00", "BBC One"),
    ("Belgium", "Iran", "2026-06-21", "20:00", "ITV1"),
    ("Uruguay", "Cape Verde", "2026-06-21", "23:00", "BBC One"),
    ("New Zealand", "Egypt", "2026-06-22", "02:00", "ITV1"),
    ("Argentina", "Austria", "2026-06-22", "18:00", "BBC One"),
    ("France", "Iraq", "2026-06-22", "22:00", "BBC One"),
    ("Norway", "Senegal", "2026-06-23", "01:00", "ITV1"),
    ("Jordan", "Algeria", "2026-06-23", "04:00", "ITV1"),
    ("Portugal", "Uzbekistan", "2026-06-23", "18:00", "ITV1"),
    ("England", "Ghana", "2026-06-23", "21:00", "BBC One"),
    ("Panama", "Croatia", "2026-06-24", "00:00", "BBC One"),
    ("Colombia", "DR Congo", "2026-06-24", "03:00", "ITV1"),
    ("Bosnia-Herzegovina", "Qatar", "2026-06-24", "20:00", "ITV4"),
    ("Switzerland", "Canada", "2026-06-24", "20:00", "ITV1"),
    ("Morocco", "Haiti", "2026-06-24", "23:00", "BBC Two"),
    ("Scotland", "Brazil", "2026-06-24", "23:00", "BBC One"),
    ("Czech Republic", "Mexico", "2026-06-25", "02:00", "BBC One"),
    ("South Africa", "South Korea", "2026-06-25", "02:00", "BBC Two"),
    ("Curacao", "Ivory Coast", "2026-06-25", "21:00", "BBC Two"),
    ("Ecuador", "Germany", "2026-06-25", "21:00", "BBC One"),
    ("Japan", "Sweden", "2026-06-26", "00:00", "BBC Two"),
    ("Tunisia", "Netherlands", "2026-06-26", "00:00", "BBC One"),
    ("Paraguay", "Australia", "2026-06-26", "03:00", "ITV4"),
    ("Turkey", "USA", "2026-06-26", "03:00", "ITV1"),
    ("Norway", "France", "2026-06-26", "20:00", "ITV1"),
    ("Senegal", "Iraq", "2026-06-26", "20:00", "ITV4"),
    ("Cape Verde", "Saudi Arabia", "2026-06-27", "01:00", "ITV4"),
    ("Uruguay", "Spain", "2026-06-27", "01:00", "ITV1"),
    ("Egypt", "Iran", "2026-06-27", "04:00", "BBC Two"),
    ("New Zealand", "Belgium", "2026-06-27", "04:00", "BBC One"),
    ("Croatia", "Ghana", "2026-06-27", "22:00", "ITV4"),
    ("Panama", "England", "2026-06-27", "22:00", "ITV1"),
    ("Colombia", "Portugal", "2026-06-28", "00:30", "BBC One"),
    ("DR Congo", "Uzbekistan", "2026-06-28", "00:30", "BBC Two"),
    ("Algeria", "Austria", "2026-06-28", "03:00", "BBC Two"),
    ("Jordan", "Argentina", "2026-06-28", "03:00", "BBC One"),
]


import datetime as _dt

# Knockout match number -> kickoff in UTC (YYYY-MM-DD HH:MM). Source: published
# 104-match schedule. Times convert to BST (+1h) for display.
KO_KICKOFFS_UTC = {
    73: "2026-06-28 19:00", 74: "2026-06-29 20:30", 75: "2026-06-29 01:00",
    76: "2026-06-29 17:00", 77: "2026-06-30 21:00", 78: "2026-06-30 17:00",
    79: "2026-06-30 01:00", 80: "2026-07-01 16:00", 81: "2026-07-01 00:00",
    82: "2026-07-01 20:00", 83: "2026-07-02 23:00", 84: "2026-07-02 19:00",
    85: "2026-07-02 03:00", 86: "2026-07-03 22:00", 87: "2026-07-04 01:30",
    88: "2026-07-03 19:00", 89: "2026-07-04 21:00", 90: "2026-07-04 17:00",
    91: "2026-07-05 20:00", 92: "2026-07-05 00:00", 93: "2026-07-06 19:00",
    94: "2026-07-06 00:00", 95: "2026-07-07 16:00", 96: "2026-07-07 20:00",
    97: "2026-07-09 20:00", 98: "2026-07-10 19:00", 99: "2026-07-11 21:00",
    100: "2026-07-11 00:00", 101: "2026-07-14 18:00", 102: "2026-07-15 19:00",
    103: "2026-07-18 21:00", 104: "2026-07-19 19:00",
}


def ko_info(num):
    """Return {date, time (BST), epoch (UTC seconds)} for a knockout match number."""
    raw = KO_KICKOFFS_UTC.get(num)
    if not raw:
        return None
    utc = _dt.datetime.strptime(raw, "%Y-%m-%d %H:%M").replace(tzinfo=_dt.timezone.utc)
    bst = utc + _dt.timedelta(hours=1)
    return {"date": bst.strftime("%Y-%m-%d"), "time": bst.strftime("%H:%M"),
            "epoch": int(utc.timestamp())}


def _canon(name):
    return _NORMALISE.get(name, name)


def _key(a, b):
    return tuple(sorted((_canon(a), _canon(b))))


_LOOKUP = {
    _key(a, b): {"date": d, "time": t, "channel": c}
    for (a, b, d, t, c) in _RAW
}


def for_match(team_a, team_b):
    """Return {date, time, channel} for a fixture, or None if unknown."""
    return _LOOKUP.get(tuple(sorted((team_a, team_b))))
