# Demo data — University of Poppleton

Ready-made, load-and-explore sample data for Scholar Dashboard, for tutorials
and experimentation without touching real staff records. The cast is drawn from
Laurie Taylor's long-running "Poppletonian" column in *Times Higher Education*.

## Two bundles

| File | Load it to demonstrate |
|------|------------------------|
| `University-of-Poppleton_Faculty.json` | The whole institution: two faculties, the faculty → school → unit tree, By-Faculty and By-UoA views, and the three Scholar states. |
| `University-of-Poppleton_UoA-99_UoA.json` | The single-UoA REF workflow: one unit (Media and Cultural Studies) with three **impact case studies** across draft / proof / finished, slotted №1–3. |

## How to load it

The easiest way: **Help → Using Scholar Dashboard**, then under *"New here? Try
the demo data"* click **Load whole institution** or **Load UoA 99**. These
bundles ship inside the app, so the buttons work on a fresh install with no
files to find.

The demo uses out-of-range UoA codes (**99** and **98**) on purpose, so loading
it can never collide with a real REF UoA (1–34) in your working data.

Or load the JSON directly:

1. Open Scholar Dashboard. Faculty bundles load from either view; the UoA
   bundle is best appreciated in **By UoA** view.
2. **File → Load…** and pick one of the two JSON files above.
3. The data appears with publications, ratings, narratives and case studies
   already in place. Nothing is fetched from Google Scholar — the profiles are
   seeded from the bundle's own cache.

To remove it again: **Settings → Danger Zone → delete the faculty**, or delete
the unit files from your data folder.

## What's inside

**Faculty of Arts and Social Sciences**
- *School of Media, Culture and Society*
  - **Department of Media and Cultural Studies** (UoA 99) — Professor Gordon
    Lapping (HoD) and Ted Odgers, whose practice-based outputs and barricaded
    office anchor the case studies, plus **Maureen** the departmental secretary,
    who, it turns out, co-authored half of it.
  - **Department of Social Psychology** (UoA 98) — Professor G. W. Tipping, of
    two-way-mirror fame.

**University Directorate and Professional Services** (no UoA)
- **Senior Management and Professional Services** — the Vice-Chancellor, Jamie
  Targett (Corporate Affairs), Georgina Edsel (Brand Management), Louise Bimpson
  (HR), Ted Chippings (TEF Submissions), Brigadier T. W. Trouncing (Security),
  Jennifer Doubleday (Wellbeing / "Thought for the Week") and Keith Ponting (30),
  the staff reporter.

Every named figure carries a (deliberately comic) Scholar profile, so the demo
is dense with cards to explore. The managers' profiles are the joke, and so are
their *venues*: the managers don't publish in academic journals, they publish in
Poppleton's own organs, **The Poppletonian**, the student magazine
(**Poppleton Student**), prospectuses, promotional pamphlets, HR briefing notes,
security bulletins and staff handbooks. The Vice-Chancellor has an enormous
citation count but an h-index of 4 (his Strategic Review documents mostly cite
each other); **Maureen** the secretary quietly out-publishes the professors she
types for; **Keith Ponting (30)**, the staff reporter, has a profile made
entirely of articles he filed for The Poppletonian. They sit at `uoa:0`, outside
the REF units, so they show as citation cards in Faculty view but are excluded
from any UoA submission, the satirical point being that the people with the
metrics are the ones who can't be returned. It exercises:

- **The `set` state for everyone** — academics, comically-profiled managers, and
  the reporter all have profiles. To see the `missing` / `unchecked` states,
  clear or blank a profile in the Data editor.
- **No-UoA staff** — the whole Directorate sits outside the REF units (`uoa:0`).
- **A co-authorship graph** — Maureen ↔ Lapping/Odgers, Doubleday ↔ Tipping,
  Trouncing ↔ Tipping, Bimpson ↔ Targett.
- **REF star ratings** across the 1\*–4\* bands (including the 2–3\* / 3–4\*
  in-between bands), so the quality profile, mean GPA and Red/Amber/Green
  readiness scorecard populate for UoA 99 and UoA 98.
- **UoA narratives** for 34 and 4, and **four impact case studies** (three in
  UoA 99, one in UoA 98) with references picked from rated outputs and
  contributors drawn from their authors.

## The case studies

Written in the column's deadpan register, but each is built on a storyline the
column actually ran:

- **Dogsbody and Vassal** — the barricaded office reclassified as a fourteen-
  month durational practice-based output (with Targett's euphemisms, Trouncing's
  warders and the withdrawal of photocopying rights).
- **REF-Excluded but Research Active** — the Poppletonian Apology, Edsel's "ethical
  relativism of progressive public relations", and the motto *Finem respice!*
- **The Higher Education Experience** — the preserved barricade repackaged as a
  paying heritage attraction (Bimpson's "silver lining").
- **Behind the Glass** (UoA 98) — Tipping's two-way mirror and his "just think of
  what happened with lasers" defence of blue-skies research, with Doubleday's
  "imagine yourself as a tree" wellbeing response.

## Provenance — real characters only

Every named person is a recurring figure from the Poppletonian column, placed in
the department the column gives them. **No one here is invented**, and **no ages
are invented** — the column gives everyone an age in brackets, but the only one
used here is the canonical "Keith Ponting (30)".

What *is* fabricated is the apparatus the dashboard needs: Scholar IDs, citation
counts, publication titles, REF ratings, and the prose of the case studies. The
case studies are original satire in the column's style, grounded in real
Poppleton plots, not reproductions of anything Laurie Taylor published.

## A note on freshness

The seeded profiles carry a far-future "last fetched" timestamp on purpose, so
the demo never expires against the 7-day Scholar cache and never tries to
"refresh" a profile that doesn't really exist on Google Scholar. Do **not** press
Refresh on a Poppleton card — there's no real profile behind it. Everything you
need is already in the bundle.

## Regenerating

```bash
python3 generate_poppleton.py     # rewrites both JSON bundles
```

Edit the roster, publications, ratings or case studies in
`generate_poppleton.py` and re-run. The script mirrors the app's own bundle
schema and `pub_key` derivation, so the output loads through **File → Load**
exactly like a bundle the app saved itself.
