# Scholar Dashboard

A staff metrics dashboard that surfaces Google Scholar citations, h-index,
and REF 2029 Unit-of-Assessment readiness at unit, school, and faculty level.

**Version:** 0.2.55 · proof-of-concept.

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
- **REF flagging & star ratings**: on a person's card, rate each in-window
  output *Not REF / 1\* / 2\* / 2–3\* / 3\* / 3–4\* / 4\** (the in-between bands
  store as 2.5 / 3.5). The **REF** chip redraws each card's chart to show only
  the years with a selected output (empty years show N/A). The REF *exercise
  year* and window are configurable in Settings (year floored at 2029).
- **GPA & quality profile**: reports compute a mean output GPA per scholar and
  per UoA, plus a star-band profile (% at each band). The **Analytics** REF
  readiness scorecard (which defaults to grouping by UoA) counts the actual
  selected outputs and impact case studies — not a venue heuristic.
- **Text / rich-text reports**: the REF selection and UoA reports have a
  *Text version* button that renders the data as text (charts → text) to copy
  (as rich text or Markdown) into other documents. All reports are datestamped.
- **Case-study inclusion slots**: each impact case study can be slotted as
  *№N of the total required* for the UoA (unique), or left as a *Draft /
  candidate*. A **Data → Manage impact case studies** modal reassigns them
  between UoAs, surfaces unassigned ones, and deletes unwanted ones.
- **Danger Zone** (Settings): delete a whole faculty (type-to-confirm) or
  clear a UoA's relations (untags units/people, unassigns its case studies —
  underlying data kept). Loading a bundle that collides with an existing
  faculty/UoA offers to overwrite (clearing stale data first) or merge.
- **Reports**: a **Report** button beside the UoA selector builds the full UoA
  report — a colour-coded Red/Amber/Green readiness dashboard, quality profile,
  narrative/environment, selected outputs with ratings, and every impact case
  study (printable). **REF → REF selection report** lists flagged outputs and
  GPA per scholar for the current view.
- **Impact case studies (REF3)**: per-UoA editor with status workflow and a
  version log; references picked by scholar → output; contributors auto-suggested
  from the referenced outputs' authors, then freely editable; Markdown
  import/export (+ template in `docs/`).
- **Complete bundles**: *File → Save UoA…* (in By-UoA view) or *Save Faculty
  bundle…* (in By-Faculty view) writes one self-contained `…_UoA.json` /
  `…_Faculty.json` — units, cached publications with ratings, profiles, every
  impact case study and the UoA narratives for the scope; *Load…* re-imports
  either. The File menu is mode-aware (UoA mode deals only in bundles). Every
  export carries a version stamp and imports warn on a newer format.
- **Configurable data folder**: relocate it from *Settings → Data & reset*
  (backup-first copy), with a **Show Folder** button to reveal it.
- **Help menu**: an in-app guide to the whole workflow.
- **Analytics modal**: cross-unit visibility, citation totals, REF readiness,
  momentum, cross-listings, citation history.
- **Data editor**: add / edit / remove faculties, schools, units, and staff.
- **Native menu bar**: File · View · Data · REF · Export · Help, plus a
  one-click Analytics button.
- Server-side Scholar cache (7-day TTL) in `.cache/`; force-refresh per card
  or the whole view. A **10-minute server cooldown** is auto-engaged after a
  Scholar 429 / captcha so repeated retries don't make things worse.

## Architecture

- `app.py` — Flask backend. Scrapes Google Scholar profile pages directly
  (`requests` + `BeautifulSoup` with a browser User-Agent — the `scholarly`
  library is fingerprinted and blocked). Endpoints: `/api/staff`,
  `/api/scholar/<id>` (GET + DELETE), `/api/scholar-batch`,
  `/api/scholar-cache-index`, `/api/unit-file` (GET + POST),
  `/api/version`, `/api/export.json`, `/api/ref-flag`, `/api/ref-targets`,
  `/api/case-study(.md)`, `/api/uoa-bundle.json` (+ import),
  `/api/data-location`, `/api/choose-folder`, `/api/open-folder`.
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

- Ada Example | Professor of Examples | 000001 | https://scholar.google.com/citations?user=22sLFVoAAAAJ&hl=en | set | uoa:30
- Bob Placeholder | Lecturer in Placeholders | 000002 | | missing | uoa:28
```

The app globs `data/*.md`, parses each file, and rebuilds the
University → Faculty → School → Unit tree. Parsing is forgiving: a malformed
line is skipped and reported, never fatal; a unit file missing its
Faculty/School headers loads under "Unfiled".

The `data/` folder is **gitignored** (it holds personal data). Copy
`data.example/` to `data/` to get started, or use the in-app Data editor
(Toolbar → **Data ▾** → Edit data) or **Data ▾ → New unit** to create the
first file.

## Three-state Scholar tracking

Each person has a `status`:

| Status | Meaning |
|---|---|
| `set` | Profile confirmed, `scholar_id` populated, live fetch works. |
| `missing` | No profile exists, or the person has chosen not to maintain one. |
| `unchecked` | Not yet verified. |

## Run it

### Easiest path — download the packaged app (macOS)

Grab the latest `Scholar-Dashboard-<version>-macos.zip` from the
[GitHub Releases](https://github.com/dmberry/scholar-lab/releases) page.
Unzip, drag **Scholar Dashboard.app** to your Applications folder, and
double-click. No Python install required.

On first launch it seeds an example faculty into
`~/Library/Application Support/Scholar Dashboard/data/` and opens the
browser at <http://localhost:5057>. Use the in-app **Data** editor or
**＋ Unit** to add your own people; everything you add lives in that
Application Support folder and persists across app upgrades.

The first launch may show macOS's *"unidentified developer"* warning —
right-click → **Open** clears it permanently.

### Source-tree path (if you cloned the repo)

Two options, both included in the source tree.

**Option 1: Scholar-Dashboard.app** in the repo root (no Terminal window)

Double-click **`Scholar-Dashboard.app`** in Finder. It silently bootstraps
a venv on first run, starts the server in the background, and opens the
browser. The repo's data folder is used, not Application Support.

**Option 2: start.command** (shows a Terminal window with live logs)

Double-click **`start.command`** in Finder. Same bootstrap as above, but
Flask runs in the foreground so you can see logs. Ctrl-C stops the server.

To stop a backgrounded server, double-click **`stop.command`**.

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

### Building the release package

To produce a fresh **Scholar Dashboard.app** + zip for distribution:

```bash
./build.sh                     # writes dist/Scholar Dashboard.app + zip
./build.sh --no-zip            # skip the zip step (faster iteration)
```

PyInstaller bundles Python + Flask + BeautifulSoup + requests + the
frontend assets into a self-contained `.app`. The build uses a
separate `.venv-build/` so it doesn't pollute your dev venv.

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

## Recent additions (0.2.51 – 0.2.53)

- Per-output **REF star ratings** (Not REF / 1\* … 4\*, with 2–3\* and 3–4\*
  bands stored as 2.5 / 3.5); REF chip charts flagged years only with N/A gaps.
- Configurable **REF exercise year + window** (Settings), floored at 2029 with a
  change warning.
- **Mean GPA** per scholar / per UoA and a **quality profile** bar in both
  reports; a colour-coded **Red/Amber/Green readiness dashboard** atop the UoA
  report (outputs vs target, GPA, % rated, case-study progress).
- **Faceted pickers** in the case-study editor: references by scholar → output,
  contributors auto-suggested from the referenced authors then editable.
- **Complete-UoA bundles** (`…_UoA.json`) for save/load; **version-stamped
  exports** with import-time compatibility warnings.
- **Report** button beside the UoA selector; **Help** menu with an in-app guide.
- **Relocatable data folder** with backup-first copy and a Show-Folder reveal.

## Earlier additions (0.2.0)

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
