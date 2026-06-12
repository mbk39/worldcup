#!/usr/bin/env python3
"""External results feeder for the World Cup Predictor.

Pulls live/final group-stage scores and goalscorers from ESPN's free public
scoreboard (no API key) and pushes them into the app's token-secured feed
endpoint. Designed to run on GitHub Actions (or any machine) on a schedule —
NOT on the app host, which can't reach external sites on the free tier.

Env vars:
  APP_URL     base URL of the app, e.g. https://mbk39.pythonanywhere.com
  FEED_TOKEN  shared secret, must match the app's FEED_TOKEN
"""

import datetime as dt
import os
import re
import sys
import unicodedata

import requests

ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates={}"
APP_URL = os.environ.get("APP_URL", "https://mbk39.pythonanywhere.com").rstrip("/")
FEED_TOKEN = os.environ.get("FEED_TOKEN", "")

# Normalised name variants -> a shared canonical token, so ESPN names and our
# names resolve to the same key.
ALIAS = {
    "unitedstates": "usa", "usa": "usa",
    "southkorea": "korea", "korearepublic": "korea", "republicofkorea": "korea",
    "iran": "iran", "iriran": "iran",
    "czechia": "czech", "czechrepublic": "czech",
    "turkiye": "turkey", "turkey": "turkey",
    "ivorycoast": "cotedivoire", "cotedivoire": "cotedivoire",
    "capeverde": "capeverde", "caboverde": "capeverde",
    "bosniaandherzegovina": "bosnia", "bosniaherzegovina": "bosnia",
    "drcongo": "drcongo", "congodr": "drcongo",
    "democraticrepublicofthecongo": "drcongo", "drcongo ": "drcongo",
    "curacao": "curacao",
}


def normalise(name):
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]", "", s.lower())
    return s


def canon(name):
    n = normalise(name)
    return ALIAS.get(n, n)


def pair_key(a, b):
    return frozenset((canon(a), canon(b)))


def build_fixture_map():
    """frozenset of the two team tokens -> our group-stage match id."""
    data = requests.get(f"{APP_URL}/api/data", timeout=30).json()
    out = {}
    for f in data["fixtures"]:
        if f["id"].startswith("G-"):
            out[pair_key(f["home"], f["away"])] = f["id"]
    return out


def parse_event(ev):
    """Return (matchId-less) dict for a single ESPN event, or None to skip."""
    comp = ev["competitions"][0]
    state = ev.get("status", {}).get("type", {}).get("state")  # pre|in|post
    if state not in ("in", "post"):
        return None  # not started — don't overwrite with 0-0

    sides, id_to_side = {}, {}
    for c in comp.get("competitors", []):
        side = c.get("homeAway")
        sides[side] = c
        id_to_side[str(c.get("id"))] = side
        id_to_side[str(c.get("team", {}).get("id"))] = side
    if "home" not in sides or "away" not in sides:
        return None

    def score(c):
        try:
            return int(c.get("score"))
        except (TypeError, ValueError):
            return None

    scorers = {"home": [], "away": []}
    for d in comp.get("details", []):
        if not d.get("scoringPlay"):
            continue
        typ = (d.get("type", {}) or {}).get("text", "")
        if "Shootout" in typ:        # ignore penalty-shootout markers
            continue
        ath = (d.get("athletesInvolved") or [{}])[0]
        name = ath.get("displayName") or ath.get("shortName") or "Goal"
        minute = (d.get("clock", {}) or {}).get("displayValue", "")
        tag = " (pen)" if typ == "Penalty - Scored" else (" (OG)" if "Own" in typ else "")
        side = id_to_side.get(str((d.get("team", {}) or {}).get("id")))
        if side in scorers:
            scorers[side].append(f"{name} {minute}{tag}".strip())

    return {
        "home_team": sides["home"].get("team", {}).get("displayName"),
        "away_team": sides["away"].get("team", {}).get("displayName"),
        "home": score(sides["home"]),
        "away": score(sides["away"]),
        "status": "ft" if state == "post" else "live",
        "scorers": scorers,
    }


def main():
    if not FEED_TOKEN:
        # Nothing we can push without the shared secret. Don't fail the workflow
        # (avoids a red ✗ every run) — just warn so it's visible in the log.
        print("::warning::FEED_TOKEN secret not set — skipping. "
              "Add it in repo Settings → Secrets and variables → Actions, "
              "matching the app's FEED_TOKEN env var.")
        return 0
    try:
        fixtures = build_fixture_map()
    except Exception as exc:  # noqa: BLE001 - app unreachable / bad response
        print(f"::warning::Could not load fixtures from {APP_URL}: {exc!r} — skipping.")
        return 0
    print(f"Loaded {len(fixtures)} group fixtures from {APP_URL}")

    today = dt.datetime.utcnow().date()
    dates = [today + dt.timedelta(days=d) for d in (-1, 0, 1)]
    collected = {}
    for day in dates:
        url = ESPN.format(day.strftime("%Y%m%d"))
        try:
            events = requests.get(url, timeout=30).json().get("events", [])
        except Exception as exc:  # noqa: BLE001
            print(f"  {day}: fetch error {exc!r}")
            continue
        for ev in events:
            try:
                p = parse_event(ev)
            except Exception as exc:  # noqa: BLE001
                print(f"  event parse error: {exc!r}")
                continue
            if not p:
                continue
            mid = fixtures.get(pair_key(p["home_team"], p["away_team"]))
            if not mid:
                continue  # not a group match we track (e.g. knockout)
            collected[mid] = {
                "matchId": mid, "home": p["home"], "away": p["away"],
                "status": p["status"], "scorers": p["scorers"],
            }

    if not collected:
        print("No live/finished group matches to push right now.")
        return 0

    resp = requests.post(
        f"{APP_URL}/api/feed/results",
        json={"results": list(collected.values())},
        headers={"X-Feed-Token": FEED_TOKEN},
        timeout=30,
    )
    print(f"Pushed {len(collected)} match(es) -> {resp.status_code} {resp.text[:200]}")
    return 0 if resp.ok else 1


if __name__ == "__main__":
    sys.exit(main())
