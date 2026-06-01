# Prepopulating Scholar Dashboard data with an LLM / agent

This guide explains how to get an LLM (ChatGPT, Claude, etc.) to build the data
files Scholar Dashboard loads — a **unit**, a whole **faculty**, or the people
for a **Unit of Assessment (UoA)** — so you don't have to type rosters by hand.

The copy-and-paste prompt at the bottom is also available in the app:
**Help → Generate data with an LLM…** (a Copy button puts it on your clipboard).

---

## How it works (read this first)

Scholar Dashboard stores each **unit** (department/group) as one human-readable
**Markdown file**. The file lists people, their titles, their Google Scholar
profile URL, and their UoA tags. You load it with **File → Load unit file…**

> **The app fetches the metrics, not the LLM.** Citations, h-index, i10 and the
> citation history are scraped live from Google Scholar after you load the file
> and run **Data → Refresh Scholar data**. So the LLM's job is only to build the
> *roster* — names, titles, and the correct **Scholar profile URL** for each
> person. Never let an LLM invent citation counts or Scholar IDs; leave the
> Scholar field blank if it can't find a real profile.

A **faculty** is just several unit files (one per department). A **UoA** view is
assembled automatically from whichever people are tagged to that UoA across all
units — so "prepopulating a UoA" means tagging people with `uoa:NN`.

---

## The unit file format

A unit file is plain text. Header lines are `Key: value`; staff are bullet
lines; lines starting with `#` are comments and are ignored.

```
University: University of Example
Faculty: Faculty of Arts and Humanities
Faculty-URL: https://example.ac.uk/arts
School: School of Media and Film
Unit: Department of Film Studies
Slug: film-studies
UoA: 33
Active: yes

# Staff — one person per line, fields pipe-separated, in this fixed order:
#   - Name | Title | Staff ID | Google Scholar URL | status | uoa:NN
- Jane Doe | Professor of Film | 100234 | https://scholar.google.com/citations?user=AbCdEfG | set
- John Roe | Senior Lecturer | 100235 | https://scholar.google.com/citations?user=HiJkLmN | set
- Sam Penrose | Lecturer | 100236 |  | missing
- Asha Bello | Reader in Film | 100237 | https://scholar.google.com/citations?user=OpQrStU | set | uoa:34
```

### Header fields

| Field | Required | Notes |
|-------|----------|-------|
| `University:` | recommended | Institution name. |
| `Faculty:` | **yes** | Groups units in the By-Faculty tree. Same spelling across files = same faculty. |
| `Faculty-URL:` | optional | Faculty homepage. |
| `School:` | optional | Mid-level grouping under the faculty. Omit for a flat faculty → unit tree. |
| `Unit:` | **yes** | The department/group name. Without it the file is rejected. |
| `Slug:` | recommended | Filename-safe id (`lower-case-hyphens`). If omitted it's derived from the unit name. Must be unique per unit. |
| `UoA:` | optional | The unit's **default** REF Unit of Assessment, a number **1–34**. Each person inherits it unless they override with `uoa:NN`. |
| `Active:` | optional | `yes` (default) or `no` to disable a unit. |

### Staff line: `- Name | Title | Staff ID | Scholar | status | uoa:NN`

- **Name** — full name (required; a line with no name is skipped).
- **Title** — e.g. *Professor of X*, *Senior Lecturer*, *Reader*, *Lecturer*,
  *Research Fellow*. Used for the "stack by role" analytics, so keep it a real
  academic title where possible.
- **Staff ID** — any internal identifier, or leave blank.
- **Scholar** — the person's **full Google Scholar profile URL**
  (`https://scholar.google.com/citations?user=…`) or just the bare profile id.
  Leave **blank** if there is no profile / you can't verify one.
- **status** — one of:
  - `set` — has a Scholar profile (use whenever a Scholar URL is present).
  - `missing` — confirmed to have **no** Scholar profile.
  - `unchecked` — not yet looked up.
  - If omitted, the app infers `set` when a Scholar URL is present, else `unchecked`.
- **uoa:NN** — optional **per-person** UoA override (1–34). `uoa:0` means
  "explicitly no UoA" (e.g. professional-services staff). Omit to inherit the
  unit's `UoA:`. Trailing fields are optional.

---

## Rules for the agent

1. **One file per unit.** A department with 40 staff = one file with 40 bullet
   lines. A faculty of six departments = six files (same `Faculty:` value).
2. **Find real Scholar profiles; never fabricate them.** Search for each
   person's Google Scholar profile and use its real URL. If you are not
   confident it is the right person, leave the Scholar field blank and set
   status `missing` or `unchecked`. A wrong profile is worse than none.
3. **Never invent metrics.** Do not add citation counts, h-index, or publication
   lists. The app scrapes those from Scholar after loading.
4. **UoA codes are 1–34** (REF 2029 Units of Assessment). Use the unit's
   discipline to pick a sensible default `UoA:`; override individuals with
   `uoa:NN` only where they genuinely belong to a different UoA. Use `uoa:0` for
   people who should not be returned (e.g. administrators).
5. **Keep titles real.** Prefer standard academic ranks so the role analytics
   work.
6. **Slugs are unique, lower-case, hyphenated**, derived from the unit name.
7. **Output plain text/Markdown**, one fenced code block per unit, and state the
   suggested filename (`<slug>.md`) above each block. No prose inside the block.

---

## Loading what the agent produces

1. Save each block as `<slug>.md`.
2. In Scholar Dashboard: **File → Load unit file…** and pick the file
   (repeat for each unit in a faculty).
3. **Data → Refresh Scholar data** to fetch citations/h-index for everyone with
   a Scholar URL. Google rate-limits, so a large faculty may fetch in batches —
   if a card errors, wait a few minutes rather than hammering Refresh.
4. Switch to **By UoA** to see everyone tagged to each Unit of Assessment.

> **Tip:** build a small unit first (5–10 people), load it, and confirm the
> Scholar profiles resolve before generating a whole faculty.

---

## Advanced: complete bundles (`*_Faculty.json` / `*_UoA.json`)

The app can also *save* a whole faculty or UoA as a single self-contained JSON
**bundle** (units + cached Scholar payloads + REF ratings + impact case studies
+ narratives). Those are normally produced **by the app** (File → Save…), not
hand-authored, because they embed scraped Scholar data and derived keys. Build
rosters as unit Markdown (above) and let the app create bundles once the data is
fetched. (The `samples/poppleton/` demo bundles are the exception — generated by
a script that mirrors the bundle schema — see that folder if you need the JSON
shape.)

---

## The prompt (copy this into an LLM)

````
You are building roster data for "Scholar Dashboard", which loads each
university unit (department) as a Markdown file. I will give you a list of
staff (or a department web page); produce one Markdown file per unit in the
EXACT format below.

FORMAT — header lines, then one bullet per person:

University: <institution>
Faculty: <faculty name>          # same spelling groups units together
Faculty-URL: <optional homepage>
School: <optional mid-level grouping; omit if none>
Unit: <department name>          # REQUIRED
Slug: <lower-case-hyphenated-id> # unique per unit
UoA: <default REF Unit of Assessment, a number 1–34; omit if unsure>
Active: yes

- Name | Title | Staff ID | Google Scholar URL | status | uoa:NN

STAFF LINE RULES:
- Fields are pipe-separated, in that fixed order. Trailing fields are optional.
- Name: full name (required).
- Title: real academic rank (Professor of X, Senior Lecturer, Reader, Lecturer,
  Research Fellow, etc.).
- Staff ID: any internal id, or blank.
- Google Scholar URL: the person's REAL profile URL
  (https://scholar.google.com/citations?user=...) or blank if none/uncertain.
- status: "set" if a Scholar URL is present; "missing" if they genuinely have no
  profile; "unchecked" if not looked up.
- uoa:NN: optional per-person override (1–34). uoa:0 = explicitly no UoA
  (e.g. administrators). Omit to inherit the unit's UoA.
- Lines starting with # are comments.

HARD RULES:
1. NEVER invent Google Scholar IDs, citation counts, h-index, or publications.
   This app scrapes metrics itself. Your job is only the roster + correct
   Scholar profile URLs.
2. If you cannot confidently identify a person's real Scholar profile, leave the
   Scholar field blank and set status "missing" or "unchecked". A wrong profile
   is worse than none.
3. UoA codes are 1–34 (REF 2029). Pick the unit default from its discipline;
   override individuals only where justified.
4. Output one fenced code block per unit, with the suggested filename
   "<slug>.md" on the line above each block. No commentary inside the block.

Here is the staff list / source:
<PASTE YOUR LIST OR A DEPARTMENT URL HERE>
````
