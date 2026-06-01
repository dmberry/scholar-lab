"""
Scholar Dashboard — Flask backend.

Version: 0.2.0 (2026-05-23)
  Bumped from initial (unversioned) state. Markdown data layer, REF 2029
  UoA tagging, Stack-by-role view + bell-curve comparison, server-side
  Scholar rate-limit cooldown, copy-card-as-image, etc.

Direct HTML scrape of Google Scholar citation profiles. The `scholarly`
Python library was tried first and got blocked immediately — its request
fingerprint is well-known to Scholar. Plain `requests` with a real
browser User-Agent goes through fine, so that's what we do here.

Cache TTL is 7 days on disk to avoid hammering Scholar between sessions.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, request, send_from_directory


# ──────────────────────────────────────────────────────────────────────────
# Paths.
#
# Two distinct roots, one read-only and one writable:
#
#   STATIC_ROOT  resources packaged with the app: index.html, app.js,
#                style.css, data.example/. When running from source this
#                is the repo folder; when bundled by PyInstaller it's
#                sys._MEIPASS (the temp dir PyInstaller unpacks into).
#
#   USER_ROOT    persistent per-user state: data/, .cache/. When running
#                from source it sits next to app.py so the dev workflow
#                stays unchanged. When packaged it lives in the platform-
#                standard application-support directory so it survives
#                .app upgrades and isn't lost if the .app is replaced.
# ──────────────────────────────────────────────────────────────────────────

_FROZEN = bool(getattr(sys, "frozen", False))

if _FROZEN:
    # PyInstaller unpacks bundled resources into sys._MEIPASS at runtime.
    STATIC_ROOT = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    if sys.platform == "darwin":
        _DEFAULT_USER_ROOT = Path.home() / "Library" / "Application Support" / "Scholar Dashboard"
    elif sys.platform == "win32":
        _DEFAULT_USER_ROOT = Path(os.environ.get("APPDATA", Path.home())) / "Scholar Dashboard"
    else:
        _DEFAULT_USER_ROOT = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "scholar-dashboard"
else:
    STATIC_ROOT = Path(__file__).parent
    _DEFAULT_USER_ROOT = Path(__file__).parent

_DEFAULT_USER_ROOT.mkdir(parents=True, exist_ok=True)

# The data folder can be relocated by the user. A small pointer file always
# lives in the default location and records where the data actually is, so we
# can always find the redirect (and fall back gracefully if it's gone).
_LOCATION_FILE = _DEFAULT_USER_ROOT / "location.json"


def _resolve_user_root() -> Path:
    try:
        p = Path(json.loads(_LOCATION_FILE.read_text())["data_root"]).expanduser()
        if p.is_dir():
            return p
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return _DEFAULT_USER_ROOT


USER_ROOT = _resolve_user_root()
USER_ROOT.mkdir(parents=True, exist_ok=True)

# Back-compat alias — most of the existing code references ROOT for static
# files (index.html, app.js, style.css).
ROOT = STATIC_ROOT

CACHE_DIR = USER_ROOT / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
DATA_DIR = USER_ROOT / "data"   # one Markdown file per unit lives here
REF_FLAGS_FILE    = USER_ROOT / "ref_flags.json"     # {scholar_id: {pub_key: True}}
REF_TARGETS_FILE  = USER_ROOT / "ref_targets.json"   # {uoa_code: {multiplier, min_per_person, max_per_person}}
CASE_STUDIES_FILE = USER_ROOT / "case_studies.json"  # {id: {uoa, title, status, …, versions[]}}
UOA_META_FILE     = USER_ROOT / "uoa_meta.json"      # {uoa_code: {narrative}}
SCHOLAR_META_FILE = USER_ROOT / "scholar_meta.json"
SCHOLAR_TRASH_FILE = USER_ROOT / "scholar_trash.json"  # soft-deleted people (30-day retention)
TRASH_RETENTION_DAYS = 30  # {person_key: {profile}}

# First-run seed: if the user has no data/ yet, copy the bundled
# data.example/ so they see a working dashboard immediately rather than
# an empty grid.
if not DATA_DIR.exists():
    seed = STATIC_ROOT / "data.example"
    if seed.is_dir():
        shutil.copytree(seed, DATA_DIR)
    else:
        DATA_DIR.mkdir(parents=True, exist_ok=True)

# App version — surfaced in the toolbar and via /api/version.
__version__ = "3.0.3"
# Bump when an export schema changes in a way older readers can't ingest.
# Every export embeds this; imports warn (but still try) when they meet a
# higher number than they understand. See _format_warning().
EXPORT_FORMAT_VERSION = 1
# The REF exercise year can be reconfigured but never set earlier than the
# current exercise (REF 2029); earlier values make no sense for the window.
REF_MIN_YEAR = 2029
CACHE_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 days

# Once Scholar returns a 429 / captcha, all further outbound Scholar fetches
# are short-circuited for this many seconds. Stops the dashboard from making
# the rate-limit worse with a flurry of retries. The expiry timestamp is
# persisted to disk so a server restart doesn't clear it and reset us into
# hammering Scholar again.
SCHOLAR_COOLDOWN_SECONDS = 60 * 10  # 10 minutes
_COOLDOWN_FILE = CACHE_DIR / "_cooldown.json"


def _load_cooldown() -> float:
    """Read the persisted cooldown expiry (epoch seconds). 0 if none."""
    try:
        return float(json.loads(_COOLDOWN_FILE.read_text()).get("until", 0))
    except (OSError, ValueError, json.JSONDecodeError):
        return 0.0


def _save_cooldown(until: float) -> None:
    try:
        _COOLDOWN_FILE.write_text(json.dumps({"until": until}))
    except OSError:
        pass


_scholar_rl_until = _load_cooldown()
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/120.0.0.0 Safari/537.36")

app = Flask(__name__, static_folder=None)

# Idle auto-shutdown. The server kills itself after IDLE_TIMEOUT_SECONDS of
# no real requests, so an abandoned tab doesn't leave a Python process
# squatting on port 5057 forever. Heartbeat pings from the frontend do not
# count as activity — they only ask "are you alive?" not "do something".
IDLE_TIMEOUT_SECONDS = 60 * 20  # 20 minutes (0 = never auto-shutdown)
_last_request_at = time.time()
_IDLE_EXCLUDED_PATHS = {"/api/heartbeat"}

# Scholar fetch tuning — the three rate/lifetime knobs above
# (SCHOLAR_COOLDOWN_SECONDS, IDLE_TIMEOUT_SECONDS, CACHE_TTL_SECONDS) can be
# overridden at runtime from Settings → Scholar fetch tuning. Overrides
# persist to settings.json and are re-applied at startup. All three are
# read at use-time (not captured), so changes take effect live.
_SETTINGS_FILE = USER_ROOT / "settings.json"

# REF assessment year + publication window. Configurable in Settings; the
# label "REF <year>" and the window bounds derive from these. Defaults are
# REF 2029 (window 1 Jan 2021 – 31 Dec 2028).
REF_YEAR = 2029
REF_START_YEAR_PY = 2021
REF_END_YEAR_PY   = 2028


def _load_settings_overrides():
    global SCHOLAR_COOLDOWN_SECONDS, IDLE_TIMEOUT_SECONDS, CACHE_TTL_SECONDS
    global REF_YEAR, REF_START_YEAR_PY, REF_END_YEAR_PY
    try:
        s = json.loads(_SETTINGS_FILE.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return
    if "cooldown_minutes" in s:
        SCHOLAR_COOLDOWN_SECONDS = max(0, int(float(s["cooldown_minutes"]) * 60))
    if "idle_minutes" in s:
        IDLE_TIMEOUT_SECONDS = max(0, int(float(s["idle_minutes"]) * 60))
    if "cache_ttl_days" in s:
        CACHE_TTL_SECONDS = max(3600, int(float(s["cache_ttl_days"]) * 86400))
    if "ref_year" in s:
        try: REF_YEAR = int(s["ref_year"])
        except (TypeError, ValueError): pass
    if "ref_window_start" in s:
        try: REF_START_YEAR_PY = int(s["ref_window_start"])
        except (TypeError, ValueError): pass
    if "ref_window_end" in s:
        try: REF_END_YEAR_PY = int(s["ref_window_end"])
        except (TypeError, ValueError): pass


_load_settings_overrides()


@app.before_request
def _track_activity():
    global _last_request_at
    if request.path not in _IDLE_EXCLUDED_PATHS:
        _last_request_at = time.time()


def _idle_watchdog():
    """Background thread. Every 30s, check whether we've been idle past
    the timeout; if so, send SIGTERM to ourselves and let the normal
    shutdown path run."""
    import signal
    while True:
        time.sleep(30)
        # IDLE_TIMEOUT_SECONDS == 0 disables auto-shutdown entirely.
        if IDLE_TIMEOUT_SECONDS > 0 and time.time() - _last_request_at >= IDLE_TIMEOUT_SECONDS:
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            except OSError:
                pass
            return


def _start_idle_watchdog():
    import threading
    t = threading.Thread(target=_idle_watchdog, daemon=True)
    t.start()

# (REF year + window defined above, overridable via Settings.)


# ---------- helpers ----------

# ──────────────────────────────────────────────────────────────────────────
# Markdown data layer.
#
# Staff data lives as one flat Markdown file per unit in data/. Each file
# declares its University / Faculty / School in a small header block, then
# lists staff as bullet lines. The app globs data/*.md, parses each, and
# rebuilds the University → Faculty → School → Unit tree in memory.
#
# Parsing is deliberately forgiving: a malformed line is skipped and logged
# (surfaced to the UI as a warning) rather than crashing the load; a unit
# file missing its Faculty/School headers still loads under "Unfiled".
#
# Unit file format:
#
#   University: University of X
#   Faculty: Example Faculty
#   School: School of Example Studies
#   Unit: Philosophy
#   Slug: philosophy
#   UoA: 30
#   Active: yes
#
#   - Ada Example | Professor of Examples | 000001 | 22sLFVoAAAAJ | set | uoa:30
#   - Bob Placeholder | Lecturer in Placeholders | 000002 | | missing | uoa:28
#
# Staff bullet fields, pipe-separated, fixed order, trailing fields optional:
#   Name | Title | staff_id | scholar_id | status | uoa:NN
# ──────────────────────────────────────────────────────────────────────────

# University name. Carried in every unit file's header; the parser picks it
# up, the serialiser writes it back. Falls back to this default.
_UNIVERSITY = "University"

_VALID_STATUS = ("set", "missing", "unchecked")


def _clean_affil(el) -> str | None:
    """Extract the affiliation string from a Scholar profile fragment with
    sane whitespace. Scholar wraps the affiliation in multiple inline
    elements (university, link, etc.) — get_text(strip=True) glues them
    together with no separator, producing 'School of X,University of Y'.
    Use a space separator instead, then collapse double whitespace and fix
    the missing-space-after-comma artefact."""
    if not el:
        return None
    s = el.get_text(" ", strip=True)
    s = re.sub(r"\s+", " ", s)        # collapse runs of whitespace
    s = re.sub(r"\s*,\s*", ", ", s)   # normalise ', ' spacing
    return s or None


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")
    return s[:60] or "x"


def _extract_scholar_id(raw: str) -> str | None:
    """Pull the Google Scholar user ID out of whatever's in the Scholar field —
    a full profile URL, a partial URL, or a bare ID. Returns None if blank."""
    raw = (raw or "").strip()
    if not raw:
        return None
    m = re.search(r"[?&]user=([A-Za-z0-9_-]+)", raw)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{8,20}", raw):
        return raw
    return None


def _scholar_url(scholar_id: str | None) -> str:
    """Full Scholar profile URL for a bare ID, or "" when there is none.
    Unit files store the full URL so they read clearly and click through."""
    if not scholar_id:
        return ""
    return f"https://scholar.google.com/citations?user={scholar_id}&hl=en"


# Explanatory comment block written at the top of the staff list in every
# unit file. Lines start with '#', which the parser ignores — it's purely
# documentation for anyone hand-editing the file.
_STAFF_FORMAT_HELP = [
    "# ── Staff ──────────────────────────────────────────────────────────",
    "# One person per line. Fields are pipe-separated, in this fixed order:",
    "#",
    "#   - Name | Title | Staff ID | Google Scholar URL | status | uoa:NN",
    "#",
    "#   status  = set | missing | unchecked",
    "#   Scholar = full profile URL (https://scholar.google.com/citations?user=…)",
    "#             or blank if the person has no profile",
    "#   uoa:NN  = optional; overrides this unit's UoA for that person.",
    "#             uoa:0 means 'explicitly no UoA'. Omit to inherit the unit.",
    "#   Trailing fields are optional. Lines starting with '#' are ignored.",
]


def _parse_staff_line(body: str, warnings: list, fname: str, lineno: int) -> dict | None:
    """Parse one '- Name | Title | id | scholar | status | uoa:NN' bullet.
    Returns None (with a warning) if the line has no name."""
    parts = [p.strip() for p in body.split("|")]
    name = parts[0] if parts else ""
    if not name:
        warnings.append(f"{fname}:{lineno}: staff line has no name — skipped")
        return None
    person: dict = {"name": name}
    person["title"]     = parts[1] if len(parts) > 1 else ""
    person["staff_id"]  = parts[2] if len(parts) > 2 else ""
    # Scholar field accepts a full profile URL or a bare ID — both normalise
    # to the bare ID in memory.
    person["scholar_id"] = _extract_scholar_id(parts[3] if len(parts) > 3 else "")
    status = (parts[4].lower() if len(parts) > 4 else "")
    if status and status not in _VALID_STATUS:
        warnings.append(f"{fname}:{lineno}: unknown status '{status}' — treating as unchecked")
        status = ""
    if not status:
        status = "set" if person["scholar_id"] else "unchecked"
    person["scholar_status"] = status
    for tok in parts[5:]:
        m = re.match(r"uoa\s*:\s*(\d+)\s*$", tok, re.I)
        if m:
            person["uoa"] = int(m.group(1))
    return person


def _parse_unit_file(path: Path) -> dict:
    """Parse one unit Markdown file. Returns a dict with the unit, its
    faculty/school context, and any parse warnings. `ok` is False if the
    file is unusable (no Unit: header)."""
    warnings: list[str] = []
    headers: dict[str, str] = {}
    staff: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return {"ok": False, "warnings": [f"{path.name}: cannot read ({e})"]}
    for i, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("-"):
            person = _parse_staff_line(line[1:].strip(), warnings, path.name, i)
            if person:
                staff.append(person)
        elif line.startswith("#"):
            continue   # markdown heading — ignored
        elif ":" in line:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        else:
            warnings.append(f"{path.name}:{i}: unrecognised line — ignored")
    unit_name = headers.get("unit") or headers.get("unit name")
    if not unit_name:
        warnings.append(f"{path.name}: no 'Unit:' header — file skipped")
        return {"ok": False, "warnings": warnings}
    slug = headers.get("slug") or _slugify(unit_name)
    uoa = None
    if headers.get("uoa"):
        try:
            uoa = int(re.sub(r"\D", "", headers["uoa"]) or 0) or None
        except ValueError:
            warnings.append(f"{path.name}: bad UoA '{headers['uoa']}' — ignored")
    active = headers.get("active", "yes").strip().lower()
    unit = {
        "slug": slug,
        "name": unit_name,
        "source": headers.get("source", ""),
        "last_scraped": headers.get("last-scraped", ""),
        "disabled": active in ("no", "false", "0", "off"),
        "staff": staff,
    }
    if uoa:
        unit["uoa"] = uoa
    return {
        "ok": True,
        "unit": unit,
        "university": headers.get("university", ""),
        "faculty": headers.get("faculty", "") or "Unfiled",
        "faculty_url": headers.get("faculty-url", ""),
        "school": headers.get("school", ""),
        "school_url": headers.get("school-url", ""),
        "warnings": warnings,
    }


def _load_staff() -> dict:
    """Assemble the faculties tree from data/*.md. Falls back to the legacy
    staff.json if the data folder is empty (first run / not yet migrated)."""
    global _UNIVERSITY
    md_files = sorted(DATA_DIR.glob("*.md")) if DATA_DIR.exists() else []
    md_files = [f for f in md_files if not f.name.startswith(("_", "."))]
    if not md_files:
        legacy = ROOT / "staff.json"
        if legacy.exists():
            with open(legacy, "r", encoding="utf-8") as f:
                return json.load(f)
        return {"faculties": [], "_parse_warnings": ["No data/*.md files and no staff.json"]}

    faculties: dict[str, dict] = {}
    warnings: list[str] = []
    for path in md_files:
        parsed = _parse_unit_file(path)
        warnings.extend(parsed.get("warnings", []))
        if not parsed.get("ok"):
            continue
        if parsed.get("university"):
            _UNIVERSITY = parsed["university"]
        fac_name = parsed["faculty"]
        fac = faculties.get(fac_name)
        if fac is None:
            fac = {"slug": _slugify(fac_name), "name": fac_name,
                   "url": parsed.get("faculty_url", ""), "schools": [], "units": []}
            faculties[fac_name] = fac
        sch_name = parsed["school"]
        if sch_name:
            sch = next((s for s in fac["schools"] if s["name"] == sch_name), None)
            if sch is None:
                sch = {"slug": _slugify(sch_name), "name": sch_name,
                       "url": parsed.get("school_url", ""), "units": []}
                fac["schools"].append(sch)
            sch["units"].append(parsed["unit"])
        else:
            fac["units"].append(parsed["unit"])
    # Drop empty `units`/`schools` arrays to keep the shape tidy.
    out = []
    for fac in faculties.values():
        if not fac["units"]:
            del fac["units"]
        if not fac["schools"]:
            del fac["schools"]
        out.append(fac)
    return {"faculties": out, "university": _UNIVERSITY, "_parse_warnings": warnings}


def _generator_line() -> str:
    """A version stamp embedded in every text export. Parsers treat
    'Generator:' as just another header key, so it round-trips harmlessly;
    importers read the format number from it to detect incompatibilities."""
    return f"Generator: Scholar Dashboard v{__version__} (format {EXPORT_FORMAT_VERSION})"


def _export_meta() -> dict:
    """Version block embedded in every JSON / bundle export."""
    return {
        "app": "Scholar Dashboard",
        "app_version": __version__,
        "format_version": EXPORT_FORMAT_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def _format_warning(found) -> str | None:
    """Return a human-readable warning if an import declares a format
    version newer than this build understands; else None. We never block —
    we try the import and surface the risk."""
    try:
        fv = int(found)
    except (TypeError, ValueError):
        return None
    if fv > EXPORT_FORMAT_VERSION:
        return (f"File was made by a newer export format (v{fv}); this build "
                f"reads up to v{EXPORT_FORMAT_VERSION}. Imported on a best-effort "
                f"basis — some fields may be ignored.")
    return None


def _scan_generator_format(text: str):
    """Pull the 'format N' number out of a Generator: header line, if any."""
    m = re.search(r"^Generator:.*\(format\s+(\d+)\)", text, re.MULTILINE)
    return int(m.group(1)) if m else None


def _unit_to_markdown(unit: dict, faculty: dict, school: dict | None) -> str:
    """Serialise one unit (with its faculty/school context) to a Markdown
    unit file. Canonical output — re-serialising is idempotent."""
    L = [_generator_line(),
         f"University: {_UNIVERSITY}",
         f"Faculty: {faculty.get('name', '')}"]
    if faculty.get("url"):
        L.append(f"Faculty-URL: {faculty['url']}")
    if school:
        L.append(f"School: {school.get('name', '')}")
        if school.get("url"):
            L.append(f"School-URL: {school['url']}")
    L.append(f"Unit: {unit.get('name', '')}")
    L.append(f"Slug: {unit.get('slug', '')}")
    if unit.get("uoa"):
        L.append(f"UoA: {unit['uoa']}")
    if unit.get("source"):
        L.append(f"Source: {unit['source']}")
    L.append(f"Active: {'no' if unit.get('disabled') else 'yes'}")
    L.append("")
    L.extend(_STAFF_FORMAT_HELP)
    L.append("")
    for p in unit.get("staff", []):
        fields = [
            str(p.get("name", "") or ""),
            str(p.get("title", "") or ""),
            str(p.get("staff_id", "") or ""),
            _scholar_url(p.get("scholar_id")),
            str(p.get("scholar_status", "") or ""),
        ]
        line = "- " + " | ".join(fields)
        if p.get("uoa") is not None:
            line += f" | uoa:{p['uoa']}"
        L.append(line)
    return "\n".join(L) + "\n"


def _unit_context_map() -> dict:
    """slug → (unit, faculty_dict, school_dict|None) for the whole dataset, so
    a unit can be re-serialised to canonical Markdown (with a current Generator
    stamp) on export rather than served as possibly-stale on-disk text."""
    data = _load_staff()
    m: dict = {}
    for fac in data.get("faculties", []):
        for sch in fac.get("schools", []):
            for u in sch.get("units", []):
                m[_slugify(u.get("slug", ""))] = (u, fac, sch)
        for u in fac.get("units", []):
            m[_slugify(u.get("slug", ""))] = (u, fac, None)
    for u in (data.get("units") or []):
        m[_slugify(u.get("slug", ""))] = (u, {"name": data.get("university", "")}, None)
    return m


def _unit_markdown(slug: str, ctx: dict | None = None) -> str | None:
    """Canonical Markdown for one unit (freshly serialised → carries the
    version stamp). Falls back to raw on-disk text if the unit isn't in the
    loaded tree. Returns None if neither exists."""
    slug = _slugify(slug)
    ctx = ctx if ctx is not None else _unit_context_map()
    if slug in ctx:
        u, fac, sch = ctx[slug]
        return _unit_to_markdown(u, fac, sch)
    p = DATA_DIR / f"{slug}.md"
    return p.read_text(encoding="utf-8") if p.exists() else None


def _write_staff_markdown(payload: dict) -> int:
    """Write the faculties tree out as one Markdown file per unit. Backs up
    the existing data/ folder first, and prunes files for units that no
    longer exist. Returns the number of unit files written."""
    DATA_DIR.mkdir(exist_ok=True)
    existing = [f for f in DATA_DIR.glob("*.md") if not f.name.startswith(("_", "."))]
    if existing:
        bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
        bak.mkdir(parents=True, exist_ok=True)
        for f in existing:
            shutil.copy2(f, bak / f.name)
    written: set[str] = set()
    for fac in payload.get("faculties", []):
        for sch in fac.get("schools", []):
            for unit in sch.get("units", []):
                slug = unit.get("slug") or _slugify(unit.get("name", ""))
                fname = f"{_slugify(slug)}.md"
                (DATA_DIR / fname).write_text(_unit_to_markdown(unit, fac, sch), encoding="utf-8")
                written.add(fname)
        for unit in fac.get("units", []):
            slug = unit.get("slug") or _slugify(unit.get("name", ""))
            fname = f"{_slugify(slug)}.md"
            (DATA_DIR / fname).write_text(_unit_to_markdown(unit, fac, None), encoding="utf-8")
            written.add(fname)
    # Prune orphaned unit files — but only if we actually wrote something,
    # so a malformed empty payload can't wipe the whole data folder.
    if written:
        for f in existing:
            if f.name not in written:
                f.unlink()
    return len(written)


def _cache_path(scholar_id: str) -> Path:
    safe = "".join(c for c in scholar_id if c.isalnum() or c in "-_")
    return CACHE_DIR / f"{safe}.json"


CACHE_DATA_VERSION = 8   # bump when the fetched payload shape changes


# Venue patterns commonly associated with outputs not eligible for REF
# (blog posts, op-eds, podcasts, social posts, popular press). Best-effort
# heuristic only — final eligibility is a manual judgement per REF rules.
_REF_INELIGIBLE_VENUE_PATTERNS = (
    # Preprint servers — not REF-eligible outputs themselves
    "arxiv", "arxiv.org", "biorxiv", "medrxiv", "ssrn",
    "preprint", "preprints.org", "osf preprint", "psyarxiv",

    # Generic blog signals
    "blog", "weblog", "stunlaw",

    # Blog-hosting platforms (domain + bare name forms)
    "blogspot.com", "blogspot.co", ".blogspot.",
    "blogger.com",
    "wordpress.com", "wordpress.co", "wordpress.org", ".wordpress.",
    "substack.com", ".substack.com", "substack",
    "medium.com",
    "tumblr.com",
    "typepad.com",
    "ghost.io", "ghost.org",
    "squarespace.com",
    "weebly.com", "wix.com",
    "dev.to", "hashnode.dev", "hashnode.com",
    "mirror.xyz",
    "patreon.com",

    # Academic-blog-style sites
    "the conversation", "theconversation.com",
    "crookedtimber", "daily nous", "dailynous",
    "3quarksdaily", "3 quarks daily",
    "lse blog", "lse blogs",
    "aeon.co", "psyche.co",

    # Social media
    "twitter.com", "twitter", "tweet",
    "x.com/", "x.com,",
    "facebook.com", "facebook",
    "instagram.com", "instagram",
    "linkedin.com",
    "tiktok.com",
    "reddit.com",
    "mastodon",
    "bluesky", "bsky.app",

    # Audio / video
    "podcast", "soundcloud",
    "youtube.com", "youtube",
    "vimeo.com",

    # UK + US press
    "guardian.com", "theguardian", "the guardian",
    "telegraph.co.uk", "the telegraph",
    "thetimes.co.uk", "the times,",
    "ft.com", "financial times",
    "bbc.co.uk", "bbc.com", "bbc news",
    "independent.co.uk",
    "nytimes.com", "the new york times",
    "washingtonpost.com",
    "huffington", "huffpost",
    "vice.com", "vice ",
    "vox.com",
    "buzzfeed",
    "atlantic.com", "the atlantic",
    "newyorker.com", "the new yorker",
    "wired.com",

    # Generic descriptors
    "newspaper", "magazine column", "op-ed", "opinion piece",
    "press release", "interview with",
    "wikipedia",
)


import re as _re

def _is_ref_eligible_pub(pub: dict) -> bool:
    """Best-effort heuristic: does this publication look like a REF-eligible
    research output?

    Excludes:
    - Empty / placeholder venue strings — can't be assessed (poorly entered)
    - Venues matching known non-academic platforms (blogs, social, podcasts,
      popular press)
    """
    venue = (pub.get("venue") or "").strip().lower()

    # No venue, or a venue that's just numbers/punctuation/whitespace.
    # These are typically self-uploaded items with no real metadata.
    if not venue:
        return False
    stripped_to_letters = _re.sub(r"[\d,\.\-\s\(\)\[\]\:\;\/]+", "", venue)
    if len(stripped_to_letters) < 3:
        return False

    for pat in _REF_INELIGIBLE_VENUE_PATTERNS:
        if pat in venue:
            return False
    return True

def _read_cache(scholar_id: str) -> dict | None:
    p = _cache_path(scholar_id)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except json.JSONDecodeError:
        return None
    if time.time() - data.get("_fetched_at", 0) > CACHE_TTL_SECONDS:
        return None
    # NOTE: we deliberately do NOT invalidate on data_version mismatch — that
    # caused a refetch storm whenever filter logic changed, leading to Scholar
    # 429s and apparent "data loss" on page reload. Old cached entries are
    # served as-is; missing fields surface as nulls in the frontend, and the
    # user can force-refresh individuals to apply newer filter logic.
    return data


def _write_cache(scholar_id: str, data: dict) -> None:
    data["_fetched_at"] = time.time()
    data["_fetched_iso"] = datetime.now(timezone.utc).isoformat()
    _cache_path(scholar_id).write_text(json.dumps(data, indent=2))


def _int_or_none(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if not s or not s.isdigit():
        return None
    return int(s)


def _fetch_scholar(scholar_id: str) -> dict:
    """Fetch a Scholar profile page and parse out the bits we need.
    Single page of 100 most-recent pubs — enough to capture every REF 2029
    eligible publication (2021–2028 = at most ~8 years) for anyone short of
    publishing 100 papers in that window."""
    url = (f"https://scholar.google.com/citations?user={scholar_id}"
           f"&hl=en&pagesize=100&sortby=pubdate")
    r = requests.get(url, headers={"User-Agent": UA}, timeout=15)
    if r.status_code == 404:
        raise RuntimeError(f"Scholar profile not found (HTTP 404) for id={scholar_id}")
    if r.status_code != 200:
        raise RuntimeError(f"Scholar HTTP {r.status_code} for id={scholar_id}")
    if "Our systems have detected unusual traffic" in r.text:
        raise RuntimeError("Scholar rate-limit page returned (captcha challenge)")

    soup = BeautifulSoup(r.text, "html.parser")

    name = soup.select_one("#gsc_prf_in")
    affil_div = soup.select_one(".gsc_prf_il")
    pic = soup.select_one("#gsc_prf_pup-img")
    interests = [a.get_text(strip=True) for a in soup.select(".gsc_prf_inta")]

    stat_cells = [c.get_text(strip=True) for c in soup.select(".gsc_rsb_std")]
    citedby    = _int_or_none(stat_cells[0] if len(stat_cells) > 0 else None)
    citedby5y  = _int_or_none(stat_cells[1] if len(stat_cells) > 1 else None)
    hindex     = _int_or_none(stat_cells[2] if len(stat_cells) > 2 else None)
    hindex5y   = _int_or_none(stat_cells[3] if len(stat_cells) > 3 else None)
    i10index   = _int_or_none(stat_cells[4] if len(stat_cells) > 4 else None)
    i10index5y = _int_or_none(stat_cells[5] if len(stat_cells) > 5 else None)

    # Scholar's citation histogram has two layers, both absolutely
    # positioned by a `right: Xpx` style attribute:
    #   .gsc_g_t  — year tick label (ONE per year on the x-axis)
    #   .gsc_g_a  — bar element (only present for years with >0 citations)
    #
    # Zipping the two lists by index used to silently misalign whenever a
    # year had no bar (e.g. 2024/2025 for a quiet researcher): year[0]
    # would get paired with bar[0]'s value even though bar[0] is for a
    # much later year. Match by `right` position instead.
    def _right_px(el):
        m = re.search(r"right:\s*(\d+)", el.get("style") or "")
        return int(m.group(1)) if m else None

    years_with_pos = []
    for el in soup.select(".gsc_g_t"):
        y = _int_or_none(el.get_text(strip=True))
        pos = _right_px(el)
        if y is not None and pos is not None:
            years_with_pos.append((pos, y))

    cites_per_year = {}
    for bar in soup.select(".gsc_g_a"):
        pos = _right_px(bar)
        val_el = bar.select_one(".gsc_g_al")
        v = _int_or_none(val_el.get_text(strip=True)) if val_el else None
        if pos is None or v is None or not years_with_pos:
            continue
        # Pair the bar with the year-label whose `right` is closest.
        nearest = min(years_with_pos, key=lambda yp: abs(yp[0] - pos))
        if abs(nearest[0] - pos) <= 12:   # within ~one bar-width
            cites_per_year[str(nearest[1])] = v

    def _parse_pub_rows(parsed_soup):
        rows = []
        for row in parsed_soup.select(".gsc_a_tr"):
            title_el = row.select_one(".gsc_a_at")
            title = title_el.get_text(strip=True) if title_el else None
            venue_els = row.select(".gs_gray")
            authors = venue_els[0].get_text(strip=True) if len(venue_els) > 0 else ""
            venue   = venue_els[1].get_text(strip=True) if len(venue_els) > 1 else ""
            year_el = row.select_one(".gsc_a_y .gsc_a_h, .gsc_a_y")
            year = _int_or_none(year_el.get_text(strip=True)) if year_el else None
            cite_el = row.select_one(".gsc_a_c .gsc_a_ac")
            num_citations = _int_or_none(cite_el.get_text(strip=True)) if cite_el else 0
            row_data = {
                "title": title, "authors": authors, "venue": venue,
                "year": year, "num_citations": num_citations or 0,
            }
            # Stable key used by the REF-flag store. Derived from title +
            # year; survives Scholar re-scrapes so flag state persists.
            row_data["pub_key"] = pub_key(row_data)
            rows.append(row_data)
        return rows

    pubs = _parse_pub_rows(soup)

    current_year = datetime.now().year
    # "Recent" publications now means the REF 2029 publication window —
    # 1 Jan 2021 onwards. Also drops poorly-entered items (no venue, blogs,
    # social posts) so the strip on the card and the list in the modal show
    # only assessable research outputs.
    recent = [p for p in pubs
              if p["year"] and p["year"] >= REF_START_YEAR_PY
              and _is_ref_eligible_pub(p)]
    recent.sort(key=lambda p: (p["year"] or 0, p["num_citations"]), reverse=True)
    # REF 2029 publication window: 1 Jan 2021 – 31 Dec 2028.
    # Filter out venues that look like blogs / op-eds / podcasts / popular press.
    ref_in_window = [p for p in pubs
                     if p["year"] and REF_START_YEAR_PY <= p["year"] <= REF_END_YEAR_PY]
    ref_eligible = [p for p in ref_in_window if _is_ref_eligible_pub(p)]
    ref_excluded = [p for p in ref_in_window if not _is_ref_eligible_pub(p)]

    return {
        "scholar_id": scholar_id,
        "name": name.get_text(strip=True) if name else None,
        # Use " " as the inter-tag separator so multi-span affiliations like
        # "<span>School of …</span><span>University of Sussex</span>" don't
        # squash into "School of …,University of Sussex". Then collapse any
        # double spaces and tidy up the comma spacing.
        "affiliation": _clean_affil(affil_div),
        "interests": interests,
        "url_picture": pic.get("src") if pic else None,
        "citedby": citedby,
        "citedby5y": citedby5y,
        "hindex": hindex,
        "hindex5y": hindex5y,
        "i10index": i10index,
        "i10index5y": i10index5y,
        "cites_per_year": cites_per_year,
        "recent_publications": recent[:15],
        "ref_eligible_count": len(ref_eligible),
        "ref_excluded_count": len(ref_excluded),
        "ref_excluded_titles": [{"title": p["title"], "venue": p["venue"], "year": p["year"]}
                                for p in ref_excluded[:10]],
        "data_version": 4,
    }


# ---------- routes ----------

@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:fname>")
def static_files(fname: str):
    return send_from_directory(ROOT, fname)


# ──────────────────────────────────────────────────────────────────────────
# REF 2029 flagging.
#
# Each publication can be ticked as "include in our REF 2029 submission".
# Flags persist in USER_ROOT/ref_flags.json, keyed by scholar_id then by
# a stable pub_key (year + title-slug). The Scholar cache is rebuilt
# periodically, so flags can't live inside the cached payload — they live
# in their own file and the frontend overlays them at render time.
#
# Per-UoA targets (multiplier, min/max per person) live in
# USER_ROOT/ref_targets.json. Defaults to REF 2029's published rules:
# 2.5 × FTE outputs per UoA, with each submitted person contributing
# between 1 and 5 outputs.
# ──────────────────────────────────────────────────────────────────────────

_DEFAULT_REF_TARGETS = {
    "default": {"multiplier": 2.5, "min_per_person": 1, "max_per_person": 5},
}


def pub_key(pub: dict) -> str:
    """A stable identifier for a publication, derived from year + a slug
    of the title. Survives Scholar re-scrapes (title strings come back
    consistent). Returns '' if there's nothing to key on."""
    title = (pub.get("title") or "").lower().strip()
    title = re.sub(r"[^a-z0-9]+", "-", title).strip("-")[:80]
    if not title:
        return ""
    year = pub.get("year") or "n.d."
    return f"{year}-{title}"


def _load_ref_flags() -> dict:
    try:
        with REF_FLAGS_FILE.open() as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_ref_flags(flags: dict) -> None:
    REF_FLAGS_FILE.write_text(json.dumps(flags, indent=2, sort_keys=True))


def _load_ref_targets() -> dict:
    try:
        with REF_TARGETS_FILE.open() as f:
            data = json.load(f) or {}
            # Ensure 'default' is always present so the client never has
            # to fall back to hard-coded values.
            if "default" not in data:
                data["default"] = dict(_DEFAULT_REF_TARGETS["default"])
            return data
    except (OSError, json.JSONDecodeError):
        return dict(_DEFAULT_REF_TARGETS)


def _save_ref_targets(targets: dict) -> None:
    REF_TARGETS_FILE.write_text(json.dumps(targets, indent=2, sort_keys=True))


@app.route("/api/ref-flags", methods=["GET"])
def api_ref_flags_get():
    """Return the full flag map. Values are the REF star rating for that
    output: 1, 2, 2.5, 3, 3.5, 4 (in-between = the X-Y* bands), or `true`
    for a legacy flag with no rating yet. Absent = Not REF.
    Shape: {scholar_id: {pub_key: rating, ...}, ...}"""
    return jsonify(_load_ref_flags())


# Allowed REF star ratings; the X.5 values are the "X–Y*" bands.
_REF_RATINGS = (1, 2, 2.5, 3, 3.5, 4)


@app.route("/api/ref-flag", methods=["POST"])
def api_ref_flag_set():
    """Set a publication's REF status. Body: {scholar_id, pub_key, rating}.
    rating ∈ {1,2,2.5,3,3.5,4} flags the output at that star band;
    rating 0 / null (or {flagged:false}) means Not REF → removed. For
    backward compat, {flagged:true} with no rating stores `true`."""
    body = request.get_json(force=True, silent=True) or {}
    sid = body.get("scholar_id")
    key = body.get("pub_key")
    if not sid or not key:
        return jsonify({"error": "scholar_id and pub_key are required"}), 400

    has_rating = "rating" in body
    rating = body.get("rating")
    if has_rating:
        try:
            rating = float(rating)
        except (TypeError, ValueError):
            rating = 0
        keep = rating in _REF_RATINGS
        value = rating if keep else None
    else:
        # Legacy boolean path.
        keep = bool(body.get("flagged"))
        value = True

    flags = _load_ref_flags()
    person = flags.setdefault(sid, {})
    if keep:
        person[key] = value
    else:
        person.pop(key, None)
        if not person:
            flags.pop(sid, None)
    _save_ref_flags(flags)
    return jsonify({"ok": True, "scholar_id": sid, "pub_key": key,
                    "flagged": keep, "rating": value if keep else None})


@app.route("/api/ref-targets", methods=["GET", "POST"])
def api_ref_targets():
    if request.method == "GET":
        return jsonify(_load_ref_targets())
    body = request.get_json(force=True, silent=True) or {}
    uoa  = str(body.get("uoa") or "default")
    rec  = {
        "multiplier":      float(body.get("multiplier", 2.5)),
        "min_per_person":  int(body.get("min_per_person", 1)),
        "max_per_person":  int(body.get("max_per_person", 5)),
    }
    targets = _load_ref_targets()
    targets[uoa] = rec
    _save_ref_targets(targets)
    return jsonify({"ok": True, "uoa": uoa, "target": rec})


# ──────────────────────────────────────────────────────────────────────────
# REF impact case studies. Persisted in case_studies.json (USER_ROOT),
# keyed by id. Mirrors the REF3 template; states track authoring progress
# (not_started → draft → proof → finished) with an ISO-stamped version log
# on each status change. See docs/REF-CASE-STUDIES-PLAN.md.
# ──────────────────────────────────────────────────────────────────────────

_CASE_STUDY_STATES = ("not_started", "draft", "proof", "finished")
_CASE_STUDY_FIELDS = ("title", "period", "summary", "underpinning_research",
                      "details")
_CASE_STUDY_LISTS = ("references", "corroborating_sources", "contributors")


def _load_case_studies() -> dict:
    try:
        with CASE_STUDIES_FILE.open() as f:
            return json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_case_studies(data: dict) -> None:
    CASE_STUDIES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


@app.route("/api/case-studies", methods=["GET"])
def api_case_studies_get():
    """All case studies, or those for one UoA via ?uoa=NN."""
    data = _load_case_studies()
    uoa = request.args.get("uoa")
    if uoa:
        data = {k: v for k, v in data.items() if str(v.get("uoa")) == str(uoa)}
    # Return as a list sorted by updated_at desc for easy rendering.
    items = sorted(data.values(), key=lambda c: c.get("updated_at", ""), reverse=True)
    return jsonify({"case_studies": items})


@app.route("/api/case-study", methods=["POST", "DELETE"])
def api_case_study_write():
    """Create or update (POST) / remove (DELETE) a single case study.
    POST body: {id?, uoa, title, status, period, summary,
    underpinning_research, details, references[], corroborating_sources[],
    contributors[], note?}. A new id is minted when absent. Each status
    change appends a stamped entry to the version log."""
    body = request.get_json(force=True, silent=True) or {}
    data = _load_case_studies()

    if request.method == "DELETE":
        cid = body.get("id") or request.args.get("id")
        existed = data.pop(cid, None) is not None
        _save_case_studies(data)
        return jsonify({"ok": True, "removed": existed, "id": cid})

    now = datetime.now(timezone.utc).isoformat()
    cid = body.get("id")
    rec = data.get(cid) if cid else None
    if rec is None:
        cid = "cs-" + datetime.now().strftime("%Y%m%d%H%M%S%f")
        rec = {"id": cid, "created_at": now, "versions": []}

    prev_status = rec.get("status")
    status = body.get("status") if body.get("status") in _CASE_STUDY_STATES else (prev_status or "not_started")

    # uoa "" / "none" → unassigned (tracked separately so it can be reassigned).
    if "uoa" in body:
        rec["uoa"] = "" if str(body.get("uoa") or "").lower() in ("", "none", "0") else str(body["uoa"])
    else:
        rec["uoa"] = rec.get("uoa", "")
    for f in _CASE_STUDY_FIELDS:
        if f in body:
            rec[f] = body[f]
    for f in _CASE_STUDY_LISTS:
        if f in body and isinstance(body[f], list):
            rec[f] = body[f]
    # Inclusion slot: an integer "№N of required", unique within the UoA, or
    # None = a draft/candidate not slotted for inclusion. Assigning a slot held
    # by another case study in the same UoA bumps that one back to draft.
    if "slot" in body:
        raw = body.get("slot")
        if raw in (None, "", "draft", 0, "0"):
            rec["slot"] = None
        else:
            try:
                n = int(raw)
            except (TypeError, ValueError):
                n = 0
            rec["slot"] = n if n > 0 else None
        if rec["slot"] is not None:
            for oid, other in data.items():
                if oid != cid and str(other.get("uoa")) == rec["uoa"] and other.get("slot") == rec["slot"]:
                    other["slot"] = None
    rec["status"] = status
    rec["updated_at"] = now
    # Stamp the version log on creation or any status transition.
    if status != prev_status:
        rec.setdefault("versions", []).append({
            "ts": now, "status": status,
            "note": (body.get("note") or "").strip(),
        })

    data[cid] = rec
    _save_case_studies(data)
    return jsonify({"ok": True, "case_study": rec})


# ── Case-study Markdown import / export ─────────────────────────────────────
# A portable, human/AI-editable format. See docs/case-study-template.md.

def _case_study_to_markdown(cs: dict) -> str:
    L = ["# Impact Case Study", ""]
    L.append(_generator_line())
    L.append(f"UoA: {cs.get('uoa', '')}")
    L.append(f"Title: {cs.get('title', '')}")
    L.append(f"Status: {cs.get('status', 'not_started')}")
    L.append(f"Period: {cs.get('period', '')}")
    L.append(f"Contributors: {', '.join(cs.get('contributors', []))}")
    L.append("References:")
    for r in cs.get("references", []):
        L.append(f"  - {r}")
    L.append("")
    for label, key in (("Summary of the impact", "summary"),
                       ("Underpinning research", "underpinning_research"),
                       ("Details of the impact", "details")):
        L += [f"## {label}", "", (cs.get(key) or ""), ""]
    L += ["## Sources to corroborate", ""]
    for s in cs.get("corroborating_sources", []):
        L.append(f"- {s}")
    L.append("")
    return "\n".join(L)


_CS_SECTION_KEYS = {
    "summary of the impact": "summary",
    "underpinning research": "underpinning_research",
    "details of the impact": "details",
    "sources to corroborate": "corroborating_sources",
}


def _parse_case_study_markdown(text: str) -> dict:
    cs = {"references": [], "corroborating_sources": [], "contributors": [],
          "status": "draft", "uoa": "", "title": "", "period": "",
          "summary": "", "underpinning_research": "", "details": ""}
    section = None       # current "## …" body key
    in_refs = False
    buf = []

    def flush():
        nonlocal buf
        if section in ("summary", "underpinning_research", "details"):
            cs[section] = "\n".join(buf).strip()
        buf.clear()

    for ln in text.splitlines():
        if ln.startswith("## "):
            flush(); in_refs = False
            section = _CS_SECTION_KEYS.get(ln[3:].strip().lower())
            continue
        if ln.startswith("# "):
            continue
        if section == "corroborating_sources":
            m = re.match(r"\s*-\s+(.*)", ln)
            if m and m.group(1).strip():
                cs["corroborating_sources"].append(m.group(1).strip())
            continue
        if section in ("summary", "underpinning_research", "details"):
            buf.append(ln); continue
        # Header region (before the first "## ").
        if ln.strip().lower() == "references:":
            in_refs = True; continue
        if in_refs:
            m = re.match(r"\s*-\s+(.*)", ln)
            if m:
                if m.group(1).strip():
                    cs["references"].append(m.group(1).strip())
                continue
            in_refs = False
        m = re.match(r"([A-Za-z ]+):\s*(.*)", ln)
        if m:
            k, v = m.group(1).strip().lower(), m.group(2).strip()
            if k == "uoa":          cs["uoa"] = v
            elif k == "title":      cs["title"] = v
            elif k == "status":     cs["status"] = v if v in _CASE_STUDY_STATES else "draft"
            elif k == "period":     cs["period"] = v
            elif k == "contributors":
                cs["contributors"] = [x.strip() for x in v.split(",") if x.strip()]
    flush()
    return cs


@app.route("/api/case-study.md")
def api_case_study_md():
    """Download one case study as Markdown. ?id=<id>."""
    cid = request.args.get("id", "")
    cs = _load_case_studies().get(cid)
    if not cs:
        return jsonify({"error": "no such case study"}), 404
    slug = _slugify(cs.get("title") or cid)[:50] or "case-study"
    return Response(_case_study_to_markdown(cs), mimetype="text/markdown",
                    headers={"Content-Disposition": f'attachment; filename="{slug}.md"'})


@app.route("/api/case-studies.zip")
def api_case_studies_zip():
    """Download all case studies (optionally ?uoa=NN) as a .zip of .md files."""
    import io, zipfile
    data = _load_case_studies()
    uoa = request.args.get("uoa")
    items = [c for c in data.values() if not uoa or str(c.get("uoa")) == str(uoa)]
    if not items:
        return jsonify({"error": "no case studies to export"}), 404
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("MANIFEST.json", json.dumps({**_export_meta(), "kind": "case-studies",
                                                  "uoa": uoa, "count": len(items)}, indent=2))
        for c in items:
            slug = _slugify(c.get("title") or c.get("id"))[:50] or c.get("id")
            zf.writestr(f"{c.get('uoa','x')}-{slug}.md", _case_study_to_markdown(c))
    buf.seek(0)
    fname = f"case-studies{('-uoa' + uoa) if uoa else ''}-{datetime.now().strftime('%Y%m%d')}.zip"
    return Response(buf.getvalue(), mimetype="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.route("/api/case-study-import", methods=["POST"])
def api_case_study_import():
    """Import one case study from Markdown (body = the .md text). Creates a
    new record (always a fresh id). Returns the saved case study."""
    text = request.get_data(as_text=True) or ""
    if not text.strip():
        return jsonify({"error": "empty upload"}), 400
    parsed = _parse_case_study_markdown(text)
    if not parsed.get("uoa"):
        return jsonify({"error": "missing 'UoA:' header — see the template"}), 400
    now = datetime.now(timezone.utc).isoformat()
    cid = "cs-" + datetime.now().strftime("%Y%m%d%H%M%S%f")
    parsed.update({"id": cid, "created_at": now, "updated_at": now,
                   "versions": [{"ts": now, "status": parsed.get("status", "draft"),
                                 "note": "imported from Markdown"}]})
    data = _load_case_studies()
    data[cid] = parsed
    _save_case_studies(data)
    warn = _format_warning(_scan_generator_format(text))
    return jsonify({"ok": True, "case_study": parsed,
                    "warnings": [warn] if warn else []})


@app.route("/api/uoa-meta", methods=["GET", "POST"])
def api_uoa_meta():
    """Per-UoA narrative / environment text + case-study target for the UoA
    report.
      GET ?uoa=NN → {narrative, case_studies_required}
      POST {uoa, narrative?, case_studies_required?} → save (merge)."""
    try:
        with UOA_META_FILE.open() as f:
            meta = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        meta = {}
    if request.method == "GET":
        uoa = str(request.args.get("uoa") or "")
        rec = meta.get(uoa, {})
        return jsonify({"narrative": rec.get("narrative", ""),
                        "case_studies_required": rec.get("case_studies_required")})
    body = request.get_json(force=True, silent=True) or {}
    uoa = str(body.get("uoa") or "")
    if not uoa:
        return jsonify({"error": "uoa required"}), 400
    rec = dict(meta.get(uoa, {}))
    if "narrative" in body:
        rec["narrative"] = body.get("narrative") or ""
    if "case_studies_required" in body:
        try:
            rec["case_studies_required"] = max(0, int(body["case_studies_required"]))
        except (TypeError, ValueError):
            pass
    meta[uoa] = rec
    try:
        UOA_META_FILE.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    except OSError:
        pass
    return jsonify({"ok": True, "uoa": uoa, **rec})


@app.route("/api/scholar-meta", methods=["GET", "POST"])
def api_scholar_meta():
    """Per-person free-text institutional profile, keyed by a stable
    person key (staff_id or scholar_id).
      GET ?key=… → {profile}
      POST {key, profile} → save."""
    try:
        with SCHOLAR_META_FILE.open() as f:
            meta = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        meta = {}
    if request.method == "GET":
        return jsonify(meta.get(str(request.args.get("key") or ""), {"profile": ""}))
    body = request.get_json(force=True, silent=True) or {}
    key = str(body.get("key") or "")
    if not key:
        return jsonify({"error": "key required"}), 400
    meta[key] = {"profile": (body.get("profile") or "")}
    try:
        SCHOLAR_META_FILE.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    except OSError:
        pass
    return jsonify({"ok": True, "key": key, **meta[key]})


@app.route("/api/version")
def api_version():
    return jsonify({"version": __version__})


@app.route("/api/about")
def api_about():
    """Metadata for the About dialog + the Settings 'Data & reset' panel:
    version, where user data lives, and how much is cached."""
    cached = len(list(CACHE_DIR.glob("*.json"))) if CACHE_DIR.exists() else 0
    # _cooldown.json sits in .cache too — don't count it as a profile.
    cached = max(0, cached - (1 if (_COOLDOWN_FILE.exists()) else 0))
    units = len(list(DATA_DIR.glob("*.md"))) if DATA_DIR.exists() else 0
    return jsonify({
        "name": "Scholar Dashboard",
        "version": __version__,
        "author": "David M. Berry",
        "homepage": "https://github.com/dmberry/scholar-lab",
        "license": "Proof-of-concept; not for production bibliometrics.",
        "frozen": _FROZEN,
        "data_dir": str(DATA_DIR),
        "cache_dir": str(CACHE_DIR),
        "user_root": str(USER_ROOT),
        "unit_files": units,
        "cached_profiles": cached,
    })


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    """Get / set app settings: Scholar fetch tuning (cooldown,
    idle-shutdown, cache TTL) and the REF assessment year + window.
    Persisted to settings.json (merged, not overwritten); applied live to
    the module globals, which are read at use-time."""
    global SCHOLAR_COOLDOWN_SECONDS, IDLE_TIMEOUT_SECONDS, CACHE_TTL_SECONDS
    global REF_YEAR, REF_START_YEAR_PY, REF_END_YEAR_PY
    if request.method == "GET":
        return jsonify({
            "cooldown_minutes": round(SCHOLAR_COOLDOWN_SECONDS / 60, 2),
            "idle_minutes":     round(IDLE_TIMEOUT_SECONDS / 60, 2),
            "cache_ttl_days":   round(CACHE_TTL_SECONDS / 86400, 2),
            "ref_year":         REF_YEAR,
            "ref_window_start": REF_START_YEAR_PY,
            "ref_window_end":   REF_END_YEAR_PY,
        })
    body = request.get_json(force=True, silent=True) or {}
    def _clamp(v, lo, hi, default):
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return default
    def _int(v, lo, hi, default):
        try:
            return max(lo, min(hi, int(v)))
        except (TypeError, ValueError):
            return default
    cm = _clamp(body.get("cooldown_minutes"), 0, 180,  SCHOLAR_COOLDOWN_SECONDS / 60)
    im = _clamp(body.get("idle_minutes"),     0, 1440, IDLE_TIMEOUT_SECONDS / 60)
    td = _clamp(body.get("cache_ttl_days"),   0.04, 365, CACHE_TTL_SECONDS / 86400)
    ry = _int(body.get("ref_year"),          REF_MIN_YEAR, 2100, max(REF_YEAR, REF_MIN_YEAR))
    ws = _int(body.get("ref_window_start"),  1900, 2100, REF_START_YEAR_PY)
    we = _int(body.get("ref_window_end"),    1900, 2100, REF_END_YEAR_PY)
    if we < ws:
        ws, we = we, ws
    SCHOLAR_COOLDOWN_SECONDS = int(cm * 60)
    IDLE_TIMEOUT_SECONDS     = int(im * 60)
    CACHE_TTL_SECONDS        = int(td * 86400)
    REF_YEAR, REF_START_YEAR_PY, REF_END_YEAR_PY = ry, ws, we
    # Merge into whatever is already on disk so unrelated keys survive.
    try:
        existing = json.loads(_SETTINGS_FILE.read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        existing = {}
    existing.update({"cooldown_minutes": cm, "idle_minutes": im, "cache_ttl_days": td,
                     "ref_year": ry, "ref_window_start": ws, "ref_window_end": we})
    try:
        _SETTINGS_FILE.write_text(json.dumps(existing, indent=2))
    except OSError:
        pass
    return jsonify({"ok": True, "cooldown_minutes": cm, "idle_minutes": im,
                    "cache_ttl_days": td, "ref_year": ry,
                    "ref_window_start": ws, "ref_window_end": we})


@app.route("/api/clear-cache", methods=["POST"])
def api_clear_cache():
    """Delete all cached Scholar payloads (keeps the cooldown marker).
    Staff/unit data is untouched — only the re-fetchable Scholar cache."""
    removed = 0
    if CACHE_DIR.exists():
        for p in CACHE_DIR.glob("*.json"):
            if p.name == _COOLDOWN_FILE.name:
                continue
            try:
                p.unlink(); removed += 1
            except OSError:
                pass
    return jsonify({"ok": True, "removed": removed})


# ── Data-folder location (choose / reveal / relocate) ───────────────────────
@app.route("/api/data-location", methods=["GET", "POST"])
def api_data_location():
    """GET → where the data folder is and whether it's relocatable here.
    POST {path} → relocate: back up the current folder, copy everything to the
    new location, and update the pointer. A restart is needed to take effect."""
    if request.method == "GET":
        return jsonify({
            "data_root":    str(USER_ROOT),
            "default_root": str(_DEFAULT_USER_ROOT),
            "is_custom":    USER_ROOT != _DEFAULT_USER_ROOT,
            "can_choose":   sys.platform == "darwin",   # native folder picker
        })

    body = request.get_json(force=True, silent=True) or {}
    raw = (body.get("path") or "").strip()
    if not raw:
        return jsonify({"error": "no path given"}), 400
    target = Path(raw).expanduser()
    if target == USER_ROOT:
        return jsonify({"ok": True, "unchanged": True, "data_root": str(USER_ROOT)})
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return jsonify({"error": f"can't create that folder: {e}"}), 400

    # Guard against clobbering an unrelated, non-empty folder.
    looks_ours = (target / "data").exists() or (target / "ref_flags.json").exists()
    if any(target.iterdir()) and not looks_ours:
        return jsonify({"error": "That folder isn't empty and isn't an existing Scholar "
                                 "Dashboard data folder. Choose an empty or previous folder."}), 400

    import zipfile
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backups = _DEFAULT_USER_ROOT / "backups"
    backups.mkdir(exist_ok=True)
    backup_zip = backups / f"data-backup-{ts}.zip"
    try:
        with zipfile.ZipFile(backup_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in USER_ROOT.rglob("*"):
                if p.is_file() and "backups" not in p.parts and ".bak" not in p.parts:
                    zf.write(p, p.relative_to(USER_ROOT))
    except OSError as e:
        return jsonify({"error": f"backup failed, aborting move: {e}"}), 500

    # Copy everything across (originals are left in place as a safety net).
    try:
        for p in USER_ROOT.iterdir():
            if p.name == "backups":
                continue
            dest = target / p.name
            if p.is_dir():
                shutil.copytree(p, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(p, dest)
    except OSError as e:
        return jsonify({"error": f"copy failed: {e}", "backup": str(backup_zip)}), 500

    try:
        _LOCATION_FILE.write_text(json.dumps({"data_root": str(target)}, indent=2))
    except OSError as e:
        return jsonify({"error": f"couldn't save the new location: {e}"}), 500

    return jsonify({"ok": True, "data_root": str(target), "backup": str(backup_zip),
                    "needs_restart": True})


@app.route("/api/choose-folder")
def api_choose_folder():
    """Native macOS folder picker (osascript). Returns {path} or {cancelled}.
    Non-macOS clients get {supported:false} and fall back to a typed path."""
    if sys.platform != "darwin":
        return jsonify({"supported": False})
    import subprocess
    script = ('POSIX path of (choose folder with prompt '
              '"Choose a folder to hold the Scholar Dashboard data")')
    try:
        r = subprocess.run(["osascript", "-e", script],
                           capture_output=True, text=True, timeout=180)
    except Exception as e:   # noqa: BLE001 - surface any launcher failure
        return jsonify({"error": str(e)}), 500
    if r.returncode != 0:
        return jsonify({"cancelled": True})
    return jsonify({"path": r.stdout.strip()})


@app.route("/api/open-folder", methods=["POST"])
def api_open_folder():
    """Reveal a folder in the OS file browser. Body {path?} defaults to the
    data folder."""
    body = request.get_json(silent=True) or {}
    path = Path(body.get("path") or USER_ROOT).expanduser()
    if not path.exists():
        return jsonify({"error": "folder not found"}), 404
    import subprocess
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        elif sys.platform == "win32":
            os.startfile(str(path))   # type: ignore[attr-defined]  # noqa
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
    except Exception as e:   # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True})


# ── Danger zone: destructive structural edits ──────────────────────────────
@app.route("/api/delete-faculty", methods=["POST"])
def api_delete_faculty():
    """Permanently delete a whole faculty: every unit Markdown file under it.
    Files are backed up to data/.bak first. Body {name} must exactly match the
    faculty name (the client makes the user type it to confirm)."""
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "faculty name required"}), 400
    ctx = _unit_context_map()
    slugs = [slug for slug, (_u, fac, _sch) in ctx.items() if (fac.get("name") or "") == name]
    if not slugs:
        return jsonify({"error": f"no faculty named “{name}”"}), 404
    removed = 0
    bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
    for slug in slugs:
        p = DATA_DIR / f"{slug}.md"
        if p.exists():
            bak.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, bak / p.name)
            p.unlink()
            removed += 1
    return jsonify({"ok": True, "faculty": name, "removed": removed})


@app.route("/api/delete-school", methods=["POST"])
def api_delete_school():
    """Delete a whole school: every unit file under it. Body {name}."""
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "school name required"}), 400
    ctx = _unit_context_map()
    slugs = [slug for slug, (_u, _fac, sch) in ctx.items() if sch and (sch.get("name") or "") == name]
    if not slugs:
        return jsonify({"error": f"no school named “{name}”"}), 404
    removed = 0
    bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
    for slug in slugs:
        p = DATA_DIR / f"{slug}.md"
        if p.exists():
            bak.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, bak / p.name)
            p.unlink()
            removed += 1
    return jsonify({"ok": True, "school": name, "removed": removed})


@app.route("/api/delete-unit", methods=["POST"])
def api_delete_unit():
    """Delete a single unit file. Body {slug}."""
    body = request.get_json(force=True, silent=True) or {}
    slug = _slugify(body.get("slug") or "")
    if not slug:
        return jsonify({"error": "unit slug required"}), 400
    p = DATA_DIR / f"{slug}.md"
    if not p.exists():
        return jsonify({"error": f"no unit “{slug}”"}), 404
    bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
    bak.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, bak / p.name)
    p.unlink()
    return jsonify({"ok": True, "slug": slug})


@app.route("/api/clear-uoa", methods=["POST"])
def api_clear_uoa():
    """Clear a UoA's *relations* only — never the underlying staff/units. Drops
    the UoA default from any unit, the per-person override from anyone tagged to
    it, and unassigns (does not delete) that UoA's impact case studies. Body
    {code}."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        code = int(re.sub(r"\D", "", str(body.get("code") or "")) or 0)
    except ValueError:
        code = 0
    if not code:
        return jsonify({"error": "valid UoA code required"}), 400

    staff = _load_staff()
    units_cleared = people_cleared = 0

    def _walk(units):
        nonlocal units_cleared, people_cleared
        for u in units:
            if u.get("uoa") == code:
                u.pop("uoa", None); units_cleared += 1
            for p in u.get("staff", []):
                if p.get("uoa") == code:
                    p.pop("uoa", None); people_cleared += 1

    for fac in staff.get("faculties", []):
        for sch in fac.get("schools", []):
            _walk(sch.get("units", []))
        _walk(fac.get("units", []))
    if isinstance(staff.get("units"), list):
        _walk(staff["units"])
    # Re-serialise the whole tree (backs up data/ first).
    _write_staff_markdown(staff)

    # Unassign — not delete — the UoA's case studies.
    cs = _load_case_studies()
    cs_cleared = 0
    for c in cs.values():
        if str(c.get("uoa")) == str(code):
            c["uoa"] = ""; cs_cleared += 1
    if cs_cleared:
        _save_case_studies(cs)

    return jsonify({"ok": True, "code": code, "units_cleared": units_cleared,
                    "people_cleared": people_cleared, "case_studies_unassigned": cs_cleared})


@app.route("/api/heartbeat")
def api_heartbeat():
    """Lightweight liveness probe. The frontend polls this every 60s so it
    can detect when the server has idled out and swap the Quit button for
    Restart. Deliberately excluded from the idle-activity tracker so that
    polling alone never keeps the server awake."""
    idle = time.time() - _last_request_at
    return jsonify({
        "ok": True,
        "version": __version__,
        "idle_seconds": int(idle),
        "idle_timeout_seconds": IDLE_TIMEOUT_SECONDS,
        "expires_in_seconds": max(0, int(IDLE_TIMEOUT_SECONDS - idle)),
    })


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    """Gracefully stop the server. Triggered by the Quit button in the
    toolbar. Schedules SIGTERM to self ~300ms after the response goes out
    so the browser sees a clean reply before the socket closes."""
    import threading, signal
    def _stop():
        time.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_stop, daemon=True).start()
    return jsonify({"ok": True, "shutting_down": True})


# ── Scholar trash (soft delete with 30-day retention) ──────────────────────
def _load_trash() -> list:
    try:
        data = json.loads(SCHOLAR_TRASH_FILE.read_text())
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_trash(items: list) -> None:
    try:
        SCHOLAR_TRASH_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False))
    except OSError:
        pass


def _purge_expired_trash(items: list) -> list:
    """Drop trash older than the retention window. Best-effort on bad dates."""
    cutoff = time.time() - TRASH_RETENTION_DAYS * 86400
    kept = []
    for it in items:
        try:
            ts = datetime.fromisoformat(it.get("deleted_at", "")).timestamp()
        except (ValueError, TypeError):
            ts = time.time()   # unknown → keep
        if ts >= cutoff:
            kept.append(it)
    return kept


def _person_key(p: dict) -> str:
    return ((p.get("staff_id") or "").strip() or (p.get("scholar_id") or "").strip()
            or (p.get("name") or "").strip())


def _capture_deletions(payload: dict) -> int:
    """Diff the incoming faculties tree against what's on disk; any person who
    has vanished from a unit that still exists (and isn't simply moved to
    another unit) is moved to the trash so the delete is recoverable."""
    old = _load_staff()
    old_index: dict = {}

    def _walk_old(units):
        for u in units:
            slug = _slugify(u.get("slug", ""))
            old_index[slug] = {"name": u.get("name", ""),
                               "people": {_person_key(p): p for p in u.get("staff", []) if _person_key(p)}}

    for fac in old.get("faculties", []):
        for sch in fac.get("schools", []):
            _walk_old(sch.get("units", []))
        _walk_old(fac.get("units", []))
    if isinstance(old.get("units"), list):
        _walk_old(old["units"])

    new_keys: dict = {}

    def _walk_new(units):
        for u in units:
            slug = _slugify(u.get("slug", ""))
            new_keys.setdefault(slug, set()).update(_person_key(p) for p in u.get("staff", []) if _person_key(p))

    for fac in payload.get("faculties", []):
        for sch in fac.get("schools", []):
            _walk_new(sch.get("units", []))
        _walk_new(fac.get("units", []))
    if isinstance(payload.get("units"), list):
        _walk_new(payload["units"])

    all_new = set().union(*new_keys.values()) if new_keys else set()
    now = datetime.now(timezone.utc).isoformat()
    trash = _load_trash()
    added = 0
    for slug, info in old_index.items():
        survivors = new_keys.get(slug)
        if survivors is None:
            continue   # unit absent from this save → don't trash (scoped save / unit delete handled elsewhere)
        for key, person in info["people"].items():
            if key not in survivors and key not in all_new:   # gone, and not moved elsewhere
                trash.append({
                    "id": "tr-" + datetime.now().strftime("%Y%m%d%H%M%S%f") + str(added),
                    "person": person, "unit_slug": slug, "unit_name": info["name"],
                    "deleted_at": now,
                })
                added += 1
    if added:
        _save_trash(trash)
    return added


@app.route("/api/trash", methods=["GET", "POST"])
def api_trash():
    """GET → the current trash (expired entries purged first).
    POST {action: restore|purge|empty, id?} — restore re-adds the person to
    their origin unit; purge removes one; empty clears all."""
    items = _purge_expired_trash(_load_trash())
    if request.method == "GET":
        _save_trash(items)
        return jsonify({"trash": items, "retention_days": TRASH_RETENTION_DAYS})

    body = request.get_json(force=True, silent=True) or {}
    action = body.get("action")
    if action == "empty":
        _save_trash([])
        return jsonify({"ok": True, "emptied": True})
    tid = body.get("id")
    item = next((it for it in items if it.get("id") == tid), None)
    if not item:
        return jsonify({"error": "trash item not found"}), 404
    if action == "purge":
        _save_trash([it for it in items if it.get("id") != tid])
        return jsonify({"ok": True, "purged": tid})
    if action == "restore":
        staff = _load_staff()
        slug = item.get("unit_slug")
        target = None

        def _find(units):
            nonlocal target
            for u in units:
                if _slugify(u.get("slug", "")) == slug:
                    target = u

        for fac in staff.get("faculties", []):
            for sch in fac.get("schools", []):
                _find(sch.get("units", []))
            _find(fac.get("units", []))
        if isinstance(staff.get("units"), list):
            _find(staff["units"])
        if target is None:
            return jsonify({"error": f"the original unit “{item.get('unit_name') or slug}” no longer exists; "
                                     f"recreate it before restoring"}), 409
        # Avoid a duplicate if they already exist there.
        if not any(_person_key(p) == _person_key(item["person"]) for p in target.setdefault("staff", [])):
            target["staff"].append(item["person"])
        _write_staff_markdown(staff)
        _save_trash([it for it in items if it.get("id") != tid])
        return jsonify({"ok": True, "restored": tid, "unit": item.get("unit_name")})
    return jsonify({"error": "unknown action"}), 400


@app.route("/api/staff", methods=["GET", "POST"])
def api_staff():
    if request.method == "POST":
        # Persist the edited faculties tree out to data/*.md (one file per
        # unit). The previous data/ folder is backed up to data/.bak/<ts>/.
        try:
            payload = request.get_json(force=True)
        except Exception as e:
            return jsonify({"error": f"Invalid JSON: {e}"}), 400
        if not isinstance(payload, dict) or "faculties" not in payload:
            return jsonify({"error": "Expected {faculties: [...]} structure"}), 400
        faculties = payload.get("faculties")
        if not isinstance(faculties, list):
            return jsonify({"error": "faculties must be a list"}), 400
        def _check_unit(u):
            if not isinstance(u, dict) or not u.get("slug") or not u.get("name"):
                return "Each unit needs a slug and name"
            for p in u.get("staff", []):
                if not p.get("name"):
                    return "Every staff row needs a name"
            return None
        for f in faculties:
            if not isinstance(f, dict) or not f.get("name"):
                return jsonify({"error": "Each faculty needs a name"}), 400
            for sch in f.get("schools", []):
                if not isinstance(sch, dict) or not sch.get("name"):
                    return jsonify({"error": "Each school needs a name"}), 400
                for u in sch.get("units", []):
                    err = _check_unit(u)
                    if err:
                        return jsonify({"error": err}), 400
            for u in f.get("units", []):
                err = _check_unit(u)
                if err:
                    return jsonify({"error": err}), 400
        # Capture any people removed in this save into the trash (recoverable
        # for 30 days) before overwriting the unit files.
        trashed = 0
        try:
            trashed = _capture_deletions(payload)
        except Exception:   # noqa: BLE001 — never block a save on trash bookkeeping
            trashed = 0
        try:
            count = _write_staff_markdown(payload)
        except Exception as e:
            return jsonify({"error": f"Could not write data files: {e}"}), 500
        return jsonify({"ok": True, "units": count, "trashed": trashed})
    return jsonify(_load_staff())


@app.route("/api/unit-file", methods=["GET", "POST"])
def api_unit_file():
    """Load / Save a single unit's Markdown file.
      GET ?slug=<slug>  → download that unit's .md
      POST <markdown>   → parse an uploaded unit file and save it into data/
    """
    if request.method == "GET":
        slug = _slugify(request.args.get("slug", ""))
        md = _unit_markdown(slug)
        if md is None:
            return jsonify({"error": f"no unit file for slug '{slug}'"}), 404
        return Response(
            md,
            mimetype="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{slug}.md"'},
        )
    # POST — body is the raw Markdown text of one unit file.
    text = request.get_data(as_text=True) or ""
    if not text.strip():
        return jsonify({"error": "empty upload"}), 400
    DATA_DIR.mkdir(exist_ok=True)
    tmp = DATA_DIR / f"_upload_{datetime.now().strftime('%Y%m%d%H%M%S%f')}.md"
    tmp.write_text(text, encoding="utf-8")
    try:
        parsed = _parse_unit_file(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    if not parsed.get("ok"):
        return jsonify({"error": "could not parse uploaded unit file",
                        "warnings": parsed.get("warnings", [])}), 400
    fmt_warn = _format_warning(_scan_generator_format(text))
    if fmt_warn:
        parsed.setdefault("warnings", []).append(fmt_warn)
    global _UNIVERSITY
    if parsed.get("university"):
        _UNIVERSITY = parsed["university"]
    slug = parsed["unit"]["slug"]
    dest = DATA_DIR / f"{_slugify(slug)}.md"
    if dest.exists():
        bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
        bak.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dest, bak / dest.name)
    # Re-serialise to the canonical format — uploaded / newly-created files
    # get the standard header order, full Scholar URLs, and the help block.
    fac = {"name": parsed["faculty"], "url": parsed.get("faculty_url", "")}
    sch = ({"name": parsed["school"], "url": parsed.get("school_url", "")}
           if parsed.get("school") else None)
    dest.write_text(_unit_to_markdown(parsed["unit"], fac, sch), encoding="utf-8")
    return jsonify({"ok": True, "slug": slug, "unit": parsed["unit"]["name"],
                    "staff": len(parsed["unit"]["staff"]),
                    "warnings": parsed.get("warnings", [])})


def _enrich_staff_list(staff):
    out = []
    for p in staff:
        row = dict(p)
        if p.get("scholar_id"):
            cached = _read_cache(p["scholar_id"])
            if cached:
                row["scholar_data"] = cached
        out.append(row)
    return out


def _enrich_units_in_place(container: dict, scope_slugs: set | None) -> int:
    """Walk a faculty/school container, keep only units whose slug is in
    scope (or all if scope_slugs is None), and inline cached Scholar data
    into each kept unit's staff rows. Returns the number of units kept.
    Mutates `container` (faculties[].schools[].units[] and any
    faculties[].units[])."""
    kept = 0

    def _prune_units(units):
        nonlocal kept
        out = []
        for u in units:
            if scope_slugs is not None and _slugify(u.get("slug", "")) not in scope_slugs:
                continue
            u = {**u, "staff": _enrich_staff_list(u.get("staff", []))}
            out.append(u)
            kept += 1
        return out

    for fac in container.get("faculties", []):
        if isinstance(fac.get("units"), list):
            fac["units"] = _prune_units(fac["units"])
        for sch in fac.get("schools", []):
            sch["units"] = _prune_units(sch.get("units", []))
        # Drop now-empty schools so a scoped export isn't full of stubs.
        fac["schools"] = [s for s in fac.get("schools", [])
                          if s.get("units") or not isinstance(s.get("units"), list)]
    # Drop now-empty faculties.
    container["faculties"] = [
        f for f in container.get("faculties", [])
        if f.get("schools") or f.get("units")
    ]
    return kept


@app.route("/api/export.json")
def api_export():
    """JSON snapshot of the current view: the faculty→school→unit tree
    pruned to the requested units, with cached Scholar data inlined into
    each staff row so it re-imports without a re-scrape.
      ?slugs=a,b,c  limit to these unit slugs (omit = whole dataset)
      ?name=        filename base."""
    from flask import Response
    staff_data = _load_staff()
    slugs_arg = request.args.get("slugs", "").strip()
    scope_slugs = {_slugify(s) for s in slugs_arg.split(",") if s.strip()} if slugs_arg else None
    name_arg = request.args.get("name", "").strip()

    payload = {k: v for k, v in staff_data.items() if k != "staff"}
    if isinstance(payload.get("faculties"), list):
        _enrich_units_in_place(payload, scope_slugs)
    elif isinstance(staff_data.get("units"), list):
        src = staff_data["units"]
        if scope_slugs is not None:
            src = [u for u in src if _slugify(u.get("slug", "")) in scope_slugs]
        payload["units"] = [{**u, "staff": _enrich_staff_list(u.get("staff", []))} for u in src]
    payload["_meta"] = _export_meta()
    payload["exported_at"] = payload["_meta"]["exported_at"]   # back-compat alias

    fname_base = re.sub(r"[^A-Za-z0-9._-]+", "-", name_arg).strip("-") or "scholar-dashboard"
    body = json.dumps(payload, indent=2, ensure_ascii=False)
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname_base}-{datetime.now().strftime("%Y%m%d")}.json"'},
    )


@app.route("/api/export-units.zip")
def api_export_units_zip():
    """Shareable export: a .zip of the per-unit Markdown files for the
    given scope. These are the exact files 'Load unit file' ingests, so
    the bundle round-trips into another copy of the app.

      ?slugs=a,b,c   → zip data/a.md, data/b.md, data/c.md
      (no slugs)     → zip every unit file in data/

    A single-slug request still returns a .zip for consistency; the
    frontend offers a direct .md download for the single-unit case."""
    import io, zipfile
    slugs_arg = request.args.get("slugs", "").strip()
    if slugs_arg:
        slugs = [_slugify(s) for s in slugs_arg.split(",") if s.strip()]
    else:
        slugs = [p.stem for p in DATA_DIR.glob("*.md")]
    name = request.args.get("name", "scholar-dashboard").strip() or "scholar-dashboard"
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "scholar-dashboard"

    buf = io.BytesIO()
    written = 0
    ctx = _unit_context_map()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        manifest_slugs = []
        for slug in slugs:
            md = _unit_markdown(slug, ctx)
            if md is not None:
                zf.writestr(f"{_slugify(slug)}.md", md)
                manifest_slugs.append(slug)
                written += 1
        zf.writestr("MANIFEST.json", json.dumps({**_export_meta(), "kind": "units",
                                                  "units": manifest_slugs}, indent=2))
    if not written:
        return jsonify({"error": "no unit files matched the requested scope"}), 404
    buf.seek(0)
    fname = f"{name}-{datetime.now().strftime('%Y%m%d')}.zip"
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Complete bundles (load / save a whole UoA or a whole Faculty) ───────────
# A bundle is one self-contained JSON carrying the unit files, the cached
# Scholar payloads (so pubs travel offline), the REF ratings, the
# institutional profiles, the impact case studies, and the UoA narratives for
# a scope. "Load" ingests it back. Unit data round-trips through the canonical
# per-unit Markdown. The scope is just which units (slugs) are included and,
# for case studies / narratives, which UoAs those units' staff belong to.
_BUNDLE_FORMAT = "scholar-dashboard-bundle"            # current
_UOA_BUNDLE_FORMAT = "scholar-dashboard-uoa-bundle"    # legacy (still imported)
_BUNDLE_FORMATS = {_BUNDLE_FORMAT, _UOA_BUNDLE_FORMAT}


def _assemble_bundle(slugs: list[str], scope: dict) -> dict:
    """Build a bundle for a set of unit slugs. scope = {kind, code, name}.
    For a UoA bundle case studies/narratives are limited to that one UoA; for
    a Faculty (or wider) bundle they cover every UoA represented by the
    in-scope staff."""
    kind = scope.get("kind", "")
    code = str(scope.get("code") or "")
    want = {_slugify(s) for s in slugs if s and str(s).strip()} or None
    units_md: list[dict] = []
    scholar_ids: set[str] = set()
    staff_keys: set[str] = set()
    uoa_codes: set[str] = set()

    def _walk(units, fac, sch):
        for u in units:
            slug = _slugify(u.get("slug", ""))
            if want is not None and slug not in want:
                continue
            units_md.append({"slug": slug, "markdown": _unit_to_markdown(u, fac, sch)})
            unit_uoa = u.get("uoa")
            for person in u.get("staff", []):
                if person.get("scholar_id"):
                    scholar_ids.add(person["scholar_id"])
                staff_keys.add(person.get("staff_id") or person.get("scholar_id") or person.get("name") or "")
                pu = person.get("uoa")
                eff = pu if pu is not None else unit_uoa
                if eff:                      # 0 / None = no UoA
                    uoa_codes.add(str(eff))

    staff_data = _load_staff()
    for fac in staff_data.get("faculties", []):
        for sch in fac.get("schools", []):
            _walk(sch.get("units", []), fac, sch)
        _walk(fac.get("units", []), fac, None)
    if isinstance(staff_data.get("units"), list):
        _walk(staff_data["units"], {"name": staff_data.get("university", "")}, None)

    flags = _load_ref_flags()
    ref_flags = {sid: flags[sid] for sid in scholar_ids if sid in flags}

    scholar_cache: dict = {}
    for sid in scholar_ids:
        p = _cache_path(sid)
        if p.exists():
            try:
                scholar_cache[sid] = json.loads(p.read_text())
            except (OSError, ValueError):
                pass

    try:
        smeta = json.loads(SCHOLAR_META_FILE.read_text())
    except (OSError, ValueError):
        smeta = {}
    scholar_meta = {k: v for k, v in smeta.items() if k in staff_keys}

    # A UoA bundle is exactly that UoA; a wider bundle covers every UoA its
    # staff belong to.
    uoa_filter = {code} if (kind == "uoa" and code) else uoa_codes
    cases = [c for c in _load_case_studies().values() if str(c.get("uoa")) in uoa_filter]

    try:
        umeta = json.loads(UOA_META_FILE.read_text())
    except (OSError, ValueError):
        umeta = {}
    uoa_meta = {c: umeta.get(c, {"narrative": ""}) for c in uoa_filter}

    bundle = {
        "_meta": {**_export_meta(), "kind": "bundle", "format": _BUNDLE_FORMAT},
        "scope": {"kind": kind, "code": code or None, "name": scope.get("name", "")},
        "units": units_md,
        "scholar_cache": scholar_cache,
        "ref_flags": ref_flags,
        "scholar_meta": scholar_meta,
        "case_studies": cases,
        "uoa_meta": uoa_meta,
    }
    if kind == "uoa":   # back-compat: older readers expect a top-level `uoa`
        bundle["uoa"] = {"code": code, "name": scope.get("name", "")}
    return bundle


def _bundle_filename(kind: str, base: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", base or "bundle").strip("-") or "bundle"
    suffix = {"uoa": "_UoA", "faculty": "_Faculty", "school": "_School"}.get(kind, "_bundle")
    return f"{base}{suffix}.json"


@app.route("/api/bundle.json")
def api_bundle_get():
    """Export a scope bundle. ?kind=uoa|faculty|school|all, ?code=NN (UoA),
    ?slugs=a,b,c (the units in scope), ?name= (display), ?file= (filename base)."""
    kind = (request.args.get("kind") or "uoa").strip()
    code = (request.args.get("code") or request.args.get("uoa") or "").strip()
    name = request.args.get("name", "")
    slugs = [s for s in request.args.get("slugs", "").split(",") if s.strip()]
    if not slugs:
        return jsonify({"error": "no units in scope to bundle"}), 400
    bundle = _assemble_bundle(slugs, {"kind": kind, "code": code, "name": name})
    base = request.args.get("file") or (f"uoa-{code}" if kind == "uoa" else (name or kind))
    body = json.dumps(bundle, indent=2, ensure_ascii=False)
    return Response(body, mimetype="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{_bundle_filename(kind, base)}"'})


@app.route("/api/uoa-bundle.json")
def api_uoa_bundle_get():
    """Back-compat UoA export. Prefer /api/bundle.json?kind=uoa."""
    code = (request.args.get("code") or request.args.get("uoa") or "").strip()
    if not code:
        return jsonify({"error": "code (UoA) required"}), 400
    slugs = [s for s in request.args.get("slugs", "").split(",") if s.strip()]
    bundle = _assemble_bundle(slugs, {"kind": "uoa", "code": code, "name": request.args.get("name", "")})
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", request.args.get("file") or f"uoa-{code}").strip("-") or f"uoa-{code}"
    body = json.dumps(bundle, indent=2, ensure_ascii=False)
    return Response(body, mimetype="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{base}_UoA.json"'})


@app.route("/api/bundle-import", methods=["POST"])
@app.route("/api/uoa-bundle-import", methods=["POST"])   # legacy route alias
def api_bundle_import():
    """Ingest a bundle (UoA or Faculty; current or legacy format). Body = the
    bundle JSON. Non-destructive: unit files are backed up before overwrite,
    and ref-flags / scholar-meta / case studies / narratives are merged."""
    bundle = request.get_json(force=True, silent=True) or {}
    meta = bundle.get("_meta") or {}
    if meta.get("format") not in _BUNDLE_FORMATS and meta.get("kind") not in ("bundle", "uoa-bundle"):
        return jsonify({"error": "this file is not a Scholar Dashboard bundle"}), 400
    warnings = []
    w = _format_warning(meta.get("format_version"))
    if w:
        warnings.append(w)
    summary = {"units": 0, "scholars": 0, "case_studies": 0, "ref_flags": 0, "narratives": 0, "removed": 0}
    scope = bundle.get("scope") or {}
    overwrite = bool(bundle.get("overwrite") or request.args.get("overwrite"))

    # 0. Overwrite mode — clear the existing scope first so a re-import leaves
    #    no stray data behind. Faculty: drop the faculty's current unit files
    #    (the bundle re-supplies the full set). UoA: drop that UoA's existing
    #    case studies (the bundle re-supplies them); units/relations are left
    #    alone since a UoA's units can carry other-UoA staff.
    if overwrite:
        if scope.get("kind") == "faculty" and scope.get("name"):
            ctx = _unit_context_map()
            for slug, (_u, fac, _sch) in ctx.items():
                if (fac.get("name") or "") == scope["name"]:
                    p = DATA_DIR / f"{slug}.md"
                    if p.exists():
                        bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
                        bak.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(p, bak / p.name)
                        p.unlink()
                        summary["removed"] += 1
        elif scope.get("kind") == "uoa" and scope.get("code"):
            cs = _load_case_studies()
            drop = [cid for cid, c in cs.items() if str(c.get("uoa")) == str(scope["code"])]
            for cid in drop:
                cs.pop(cid, None)
            if drop:
                _save_case_studies(cs)
                summary["removed"] += len(drop)

    # 1. Unit Markdown files (canonical text round-trips as-is).
    DATA_DIR.mkdir(exist_ok=True)
    for u in bundle.get("units", []):
        slug = _slugify(u.get("slug", ""))
        text = u.get("markdown", "")
        if not slug or not text.strip():
            continue
        dest = DATA_DIR / f"{slug}.md"
        if dest.exists():
            bak = DATA_DIR / ".bak" / datetime.now().strftime("%Y%m%d-%H%M%S")
            bak.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, bak / dest.name)
        dest.write_text(text, encoding="utf-8")
        summary["units"] += 1

    # 2. Cached Scholar payloads (pubs) — write straight to the cache.
    CACHE_DIR.mkdir(exist_ok=True)
    for sid, payload in (bundle.get("scholar_cache") or {}).items():
        try:
            _cache_path(sid).write_text(json.dumps(payload, indent=2))
            summary["scholars"] += 1
        except (OSError, TypeError):
            pass

    # 3. REF ratings — merge per scholar.
    flags = _load_ref_flags()
    for sid, m in (bundle.get("ref_flags") or {}).items():
        if isinstance(m, dict):
            flags.setdefault(sid, {}).update(m)
            summary["ref_flags"] += len(m)
    _save_ref_flags(flags)

    # 4. Institutional profiles — merge by key.
    try:
        smeta = json.loads(SCHOLAR_META_FILE.read_text())
    except (OSError, ValueError):
        smeta = {}
    smeta.update(bundle.get("scholar_meta") or {})
    try:
        SCHOLAR_META_FILE.write_text(json.dumps(smeta, indent=2, ensure_ascii=False))
    except OSError:
        pass

    # 5. Impact case studies — upsert by id.
    data = _load_case_studies()
    for i, c in enumerate(bundle.get("case_studies") or []):
        cid = c.get("id") or ("cs-" + datetime.now().strftime("%Y%m%d%H%M%S%f") + str(i))
        c["id"] = cid
        data[cid] = c
        summary["case_studies"] += 1
    _save_case_studies(data)

    # 6. UoA narratives. Accept the new {code: {narrative}} map and the legacy
    #    single {narrative} object (keyed by scope.code / uoa.code).
    um = bundle.get("uoa_meta") or {}
    try:
        allmeta = json.loads(UOA_META_FILE.read_text())
    except (OSError, ValueError):
        allmeta = {}
    pairs = []
    if "narrative" in um:
        code = str((bundle.get("scope") or {}).get("code") or (bundle.get("uoa") or {}).get("code") or "")
        if code:
            pairs.append((code, um))
    else:
        pairs = [(str(c), v) for c, v in um.items() if isinstance(v, dict)]
    for c, v in pairs:
        if (v.get("narrative") or "").strip():
            allmeta[c] = {"narrative": v["narrative"]}
            summary["narratives"] += 1
    if summary["narratives"]:
        try:
            UOA_META_FILE.write_text(json.dumps(allmeta, indent=2, ensure_ascii=False))
        except OSError:
            pass

    scope = bundle.get("scope") or {}
    return jsonify({"ok": True, "summary": summary, "warnings": warnings,
                    "kind": scope.get("kind") or ("uoa" if bundle.get("uoa") else "bundle"),
                    "name": scope.get("name") or (bundle.get("uoa") or {}).get("name", "")})


@app.route("/api/scholar-batch")
def api_scholar_batch():
    """Return cached payloads for a comma-separated list of scholar_ids in
    one shot, so the frontend can hydrate a whole grid (potentially hundreds
    of cards) without firing one request per card. Only serves cache hits —
    missing or expired entries come back as {"error": "..."} so the caller
    can decide whether to re-fetch them individually."""
    ids_arg = request.args.get("ids", "")
    ids = [i.strip() for i in ids_arg.split(",") if i.strip() and i.strip() != "null"]
    out = {}
    for sid in ids:
        cached = _read_cache(sid)
        if cached:
            cached = {**cached, "_from_cache": True}
            out[sid] = cached
        else:
            out[sid] = {"error": "no fresh cache; refresh individually"}
    return jsonify(out)


@app.route("/api/scholar-cache-index")
def api_scholar_cache_index():
    """Return a compact freshness map of every cached Scholar profile:
    { "<scholar_id>": {"fetched_at": <epoch>, "fetched_iso": "..."}, ... }.

    Used by the Data editor to flag stale rows (> 30 days) without firing a
    fetch per row. Reads each cache file's metadata field only — cheap enough
    for ~hundreds of files."""
    out = {}
    if not CACHE_DIR.exists():
        return jsonify(out)
    for f in CACHE_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        fetched_at = data.get("_fetched_at")
        # Fall back to file mtime for any pre-existing cache file that predates
        # the _fetched_at field.
        if not fetched_at:
            try:
                fetched_at = f.stat().st_mtime
            except OSError:
                continue
        out[f.stem] = {
            "fetched_at": fetched_at,
            "fetched_iso": data.get("_fetched_iso", ""),
        }
    return jsonify(out)


@app.route("/api/scholar/<scholar_id>", methods=["GET", "DELETE"])
def api_scholar(scholar_id: str):
    if not scholar_id or scholar_id == "null":
        return jsonify({"error": "no scholar_id set for this staff member"}), 404

    # DELETE drops the cached payload so the next GET refetches from Scholar.
    # Useful from the Data editor when a cache looks corrupted or stale and the
    # 7-day TTL hasn't elapsed yet.
    if request.method == "DELETE":
        p = _cache_path(scholar_id)
        existed = p.exists()
        if existed:
            try:
                p.unlink()
            except OSError as e:
                return jsonify({"error": f"could not delete cache: {e}"}), 500
        return jsonify({"ok": True, "cleared": existed, "scholar_id": scholar_id})

    refresh = request.args.get("refresh") == "1"
    if not refresh:
        cached = _read_cache(scholar_id)
        if cached:
            cached["_from_cache"] = True
            return jsonify(cached)

    # About to hit Scholar — bail early if we're inside the cooldown window
    # from a recent 429. The cooldown protects us from making the rate-limit
    # worse with repeated requests. `force=1` explicitly opts out (user
    # accepts the risk that Scholar may still 429).
    global _scholar_rl_until
    force = request.args.get("force") == "1"
    now = time.time()
    if not force and now < _scholar_rl_until:
        remaining = int(_scholar_rl_until - now)
        return jsonify({
            "error": f"Scholar rate-limit cooldown active ({remaining}s remaining)",
            "cooldown_remaining_seconds": remaining,
        }), 429

    try:
        data = _fetch_scholar(scholar_id)
    except Exception as e:
        msg = str(e)
        # Detect 429 / captcha and trip the cooldown.
        if "429" in msg or "rate-limit" in msg.lower() or "captcha" in msg.lower() or "unusual traffic" in msg.lower():
            _scholar_rl_until = time.time() + SCHOLAR_COOLDOWN_SECONDS
            _save_cooldown(_scholar_rl_until)
            return jsonify({
                "error": f"Scholar rate-limited; cooldown engaged for {SCHOLAR_COOLDOWN_SECONDS // 60} min",
                "cooldown_remaining_seconds": SCHOLAR_COOLDOWN_SECONDS,
            }), 429
        return jsonify({"error": f"Scholar fetch failed: {e}"}), 502

    _write_cache(scholar_id, data)
    data["_from_cache"] = False
    return jsonify(data)


def _open_browser_when_ready(port: int, delay: float = 0.8) -> None:
    """Background thread that waits for the server to start, then opens
    the default browser. Only used when running as a packaged .app — the
    dev workflow already prints the URL to the terminal."""
    import threading
    import webbrowser
    def _go():
        time.sleep(delay)
        try:
            webbrowser.open(f"http://localhost:{port}")
        except Exception:
            pass
    threading.Thread(target=_go, daemon=True).start()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5057"))
    _start_idle_watchdog()
    if _FROZEN:
        # Packaged .app double-click flow: open the browser after a beat
        # and run Flask in plain production mode (no debug, no reloader).
        _open_browser_when_ready(port)
        app.run(debug=False, port=port, use_reloader=False)
    else:
        # Dev flow: leave debug on for the friendlier tracebacks, but
        # keep use_reloader=False so the idle watchdog doesn't kill the
        # reloader's parent process.
        app.run(debug=True, port=port, use_reloader=False)
