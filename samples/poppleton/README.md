# Demo faculty — University of Poppleton

A ready-made, **entirely fictional** faculty you can load into Scholar Dashboard
to learn the tool without touching real staff data. It exercises nearly every
feature: the faculty/school/unit tree, By-UoA grouping, the three Scholar
states, REF star ratings, a quality profile and readiness scorecard, a UoA
narrative, and an impact case study.

The cast is an affectionate homage to Laurie Taylor's long-running
"Poppletonian" column in *Times Higher Education*. Every person, citation
count, publication, rating and case study below is invented. (In the original
column, every name is followed by the person's age in brackets, e.g. *Keith
Ponting (30)* — the data model has no age field, so that gag lives only here.)

## Two bundles

| File | Load it to demonstrate |
|------|------------------------|
| `University-of-Poppleton_Faculty.json` | The whole institution: faculty → school → unit tree, By-Faculty and By-UoA views, the full staff grid. 4 units, 19 people. |
| `University-of-Poppleton_UoA-34_UoA.json` | The single-UoA REF workflow: one unit (Media and Cultural Studies, UoA 34) with a full slate of **four impact case studies** across the draft/proof/finished states, slotted №1–4. |

## How to load it

1. Open Scholar Dashboard. Faculty bundles load from either view; the UoA
   bundle is best appreciated in **By UoA** view.
2. **File → Load…** and pick one of the two JSON files above.
3. The data appears with publications, ratings, narratives and case studies
   already in place. Nothing is fetched from Google Scholar — the profiles are
   seeded from the bundle's own cache.

To remove it again: **Settings → Danger Zone → delete the faculty**
("Faculty of Arts and Social Sciences"), or delete the four unit files from
your data folder.

## What's inside

**Faculty of Arts and Social Sciences**, three schools, four units, 19 people:

| Unit | UoA | People | Notes |
|------|-----|--------|-------|
| Department of Media and Cultural Studies | 34 | 6 | Prof. Lapping (HoD), Dr Piercemüller, Ted Odgers, Dr Petty (ECR), **Maureen the secretary** (no profile), Prof. Stoat (emeritus) |
| Department of Sociology | 21 | 4 | Prof. Lasenby (HoD), Dr Quaife, Dr Pith, Dr Lard (visiting) |
| Department of Philosophy | 30 | 3 | Prof. Garn (HoD), Dr C. E. M. Cummings, Dr Robards |
| Office of Corporate Affairs and Strategic Development | 17 | 6 | The Vice-Chancellor, Jamie Targett, Georgina Edsel, Ted Chippings, Keith Ponting (unchecked), Louise Bimpson (HR, no profile) |

It deliberately covers a spread so the dashboard has something to show:

- **All three Scholar states** — `set` (16 people with seeded profiles),
  `missing` (Maureen the secretary; Louise Bimpson in HR), and `unchecked`
  (Keith Ponting).
- **Emeritus and visiting** staff, so the *Hide emeritus* / *Hide visiting*
  toggles do something.
- **A wide citation range** — from a 1,800-citation emeritus film scholar down
  to a director of corporate affairs on a dozen, so the cards, sparklines and
  role distributions vary.
- **21 REF star ratings** across the 1\*–4\* bands (including the 2–3\* / 3–4\*
  in-between bands), concentrated in UoA 34 and 21 so the **quality profile**,
  **mean GPA** and **Red/Amber/Green readiness scorecard** are populated.
- **Four UoA narratives** and **one impact case study** (REF3) in UoA 34,
  slotted as case study №1, in *draft*, with references picked from rated
  outputs and contributors drawn from their authors.

## Provenance of the names (be honest with your audience)

This is a tribute, not a transcript. The cast falls into two groups:

- **Drawn from the column** (recurring Poppletonian figures): Jamie Targett
  (Director of Corporate Affairs), Keith Ponting (the perpetually-30 reporter),
  Ted Odgers, Professor Lapping, Dr Piercemüller, Maureen the secretary, Louise
  Bimpson (HR), Georgina Edsel (Brand Management), Ted Chippings (TEF), and the
  Philosophy pair Dr C. E. M. Cummings and Dr Gerald Robards — plus the
  Department of Media and Cultural Studies itself.
- **Invented in the same spirit** to fill out a plausible faculty: Professors
  Stoat, Lasenby, Garn and Sir Vivian Bakewell (the column's Vice-Chancellor is
  never named — "Bakewell" is ours), and Drs Quaife, Pith, Lard and Petty.

Everything quantitative or biographical is fabricated: **all ages in brackets**
(only "Keith Ponting (30)" is canonical), all surnames not listed above, all
publications, citation counts, REF ratings, and **all four impact case
studies**, which are original satire written in the column's register rather
than reproductions of anything Laurie Taylor published. Treat the whole thing
as affectionate pastiche.

## A note on freshness

The seeded profiles carry a far-future "last fetched" timestamp on purpose, so
the demo never expires against the 7-day Scholar cache and never tries to
"refresh" a profile that doesn't really exist on Google Scholar. Do **not**
press Refresh on a Poppleton card — there's no real profile behind it, so the
fetch would simply fail. Everything you need is already in the bundle.

## Regenerating

The bundle is built by a small, dependency-free script:

```bash
python3 generate_poppleton.py     # rewrites University-of-Poppleton_Faculty.json
```

Edit the roster, publications or ratings in `generate_poppleton.py` and re-run.
The script mirrors the app's own bundle schema and `pub_key` derivation, so the
output loads through **File → Load** exactly like a bundle the app saved itself.
