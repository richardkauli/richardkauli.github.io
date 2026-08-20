# FIT seat watch

Always-on watcher for FIT (Banner) course seats, **FALL 2026 (term 202701)**.
Runs on GitHub Actions — no computer of yours needs to be on.

- **Every 15 min:** checks SP 112, AC 362, AC 411, AC 412, IC 497 and emails you
  the moment any section flips from 0 seats to open, with your best schedule recomputed.
- **Daily 8:00 AM ET:** a digest email of the last 24h + current openings + best schedule.
- Reads FIT's **public** class-search API (no login). Auto-stops after **Sep 3, 2026**.

Lives in the public `richardkauli.github.io` repo, so the email address is kept
out of the code and provided via encrypted repo secrets.

## One-time setup

1. **Create a Gmail App Password** (the email is sent from your Gmail):
   - Turn on 2-Step Verification: https://myaccount.google.com/security
   - Create an app password: https://myaccount.google.com/apppasswords
     (name it "fit-seat-watch"). You'll get a 16-character code.
2. **Add two repo secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `GMAIL_USER` = your gmail address (e.g. you@gmail.com)
   - `GMAIL_APP_PASSWORD` = the 16-char code (spaces optional)
   - (optional) `ALERT_TO` if alerts should go to a different address than `GMAIL_USER`.
3. Done. The schedule runs automatically. To trigger by hand:
   Actions tab → **FIT seat watch** → Run workflow (mode `snapshot` for a full report,
   `check` for a live check, `digest` for the 24h summary).

## Files (in the `classes/` folder)
- `watch.py` — fetch + 0→open detection + schedule optimizer + email. Modes: `check`, `digest`, `snapshot`.
- `../.github/workflows/seatwatch.yml` — the schedule (must live at the repo root).
- `state.json` / `events.jsonl` — seat state + history (persisted between runs via Actions cache).

To change what's watched or your registered sections, edit the `FETCH`, `ALERT_KEYS`,
and `CURRENT` constants at the top of `watch.py`.
