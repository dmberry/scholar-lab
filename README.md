# Scholar Dashboard

A staff metrics dashboard that surfaces Google Scholar citations, h-index,
and REF 2029 Unit-of-Assessment readiness at unit, school, and faculty level.

**Version:** 0.2.19 · proof-of-concept.

## What it does

- Browse staff **By Faculty** (Faculty → School → Unit) or **By UoA**.
- Each person gets a card: citations / h-index / i10-index (lifetime + 5-year),
  a 20-year citation sparkline with the REF 2029 window (2021–2028) highlighted,
  and their two most recent publications.
- Click a card → modal with the full Scholar profile, including a deep-dive
  raw-payload panel, a subtle ↻ Refresh button, and (on failure) a clickable
  Scholar URL + Retry button.
- **UoA tagging**: tag a unit's default UoA, override per person; the UoA chip
  on each card is click-to-edit (centred picker with all 34 UoAs, current
  highlighted).
- **Stack-by-role** view: per-role bar chart + section-headed cards, with a
  Distribution panel (Most common role, Shape, mini Bell-Curve Comparison)
  and a Role Spread / Data Coverage strip below.
- **Overview** mode: one Staff-by-role card per unit in the current scope —
  no individual people cards. Useful for school/faculty-wide views.
- **Copy-as-image**: every Staff-by-role card has a 📋 button that copies a
  PNG of the card to your clipboard (or downloads it).
- **Hide emeritus** and **Hide visiting** toggles in the sort bar.
- **Analytics modal**: cross-unit visibility, citation totals, REF readiness,
  momentum, cross-listings, citation history.
- **Data editor**: add / edit / remove faculties, schools, units, and staff.
- **Toolbar New / Load / Save unit file** controls and per-unit ⤓ download.
- Server-side Scholar cache (7-day TTL) in `.cache/`; force-refresh per card
  or the whole view. A **10-minute server cooldown** is auto-engaged after a
  Scholar 429 / captcha so repeated retries don't make things worse.

## Architecture

- `app.py` — Flask backend. Scrapes Google Scholar profile pages directly
  (`requests` + `BeautifulSoup` with a browser User-Agent — the `scholarly`
  library is fingerprinted and blocked). Endpoints: `/api/staff`,
  `/api/scholar/<id>` (GET + DELETE), `/api/scholar-batch`,
  `/api/scholar-cache-index`, `/api/unit-file` (GET + POST),
  `/api/version`, `/api/export.json`.
- `index.html` / `style.css` / `app.js` — framework-free static frontend,
  served by Flask.

## Data files

Staff data lives as **one Markdown file per unit** in `data/`. Each file is
self-contained — it declares its University / Faculty / School in a short
header, then lists staff as bullet lines:

```
University: University of X
Faculty: Example Faculty
School: School of Example Studies
Unit: Philosophy
Slug: philosophy
UoA: 30
Active: yes

# ── Staff ──────────────────────────────────────────────────────────
# One person per line. Fields are pipe-separated, in this fixed order:
#
#   - Name | Title | Staff ID | Google Scholar URL | status | uoa:NN
#
#   status  = set | missing | unchecked
#   Scholar = full profile URL, or blank if no profile
#   uoa:NN  = optional; overrides this unit's UoA. uoa:0 = explicitly none.
#   Lines starting with '#' are comments, ignored when the file is read.

- Ada Example | Professor of Ethics | 000001 | https://scholar.google.com/citations?user=22sLFVoAAAAJ&hl=en | set | uoa:30
- Bob Placeholder | Associate Professor | 000002 | | missing | uoa:34
```

The app globs `data/*.md`, parses each file, and rebuilds the
University → Faculty → School → Unit tree. Parsing is forgiving: a malformed
line is skipped and reported, never fatal; a unit file missing its
Faculty/School headers loads under "Unfiled".

The `data/` folder is **gitignored** (it holds personal data). Copy
`data.example/` to `data/` to get started, or use the in-app Data editor
(Toolbar → ⚙ Data) or **+ New unit** to create the first file.

## Three-state Scholar tracking

Each person has a `status`:

| Status | Meaning |
|---|---|
| `set` | Profile confirmed, `scholar_id` populated, live fetch works. |
| `missing` | No profile exists, or the person has chosen not to maintain one. |
| `unchecked` | Not yet verified. |

## Run it

### Easy path (macOS — double-click)

Two options, both included in the repo.

**Option 1: Scholar Dashboard.app** (no Terminal window)

Double-click **`Scholar Dashboard.app`** in Finder. It silently bootstraps
the venv on first run, starts the server in the background, and opens the
browser to <http://localhost:5057>. The .app icon goes away after launch
— the server runs detached. Drag the .app to **Applications** or your
**Dock** if you'd like it elsewhere; it still finds the project files
because it lives inside the repo folder.

To stop the server later, double-click **`stop.command`**.

**Option 2: start.command** (shows a Terminal window with live logs)

Double-click **`start.command`** in Finder. Same bootstrap as above, but
Flask runs in the foreground so you can see logs in the Terminal window.
Ctrl-C in that window stops the server.

Either way, the first launch may show macOS's *"unidentified developer"*
warning — right-click → **Open** clears it permanently.

### Manual path (any platform)

```bash
cd scholar-dashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp -r data.example data        # first run only
python app.py
# open http://localhost:5057
```

## PDF print

The dashboard has a print stylesheet. **⤓ Export PDF** opens the browser
print dialog; pick "Save as PDF". `@page { margin: 0 }` is used to suppress
the browser-injected URL/date header in the PDF — if your browser still
shows them, untick "Headers and footers" in the print dialog.

## Caveats

- **Google Scholar rate-limits hard.** A 7-day cache plus a 10-min server
  cooldown after each 429 keep normal use safe. Refresh small batches (one
  unit at a time) rather than the whole institution in one go.
- **Practice-based output won't appear.** Scholar indexes formal publications;
  for practice-led disciplines the metrics under-represent the work.
- **Not a research-quality bibliometric tool.** Scholar is noisy (duplicates,
  citation inflation, mis-attribution). Treat the numbers as indicative.

## Recent additions (0.2.0)

- Markdown data layer (per-unit `data/*.md`, resilient parser, canonical
  re-serialiser, /api/unit-file Load/Save endpoints).
- REF 2029 UoA tagging at unit + person level; By-UoA tab; UoA chip on cards
  and in the modal; unified UoA picker with No-UoA option.
- Stack-by-role view: role bar chart + Distribution stats + Role Spread
  mini bar + Data Coverage + mini Bell-Curve Comparison.
- Overview mode: per-unit role-distribution cards on a single page.
- Copy-card-as-image (PNG to clipboard, falls back to download).
- Toolbar: New / Load / Save unit, Hide emeritus / visiting toggles.
- Per-card and per-modal retry buttons; clickable Scholar URL on failure.
- Sort selection persists across faculty / school / unit / view changes.
- Server-side Scholar rate-limit cooldown (`429` cooldown lasts 10 min).
- Print: `break-inside: avoid` on cards; `@page { margin: 0 }` to hide the
  browser's URL/date header in saved PDFs.
- De-branded to an institution-neutral codebase; `sussex_id` → `staff_id`.
