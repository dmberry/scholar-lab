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
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, request, send_from_directory

ROOT = Path(__file__).parent
CACHE_DIR = ROOT / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
DATA_DIR = ROOT / "data"   # one Markdown file per unit lives here

# App version — surfaced in the toolbar and via /api/version.
__version__ = "0.2.26"
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
IDLE_TIMEOUT_SECONDS = 60 * 20  # 20 minutes
_last_request_at = time.time()
_IDLE_EXCLUDED_PATHS = {"/api/heartbeat"}


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
        if time.time() - _last_request_at >= IDLE_TIMEOUT_SECONDS:
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            except OSError:
                pass
            return


def _start_idle_watchdog():
    import threading
    t = threading.Thread(target=_idle_watchdog, daemon=True)
    t.start()

# REF 2029 publication window: 1 January 2021 – 31 December 2028.
REF_START_YEAR_PY = 2021
REF_END_YEAR_PY   = 2028


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
#   - Ada Example | Professor of Ethics | 000001 | 22sLFVoAAAAJ | set | uoa:30
#   - Bob Placeholder | Associate Professor | 000002 | | missing | uoa:34
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


def _unit_to_markdown(unit: dict, faculty: dict, school: dict | None) -> str:
    """Serialise one unit (with its faculty/school context) to a Markdown
    unit file. Canonical output — re-serialising is idempotent."""
    L = [f"University: {_UNIVERSITY}",
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
            rows.append({
                "title": title, "authors": authors, "venue": venue,
                "year": year, "num_citations": num_citations or 0,
            })
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


@app.route("/api/version")
def api_version():
    return jsonify({"version": __version__})


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
        try:
            count = _write_staff_markdown(payload)
        except Exception as e:
            return jsonify({"error": f"Could not write data files: {e}"}), 500
        return jsonify({"ok": True, "units": count})
    return jsonify(_load_staff())


@app.route("/api/unit-file", methods=["GET", "POST"])
def api_unit_file():
    """Load / Save a single unit's Markdown file.
      GET ?slug=<slug>  → download that unit's .md
      POST <markdown>   → parse an uploaded unit file and save it into data/
    """
    if request.method == "GET":
        slug = _slugify(request.args.get("slug", ""))
        path = DATA_DIR / f"{slug}.md"
        if not path.exists():
            return jsonify({"error": f"no unit file for slug '{slug}'"}), 404
        return Response(
            path.read_text(encoding="utf-8"),
            mimetype="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
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


@app.route("/api/export.json")
def api_export():
    """Full faculty dump: every unit, every staff row, with cached Scholar data inlined."""
    from flask import Response
    staff_data = _load_staff()

    if isinstance(staff_data.get("units"), list):
        units_out = [{**{k: v for k, v in u.items() if k != "staff"},
                      "staff": _enrich_staff_list(u.get("staff", []))}
                     for u in staff_data["units"]]
        payload = {
            **{k: v for k, v in staff_data.items() if k != "units"},
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "units": units_out,
        }
        fname_base = "scholar-dashboard"
    else:
        payload = {
            **{k: v for k, v in staff_data.items() if k != "staff"},
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "staff": _enrich_staff_list(staff_data.get("staff", [])),
        }
        fname_base = (staff_data.get("unit") or "unit").lower().replace(" ", "-").replace(",", "")

    body = json.dumps(payload, indent=2, ensure_ascii=False)
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname_base}-{datetime.now().strftime("%Y%m%d")}.json"'},
    )


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5057"))
    # debug=True would run the reloader and spawn two watchdog threads,
    # one of which would idle-kill the parent. Disable the reloader.
    _start_idle_watchdog()
    # use_reloader=False: the reloader would spawn a parent + child process
    # and the parent would idle-kill itself, leaving an orphaned child.
    app.run(debug=True, port=port, use_reloader=False)
