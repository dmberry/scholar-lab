# Plan — REF impact case studies + UoA report (proposal, not yet built)

Status: **awaiting sign-off.** This documents what REF impact case
studies are and proposes how to add them to Scholar Dashboard, plus a
UoA report → PDF. Nothing here is implemented yet.

## 1. What a REF impact case study (ICS) is

The Research Excellence Framework (REF) is the UK's periodic assessment
of university research. Alongside **outputs** (publications) and
**environment**, each submission includes **impact case studies** — 4–5
page narratives describing the demonstrable effect of a unit's research
*beyond academia* (on policy, the economy, society, culture, health,
practice, etc.), each grounded in specific underpinning research.

**REF 2029 specifics relevant to us:**
- Number of ICS scales with unit size (FTE). Small units (<~10 FTE)
  submit 1–2; larger units submit more, in FTE brackets. (Exact bracket
  table is in the official guidance — see Sources; we'll make the count
  a per-UoA setting rather than hard-code a table that may still move.)
- The **2\* quality threshold on underpinning research has been removed**
  for REF 2029 — underpinning research now only needs to meet the REF
  definition of research. So an ICS can cite outputs regardless of star
  rating.
- Impact carries significant weight in the overall profile (~25% in
  recent exercises).

**The ICS document structure** (the REF3 template), which our data model
should mirror:
1. **Title**
2. **Period** the underpinning research was undertaken
3. **Summary of the impact** (~100 words)
4. **Underpinning research** (the research and its findings)
5. **References to the research** (the outputs — these can be linked to
   the publications we already track per scholar)
6. **Details of the impact** (the narrative, with corroborating evidence)
7. **Sources to corroborate** the impact (testimonials, reports, links)

## 2. Proposed data model

A new persistent store, sibling to `ref_flags.json` /
`ref_targets.json`, living in `USER_ROOT`:

`case_studies.json` — keyed by an auto id:
```jsonc
{
  "<id>": {
    "id": "cs-<timestamp>",
    "uoa": "34",                       // which UoA this ICS belongs to
    "title": "…",
    "status": "not_started|draft|proof|finished",
    "period": "2018–2024",
    "summary": "…",
    "underpinning_research": "…",
    "references": ["<scholar_id>:<pub_key>", …],  // link to tracked outputs
    "details": "…",
    "corroborating_sources": ["…"],
    "contributors": ["<staff_id>", …],            // staff involved
    "created_at": "<iso>",
    "updated_at": "<iso>",
    "versions": [                                  // lightweight version log
      { "ts": "<iso>", "status": "draft", "note": "first pass" }, …
    ]
  }
}
```

**States + version stamp** (as requested):
- `not_started` → `draft` → `proof` → `finished`.
- Every status change (and explicit "snapshot") appends to `versions`
  with an ISO timestamp + the status + an optional note. The latest
  `updated_at` drives sort/age display. (Full document-version diffing
  is out of scope; we store status-transition stamps + notes, which is
  what "data stamp of the versioning" needs.)

**Endpoints:** `/api/case-studies` (GET all / scoped by `?uoa=`),
`/api/case-study` (POST create/update, DELETE remove) — same shape as
the REF-flag endpoints.

## 3. Where it lives in the UI

- **By UoA view** gains a panel/section above the people grid:
  *"Impact case studies (N / target)"* listing each ICS as a card with
  title, status chip (colour-coded: grey/amber/blue/green), last-updated
  date, and contributor avatars. Target count comes from the per-UoA
  REF target (extend `ref_targets.json` with `case_studies` count).
- **New / edit ICS** opens a modal form following the REF3 sections,
  with a reference-picker that pulls from the staff already in that UoA
  and their REF-flagged publications (reuses the flag store).
- A small **REF readiness** strip per UoA: outputs flagged vs target,
  case studies by status vs target.

## 4. The UoA report → PDF

A new **"UoA report"** action (Export menu, when in By UoA view, or a
button in the UoA panel) renders a single long printable document:

1. **Cover**: UoA code + name, institution, generated date, headline
   counts (staff, FTE, outputs flagged, case studies by status).
2. **Narrative / environment** (a free-text field per UoA — new, small
   addition to `ref_targets.json` or a `uoa_meta.json`).
3. **Outputs**: per scholar, only their REF-flagged publications
   (this is the "REF selection report" the user also asked for — it
   becomes a section of this report and a standalone modal).
4. **Impact case studies**: each finished/draft ICS rendered in full
   in REF3 section order.

Rendering reuses the existing print stylesheet (`@media print`,
`break-inside: avoid`) so "Save as PDF" produces the document. No new
PDF library needed — same path as the current Print/PDF.

## 5. Suggested build order (each a verifiable commit)

1. **REF selection report modal** — per-scholar flagged outputs for the
   current Unit/UoA scope (standalone, immediately useful; becomes
   §3 of the UoA report). *Smallest, highest-value first step.*
2. **Case-study store + endpoints** (`case_studies.json`, CRUD API).
3. **ICS panel + editor modal** in By UoA view (REF3 sections, status
   chips, version stamps, reference-picker).
4. **Per-UoA targets extended** (case-study count + narrative field) in
   Settings.
5. **UoA report → PDF** assembling cover + narrative + outputs + ICS,
   via the print stylesheet.

## Sources

- [Section 6 – Engagement and Impact guidance – REF 2029](https://2029.ref.ac.uk/guidance/section-6-engagement-and-impact-guidance/)
- [Guidance – REF 2029](https://2029.ref.ac.uk/guidance/)
- [Initial decisions next steps, Dec 2023 – REF 2029](https://2029.ref.ac.uk/news/update-on-initial-decisions/)
- [REF2029 Impact – University of St Andrews](https://impact.wp.st-andrews.ac.uk/ref-impact-3/)

> Note: REF 2029 rules are still being finalised by the funding bodies.
> The exact FTE→case-study bracket table and impact weighting should be
> confirmed against the official guidance before relying on the numbers;
> the plan keeps counts/targets user-editable to absorb late changes.
