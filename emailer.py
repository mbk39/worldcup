"""Email sending for account verification.

Configured entirely via environment variables so no secrets live in the repo:

    SMTP_HOST   e.g. smtp.gmail.com
    SMTP_PORT   default 587 (STARTTLS); use 465 for SSL
    SMTP_USER   the login / sending address
    SMTP_PASS   password or app-password (Gmail: an "App Password")
    FROM_EMAIL  optional; defaults to SMTP_USER
    FROM_NAME   optional display name, default "World Cup Predictor"

If SMTP isn't configured, is_configured() is False and the app runs in a dev
fallback: accounts are auto-verified and the verification link is logged to the
console instead of emailed. Configure the vars to switch on real verification.
"""

import os
import smtplib
import ssl
from email.message import EmailMessage


def is_configured():
    return bool(os.environ.get("SMTP_HOST")
                and os.environ.get("SMTP_USER")
                and os.environ.get("SMTP_PASS"))


def _open_smtp():
    """Open and authenticate one SMTP connection. Caller must close it."""
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASS"]
    if port == 465:
        s = smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20)
    else:
        s = smtplib.SMTP(host, port, timeout=20)
        s.starttls(context=ssl.create_default_context())
    s.login(user, password)
    return s


def send_bulk(recipients, subject, make_text, make_html):
    """Send a personalised email to many recipients over ONE connection.

    recipients : list of dicts with 'email' and 'display_name'.
    make_text / make_html : fn(display_name) -> str.
    Returns the number of messages successfully sent (0 if SMTP not configured —
    in dev mode the intended sends are logged instead).
    """
    if not recipients:
        return 0
    if not is_configured():
        for r in recipients:
            print(f"[emailer] (dev) would send '{subject}' to {r['email']}")
        return 0

    from_email = os.environ.get("FROM_EMAIL", os.environ["SMTP_USER"])
    from_name = os.environ.get("FROM_NAME", "World Cup Predictor")
    sent = 0
    server = None
    try:
        server = _open_smtp()
        for r in recipients:
            name = r.get("display_name") or "there"
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = f"{from_name} <{from_email}>"
            msg["To"] = r["email"]
            msg.set_content(make_text(name))
            msg.add_alternative(make_html(name), subtype="html")
            try:
                server.send_message(msg)
                sent += 1
            except Exception as exc:  # noqa: BLE001 - skip a bad address, keep going
                print(f"[emailer] send to {r['email']} failed: {exc!r}")
    except Exception as exc:  # noqa: BLE001 - connection/login failure
        print(f"[emailer] bulk send failed: {exc!r}")
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:  # noqa: BLE001
                pass
    return sent


def send_verification(to_email, display_name, verify_url):
    """Send the verification email. Returns True on success.

    Raises nothing — on failure returns False so the caller can decide.
    """
    if not is_configured():
        print(f"[emailer] (dev) verification link for {to_email}: {verify_url}")
        return False

    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASS"]
    from_email = os.environ.get("FROM_EMAIL", user)
    from_name = os.environ.get("FROM_NAME", "World Cup Predictor")

    msg = EmailMessage()
    msg["Subject"] = "Confirm your World Cup Predictor account"
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = to_email
    msg.set_content(
        f"Hi {display_name},\n\n"
        f"Confirm your World Cup 2026 Predictor account by opening this link:\n\n"
        f"{verify_url}\n\n"
        f"If you didn't sign up, you can ignore this email.\n"
    )
    msg.add_alternative(
        f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a1a">
          <p>Hi {display_name},</p>
          <p>Confirm your <b>World Cup 2026 Predictor</b> account:</p>
          <p><a href="{verify_url}"
                style="background:#34d399;color:#03261a;padding:10px 18px;
                       border-radius:8px;text-decoration:none;font-weight:700">
             Confirm my account</a></p>
          <p style="color:#666;font-size:13px">Or paste this link:<br>{verify_url}</p>
          <p style="color:#999;font-size:12px">If you didn't sign up, ignore this email.</p>
        </div>""",
        subtype="html",
    )

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
                s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                s.login(user, password)
                s.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001 - report and let caller fall back
        print(f"[emailer] send failed: {exc!r}")
        return False
