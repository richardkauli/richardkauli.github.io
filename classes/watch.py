#!/usr/bin/env python3
"""
FIT Banner seat watcher + schedule optimizer (FALL 2026 / term 202701).

Reads the PUBLIC Banner class-search API (no login). Three modes:

  watch.py check     hourly: detect 0->open flips vs state.json, log the run,
                     print NEW_OPENINGS: <n> and (if n>0) a ready-to-send email
                     block that includes the recomputed best schedule.
  watch.py snapshot  print a full current-availability + best-schedule report
                     (used for on-demand / initial emails).
  watch.py digest    print a 24h summary from events.jsonl + current state +
                     best schedule (used by the 8am daily email task).

check-mode stdout contract for the scheduled task:
  * line 1 is always  NEW_OPENINGS: <n>
  * if n>0: next line  SUBJECT: <subj> , then ---BODY--- , then the body.
"""
import json, os, sys, datetime, itertools, urllib.parse, urllib.request, http.cookiejar
import smtplib, ssl
from email.message import EmailMessage

TERM = "202701"                         # FALL 2026
END_DATE = datetime.date(2026, 9, 3)    # stop after this date (2-week window)
BASE = "https://banner.fitnyc.edu/StudentRegistrationSsb/ssb"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")
EVENTS = os.path.join(HERE, "events.jsonl")
LOG = os.path.join(HERE, "watch.log")
REG_URL = BASE + "/classRegistration/classRegistration"

# Courses fetched for scheduling (all sections of each).
FETCH = [("SP", "112"), ("AC", "362"), ("AC", "411"),
         ("AC", "412"), ("AC", "423"), ("IC", "497")]
# Only these courses trigger 0->open alert emails.
ALERT_KEYS = {"SP 112", "AC 362", "AC 411", "AC 412", "IC 497"}
# Sections the user is currently registered in (kept as candidates even if full).
CURRENT = {"SP 112": "33423",   # BL1 Tue 11:10-1:00
           "AC 411": "23239",   # 701 Wed 11:10-2:00
           "AC 362": "34279",   # 701 Mon 9:10-1:00
           "AC 423": "24208"}   # 75A Tue 6:30-9:20p
WDAYS = ["M", "Tu", "W", "Th", "F", "Sa", "Su"]


# ---------------------------------------------------------------- fetch
def session():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA)]
    op.open(BASE + "/classSearch/classSearch", timeout=30).read()
    data = urllib.parse.urlencode({"term": TERM, "studyPath": ""}).encode()
    op.open(BASE + "/term/search?mode=search", data=data, timeout=30).read()
    return op


def fetch(op, subject, course):
    op.open(BASE + "/classSearch/resetDataForm", data=b"", timeout=30).read()
    q = urllib.parse.urlencode({
        "txt_subject": subject, "txt_courseNumber": course, "txt_term": TERM,
        "pageOffset": 0, "pageMaxSize": 50,
        "sortColumn": "subjectDescription", "sortDirection": "asc"})
    return json.loads(op.open(BASE + "/searchResults/searchResults?" + q, timeout=30).read())


def to_min(t):
    return int(t[:2]) * 60 + int(t[2:]) if t else None


def hhmm(t):
    if not t:
        return ""
    h, m = int(t[:2]), int(t[2:])
    ap = "a" if h < 12 else "p"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d}{ap}"


def collect(op):
    rows = {}
    for subj, crs in FETCH:
        for d in fetch(op, subj, crs).get("data", []):
            mt = (d.get("meetingsFaculty") or [{}])[0].get("meetingTime") or {}
            days = [lbl for k, lbl in
                    zip(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], WDAYS)
                    if mt.get(k)]
            online = not days
            when = "online / async" if online else \
                f'{"".join(days)} {hhmm(mt.get("beginTime"))}-{hhmm(mt.get("endTime"))}'
            rows[d["courseReferenceNumber"]] = {
                "key": f'{d["subject"]} {d["courseNumber"]}',
                "sec": d["sequenceNumber"], "title": d["courseTitle"],
                "seats": d["seatsAvailable"] or 0, "cap": d["maximumEnrollment"],
                "wl": f'{d["waitCount"]}/{d["waitCapacity"]}',
                "days": set(days), "b": to_min(mt.get("beginTime")), "e": to_min(mt.get("endTime")),
                "online": online, "when": when,
                "method": d.get("instructionalMethodDescription") or "-",
                "fac": (d.get("faculty") or [{}])[0].get("displayName") or "-"}
    return rows


def line(crn, r):
    return (f'{r["key"]} {r["sec"]:<4} CRN {crn}  seats {r["seats"]}/{r["cap"]}  '
            f'{r["when"]:<20} {r["method"]:<11} {r["fac"]}')


# ---------------------------------------------------------------- optimizer
def conflict(a, b):
    if a["online"] or b["online"]:
        return False
    return bool(a["days"] & b["days"]) and a["b"] < b["e"] and b["b"] < a["e"]


def candidates(key, rows):
    """Registerable sections for a course.
    SP 112: only the current section or an OPEN ONLINE section (user wants online there).
    Everyone else (AC 411, AC 362, IC 497...): the current section or ANY open section,
    so the solver is free to pick an in-person section if it fits the schedule better."""
    cur = CURRENT.get(key)
    online_only_alt = key in {"SP 112"}
    out = []
    for crn, r in rows.items():
        if r["key"] != key:
            continue
        if crn == cur or (r["seats"] > 0 and (r["online"] or not online_only_alt)):
            out.append((crn, r))
    # prefer online first, then keep-current, then earlier finish
    out.sort(key=lambda cr: (not cr[1]["online"], cr[0] != cur, cr[1]["e"] or 0))
    return out


def best(required, rows):
    """Pick one registerable section per required course: fewest campus days,
    no time overlaps, preferring online. Returns (list[(key,crn,r)], days_set) or None."""
    lists = []
    for key in required:
        c = candidates(key, rows)
        if not c:
            return None                       # nothing registerable for a required course
        lists.append([(key, crn, r) for crn, r in c])
    best_combo, best_score = None, None
    for combo in itertools.product(*lists):
        ok = True
        for i in range(len(combo)):
            for j in range(i + 1, len(combo)):
                if conflict(combo[i][2], combo[j][2]):
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        days = set().union(*[c[2]["days"] for c in combo])
        online_n = sum(1 for c in combo if c[2]["online"])
        changes = sum(1 for c in combo if c[1] != CURRENT.get(c[0]))
        score = (len(days), -online_n, changes)
        if best_score is None or score < best_score:
            best_score, best_combo = score, combo
    if not best_combo:
        return None
    days = set().union(*[c[2]["days"] for c in best_combo])
    return list(best_combo), days


def fmt_schedule(title, required, rows, extra_online):
    res = best(required, rows)
    out = [title]
    if not res:
        out.append("  (no conflict-free schedule from currently registerable sections)")
        return "\n".join(out)
    combo, days = res
    campus = [c for c in combo if not c[2]["online"]]
    online = [c for c in combo if c[2]["online"]]
    dayset = sorted(days, key=WDAYS.index)
    out.append(f'  Campus days: {", ".join(dayset) if dayset else "NONE — fully online"}  ({len(dayset)} day(s))')
    for d in dayset:
        todays = sorted([c for c in campus if d in c[2]["days"]], key=lambda c: c[2]["b"])
        for c in todays:
            key, crn, r = c
            out.append(f'    {d:<3} {hhmm_range(r):<15} {key} {r["sec"]}  (CRN {crn})  {r["fac"]}')
    onl = [f'{c[0]} {c[2]["sec"]}' for c in online] + extra_online
    if onl:
        out.append(f'  Online/async: {", ".join(onl)}')
    moves = []
    for key, crn, r in combo:
        cur = CURRENT.get(key)
        if cur is None:
            moves.append(f'REGISTER {key} {r["sec"]} (CRN {crn})')
        elif crn != cur:
            moves.append(f'SWITCH {key}: {cur_sec(key)} -> {r["sec"]} (CRN {crn})')
    if moves:
        out.append("  Action: " + "; ".join(moves))
    else:
        out.append("  Action: none — you're already in the optimal sections")
    return "\n".join(out)


def hhmm_range(r):
    def back(m):
        h, mm = divmod(m, 60)
        ap = "a" if h < 12 else "p"
        return f"{h % 12 or 12}:{mm:02d}{ap}"
    return f"{back(r['b'])}-{back(r['e'])}"


def cur_sec(key):
    return {"SP 112": "BL1", "AC 411": "701", "AC 362": "701", "AC 423": "75A"}.get(key, "?")


def schedule_block(rows):
    ic_open = any(r["key"] == "IC 497" and r["seats"] > 0 for r in rows.values())
    blocks = [fmt_schedule("BEST SCHEDULE NOW (SP 112 & AC 411 in person, AC 423 kept):",
                           ["SP 112", "AC 411", "AC 362", "AC 423"], rows,
                           extra_online=["AC 321 (online)", "AC 312 (online)"])]
    if ic_open:
        blocks.append(fmt_schedule("\nWHEN INTERNSHIP CLEARS (add IC 497, drop AC 423):",
                                   ["SP 112", "AC 411", "AC 362", "IC 497"], rows,
                                   extra_online=["AC 321 (online)", "AC 312 (online)"]))
    return "\n".join(blocks)


def open_block(rows):
    op = sorted([(c, r) for c, r in rows.items()
                 if r["seats"] > 0 and r["key"] in ALERT_KEYS], key=lambda x: (x[1]["key"], x[1]["sec"]))
    if not op:
        return "Monitored sections currently open: none."
    return "Monitored sections currently OPEN:\n" + "\n".join("  " + line(c, r) for c, r in op)


# ---------------------------------------------------------------- modes
def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def send_email(subject, body):
    """Send via Gmail SMTP using an App Password from env. Returns True on success."""
    user = os.environ.get("GMAIL_USER")          # your gmail (set as a repo secret)
    pw = os.environ.get("GMAIL_APP_PASSWORD")    # 16-char app password (repo secret)
    pw = pw.replace(" ", "") if pw else None     # Google shows it with spaces
    to = os.environ.get("ALERT_TO") or user      # defaults to sending to yourself
    if not (user and pw):
        return False
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = user, to, subject
    msg.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
        s.login(user, pw)
        s.send_message(msg)
    return True


def emit(subject, body):
    """Email if a Gmail App Password is configured (GitHub Actions); otherwise
    print the SUBJECT/---BODY--- contract (local / Claude-task use)."""
    if os.environ.get("GMAIL_APP_PASSWORD"):
        try:
            ok = send_email(subject, body)
        except Exception as e:
            print(f"[email FAILED: {e}]")
            ok = False
        print(f"[email sent={ok}] {subject}")
    else:
        print(f"SUBJECT: {subject}")
        print("---BODY---")
        print(body)


def run_check():
    now = datetime.datetime.now()
    if now.date() > END_DATE:
        print("NEW_OPENINGS: 0")
        return
    try:
        rows = collect(session())
        if not rows:
            raise RuntimeError("empty result")
    except Exception as e:
        print("NEW_OPENINGS: 0")
        print(f"(fetch error, state unchanged: {e})")
        return
    prev = load_state()
    opened, closed = [], []
    for crn, r in rows.items():
        if r["key"] not in ALERT_KEYS:
            continue
        was = prev.get(crn)
        if r["seats"] > 0 and (was is None or was == 0):
            opened.append((crn, r))
        elif r["seats"] == 0 and was and was > 0:
            closed.append((crn, r))
    json.dump({c: r["seats"] for c, r in rows.items()}, open(STATE, "w"), indent=2)
    with open(EVENTS, "a") as f:
        f.write(json.dumps({"ts": now.isoformat(timespec="minutes"),
                            "open": [c for c, r in rows.items() if r["seats"] > 0 and r["key"] in ALERT_KEYS],
                            "opened": [f'{r["key"]} {r["sec"]}' for _, r in opened],
                            "closed": [f'{r["key"]} {r["sec"]}' for _, r in closed]}) + "\n")
    with open(LOG, "a") as f:
        f.write(f'{now:%Y-%m-%d %H:%M}  {len(opened)} opened, {len(closed)} closed\n')

    print(f"NEW_OPENINGS: {len(opened)}")
    if not opened:
        return
    courses = ", ".join(sorted({r["key"] for _, r in opened}))
    lines = [f"New opening(s) detected {now:%a %b %d, %-I:%M %p}:", ""]
    for c, r in sorted(opened, key=lambda x: (x[1]["key"], x[1]["sec"])):
        lines.append("  >>> " + line(c, r))
    lines += ["", open_block(rows), "", schedule_block(rows), "",
              "Register: " + REG_URL,
              f"(Seats vanish fast — no waitlist. Checks run every 5 min until {END_DATE:%b %d}.)"]
    emit(f"🎓 FIT seat OPENED: {courses}", "\n".join(lines))


def run_snapshot():
    now = datetime.datetime.now()
    rows = collect(session())
    full = sorted([(c, r) for c, r in rows.items()
                   if r["seats"] == 0 and r["key"] in ALERT_KEYS], key=lambda x: (x[1]["key"], x[1]["sec"]))
    lines = [open_block(rows), "", "Still FULL (being watched for you):"]
    lines += ["  " + line(c, r) for c, r in full]
    lines += ["", schedule_block(rows), "", "Register: " + REG_URL]
    emit(f"FIT seat snapshot — {now:%a %b %d, %-I:%M %p}", "\n".join(lines))


def run_digest():
    now = datetime.datetime.now()
    cutoff = now - datetime.timedelta(hours=24)
    checks, opened, closed = 0, [], []
    if os.path.exists(EVENTS):
        for ln in open(EVENTS):
            try:
                ev = json.loads(ln)
                ts = datetime.datetime.fromisoformat(ev["ts"])
            except Exception:
                continue
            if ts < cutoff:
                continue
            checks += 1
            for x in ev.get("opened", []):
                opened.append((ts, x))
            for x in ev.get("closed", []):
                closed.append((ts, x))
    rows = collect(session())
    lines = [f"Last 24h: {checks} hourly checks.", ""]
    if opened:
        lines.append("Seats that OPENED in the last 24h:")
        lines += [f'  {ts:%a %-I:%M %p}  {x}' for ts, x in opened]
    else:
        lines.append("Seats that opened in the last 24h: none.")
    if closed:
        lines.append("")
        lines.append("Seats that closed again in the last 24h:")
        lines += [f'  {ts:%a %-I:%M %p}  {x}' for ts, x in closed]
    lines += ["", open_block(rows), "", schedule_block(rows), "", "Register: " + REG_URL]
    emit(f"FIT daily digest — {now:%a %b %d}", "\n".join(lines))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    {"check": run_check, "snapshot": run_snapshot, "digest": run_digest}.get(mode, run_check)()
