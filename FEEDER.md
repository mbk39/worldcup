# Automated live-results feeder (free, via GitHub Actions)

This pulls live/final **group-stage** scores and goalscorers from ESPN's free
public scoreboard (no API key) and pushes them into the app, so you don't have
to type results in by hand. It runs on **GitHub Actions** — not on
PythonAnywhere, whose free tier can't reach external sites.

- Script: [`feeder/feed_results.py`](feeder/feed_results.py)
- Schedule: [`.github/workflows/feed.yml`](.github/workflows/feed.yml) — every ~10 min

## How "live" it is
GitHub's scheduled jobs run roughly every 10 minutes and are sometimes delayed,
so scores update a few times during a match (not goal-by-goal). The site itself
auto-refreshes the Results tab / leaderboard every 60s, so whatever the feeder
has pushed shows up without anyone reloading. Your admin **Match results** screen
still works as an instant manual override.

> Group stage only for now. Knockout fixtures depend on who advances, so they're
> not auto-mapped yet — enter those via the admin screen, or ask for KO feeding.

## One-time setup (~5 minutes)

You need the **same secret token** in two places: GitHub (so the feeder can
authenticate) and your app (so it accepts the feed).

1. **Invent a token** — any long random string, e.g. `wc26-9f3a1c7b42e8d6`.

2. **Add it to the app** (PythonAnywhere → Web tab → WSGI file), in the same
   `os.environ` block as your other settings, above `from wsgi import application`:
   ```python
   os.environ["FEED_TOKEN"] = "wc26-9f3a1c7b42e8d6"
   ```
   Then **Reload**. (Without `FEED_TOKEN` set, the feed endpoint stays disabled.)

3. **Add it to GitHub** as an Actions secret:
   GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret** → Name `FEED_TOKEN`, Value the same token → Save.

4. *(Only if your site URL differs from the default)* add a repo **Variable**
   (same screen, "Variables" tab) named `APP_URL` =
   `https://mbk39.pythonanywhere.com`.

5. **Enable Actions**: the repo's **Actions** tab → enable workflows if prompted.
   The feeder then runs automatically every ~10 minutes. To test it now, open
   **Actions → "Feed live results" → Run workflow**.

## Checking it works
- After a manual run, the Actions log prints e.g.
  `Pushed 2 match(es) -> 200 {"ok": true, "updated": 2}`.
- During matches, scores + scorers appear on the **Results** tab and points
  update on league tables.
- If a run shows `Feed disabled` (503) → `FEED_TOKEN` isn't set on the app.
  If `Invalid feed token` (403) → the GitHub secret and the app value differ.

## Notes
- The feeder only **pushes** matches that are live or finished, so it never
  overwrites a real score with a 0–0 placeholder.
- ESPN is an undocumented-but-public endpoint; if it ever changes, manual admin
  entry is always available as a fallback.
- Scheduled workflows pause after ~60 days of no repo activity — a manual run or
  any push re-arms them.
