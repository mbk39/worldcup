# Hosting the World Cup 2026 Predictor

This app is a Flask web app with a SQLite database (`predictions.db`). Below is
the recommended free, always-on host, plus alternatives.

---

## ✅ Recommended: PythonAnywhere (free, always-on, persistent storage)

Why: the free tier gives a permanent `yourname.pythonanywhere.com` URL, runs the
web server for you, and (unlike most free hosts) keeps files on a **persistent
disk** — so your SQLite database of predictions survives restarts. No credit card.

### One-time setup (~10 minutes)

1. **Create a free account** at https://www.pythonanywhere.com (choose the free
   "Beginner" plan).

2. **Get the code onto the server.** Open a **Bash console** from the Dashboard
   and either clone from GitHub:
   ```bash
   git clone https://github.com/<you>/<your-repo>.git worldcup
   ```
   …or, if you're not using GitHub, zip this folder, upload it via the **Files**
   tab, and unzip it in a Bash console:
   ```bash
   unzip worldcup.zip -d worldcup
   ```

3. **Create a virtualenv and install dependencies** (in the Bash console):
   ```bash
   cd ~/worldcup
   python3 -m venv .venv
   source .venv/bin/activate
   pip install Flask
   ```
   (Gunicorn/Waitress aren't needed here — PythonAnywhere provides the server.)

4. **Create the web app.** Go to the **Web** tab → **Add a new web app** →
   **Manual configuration** → pick the same Python 3.x version you used above.

5. **Tell it where your code and virtualenv are.** On the Web tab:
   - **Source code:** `/home/<you>/worldcup`
   - **Working directory:** `/home/<you>/worldcup`
   - **Virtualenv:** `/home/<you>/worldcup/.venv`

6. **Edit the WSGI file** (there's a link to it on the Web tab). Delete the
   template contents and replace with:
   ```python
   import sys
   path = "/home/<you>/worldcup"
   if path not in sys.path:
       sys.path.insert(0, path)

   from wsgi import application  # noqa: E402
   ```

7. *(Optional but nice)* On the Web tab, add a **Static files** mapping so the
   server delivers CSS/JS efficiently:
   - URL: `/static/`  →  Directory: `/home/<you>/worldcup/static/`

8. Click the big green **Reload** button. Visit
   **`https://<you>.pythonanywhere.com`** — share that link with anyone.

### Keeping it alive
Free apps show a "Run until 3 months from today" button on the Web tab; click it
occasionally so the app isn't auto-disabled. That's the only upkeep.

### Deploying from GitHub (recommended over uploading zips)

One-time setup — clone the repo instead of uploading a zip:
```bash
cd ~
git clone https://github.com/mbk39/worldcup.git worldcup
cd worldcup
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
Then configure the Web tab exactly as above (source/working dir
`/home/mbk39/worldcup`, virtualenv `/home/mbk39/worldcup/.venv`) and Reload.

### Updating later (one command)
After new changes are pushed to GitHub, in a Bash console:
```bash
cd ~/worldcup && git pull && touch /var/www/mbk39_pythonanywhere_com_wsgi.py
```
`git pull` grabs the new code and `touch`-ing the WSGI file reloads the web app
without needing to click anything. Your `predictions.db` is git-ignored, so it's
never overwritten by updates.

---

## Alternative: Render (free tier — note the data caveat)

A `render.yaml` blueprint is included. Connect your GitHub repo at
https://render.com → **New → Blueprint**.

⚠️ **Important:** Render's free web services use an **ephemeral filesystem**, so
the SQLite DB is wiped on every redeploy/restart. The blueprint declares a
persistent disk mounted at `/var/data` (and points `WC_DB` there) — but **disks
are a paid feature on Render**. So on Render: either upgrade to a paid plan for
the persistent disk, or accept that predictions reset on redeploys. The free tier
also "sleeps" after 15 min of inactivity (first visit then takes ~50s to wake).

---

## Alternative: your own server / VPS

Any Linux box with Python 3:
```bash
pip install -r requirements.txt
gunicorn wsgi:application --bind 0.0.0.0:8000 --workers 1
```
Put Nginx/Caddy in front for HTTPS and a domain. Use **`--workers 1`** (or set a
shared `WC_DB` path) so all workers see the same SQLite database.

---

## Run a production server locally (Windows)

To serve it on your own machine without the dev server (e.g. for your home
network), use Waitress:
```powershell
pip install waitress
waitress-serve --host=0.0.0.0 --port=5000 wsgi:application
```
Then others on your Wi-Fi can reach `http://<your-PC-ip>:5000`.

---

## Accounts, leagues & email verification

The app now has user accounts (email + password), per-user predictions, and
private leagues with join codes. A few deployment notes:

- **Database:** data now lives in `worldcup.db` (auto-created on first run,
  git-ignored). The old `predictions.db` (name+PIN board) is no longer used —
  those anonymous predictions don't carry over, since predictions now belong to
  accounts.
- **Session secret:** a signing key for login sessions is auto-generated into
  `secret_key.txt` (git-ignored) on first run and reused after that, so logins
  survive reloads. To set it explicitly, use the `WC_SECRET` env var.

### Turning on real email verification (optional)

Out of the box, with no email configured, sign-up **auto-confirms** accounts so
everything works immediately (the verification link is just printed to the
server log). To require real email confirmation, give the app SMTP credentials.

**Easiest: a Gmail App Password** (works on free PythonAnywhere via their Gmail
exception):
1. On the Google account you'll send from, enable **2-Step Verification**.
2. Create an **App Password** (Google Account → Security → App passwords) — a
   16-character code.
3. On PythonAnywhere, edit your **WSGI configuration file** and add these lines
   **above** `from wsgi import application`:
   ```python
   import os
   os.environ["SMTP_HOST"] = "smtp.gmail.com"
   os.environ["SMTP_PORT"] = "587"
   os.environ["SMTP_USER"] = "youraddress@gmail.com"
   os.environ["SMTP_PASS"] = "your16charapppassword"   # the App Password
   os.environ["FROM_NAME"] = "World Cup Predictor"
   ```
4. **Reload** the web app. From now on new sign-ups must click the emailed link
   before they can log in.

Prefer an HTTPS email API (SendGrid/Brevo/Mailgun, all on the free allow-list)?
Tell me and I'll swap the sender to use it instead of SMTP.

### Making yourself the admin

One or more accounts can be admins (full backend: view/rename/delete any league,
remove members, verify/delete users). Admins are set by env var — nobody can
self-promote.

1. Decide which email you'll sign up with (your "master account").
2. In your PythonAnywhere **WSGI file**, above `from wsgi import application`, add:
   ```python
   import os
   os.environ["ADMIN_EMAILS"] = "you@example.com"   # comma-separate for several
   ```
3. **Reload**, then sign up / log in with that email. An **⚙️ Admin** tab appears
   for you only, and the admin API rejects everyone else (403).

## Notes
- The database file is created automatically on first run. An existing
  `predictions.json` from the old version is auto-imported once, then renamed to
  `predictions.json.imported`.
- `predictions.db` is git-ignored so you don't commit people's saved brackets.
- Override the DB location anywhere with the `WC_DB` environment variable.
