#!/usr/bin/env python3
"""Generate the University of Poppleton demo faculty bundle.

A self-contained Scholar Dashboard *Faculty* bundle (load via File → Load) that
seeds a complete, fictional faculty for tutorials and experimentation. Every
person, profile, publication, citation count, REF rating, UoA narrative and
impact case study below is invented. The cast is an affectionate nod to Laurie
Taylor's "Poppletonian" column in Times Higher Education.

Design notes
------------
* The bundle matches the schema built by app.py `_assemble_bundle()`:
  _meta / scope / units / scholar_cache / ref_flags / scholar_meta /
  case_studies / uoa_meta.
* Each unit is emitted as canonical per-unit Markdown (the same text the app
  round-trips), so the importer parses it straight into the faculty tree.
* Scholar IDs are fake but match the parser's bare-ID rule [A-Za-z0-9_-]{8,20}.
* `_fetched_at` is pinned far in the future (2100) so the seeded cache never
  trips the 7-day server TTL — the demo keeps working whenever it is loaded,
  and never tries to "refresh" against a non-existent Scholar profile.
* The age-in-brackets running gag from the column lives in the README and the
  case study, since the data model has no age field.

Run:  python3 generate_poppleton.py
Out:  University-of-Poppleton_Faculty.json  (in this folder)
"""

import json
import re
from pathlib import Path

UNIVERSITY = "University of Poppleton"
FACULTY = "Faculty of Arts and Social Sciences"
FACULTY_URL = "https://www.poppleton.ac.uk/arts-social-sciences"
APP_VERSION = "3.0.1"
FORMAT_VERSION = 1

# Pinned freshness: 2100-01-01 epoch (never older than the 7-day TTL) and a
# fixed, sensible "scraped on" display date.
FETCHED_AT = 4102444800
FETCHED_ISO = "2026-06-01T09:00:00+00:00"
EXPORTED_AT = "2026-06-01T09:00:00+00:00"
PIC = ""  # no portrait; the app falls back to initials


# ── helpers ─────────────────────────────────────────────────────────────────
def pub_key(title, year):
    """Mirror app.py pub_key(): '{year}-{slug-of-title trimmed to 80}'."""
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower().strip()).strip("-")[:80]
    if not slug:
        return ""
    return f"{year or 'n.d.'}-{slug}"


def cites_curve(points):
    """points: {year: cites}. Returned as string-keyed dict (as Scholar gives)."""
    return {str(y): int(c) for y, c in sorted(points.items())}


def pub(title, year, venue, cites, authors):
    p = {"title": title, "year": year, "venue": venue,
         "num_citations": cites, "authors": authors}
    p["pub_key"] = pub_key(title, year)
    return p


def profile(scholar_id, name, affiliation, interests,
            citedby, citedby5y, hindex, hindex5y, i10, i10_5y,
            curve, pubs):
    return {
        "scholar_id": scholar_id,
        "name": name,
        "affiliation": affiliation,
        "interests": interests,
        "url_picture": PIC,
        "citedby": citedby,
        "citedby5y": citedby5y,
        "hindex": hindex,
        "hindex5y": hindex5y,
        "i10index": i10,
        "i10index5y": i10_5y,
        "cites_per_year": cites_curve(curve),
        "recent_publications": pubs,
        "_fetched_at": FETCHED_AT,
        "_fetched_iso": FETCHED_ISO,
        "_from_cache": True,
    }


# Each staff member: (name, title, staff_id, scholar_id|None, status|None, uoa_override|None)
# A scholar_id present + status None ⇒ "set". status set explicitly for
# missing / unchecked people (who have no profile).
ROSTER = {}          # slug -> unit meta + staff list
CACHE = {}           # scholar_id -> profile payload
REF_FLAGS = {}       # scholar_id -> {pub_key: rating}


def add_unit(slug, name, school, uoa):
    ROSTER[slug] = {"name": name, "school": school, "uoa": uoa, "staff": []}


def add_person(slug, name, title, staff_id, scholar_id=None,
               status=None, uoa=None):
    ROSTER[slug]["staff"].append({
        "name": name, "title": title, "staff_id": staff_id,
        "scholar_id": scholar_id, "status": status, "uoa": uoa,
    })


def set_profile(scholar_id, **kw):
    CACHE[scholar_id] = profile(scholar_id, **kw)


def rate(scholar_id, title, year, stars):
    REF_FLAGS.setdefault(scholar_id, {})[pub_key(title, year)] = stars


# ── Schools / Units ──────────────────────────────────────────────────────────
SCHOOL_MCS = "School of Media, Culture and Society"
SCHOOL_AH = "School of Arts and Humanities"
SCHOOL_ME = "School of Management and Enterprise"

add_unit("media-cultural-studies", "Department of Media and Cultural Studies", SCHOOL_MCS, 34)
add_unit("sociology", "Department of Sociology", SCHOOL_MCS, 21)
add_unit("philosophy", "Department of Philosophy", SCHOOL_AH, 30)
add_unit("corporate-affairs", "Office of Corporate Affairs and Strategic Development", SCHOOL_ME, 17)


# ════════════════════════════════════════════════════════════════════════════
# Department of Media and Cultural Studies (UoA 34)
# ════════════════════════════════════════════════════════════════════════════
add_person("media-cultural-studies", "Professor G. F. Lapping",
           "Head of Department · Professor of Cultural Studies", "PUP0001", "ppltn_lapping")
set_profile("ppltn_lapping",
    name="Professor G. F. Lapping",
    affiliation="Professor of Cultural Studies, University of Poppleton",
    interests=["Cultural Studies", "Semiotics", "Television", "Critical Theory"],
    citedby=1432, citedby5y=611, hindex=19, hindex5y=12, i10=26, i10_5y=14,
    curve={2009:18,2010:31,2011:44,2012:52,2013:61,2014:73,2015:88,2016:104,
           2017:121,2018:118,2019:109,2020:96,2021:101,2022:115,2023:122,
           2024:118,2025:96,2026:41},
    pubs=[
        pub("The Hermeneutics of the Box Set: Binge-Watching as Late-Modern Ritual",
            2024, "Journal of Cultural Studies 31 (2), 145-168", 14, "G F Lapping"),
        pub("Stuart Hall and the Senior Common Room: Encoding and Decoding the Staff Meeting",
            2022, "Theory, Culture & Society 39 (4), 77-99", 31, "G F Lapping, K Piercemuller"),
        pub("Towards a Critical Theory of the Lanyard",
            2021, "New Formations 104, 22-41", 22, "G F Lapping"),
        pub("The Semiotics of the Vice-Chancellor's Away-Day",
            2019, "Media, Culture & Society 41 (6), 812-830", 40, "G F Lapping, T Odgers"),
        pub("Reading the Mission Statement: A Cultural Studies Approach",
            2017, "European Journal of Cultural Studies 20 (3), 301-322", 55, "G F Lapping"),
    ])
rate("ppltn_lapping", "The Hermeneutics of the Box Set: Binge-Watching as Late-Modern Ritual", 2024, 3.5)
rate("ppltn_lapping", "Stuart Hall and the Senior Common Room: Encoding and Decoding the Staff Meeting", 2022, 4)
rate("ppltn_lapping", "Towards a Critical Theory of the Lanyard", 2021, 3)

add_person("media-cultural-studies", "Dr Karl Piercemüller",
           "Reader in Critical Theory", "PUP0002", "ppltn_piercemuller")
set_profile("ppltn_piercemuller",
    name="Dr Karl Piercemüller",
    affiliation="Reader in Critical Theory, University of Poppleton",
    interests=["Critical Theory", "Adorno", "Aesthetics", "Frankfurt School"],
    citedby=624, citedby5y=233, hindex=13, hindex5y=9, i10=15, i10_5y=8,
    curve={2010:9,2011:14,2012:19,2013:24,2014:28,2015:34,2016:41,2017:38,
           2018:36,2019:33,2020:41,2021:46,2022:49,2023:44,2024:39,2025:31,2026:13},
    pubs=[
        pub("Negative Dialectics in the Modular Degree", 2023,
            "Radical Philosophy 215, 33-49", 9, "K Piercemuller"),
        pub("Adorno at the REF: Administered Research and the Culture Industry", 2022,
            "Telos 199, 88-110", 17, "K Piercemuller"),
        pub("The Jargon of Authenticity in the University Prospectus", 2020,
            "New German Critique 47 (2), 145-167", 12, "K Piercemuller"),
        pub("Mahler, Modernity and the Modular Timetable", 2018,
            "Cultural Critique 100, 55-78", 6, "K Piercemuller"),
        pub("Minima Pedagogica: Reflections from Damaged Teaching", 2016,
            "Constellations 23 (4), 511-530", 28, "K Piercemuller"),
    ])
rate("ppltn_piercemuller", "Negative Dialectics in the Modular Degree", 2023, 3)
rate("ppltn_piercemuller", "Adorno at the REF: Administered Research and the Culture Industry", 2022, 3.5)

add_person("media-cultural-studies", "Ted Odgers",
           "Senior Lecturer in Radical Media", "PUP0003", "ppltn_odgers")
set_profile("ppltn_odgers",
    name="Ted Odgers",
    affiliation="Senior Lecturer in Radical Media, University of Poppleton",
    interests=["Marxism", "Political Economy of Media", "Labour", "Trade Unionism"],
    citedby=214, citedby5y=84, hindex=8, hindex5y=5, i10=7, i10_5y=4,
    curve={2012:6,2013:11,2014:14,2015:19,2016:18,2017:16,2018:15,2019:17,
           2020:14,2021:16,2022:18,2023:19,2024:15,2025:11,2026:5},
    pubs=[
        pub("The Picket Line as Pedagogic Space", 2024,
            "Capital & Class 48 (1), 12-31", 4, "T Odgers"),
        pub("Brazier Operatives of the World Unite: Affective Labour on the UCU Line", 2023,
            "Work, Employment and Society 37 (3), 401-420", 7, "T Odgers"),
        pub("Against the Student-as-Consumer: A Polemic", 2021,
            "tripleC 19 (1), 88-104", 11, "T Odgers"),
        pub("The Means of Pedagogical Production", 2015,
            "Historical Materialism 23 (2), 144-170", 19, "T Odgers"),
        pub("Surplus Value in the Seminar Room", 2012,
            "Rethinking Marxism 24 (3), 366-388", 23, "T Odgers"),
    ])
rate("ppltn_odgers", "The Picket Line as Pedagogic Space", 2024, 2.5)
rate("ppltn_odgers", "Brazier Operatives of the World Unite: Affective Labour on the UCU Line", 2023, 2)

add_person("media-cultural-studies", "Dr Janet Petty",
           "Lecturer in Digital Culture (Early Career)", "PUP0004", "ppltn_petty")
set_profile("ppltn_petty",
    name="Dr Janet Petty",
    affiliation="Lecturer in Digital Culture, University of Poppleton",
    interests=["Digital Culture", "Social Media", "Memes", "Platform Studies"],
    citedby=31, citedby5y=31, hindex=3, hindex5y=3, i10=0, i10_5y=0,
    curve={2022:1,2023:4,2024:9,2025:12,2026:5},
    pubs=[
        pub("TikTok and the Crisis of the Lecture", 2025,
            "Convergence 31 (2), 220-238", 2, "J Petty"),
        pub("Meme Literacy among First-Year Undergraduates", 2024,
            "Learning, Media and Technology 49 (1), 55-71", 5, "J Petty"),
        pub("The Influencer and the Impact Agenda", 2023,
            "First Monday 28 (6)", 3, "J Petty"),
    ])
rate("ppltn_petty", "TikTok and the Crisis of the Lecture", 2025, 2)

add_person("media-cultural-studies", "Maureen Tilsley",
           "Departmental Secretary", "PUP0005", None, status="missing")

add_person("media-cultural-studies", "Professor Norman Stoat",
           "Emeritus Professor of Film Studies", "PUP0006", "ppltn_stoat")
set_profile("ppltn_stoat",
    name="Professor Norman Stoat",
    affiliation="Emeritus Professor of Film Studies, University of Poppleton",
    interests=["Film Studies", "Auteur Theory", "Westerns", "Hitchcock"],
    citedby=1810, citedby5y=96, hindex=21, hindex5y=5, i10=24, i10_5y=2,
    curve={2004:120,2005:142,2006:151,2007:148,2008:139,2009:128,2010:121,
           2011:110,2012:98,2013:84,2014:71,2015:55,2016:41,2017:30,2018:24,
           2019:19,2020:15,2021:12,2022:10,2023:9,2024:8,2025:6,2026:2},
    pubs=[
        pub("The Western and the Wagon Train of Progress", 2014,
            "Screen 55 (3), 312-333", 60, "N Stoat"),
        pub("Auteur Theory and the Departmental Hierarchy", 2009,
            "Cinema Journal 48 (4), 22-44", 95, "N Stoat"),
        pub("Hitchcock and the Audit Culture", 2004,
            "Film Quarterly 57 (3), 14-27", 120, "N Stoat"),
    ])


# ════════════════════════════════════════════════════════════════════════════
# Department of Sociology (UoA 21)
# ════════════════════════════════════════════════════════════════════════════
add_person("sociology", "Professor Gordon Lasenby",
           "Head of Department · Professor of Sociology", "PUP0011", "ppltn_lasenby")
set_profile("ppltn_lasenby",
    name="Professor Gordon Lasenby",
    affiliation="Professor of Sociology, University of Poppleton",
    interests=["Sociology of Work", "Bureaucracy", "Higher Education", "Organisations"],
    citedby=1604, citedby5y=702, hindex=20, hindex5y=14, i10=29, i10_5y=18,
    curve={2008:21,2009:34,2010:48,2011:61,2012:74,2013:86,2014:97,2015:106,
           2016:118,2017:127,2018:121,2019:114,2020:122,2021:131,2022:138,
           2023:142,2024:129,2025:101,2026:44},
    pubs=[
        pub("The Iron Cage of the Workload Model", 2024,
            "Sociology 58 (2), 288-307", 18, "G Lasenby"),
        pub("Bullshit Jobs in the Modern University", 2023,
            "The Sociological Review 71 (4), 760-781", 44, "G Lasenby, H Quaife"),
        pub("Goffman in the Open-Plan Office", 2022,
            "British Journal of Sociology 73 (3), 455-474", 26, "G Lasenby"),
        pub("The McDonaldization of the PhD Viva", 2020,
            "Sociology of Education 93 (4), 333-351", 33, "G Lasenby"),
        pub("Risk, Reflexivity and the National Student Survey", 2017,
            "Sociological Research Online 22 (2), 1-19", 51, "G Lasenby"),
    ])
rate("ppltn_lasenby", "The Iron Cage of the Workload Model", 2024, 3)
rate("ppltn_lasenby", "Bullshit Jobs in the Modern University", 2023, 4)
rate("ppltn_lasenby", "Goffman in the Open-Plan Office", 2022, 3)

add_person("sociology", "Dr Helen Quaife",
           "Senior Lecturer in Sociology", "PUP0012", "ppltn_quaife")
set_profile("ppltn_quaife",
    name="Dr Helen Quaife",
    affiliation="Senior Lecturer in Sociology, University of Poppleton",
    interests=["Gender", "Care", "Family", "Emotional Labour"],
    citedby=433, citedby5y=188, hindex=11, hindex5y=8, i10=12, i10_5y=7,
    curve={2014:8,2015:14,2016:22,2017:29,2018:34,2019:41,2020:38,2021:43,
           2022:47,2023:44,2024:39,2025:28,2026:11},
    pubs=[
        pub("Emotional Labour in the Personal Tutor System", 2024,
            "Gender, Work & Organization 31 (2), 540-559", 12, "H Quaife"),
        pub("The Care Crisis and the Care-less University", 2022,
            "The Sociological Review 70 (5), 980-999", 29, "H Quaife"),
        pub("Mothering and Marking: The Double Shift of the Female Academic", 2019,
            "Gender and Education 31 (7), 845-863", 41, "H Quaife"),
        pub("Domesticity and the Home Office", 2016,
            "Sociology 50 (6), 1122-1140", 18, "H Quaife"),
    ])
rate("ppltn_quaife", "Emotional Labour in the Personal Tutor System", 2024, 3)
rate("ppltn_quaife", "The Care Crisis and the Care-less University", 2022, 3.5)

add_person("sociology", "Dr Wendy Pith",
           "Lecturer in Sociology", "PUP0013", "ppltn_pith")
set_profile("ppltn_pith",
    name="Dr Wendy Pith",
    affiliation="Lecturer in Sociology, University of Poppleton",
    interests=["Quantitative Methods", "Surveys", "Social Statistics"],
    citedby=121, citedby5y=58, hindex=6, hindex5y=4, i10=4, i10_5y=2,
    curve={2016:4,2017:7,2018:11,2019:13,2020:12,2021:14,2022:16,2023:15,
           2024:13,2025:9,2026:3},
    pubs=[
        pub("Likert Scales and the Limits of Student Satisfaction", 2023,
            "Sociological Methods & Research 52 (3), 1201-1224", 8, "W Pith"),
        pub("Sampling the Senior Common Room", 2021,
            "Quality & Quantity 55 (4), 1455-1472", 5, "W Pith"),
        pub("The Sociology of the Tea Trolley", 2018,
            "Symbolic Interaction 41 (2), 233-251", 14, "W Pith"),
    ])
rate("ppltn_pith", "Likert Scales and the Limits of Student Satisfaction", 2023, 2)

add_person("sociology", "Dr Brian Lard",
           "Visiting Lecturer in Sociology", "PUP0014", "ppltn_lard")
set_profile("ppltn_lard",
    name="Dr Brian Lard",
    affiliation="Visiting Lecturer, University of Poppleton",
    interests=["Comparative Sociology", "Bureaucracy", "Mobility"],
    citedby=61, citedby5y=27, hindex=4, hindex5y=3, i10=1, i10_5y=1,
    curve={2017:3,2018:5,2019:8,2020:7,2021:9,2022:8,2023:7,2024:6,2025:4,2026:2},
    pubs=[
        pub("Comparative Bureaucracy: Poppleton and Beyond", 2022,
            "International Sociology 37 (4), 488-506", 3, "B Lard"),
        pub("The Visiting Scholar as Liminal Figure", 2019,
            "Mobilities 14 (5), 677-693", 7, "B Lard"),
    ])


# ════════════════════════════════════════════════════════════════════════════
# Department of Philosophy (UoA 30)
# ════════════════════════════════════════════════════════════════════════════
add_person("philosophy", "Professor Felicity Garn",
           "Head of Department · Professor of Continental Philosophy", "PUP0021", "ppltn_garn")
set_profile("ppltn_garn",
    name="Professor Felicity Garn",
    affiliation="Professor of Continental Philosophy, University of Poppleton",
    interests=["Phenomenology", "Heidegger", "Ethics", "Levinas"],
    citedby=712, citedby5y=281, hindex=14, hindex5y=10, i10=16, i10_5y=9,
    curve={2011:11,2012:18,2013:26,2014:33,2015:39,2016:44,2017:48,2018:46,
           2019:43,2020:47,2021:52,2022:55,2023:50,2024:43,2025:33,2026:14},
    pubs=[
        pub("Being and Timetabling", 2024,
            "Continental Philosophy Review 57 (1), 21-44", 16, "F Garn"),
        pub("The Phenomenology of the Inbox", 2023,
            "Phenomenology and the Cognitive Sciences 22 (3), 601-622", 22, "F Garn"),
        pub("Heidegger and the Question Concerning Lecture Capture", 2021,
            "Research in Phenomenology 51 (2), 188-210", 30, "F Garn"),
        pub("Levinas and the Face of the External Examiner", 2018,
            "Journal of the British Society for Phenomenology 49 (4), 300-319", 25, "F Garn"),
    ])
rate("ppltn_garn", "Being and Timetabling", 2024, 3)
rate("ppltn_garn", "The Phenomenology of the Inbox", 2023, 3.5)
rate("ppltn_garn", "Heidegger and the Question Concerning Lecture Capture", 2021, 3)

add_person("philosophy", "Dr C. E. M. Cummings",
           "Senior Lecturer in Ethics", "PUP0022", "ppltn_cummings")
set_profile("ppltn_cummings",
    name="Dr C. E. M. Cummings",
    affiliation="Senior Lecturer in Ethics, University of Poppleton",
    interests=["Ethics", "Applied Ethics", "Moral Philosophy"],
    citedby=212, citedby5y=96, hindex=8, hindex5y=6, i10=6, i10_5y=4,
    curve={2014:6,2015:11,2016:15,2017:19,2018:18,2019:17,2020:19,2021:22,
           2022:21,2023:20,2024:16,2025:12,2026:5},
    pubs=[
        pub("The Ethics of the Anonymous Marking Policy", 2023,
            "Journal of Applied Philosophy 40 (4), 712-729", 9, "C E M Cummings"),
        pub("Trolley Problems in the Car Park", 2021,
            "Ethical Theory and Moral Practice 24 (3), 655-672", 13, "C E M Cummings"),
        pub("Virtue Ethics and the Probationary Period", 2017,
            "Philosophy 92 (3), 401-420", 20, "C E M Cummings"),
    ])
rate("ppltn_cummings", "The Ethics of the Anonymous Marking Policy", 2023, 2.5)

add_person("philosophy", "Dr Gerald Robards",
           "Lecturer in Metaphysics", "PUP0023", "ppltn_robards")
set_profile("ppltn_robards",
    name="Dr Gerald Robards",
    affiliation="Lecturer in Metaphysics, University of Poppleton",
    interests=["Metaphysics", "Logic", "Philosophy of Time"],
    citedby=139, citedby5y=61, hindex=6, hindex5y=4, i10=3, i10_5y=2,
    curve={2016:5,2017:9,2018:12,2019:14,2020:13,2021:15,2022:16,2023:14,
           2024:11,2025:8,2026:3},
    pubs=[
        pub("Existential Redundancy: A Metaphysical Inquiry", 2022,
            "Mind 131 (523), 855-877", 11, "G Robards"),
        pub("The Persistence of Objects through Departmental Restructure", 2020,
            "Analysis 80 (4), 633-650", 7, "G Robards"),
        pub("Possible Worlds and Probable Outcomes", 2016,
            "Synthese 193 (8), 2501-2520", 15, "G Robards"),
    ])
rate("ppltn_robards", "Existential Redundancy: A Metaphysical Inquiry", 2022, 2)


# ════════════════════════════════════════════════════════════════════════════
# Office of Corporate Affairs and Strategic Development (UoA 17)
# ════════════════════════════════════════════════════════════════════════════
add_person("corporate-affairs", "Professor Sir Vivian Bakewell",
           "Vice-Chancellor · Professor of Strategic Leadership", "PUP0031", "ppltn_bakewell")
set_profile("ppltn_bakewell",
    name="Professor Sir Vivian Bakewell",
    affiliation="Vice-Chancellor, University of Poppleton",
    interests=["Strategic Leadership", "Change Management", "Higher Education Policy"],
    citedby=521, citedby5y=72, hindex=9, hindex5y=4, i10=8, i10_5y=2,
    curve={2003:34,2004:38,2005:41,2006:39,2007:36,2008:33,2009:30,2010:35,
           2011:28,2012:24,2013:20,2014:17,2015:14,2016:12,2017:10,2018:9,
           2019:8,2020:9,2021:11,2022:13,2023:12,2024:10,2025:7,2026:3},
    pubs=[
        pub("The Agile University: A Vision for 2030", 2024,
            "Higher Education Quarterly 78 (1), 3-19", 6, "V Bakewell"),
        pub("Leveraging Synergies across the Student Lifecycle", 2022,
            "Perspectives: Policy and Practice in Higher Education 26 (2), 44-58", 3, "V Bakewell, J Targett"),
        pub("Transformational Leadership in Turbulent Times", 2010,
            "Studies in Higher Education 35 (6), 671-688", 35, "V Bakewell"),
        pub("Organisational Culture and the Newly Merged Institution", 2003,
            "Journal of Higher Education Policy and Management 25 (2), 155-170", 48, "V Bakewell"),
    ])
rate("ppltn_bakewell", "The Agile University: A Vision for 2030", 2024, 2)

add_person("corporate-affairs", "Jamie Targett",
           "Director of Corporate Affairs", "PUP0032", "ppltn_targett")
set_profile("ppltn_targett",
    name="Jamie Targett",
    affiliation="Director of Corporate Affairs, University of Poppleton",
    interests=["Brand Strategy", "Stakeholder Engagement", "Communications"],
    citedby=12, citedby5y=11, hindex=2, hindex5y=2, i10=0, i10_5y=0,
    curve={2021:2,2022:3,2023:3,2024:3,2025:1},
    pubs=[
        pub("Reimagining the Poppleton Brand: A Roadmap", 2024,
            "Journal of Marketing for Higher Education 34 (1), 1-9", 1, "J Targett"),
        pub("Stakeholder-Centric Synergy: The Poppleton Way", 2023,
            "Corporate Communications: An International Journal 28 (4), 600-611", 0, "J Targett, G Edsel"),
        pub("From Mission Statement to Movement", 2021,
            "International Journal of Strategic Communication 15 (3), 200-212", 2, "J Targett"),
    ])
rate("ppltn_targett", "Reimagining the Poppleton Brand: A Roadmap", 2024, 1)

add_person("corporate-affairs", "Georgina Edsel",
           "Deputy Head of Brand Management", "PUP0033", "ppltn_edsel")
set_profile("ppltn_edsel",
    name="Georgina Edsel",
    affiliation="Deputy Head of Brand Management, University of Poppleton",
    interests=["Marketing", "Branding", "Higher Education Marketing"],
    citedby=20, citedby5y=16, hindex=2, hindex5y=2, i10=0, i10_5y=0,
    curve={2021:2,2022:4,2023:5,2024:4,2025:3,2026:2},
    pubs=[
        pub("The Logo as Boundary Object", 2023,
            "Journal of Brand Management 30 (5), 488-501", 4, "G Edsel"),
        pub("Rebranding the Lower Poppleton Campus", 2021,
            "Place Branding and Public Diplomacy 17 (2), 155-166", 2, "G Edsel"),
    ])

add_person("corporate-affairs", "Ted Chippings",
           "Head of TEF Submissions", "PUP0034", "ppltn_chippings")
set_profile("ppltn_chippings",
    name="Ted Chippings",
    affiliation="Head of Teaching Excellence Framework Submissions, University of Poppleton",
    interests=["Teaching Excellence", "Metrics", "Quality Assurance"],
    citedby=18, citedby5y=14, hindex=2, hindex5y=2, i10=0, i10_5y=0,
    curve={2020:3,2021:3,2022:4,2023:4,2024:3,2025:1},
    pubs=[
        pub("Gaming the TEF: A Practitioner's Reflection", 2023,
            "Quality in Higher Education 29 (2), 211-223", 5, "T Chippings"),
        pub("From Gold to Platinum: Aspirational Metrics", 2020,
            "Tertiary Education and Management 26 (4), 401-413", 3, "T Chippings"),
    ])

add_person("corporate-affairs", "Keith Ponting",
           "Communications Officer · Editor, The Poppletonian", "PUP0035", None, status="unchecked")

add_person("corporate-affairs", "Louise Bimpson",
           "Director of Human Resources", "PUP0036", None, status="missing")


# ── UoA narratives ───────────────────────────────────────────────────────────
UOA_META = {
    "34": {"narrative":
        "Media and Cultural Studies at Poppleton applies the full apparatus of "
        "critical theory to the institution that employs it. The unit's signature "
        "contribution is a reflexive cultural studies of the contemporary university "
        "itself, from the semiotics of the lanyard to the political economy of the "
        "picket line. Outputs cluster around three themes: the administered culture "
        "of higher education, the labour relations of academic work, and the "
        "everyday textuality of managerial life."},
    "21": {"narrative":
        "Sociology at Poppleton is organised around the sociology of work, "
        "organisations and the professions, with the modern university as its "
        "principal empirical site. The unit combines classical theory (Weber, "
        "Goffman) with contemporary critique of audit culture, workload models "
        "and academic precarity."},
    "30": {"narrative":
        "Philosophy at Poppleton specialises in bringing the great traditions of "
        "metaphysics, phenomenology and ethics to bear on the lived realities of "
        "institutional life: timetabling, redundancy, the inbox and the external "
        "examiner. The unit is small but research-intensive."},
    "17": {"narrative":
        "The Office of Corporate Affairs and Strategic Development contributes a "
        "practitioner-facing body of work on university branding, leadership and "
        "the metrics of teaching excellence. Its research is closely coupled to "
        "the institution's strategic priorities."},
}


# ── Impact case studies (UoA 34) ─────────────────────────────────────────────
# Written in the deadpan, management-speak-skewering register of Laurie Taylor's
# "Poppletonian" column — including the column's signature device of giving
# every named person their age in brackets. These are the showcase case studies
# for both the faculty bundle and the standalone UoA-34 bundle.

def _case(cid, title, status, slot, contributors, references,
          corroborating, summary, underpinning, details):
    return {
        "id": cid, "uoa": "34", "title": title, "status": status, "slot": slot,
        "period": "2021–2026", "contributors": contributors,
        "references": references, "corroborating_sources": corroborating,
        "summary": summary, "underpinning_research": underpinning, "details": details,
        "created_at": EXPORTED_AT, "updated_at": EXPORTED_AT,
        "versions": [{"ts": EXPORTED_AT, "status": status,
                      "note": "Seeded as a worked example in the Poppleton demo."}],
    }


CASE_STUDIES = [
    _case(
        "cs-poppleton-lanyard",
        "From Lanyard to Legacy: Branded Neckwear and the Architecture of Belonging",
        "finished", 1,
        ["Professor G. F. Lapping (58)", "Jamie Targett (34)"],
        ["Lapping, G. F. (2021) 'Towards a Critical Theory of the Lanyard', New Formations 104, 22-41.",
         "Lapping, G. F. (2017) 'Reading the Mission Statement: A Cultural Studies Approach', European Journal of Cultural Studies 20(3), 301-322.",
         "Lapping, G. F. (2019) 'The Semiotics of the Vice-Chancellor's Away-Day', Media, Culture & Society 41(6), 812-830."],
        ["Testimonial, Director of Corporate Affairs (34), University of Poppleton.",
         "Minutes of the Senate Lanyard Working Group, 2022 (on file).",
         "Poppleton Evening Argus, 'University Sees the Future, and It Is Around Your Neck', 9 May 2023.",
         "BBC Radio 4, 'Thinking Allowed', lanyard feature, 2023."],
        "Underpinning research by Professor G. F. Lapping (58) into the lanyard as a "
        "technology of institutional belonging was adopted in its entirety by the "
        "University's Office of Corporate Affairs. A colour-coded, four-tier lanyard "
        "system was rolled out across all eleven Poppleton campuses, accompanied by a "
        "38-page Lanyard Usage Protocol and the appointment of a dedicated Lanyard "
        "Tsar. Senior management report 'a measurable uplift in cross-portfolio "
        "stakeholder visibility'; catering staff report being 'at last able to tell "
        "the professors from the conference delegates'. The scheme reached an "
        "estimated 14,000 staff and students and was the subject of a national radio "
        "feature.",
        "In 'Towards a Critical Theory of the Lanyard' (Lapping, 2021), Professor "
        "Lapping argued that the lanyard does not merely display identity but produces "
        "it, hailing the wearer as a governable subject of the modern institution. "
        "Drawing on Althusser and a close reading of the Poppleton conference circuit, "
        "the paper proposed a typology of neckwear from the 'aspirational' (worn in "
        "the car park) to the 'forsaken' (worn home on the bus). The work was "
        "peer-reviewed in New Formations and sits within Lapping's wider programme on "
        "the everyday textuality of managerial life.",
        "The findings were taken up with enthusiasm by Jamie Targett (34), Director of "
        "Corporate Affairs, who described the work to our reporter Keith Ponting (30) "
        "as 'a genuine paradigm shift in the wearables space'. A Senate Lanyard "
        "Working Group was convened; its 2022 report recommended the four-tier system "
        "now in force. The Vice-Chancellor, Professor Sir Vivian Bakewell (61), claimed "
        "the initiative as 'a personal priority of my leadership' at the 2023 "
        "graduation, though the research is Professor Lapping's. Maureen, of the "
        "Department of Media and Cultural Studies, was obliged to distribute the "
        "lanyards. The scheme has since been benchmarked by two neighbouring "
        "universities and a regional NHS trust, evidencing reach well beyond the "
        "higher-education sector. Professor Lapping notes that the paper was intended "
        "as a warning.",
    ),
    _case(
        "cs-poppleton-mission-statement",
        "Reading the Mission Statement: Public Engagement with Institutional Prose",
        "proof", 2,
        ["Dr Karl Piercemüller (51)", "Professor G. F. Lapping (58)"],
        ["Piercemüller, K. (2020) 'The Jargon of Authenticity in the University Prospectus', New German Critique 47(2), 145-167.",
         "Lapping, G. F. (2017) 'Reading the Mission Statement: A Cultural Studies Approach', European Journal of Cultural Studies 20(3), 301-322.",
         "Piercemüller, K. (2022) 'Adorno at the REF: Administered Research and the Culture Industry', Telos 199, 88-110."],
        ["Visitor book, 'The Art of the Ask' touring exhibition, 2024.",
         "Testimonial, Head of Brand Management (39), University of Poppleton.",
         "BBC Radio 4 series 'Word Soup', producer's note, 2024.",
         "Revised University of Poppleton mission statement, Senate Paper 7(b), 2024."],
        "Research into the language of the university prospectus, led by Dr Karl "
        "Piercemüller (51), prompted a wholesale rewriting of the University of "
        "Poppleton's mission statement and seeded a touring public exhibition on "
        "institutional prose. The revised statement, which now reads in its entirety "
        "'Poppleton: Onwards', was praised by the marketing sector for its 'radical "
        "concision' and has been adopted as a teaching case on three MBA programmes.",
        "In 'The Jargon of Authenticity in the University Prospectus' (Piercemüller, "
        "2020), the research demonstrated that the contemporary mission statement "
        "communicates nothing by design, its function being purely incantatory. The "
        "argument was extended in Lapping's 'Reading the Mission Statement' (2017), "
        "which traced the genre from the medieval charter to the bullet point and "
        "identified the 'aspirational gerund' ('empowering', 'delivering', "
        "'reimagining') as its grammatical engine.",
        "Following a well-attended public lecture, the University commissioned the "
        "team to audit its own corporate language. The resulting exhibition, 'The Art "
        "of the Ask', toured four civic libraries and was visited by upwards of 3,000 "
        "members of the public, many of whom, organisers report, 'left visibly moved, "
        "or at least confused'. The findings informed a BBC Radio 4 series and the "
        "rewriting of the mission statement itself, a process the Vice-Chancellor "
        "described as 'brave'. Georgina Edsel (39), Deputy Head of Brand Management, "
        "confirmed the new statement had 'tested extremely well with stakeholders who "
        "had not read it'. Dr Piercemüller has since declined all invitations to the "
        "Strategy Away-Day.",
    ),
    _case(
        "cs-poppleton-away-day",
        "The Away-Day as Transformational Encounter: Impact on the Regional Facilitation Sector",
        "draft", 3,
        ["Professor G. F. Lapping (58)"],
        ["Lapping, G. F. (2019) 'The Semiotics of the Vice-Chancellor's Away-Day', Media, Culture & Society 41(6), 812-830.",
         "Lapping, G. F. (2024) 'The Hermeneutics of the Box Set: Binge-Watching as Late-Modern Ritual', Journal of Cultural Studies 31(2), 145-168."],
        ["Companies House filing, Blue Sky Thinking (Poppleton) Ltd.",
         "Client testimonial, Lower Poppleton Borough Council.",
         "Invoice schedule, 2022–2025 (on file).",
         "Programme, 'Visioning the Vision: A Facilitated Encounter', 2023."],
        "Professor Lapping's (58) semiotic analysis of the institutional away-day gave "
        "rise to a regional facilitation industry. His identification of the "
        "'flip-chart sublime' and the 'breakout-room contract' has been licensed to a "
        "consultancy, Blue Sky Thinking (Poppleton) Ltd, which has delivered "
        "'transformational visioning encounters' to 47 public-sector bodies, "
        "supporting an estimated 30 jobs in the local economy.",
        "'The Semiotics of the Vice-Chancellor's Away-Day' (Lapping, 2019) read the "
        "away-day as a ritual of corporate communion in which nothing is decided at "
        "great expense in a hotel near a motorway junction. The paper catalogued its "
        "liturgy: the icebreaker, the Post-it note, the 'parking' of difficult "
        "questions, and the buffet as eschatology.",
        "Although the research was intended as critique, it was received by the sector "
        "as a manual. Jamie Targett (34) approached Professor Lapping to 'monetise the "
        "learnings'. The resulting consultancy has run facilitated away-days for local "
        "authorities, a water company and, on one occasion, the University's own "
        "Senate, which spent a full day visioning a vision for the visioning process. "
        "The economic impact is the consultancy's turnover and employment; the "
        "cultural impact, Professor Lapping observes, 'is that there are now "
        "considerably more away-days'.",
    ),
    _case(
        "cs-poppleton-picket-line",
        "Picket-Line Pedagogy: Reframing the Public Debate on Academic Labour",
        "draft", 4,
        ["Ted Odgers (49)", "Professor Gordon Lasenby (57)"],
        ["Odgers, T. (2024) 'The Picket Line as Pedagogic Space', Capital & Class 48(1), 12-31.",
         "Odgers, T. (2023) 'Brazier Operatives of the World Unite: Affective Labour on the UCU Line', Work, Employment and Society 37(3), 401-420.",
         "Lasenby, G. (2023) 'Bullshit Jobs in the Modern University', The Sociological Review 71(4), 760-781."],
        ["Testimonial, General Secretary, University and College Union (on file).",
         "BBC Radio 4, 'Thinking Allowed', feature on academic labour, 14 March 2024.",
         "Editorial coverage, Times Higher Education, 2023–2024."],
        "Research by Ted Odgers (49) and Professor Gordon Lasenby (57) on the labour "
        "conditions of academic work moved from the seminar room onto the national "
        "stage during the higher-education disputes of the 2020s. Their reframing of "
        "the picket line as a site of teaching and learning, and of routinised "
        "administration as 'bullshit jobs', shaped union communications, briefed "
        "broadcast journalism, and changed how a general public discussed what "
        "academics actually do all day.",
        "The case rests on a connected body of work begun in 2021: Odgers's "
        "ethnographies of strike action, conducted largely while operating the "
        "brazier, and Lasenby's sociology of administrative overload. Together they "
        "advanced the claim that the visible, collective labour of the picket line is "
        "continuous with, rather than opposed to, the educational mission of the "
        "university. The work was peer-reviewed in Capital & Class, Work, Employment "
        "and Society and The Sociological Review.",
        "Findings were taken up by the University and College Union in its 2023–2024 "
        "campaign materials; Lasenby's 'bullshit jobs' framing was quoted in national "
        "press editorials; and Mr Odgers contributed to a widely heard radio feature, "
        "from which he had to be collected. A series of public 'teach-outs' modelled "
        "on the research reached audiences beyond the academy. The Vice-Chancellor "
        "declined to comment. The impact is one of reach (national public debate) and "
        "significance (a changed framing of academic labour in union and media "
        "discourse).",
    ),
]


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
    L = [GENERATOR_LINE,
         f"University: {UNIVERSITY}",
         f"Faculty: {FACULTY}",
         f"Faculty-URL: {FACULTY_URL}",
         f"School: {unit['school']}",
         f"Unit: {unit['name']}",
         f"Slug: {slug}",
         f"UoA: {unit['uoa']}",
         "Active: yes",
         ""]
    L += STAFF_HELP
    L.append("")
    for p in unit["staff"]:
        status = p["status"] or ("set" if p["scholar_id"] else "unchecked")
        fields = [p["name"], p["title"], p["staff_id"], scholar_url(p["scholar_id"]), status]
        line = "- " + " | ".join(fields)
        if p["uoa"] is not None:
            line += f" | uoa:{p['uoa']}"
        L.append(line)
    return "\n".join(L) + "\n"


# ── Assemble the bundle ───────────────────────────────────────────────────────
def build():
    units = [{"slug": slug, "markdown": unit_markdown(slug, u)}
             for slug, u in ROSTER.items()]

    scholar_meta = {}  # institutional profile overrides — none for the demo

    bundle = {
        "_meta": _meta_block(),
        "scope": {"kind": "faculty", "code": None, "name": FACULTY},
        "units": units,
        "scholar_cache": CACHE,
        "ref_flags": REF_FLAGS,
        "scholar_meta": scholar_meta,
        "case_studies": CASE_STUDIES,
        "uoa_meta": UOA_META,
    }
    return bundle


def _meta_block():
    return {
        "app": "Scholar Dashboard",
        "app_version": APP_VERSION,
        "format_version": FORMAT_VERSION,
        "exported_at": EXPORTED_AT,
        "kind": "bundle",
        "format": "scholar-dashboard-bundle",
    }


# REF 2029 UoA 34: Communication, Cultural and Media Studies, Library and
# Information Management. The standalone UoA bundle is scoped to the one unit
# that sits in UoA 34, and carries the full slate of impact case studies.
UOA34_NAME = "Communication, Cultural and Media Studies, Library and Information Management"


def build_uoa34():
    """A single-UoA bundle (kind='uoa', code='34') — the unit, its cached
    profiles + ratings, the UoA-34 narrative and every UoA-34 case study."""
    unit = ROSTER["media-cultural-studies"]
    sids = [p["scholar_id"] for p in unit["staff"] if p["scholar_id"]]
    cache = {sid: CACHE[sid] for sid in sids if sid in CACHE}
    flags = {sid: REF_FLAGS[sid] for sid in sids if sid in REF_FLAGS}
    bundle = {
        "_meta": _meta_block(),
        "scope": {"kind": "uoa", "code": "34", "name": UOA34_NAME},
        "uoa": {"code": "34", "name": UOA34_NAME},   # back-compat for older readers
        "units": [{"slug": "media-cultural-studies",
                   "markdown": unit_markdown("media-cultural-studies", unit)}],
        "scholar_cache": cache,
        "ref_flags": flags,
        "scholar_meta": {},
        "case_studies": CASE_STUDIES,                # all UoA-34 cases
        "uoa_meta": {"34": UOA_META["34"]},
    }
    return bundle


if __name__ == "__main__":
    fac = Path(__file__).with_name("University-of-Poppleton_Faculty.json")
    fac.write_text(json.dumps(build(), indent=2, ensure_ascii=False), encoding="utf-8")
    uoa = Path(__file__).with_name("University-of-Poppleton_UoA-34_UoA.json")
    uoa.write_text(json.dumps(build_uoa34(), indent=2, ensure_ascii=False), encoding="utf-8")

    n_people = sum(len(u["staff"]) for u in ROSTER.values())
    n_pubs = sum(len(p["recent_publications"]) for p in CACHE.values())
    n_flags = sum(len(v) for v in REF_FLAGS.values())
    print(f"Wrote {fac.name}")
    print(f"  units {len(ROSTER)} · people {n_people} ({len(CACHE)} with profiles) · "
          f"pubs {n_pubs} · ratings {n_flags} · case studies {len(CASE_STUDIES)} · "
          f"narratives {len(UOA_META)}")
    print(f"Wrote {uoa.name}")
    mcs = ROSTER["media-cultural-studies"]
    print(f"  UoA 34 · 1 unit · {len(mcs['staff'])} people · "
          f"{len(CASE_STUDIES)} case studies "
          f"({', '.join(c['status'] for c in CASE_STUDIES)})")
