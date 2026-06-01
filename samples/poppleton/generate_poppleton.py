#!/usr/bin/env python3
"""Generate the University of Poppleton demo bundles for Scholar Dashboard.

Two self-contained bundles (load via File → Load):
  * University-of-Poppleton_Faculty.json   — the whole institution
  * University-of-Poppleton_UoA-99_UoA.json — the single-UoA REF workflow

The demo uses out-of-range UoA codes (99 and 98) on purpose, so loading it can
never collide with a real REF UoA (1–34) in someone's working data.

REAL CHARACTERS ONLY. Every named person below is a recurring figure from
Laurie Taylor's "Poppletonian" column in Times Higher Education, placed in the
department the column gives them. What is *fabricated* is only the apparatus the
dashboard needs: Scholar IDs, citation counts, publication lists, REF ratings,
and the impact case studies — though each case study is built on a storyline the
column actually ran (the barricaded office and the practice-based output
"Dogsbody and Vassal"; Tipping's two-way mirror and his "just think what
happened with lasers" defence of blue-skies research; the "REF-excluded research
active" Poppletonian Apology and the motto Finem respice!).

No ages are invented: the column gives everyone an age in brackets, but the only
one known here is the staff reporter Keith Ponting (30), so that is the only one
used.

Design notes
------------
* Bundle schema matches app.py `_assemble_bundle()`: _meta / scope / units /
  scholar_cache / ref_flags / scholar_meta / case_studies / uoa_meta.
* Each unit is emitted as canonical per-unit Markdown, so the importer parses it
  straight into the faculty → school → unit tree.
* Scholar IDs are fake but satisfy the parser's bare-ID rule [A-Za-z0-9_-]{8,20}.
* `_fetched_at` is pinned to 2100 so the seeded cache never trips the 7-day
  Scholar TTL and never tries to "refresh" a profile that does not exist.

Run:  python3 generate_poppleton.py
"""

import json
import re
from pathlib import Path

UNIVERSITY = "University of Poppleton"
APP_VERSION = "3.1.1"
FORMAT_VERSION = 1

FAC_ARTS = "Faculty of Arts and Social Sciences"
FAC_ARTS_URL = "https://www.poppleton.ac.uk/arts-social-sciences"
FAC_DIR = "University Directorate and Professional Services"
SCHOOL_MCS = "School of Media, Culture and Society"

# Pinned freshness: 2100-01-01 epoch + a fixed, sensible "scraped on" date.
FETCHED_AT = 4102444800
FETCHED_ISO = "2026-06-01T09:00:00+00:00"
EXPORTED_AT = "2026-06-01T09:00:00+00:00"
PIC = ""


# ── helpers ─────────────────────────────────────────────────────────────────
def pub_key(title, year):
    """Mirror app.py pub_key(): '{year}-{slug-of-title trimmed to 80}'."""
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower().strip()).strip("-")[:80]
    return f"{year or 'n.d.'}-{slug}" if slug else ""


def cites_curve(points):
    return {str(y): int(c) for y, c in sorted(points.items())}


def pub(title, year, venue, cites, authors):
    return {"title": title, "year": year, "venue": venue,
            "num_citations": cites, "authors": authors,
            "pub_key": pub_key(title, year)}


def profile(scholar_id, name, affiliation, interests,
            citedby, citedby5y, hindex, hindex5y, i10, i10_5y, curve, pubs):
    return {
        "scholar_id": scholar_id, "name": name, "affiliation": affiliation,
        "interests": interests, "url_picture": PIC,
        "citedby": citedby, "citedby5y": citedby5y,
        "hindex": hindex, "hindex5y": hindex5y, "i10index": i10, "i10index5y": i10_5y,
        "cites_per_year": cites_curve(curve), "recent_publications": pubs,
        "_fetched_at": FETCHED_AT, "_fetched_iso": FETCHED_ISO, "_from_cache": True,
    }


ROSTER = {}      # slug -> {name, faculty, faculty_url, school, uoa, staff[]}
CACHE = {}       # scholar_id -> profile payload
REF_FLAGS = {}   # scholar_id -> {pub_key: rating}


def add_unit(slug, name, faculty, school, uoa, faculty_url=""):
    ROSTER[slug] = {"name": name, "faculty": faculty, "faculty_url": faculty_url,
                    "school": school, "uoa": uoa, "staff": []}


def add_person(slug, name, title, staff_id, scholar_id=None, status=None, uoa=None):
    ROSTER[slug]["staff"].append({"name": name, "title": title, "staff_id": staff_id,
                                  "scholar_id": scholar_id, "status": status, "uoa": uoa})


def set_profile(scholar_id, **kw):
    CACHE[scholar_id] = profile(scholar_id, **kw)


def rate(scholar_id, title, year, stars):
    REF_FLAGS.setdefault(scholar_id, {})[pub_key(title, year)] = stars


# ════════════════════════════════════════════════════════════════════════════
# Units
# ════════════════════════════════════════════════════════════════════════════
add_unit("media-cultural-studies", "Department of Media and Cultural Studies",
         FAC_ARTS, SCHOOL_MCS, 99, FAC_ARTS_URL)
add_unit("social-psychology", "Department of Social Psychology",
         FAC_ARTS, SCHOOL_MCS, 98, FAC_ARTS_URL)
add_unit("directorate", "Senior Management and Professional Services",
         FAC_DIR, None, None)


# ── Media and Cultural Studies (UoA 99) ──────────────────────────────────────
add_person("media-cultural-studies", "Professor Gordon Lapping",
           "Head of Department · Professor of Cultural Studies", "PUP0001", "ppltn_lapping")
set_profile("ppltn_lapping",
    name="Professor Gordon Lapping",
    affiliation="Professor of Cultural Studies, University of Poppleton",
    interests=["Cultural Studies", "Practice-based Research", "Performance", "Semiotics"],
    citedby=884, citedby5y=263, hindex=15, hindex5y=9, i10=18, i10_5y=8,
    curve={2010:9,2011:16,2012:24,2013:31,2014:38,2015:46,2016:53,2017:61,
           2018:58,2019:54,2020:49,2021:53,2022:58,2023:61,2024:55,2025:41,2026:18},
    pubs=[
        pub("Dogsbody and Vassal (durational performance, 14 months)", 2024,
            "Practice-based output · Poppleton Biennial; Room 4.12 (barricaded)", 6,
            "G Lapping, T Odgers"),
        pub("The Barricaded Office as Site-Specific Practice", 2023,
            "Journal of Visual Culture 22 (2), 188-209", 12, "G Lapping"),
        pub("Practice as Resistance: Notes from Behind the Filing Cabinets", 2021,
            "Performance Research 26 (4), 55-73", 18, "G Lapping, T Odgers"),
        pub("Encoding and Decoding the Staff Meeting", 2019,
            "Theory, Culture & Society 36 (5), 77-99", 34, "G Lapping"),
        pub("Reading the Mission Statement: A Cultural Studies Approach", 2017,
            "European Journal of Cultural Studies 20 (3), 301-322", 51, "G Lapping"),
    ])
rate("ppltn_lapping", "Dogsbody and Vassal (durational performance, 14 months)", 2024, 4)
rate("ppltn_lapping", "The Barricaded Office as Site-Specific Practice", 2023, 3.5)
rate("ppltn_lapping", "Practice as Resistance: Notes from Behind the Filing Cabinets", 2021, 3)

add_person("media-cultural-studies", "Ted Odgers",
           "Senior Lecturer in Radical Media", "PUP0002", "ppltn_odgers")
set_profile("ppltn_odgers",
    name="Ted Odgers",
    affiliation="Senior Lecturer in Radical Media, University of Poppleton",
    interests=["Marxism", "Practice-based Research", "Political Economy of Media", "Trade Unionism"],
    citedby=231, citedby5y=92, hindex=8, hindex5y=5, i10=7, i10_5y=4,
    curve={2012:6,2013:11,2014:15,2015:18,2016:17,2017:16,2018:18,2019:17,
           2020:15,2021:17,2022:19,2023:20,2024:16,2025:11,2026:5},
    pubs=[
        pub("Dogsbody and Vassal (durational performance, 14 months)", 2024,
            "Practice-based output · Poppleton Biennial; Room 4.12 (barricaded)", 6,
            "T Odgers, G Lapping"),
        pub("The Picket Line as Pedagogic Space", 2023,
            "Capital & Class 48 (1), 12-31", 7, "T Odgers"),
        pub("Against the Student-as-Consumer: A Polemic", 2021,
            "tripleC 19 (1), 88-104", 11, "T Odgers"),
        pub("The Means of Pedagogical Production", 2018,
            "Historical Materialism 26 (2), 144-170", 16, "T Odgers"),
        pub("Surplus Value in the Seminar Room", 2015,
            "Rethinking Marxism 27 (3), 366-388", 22, "T Odgers"),
    ])
rate("ppltn_odgers", "Dogsbody and Vassal (durational performance, 14 months)", 2024, 3.5)
rate("ppltn_odgers", "The Picket Line as Pedagogic Space", 2023, 2.5)
rate("ppltn_odgers", "Against the Student-as-Consumer: A Polemic", 2021, 2)

add_person("media-cultural-studies", "Maureen",
           "Departmental Secretary", "PUP0003", "ppltn_maureen", uoa=0)
set_profile("ppltn_maureen",
    name="Maureen",
    affiliation="Departmental Secretary, Department of Media and Cultural Studies, University of Poppleton",
    interests=["Departmental Administration", "Minute-Taking",
               "Practice-based Research (uncredited)", "Photocopier Maintenance"],
    citedby=1043, citedby5y=402, hindex=18, hindex5y=11, i10=21, i10_5y=10,
    curve={2009:11,2010:19,2011:28,2012:37,2013:46,2014:55,2015:63,2016:71,
           2017:78,2018:74,2019:69,2020:64,2021:68,2022:72,2023:76,2024:70,
           2025:52,2026:23},
    pubs=[
        pub("Dogsbody and Vassal (durational performance, 14 months)", 2024,
            "Practice-based output · Poppleton Biennial; Room 4.12 (barricaded) — rota organised by M Maureen", 6,
            "M Maureen, G Lapping, T Odgers"),
        pub("Who Actually Wrote It: Authorship and the Departmental Secretary", 2023,
            "Journal of Academic Labour 5 (1), 1-19", 34, "M Maureen"),
        pub("Minutes of the Staff Meeting, 2009–2024: A Longitudinal Study", 2024,
            "Qualitative Inquiry 30 (4), 511-540", 12, "M Maureen"),
        pub("The Photocopier as Apparatus: Twenty Years at the Machine", 2021,
            "New Media & Society 23 (8), 2210-2231", 19, "M Maureen, T Odgers"),
        pub("I Took the Minutes: Invisible Labour in the Academy", 2018,
            "Gender, Work & Organization 25 (6), 633-655", 41, "M Maureen, G Lapping"),
    ])


# ── Social Psychology (UoA 98) ───────────────────────────────────────────────
add_person("social-psychology", "Professor G. W. Tipping",
           "Head of Department · Professor of Social Psychology", "PUP0011", "ppltn_tipping")
set_profile("ppltn_tipping",
    name="Professor G. W. Tipping",
    affiliation="Professor of Social Psychology, University of Poppleton",
    interests=["Social Psychology", "Observation Methods", "Surveillance", "Blue-Skies Research"],
    citedby=1487, citedby5y=548, hindex=21, hindex5y=13, i10=27, i10_5y=15,
    curve={2008:24,2009:38,2010:52,2011:66,2012:79,2013:91,2014:103,2015:112,
           2016:121,2017:118,2018:124,2019:117,2020:121,2021:118,2022:122,
           2023:114,2024:101,2025:78,2026:33},
    pubs=[
        pub("Behind the Glass: Twenty Years of the Two-Way Mirror", 2024,
            "British Journal of Social Psychology 63 (2), 401-428", 28, "G W Tipping"),
        pub("Blue-Skies Research and the Lessons of the Laser", 2022,
            "Perspectives on Psychological Science 17 (4), 980-997", 41, "G W Tipping"),
        pub("The Observed Self: Surveillance in the Senior Common Room", 2020,
            "Journal of Experimental Social Psychology 89, 103981", 33, "G W Tipping"),
        pub("Unobtrusive Measures and Institutional Compliance", 2018,
            "Social Psychological and Personality Science 9 (6), 712-730", 47, "G W Tipping"),
        pub("Reactivity and the Watched Subject", 2014,
            "British Journal of Social Psychology 53 (1), 55-77", 60, "G W Tipping"),
    ])
rate("ppltn_tipping", "Behind the Glass: Twenty Years of the Two-Way Mirror", 2024, 4)
rate("ppltn_tipping", "Blue-Skies Research and the Lessons of the Laser", 2022, 3.5)
rate("ppltn_tipping", "The Observed Self: Surveillance in the Senior Common Room", 2020, 3)


# ── Directorate & Professional Services (no UoA; managers with comic profiles) ─
# These are uoa:0 (explicitly outside the REF units), so their citation cards
# appear in Faculty view but they are excluded from any UoA submission. Keith
# Ponting is left 'unchecked' to keep that Scholar state demonstrated.
add_person("directorate", "The Vice-Chancellor", "Vice-Chancellor", "PUP0021",
           "ppltn_vc", uoa=0)
set_profile("ppltn_vc",
    name="The Vice-Chancellor",
    affiliation="Vice-Chancellor, University of Poppleton",
    interests=["Strategic Vision", "Stakeholder Value", "League Tables", "Institutional Branding"],
    citedby=3187, citedby5y=2104, hindex=4, hindex5y=4, i10=5, i10_5y=5,
    curve={2014:88,2015:121,2016:164,2017:203,2018:248,2019:271,2020:266,
           2021:312,2022:358,2023:401,2024:372,2025:284,2026:118},
    pubs=[
        pub("Towards a Top-20 Poppleton: A Roadmap (Fourth Revised Edition)", 2025,
            "Office of the Vice-Chancellor · Poppleton Strategic Review", 412, "The Vice-Chancellor"),
        pub("Excellence as a Core Value: Excellence, Impact, Excellence", 2024,
            "Office of the Vice-Chancellor · Poppleton Strategic Review", 388, "The Vice-Chancellor"),
        pub("On the Methodological Artefact: Why Inconvenient Figures Are Mistaken", 2023,
            "Office of the Vice-Chancellor · Poppleton Strategic Review", 305, "The Vice-Chancellor"),
        pub("Finem Respice: A Vision for the Decade Ahead", 2022,
            "Office of the Vice-Chancellor · Poppleton Strategic Review", 277, "The Vice-Chancellor"),
        pub("The Heraldic Logo and the Strategic Brand", 2021,
            "Office of the Vice-Chancellor · Poppleton Strategic Review", 251, "The Vice-Chancellor"),
    ])

add_person("directorate", "Jamie Targett", "Director of Corporate Affairs", "PUP0022",
           "ppltn_targett", uoa=0)
set_profile("ppltn_targett",
    name="Jamie Targett",
    affiliation="Director of Corporate Affairs, University of Poppleton",
    interests=["Strategic Communications", "Change Management", "Workspace Optimisation", "Synergy"],
    citedby=146, citedby5y=98, hindex=6, hindex5y=5, i10=5, i10_5y=4,
    curve={2018:6,2019:11,2020:15,2021:18,2022:21,2023:23,2024:20,2025:15,2026:7},
    pubs=[
        pub("The Underheated Open-Plan Office and the Enhanced Collegial Environment", 2024,
            "Journal of Workspace Studies 11 (2), 88-109", 14, "J Targett"),
        pub("Realising a Strategic Estate Consolidation", 2023,
            "Higher Education Management Quarterly 39 (4), 410-428", 9, "J Targett"),
        pub("Goodbye and Good Luck: Reframing Closure as Opportunity", 2022,
            "Public Relations Review 48 (3), 102-119", 12, "J Targett"),
        pub("The Research Visibility Journey: A Communications Framework", 2021,
            "Corporate Communications 26 (1), 33-51", 8, "J Targett"),
    ])

add_person("directorate", "Georgina Edsel", "Deputy Head of Brand Management", "PUP0023",
           "ppltn_edsel", uoa=0)
set_profile("ppltn_edsel",
    name="Georgina Edsel",
    affiliation="Deputy Head of Brand Management, University of Poppleton",
    interests=["Brand Management", "Rankings Optimisation", "Reputation Management", "Public Relations"],
    citedby=73, citedby5y=58, hindex=4, hindex5y=4, i10=3, i10_5y=3,
    curve={2020:5,2021:8,2022:11,2023:14,2024:16,2025:12,2026:6},
    pubs=[
        pub("We Are in the Global Top 1%: A Benchmarking Methodology", 2024,
            "Journal of Marketing for Higher Education 34 (2), 201-220", 11, "G Edsel"),
        pub("The Ethical Relativism of Progressive Public Relations", 2023,
            "Public Relations Inquiry 12 (3), 277-295", 9, "G Edsel"),
        pub("Recommended by Eight out of Ten: Comparative Claims in HE Marketing", 2022,
            "International Journal of Advertising 41 (5), 880-901", 7, "G Edsel"),
    ])

add_person("directorate", "Louise Bimpson", "Director of Human Resources", "PUP0024",
           "ppltn_bimpson", uoa=0)
set_profile("ppltn_bimpson",
    name="Louise Bimpson",
    affiliation="Director of Human Resources, University of Poppleton",
    interests=["Human Resources", "Organisational Restructuring", "Change Management", "Heritage Monetisation"],
    citedby=112, citedby5y=80, hindex=5, hindex5y=5, i10=4, i10_5y=4,
    curve={2019:7,2020:11,2021:14,2022:17,2023:19,2024:18,2025:13,2026:6},
    pubs=[
        pub("The Silver Lining: Restructuring as Opportunity", 2024,
            "Human Resource Management Journal 34 (3), 455-474", 13, "L Bimpson, J Targett"),
        pub("From Barricaded Corridor to Paying Attraction: The Higher Education Experience", 2023,
            "Tourism Management Perspectives 47, 101122", 10, "L Bimpson"),
        pub("Voluntary Severance and the Engaged Workforce", 2022,
            "Work, Employment and Society 36 (4), 712-730", 8, "L Bimpson"),
    ])

add_person("directorate", "Ted Chippings", "Head of TEF Submissions", "PUP0025",
           "ppltn_chippings", uoa=0)
set_profile("ppltn_chippings",
    name="Ted Chippings",
    affiliation="Head of TEF Submissions, University of Poppleton",
    interests=["Teaching Excellence Framework", "Educational Metrics", "Lexicography", "Strategic Buzz-words"],
    citedby=164, citedby5y=121, hindex=6, hindex5y=6, i10=6, i10_5y=5,
    curve={2018:8,2019:13,2020:17,2021:21,2022:25,2023:27,2024:24,2025:17,2026:7},
    pubs=[
        pub("The Gross Teaching Quotient: Towards a Single Number", 2024,
            "Assessment & Evaluation in Higher Education 49 (5), 640-661", 16, "T Chippings"),
        pub("Words Mean What We Choose Them to Mean: A Humpty-Dumpty Approach to the TEF", 2023,
            "Studies in Higher Education 48 (8), 1190-1209", 13, "T Chippings"),
        pub("Outstanding, Fusion, Creative: A Working Lexicon", 2022,
            "Higher Education Policy 35 (2), 300-318", 11, "T Chippings"),
        pub("Bronze as the New Gold: Reframing the Award", 2021,
            "Quality in Higher Education 27 (1), 44-62", 9, "T Chippings"),
    ])

add_person("directorate", "Brigadier T. W. Trouncing", "Head of Campus Security", "PUP0026",
           "ppltn_trouncing", uoa=0)
set_profile("ppltn_trouncing",
    name="Brigadier T. W. Trouncing",
    affiliation="Head of Campus Security, University of Poppleton",
    interests=["Campus Security", "Surveillance", "Discipline", "Logistics and Sanctions"],
    citedby=58, citedby5y=44, hindex=4, hindex5y=3, i10=2, i10_5y=2,
    curve={2020:4,2021:6,2022:9,2023:12,2024:13,2025:9,2026:5},
    pubs=[
        pub("Discipline and Punish: Outsourcing Academic Sanctions to HM Prison Service", 2024,
            "Security Journal 37 (2), 188-206", 9, "T W Trouncing"),
        pub("Surveillance Positions at Key Points on Campus", 2023,
            "Surveillance & Society 21 (3), 301-319", 12, "T W Trouncing, G W Tipping"),
        pub("The Withdrawal of Photocopying Rights as a Deterrent", 2022,
            "Crime Prevention and Community Safety 24 (4), 410-427", 7, "T W Trouncing"),
    ])

add_person("directorate", "Jennifer Doubleday", "Wellbeing Coordinator (Thought for the Week)",
           "PUP0027", "ppltn_doubleday", uoa=0)
set_profile("ppltn_doubleday",
    name="Jennifer Doubleday",
    affiliation="Wellbeing Coordinator, University of Poppleton",
    interests=["Personal Development", "Mindfulness", "Wellbeing", "Aromatherapy"],
    citedby=204, citedby5y=151, hindex=7, hindex5y=6, i10=8, i10_5y=6,
    curve={2017:9,2018:14,2019:19,2020:23,2021:27,2022:30,2023:31,2024:27,2025:20,2026:9},
    pubs=[
        pub("Imagine Yourself as a Tree: Mindfulness for the Watched Subject", 2024,
            "Mindfulness 15 (4), 880-899", 18, "J Doubleday, G W Tipping"),
        pub("Know Yourself and Grow Yourself: A Personal Development Curriculum", 2023,
            "Journal of Further and Higher Education 47 (6), 720-738", 12, "J Doubleday"),
        pub("Thought for the Week: A Decade of Apercus", 2022,
            "Wellbeing in Higher Education 8 (2), 145-163", 10, "J Doubleday"),
        pub("The Moment You Are Satisfied Is the Moment You Stop Growing", 2021,
            "International Journal of Wellbeing 11 (3), 55-72", 14, "J Doubleday"),
    ])

add_person("directorate", "Keith Ponting", "Staff Reporter, The Poppletonian", "PUP0028",
           None, status="unchecked", uoa=0)


# ── UoA narratives ───────────────────────────────────────────────────────────
UOA_META = {
    "99": {"narrative":
        "Media and Cultural Studies at Poppleton is built on practice-based "
        "research. Following the reclassification of Professor Lapping and Mr "
        "Odgers as 'REF-excluded research active' and the subsequent Poppletonian "
        "Apology, the unit has reframed its industrial action as practice and its "
        "barricaded office as a site-specific output. Submissions are made in the "
        "spirit of the University motto, Finem respice! — 'consider the end'."},
    "98": {"narrative":
        "Social Psychology at Poppleton is organised around observation and the "
        "psychology of being watched. Professor Tipping's two-way-mirror programme "
        "anchors the unit's claim to blue-skies research, a claim he defends, when "
        "pressed by the Director of Corporate Affairs on its impact, with the "
        "observation that one should 'just think of what happened with lasers'."},
}


# ── Impact case studies (deadpan Poppletonian register; real storylines) ──────
def _case(cid, uoa, title, status, slot, contributors, references,
          corroborating, summary, underpinning, details):
    return {
        "id": cid, "uoa": uoa, "title": title, "status": status, "slot": slot,
        "period": "2021–2026", "contributors": contributors,
        "references": references, "corroborating_sources": corroborating,
        "summary": summary, "underpinning_research": underpinning, "details": details,
        "created_at": EXPORTED_AT, "updated_at": EXPORTED_AT,
        "versions": [{"ts": EXPORTED_AT, "status": status,
                      "note": "Seeded as a worked example in the Poppleton demo."}],
    }


CASES_UOA99 = [
    _case(
        "cs-poppleton-dogsbody-vassal", "99",
        "Dogsbody and Vassal: Fourteen Months of Practice-Based Research",
        "finished", 1,
        ["Professor Gordon Lapping", "Ted Odgers"],
        ["Lapping, G. & Odgers, T. (2024) 'Dogsbody and Vassal', durational performance, Poppleton Biennial / Room 4.12.",
         "Lapping, G. (2023) 'The Barricaded Office as Site-Specific Practice', Journal of Visual Culture 22(2), 188-209.",
         "Lapping, G. & Odgers, T. (2021) 'Practice as Resistance: Notes from Behind the Filing Cabinets', Performance Research 26(4), 55-73."],
        ["Reports by Keith Ponting (30), staff reporter, The Poppletonian, 2024-2025.",
         "Visitor figures, Poppleton Biennial (Room 4.12).",
         "Minutes, Senate Estates and Photocopying Sub-Committee, 2024.",
         "Testimonial, Director of Corporate Affairs, on 'top-1%-by-comparison' visibility."],
        "When Professor Gordon Lapping and Mr Ted Odgers barricaded their shared "
        "office in protest at the underheated open-plan move, they reclassified the "
        "barricade itself as a fourteen-month durational performance, 'Dogsbody and "
        "Vassal'. The work was submitted as a practice-based output, attracted "
        "visitors to Room 4.12, and was reported across several editions of The "
        "Poppletonian, achieving reach into public debate on the conditions of "
        "academic labour.",
        "The output develops the unit's argument, advanced in 'The Barricaded Office "
        "as Site-Specific Practice' (Lapping, 2023) and 'Practice as Resistance' "
        "(Lapping and Odgers, 2021), that withdrawal of labour is itself a form of "
        "cultural production. The barricade was theorised as a site-specific "
        "intervention; the filing cabinets, as the catalogue had it, 'do the "
        "speaking'.",
        "The Director of Corporate Affairs, Jamie Targett, initially described the "
        "occupied office to the staff reporter Keith Ponting (30) as a 'reimagined "
        "agile workspace' and the building's temperature as 'thermally ambient'. "
        "Brigadier T. W. Trouncing, Head of Security, posted warders at the door and "
        "secured the withdrawal of the occupants' photocopying rights, a measure the "
        "artists incorporated into the work. The Vice-Chancellor commissioned a set "
        "of rankings in which the performance placed in the 'top 1% by comparison'. "
        "The impact is one of reach (sustained press attention) and significance (a "
        "changed public conversation about practice, labour and the agile office).",
    ),
    _case(
        "cs-poppleton-ref-excluded", "99",
        "REF-Excluded but Research Active: The Poppletonian Apology",
        "proof", 2,
        ["Professor Gordon Lapping", "Ted Odgers"],
        ["Lapping, G. (2023) 'The Barricaded Office as Site-Specific Practice', Journal of Visual Culture 22(2), 188-209.",
         "Odgers, T. (2023) 'The Picket Line as Pedagogic Space', Capital & Class 48(1), 12-31.",
         "Odgers, T. (2021) 'Against the Student-as-Consumer: A Polemic', tripleC 19(1), 88-104."],
        ["The Poppletonian, Apology, 2024 ('we wish to make clear ...').",
         "University of Poppleton motto and arms, Finem respice!",
         "Testimonial, Head of Brand Management, on 'progressive public relations'.",
         "Internal memo, Head of TEF Submissions, on bronze status."],
        "After the Department was briefly listed as 'REF-excluded' while remaining "
        "'research active', the resulting Poppletonian Apology became a small public "
        "event in its own right. The episode, and the University's handling of it, "
        "prompted wider sector commentary on how institutions classify the research "
        "they would rather not count.",
        "The case draws on Odgers's work on academic labour and the student-as-"
        "consumer and on Lapping's theory of the barricade-as-practice. The "
        "underpinning claim is that 'research active' is a managerial category before "
        "it is a scholarly one, and that exclusion can be a finding rather than a "
        "failure.",
        "Georgina Edsel, Deputy Head of Brand Management, reframed the affair as an "
        "instance of 'the ethical relativism of progressive public relations'. Ted "
        "Chippings, Head of TEF Submissions, noted that the unit's contribution to "
        "the institution's long-awaited bronze status was 'not unconnected'. The "
        "Apology closed, as all University communications now do, with the motto "
        "Finem respice! The impact is on public and sector understanding of research "
        "classification and institutional candour.",
    ),
    _case(
        "cs-poppleton-heritage", "99",
        "The Higher Education Experience: From Barricade to Heritage Attraction",
        "draft", 3,
        ["Professor Gordon Lapping", "Ted Odgers"],
        ["Lapping, G. & Odgers, T. (2024) 'Dogsbody and Vassal', durational performance, Poppleton Biennial / Room 4.12.",
         "Lapping, G. (2017) 'Reading the Mission Statement: A Cultural Studies Approach', European Journal of Cultural Studies 20(3), 301-322."],
        ["Prospectus, 'The Higher Education Experience' visitor attraction.",
         "Testimonial, Director of Human Resources, on 'the silver lining'.",
         "Reports by Keith Ponting (30), The Poppletonian."],
        "The preserved barricade and Room 4.12 were subsequently repackaged by the "
        "University as 'The Higher Education Experience', a paying heritage attraction "
        "interpreting academic working life for the visiting public. The research thus "
        "reached a new, non-academic audience, albeit not in the way its authors "
        "intended.",
        "The attraction operationalises Lapping's long-standing analysis of "
        "institutional self-presentation, from 'Reading the Mission Statement' (2017) "
        "to the practice-based work, treating the university's own spaces as texts to "
        "be curated and sold.",
        "Louise Bimpson, Director of Human Resources, presented the attraction to "
        "staff as 'the silver lining' of the dispute. Professor Lapping has lodged a "
        "formal objection to being interpreted. The impact is economic (visitor "
        "income) and cultural (public engagement with the realities of higher "
        "education), and is offered here as a draft pending resolution of the "
        "objection.",
    ),
]

CASES_UOA98 = [
    _case(
        "cs-poppleton-two-way-mirror", "98",
        "Behind the Glass: The Two-Way Mirror and the Blue-Skies Defence",
        "proof", 1,
        ["Professor G. W. Tipping"],
        ["Tipping, G. W. (2024) 'Behind the Glass: Twenty Years of the Two-Way Mirror', British Journal of Social Psychology 63(2), 401-428.",
         "Tipping, G. W. (2022) 'Blue-Skies Research and the Lessons of the Laser', Perspectives on Psychological Science 17(4), 980-997.",
         "Tipping, G. W. (2020) 'The Observed Self: Surveillance in the Senior Common Room', Journal of Experimental Social Psychology 89, 103981."],
        ["Equipment log, two-way mirror, Senior Common Room (Estates).",
         "Testimonial, Director of Corporate Affairs, requesting an impact statement.",
         "Wellbeing materials, 'Thought for the Week', Wellbeing Coordinator."],
        "Professor Tipping's two-decade programme of observational research, conducted "
        "through the now-celebrated two-way mirror, was adopted by University "
        "management as a model for monitoring the staff common room, and his public "
        "defence of blue-skies research entered wider debate on why curiosity-driven "
        "work should be funded at all.",
        "The work, anchored by 'Behind the Glass' (Tipping, 2024) and 'Reactivity and "
        "the Watched Subject', demonstrates that observation alters the observed. "
        "Pressed by the Director of Corporate Affairs to specify the impact of his "
        "blue-skies programme, Professor Tipping replied only that one should 'just "
        "think of what happened with lasers'.",
        "Management's enthusiasm for the mirror prompted the Wellbeing Coordinator, "
        "Jennifer Doubleday, to issue a Thought for the Week inviting watched staff to "
        "'imagine yourself as a tree'. The episode reached the public through "
        "coverage of the surveillance question and contributed to debate on academic "
        "freedom and the value of basic research.",
    ),
]

CASE_STUDIES = CASES_UOA99 + CASES_UOA98   # the faculty bundle carries both UoAs


# ── Canonical unit Markdown (mirrors app.py _unit_to_markdown) ────────────────
STAFF_HELP = [
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
GENERATOR_LINE = f"Generator: Scholar Dashboard v{APP_VERSION} (format {FORMAT_VERSION})"


def scholar_url(sid):
    return f"https://scholar.google.com/citations?user={sid}&hl=en" if sid else ""


def unit_markdown(slug, unit):
    L = [GENERATOR_LINE, f"University: {UNIVERSITY}", f"Faculty: {unit['faculty']}"]
    if unit.get("faculty_url"):
        L.append(f"Faculty-URL: {unit['faculty_url']}")
    if unit.get("school"):
        L.append(f"School: {unit['school']}")
    L.append(f"Unit: {unit['name']}")
    L.append(f"Slug: {slug}")
    if unit.get("uoa"):
        L.append(f"UoA: {unit['uoa']}")
    L.append("Active: yes")
    L.append("")
    L += STAFF_HELP
    L.append("")
    for p in unit["staff"]:
        status = p["status"] or ("set" if p["scholar_id"] else "unchecked")
        line = "- " + " | ".join([p["name"], p["title"], p["staff_id"],
                                  scholar_url(p["scholar_id"]), status])
        if p["uoa"] is not None:
            line += f" | uoa:{p['uoa']}"
        L.append(line)
    return "\n".join(L) + "\n"


def _meta_block():
    return {"app": "Scholar Dashboard", "app_version": APP_VERSION,
            "format_version": FORMAT_VERSION, "exported_at": EXPORTED_AT,
            "kind": "bundle", "format": "scholar-dashboard-bundle"}


# ── Bundle assembly ───────────────────────────────────────────────────────────
def build_faculty():
    units = [{"slug": s, "markdown": unit_markdown(s, u)} for s, u in ROSTER.items()]
    return {
        "_meta": _meta_block(),
        "scope": {"kind": "faculty", "code": None, "name": FAC_ARTS},
        "units": units,
        "scholar_cache": CACHE,
        "ref_flags": REF_FLAGS,
        "scholar_meta": {},
        "case_studies": CASE_STUDIES,
        "uoa_meta": UOA_META,
    }


UOA99_NAME = "Communication, Cultural and Media Studies, Library and Information Management"


def build_uoa99():
    unit = ROSTER["media-cultural-studies"]
    sids = [p["scholar_id"] for p in unit["staff"] if p["scholar_id"]]
    return {
        "_meta": _meta_block(),
        "scope": {"kind": "uoa", "code": "99", "name": UOA99_NAME},
        "uoa": {"code": "99", "name": UOA99_NAME},   # back-compat for older readers
        "units": [{"slug": "media-cultural-studies",
                   "markdown": unit_markdown("media-cultural-studies", unit)}],
        "scholar_cache": {sid: CACHE[sid] for sid in sids if sid in CACHE},
        "ref_flags": {sid: REF_FLAGS[sid] for sid in sids if sid in REF_FLAGS},
        "scholar_meta": {},
        "case_studies": CASES_UOA99,
        "uoa_meta": {"99": UOA_META["99"]},
    }


if __name__ == "__main__":
    fac = Path(__file__).with_name("University-of-Poppleton_Faculty.json")
    fac.write_text(json.dumps(build_faculty(), indent=2, ensure_ascii=False), encoding="utf-8")
    uoa = Path(__file__).with_name("University-of-Poppleton_UoA-99_UoA.json")
    uoa.write_text(json.dumps(build_uoa99(), indent=2, ensure_ascii=False), encoding="utf-8")

    n_people = sum(len(u["staff"]) for u in ROSTER.values())
    n_pubs = sum(len(p["recent_publications"]) for p in CACHE.values())
    n_flags = sum(len(v) for v in REF_FLAGS.values())
    print(f"Wrote {fac.name}")
    print(f"  units {len(ROSTER)} · people {n_people} ({len(CACHE)} with profiles) · "
          f"pubs {n_pubs} · ratings {n_flags} · case studies {len(CASE_STUDIES)} "
          f"(UoA99={len(CASES_UOA99)}, UoA98={len(CASES_UOA98)}) · narratives {len(UOA_META)}")
    print(f"Wrote {uoa.name}")
    mcs = ROSTER["media-cultural-studies"]
    print(f"  UoA 99 · 1 unit · {len(mcs['staff'])} people · "
          f"{len(CASES_UOA99)} case studies ({', '.join(c['status'] for c in CASES_UOA99)})")
