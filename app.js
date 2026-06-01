// Scholar Dashboard — frontend.
// Loads staff.json via /api/staff, renders person cards, and on click
// hits /api/scholar/<id> which live-fetches Google Scholar (cached server-side).

const grid = document.getElementById("people-grid");
const unitCount = document.getElementById("unit-count");
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modal-body");

document.querySelector(".close").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function closeModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function openModal() {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

let FACULTIES = [];        // top-level faculties from staff.json
let UNITS = [];            // flattened list of units across all faculties
let CURRENT_UNIT = null;   // currently-selected unit object
let STAFF = [];            // staff list of the current unit
const METRICS = new Map(); // scholar_id -> {citedby, hindex, hindex5y, i10index, citedby5y, cites_per_year}
// Persisted across unit/school/faculty switches so the chosen sort sticks.
// Validated against the known sort keys on load — falls back to "name".
const _SORT_KEYS = new Set(["name", "citations", "hindex", "h5", "role", "overview"]);
let currentSort = (() => {
  const saved = localStorage.getItem("sd-sort");
  return _SORT_KEYS.has(saved) ? saved : "name";
})();
// "faculty" (default) drives the Faculty/School/Unit picker; "uoa" drives the
// UoA picker. Persisted in localStorage so the chosen view survives reloads.
let VIEW_MODE = localStorage.getItem("sd-view-mode") || "faculty";

// Optional institutional staff-profile URL. If set, person modals link to it
// for staff with no Scholar profile; "{id}" is replaced by the staff_id.
// Leave "" to disable the link entirely (the dashboard is institution-neutral).
const PROFILE_URL_TEMPLATE = "";

// Build the "institutional profile ↗ ·" link, or "" when no template is set.
function profileLink(p) {
  if (!PROFILE_URL_TEMPLATE || !p.staff_id) return "";
  const url = PROFILE_URL_TEMPLATE.replace("{id}", encodeURIComponent(p.staff_id));
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">institutional profile ↗</a> · `;
}

// REF 2029 Units of Assessment. Code + name. Used in the Data editor (unit-
// level default + per-staff override) and the By-UoA main-page view.
// Note: REF 2029 was still being finalised at points; verify against the
// official list before submission. List below reflects the 34 UoAs published
// for REF 2021 with the panel-structure carried through.
const REF_UOAS = [
  // Main Panel A — Medicine, Health & Life Sciences
  { code:  1, name: "Clinical Medicine" },
  { code:  2, name: "Public Health, Health Services and Primary Care" },
  { code:  3, name: "Allied Health Professions, Dentistry, Nursing and Pharmacy" },
  { code:  4, name: "Psychology, Psychiatry and Neuroscience" },
  { code:  5, name: "Biological Sciences" },
  { code:  6, name: "Agriculture, Food and Veterinary Sciences" },
  // Main Panel B — Physical Sciences, Engineering & Mathematics
  { code:  7, name: "Earth Systems and Environmental Sciences" },
  { code:  8, name: "Chemistry" },
  { code:  9, name: "Physics" },
  { code: 10, name: "Mathematical Sciences" },
  { code: 11, name: "Computer Science and Informatics" },
  { code: 12, name: "Engineering" },
  // Main Panel C — Social Sciences
  { code: 13, name: "Architecture, Built Environment and Planning" },
  { code: 14, name: "Geography and Environmental Studies" },
  { code: 15, name: "Archaeology" },
  { code: 16, name: "Economics and Econometrics" },
  { code: 17, name: "Business and Management Studies" },
  { code: 18, name: "Law" },
  { code: 19, name: "Politics and International Studies" },
  { code: 20, name: "Social Work and Social Policy" },
  { code: 21, name: "Sociology" },
  { code: 22, name: "Anthropology and Development Studies" },
  { code: 23, name: "Education" },
  { code: 24, name: "Sport and Exercise Sciences, Leisure and Tourism" },
  // Main Panel D — Arts & Humanities
  { code: 25, name: "Area Studies" },
  { code: 26, name: "Modern Languages and Linguistics" },
  { code: 27, name: "English Language and Literature" },
  { code: 28, name: "History" },
  { code: 29, name: "Classics" },
  { code: 30, name: "Philosophy" },
  { code: 31, name: "Theology and Religious Studies" },
  { code: 32, name: "Art and Design: History, Practice and Theory" },
  { code: 33, name: "Music, Drama, Dance, Performing Arts, Film and Screen Studies" },
  { code: 34, name: "Communication, Cultural and Media Studies, Library and Information Management" },
];
const UOA_BY_CODE = Object.fromEntries(REF_UOAS.map(u => [u.code, u]));

// Render a <select> of UoAs with a configurable "empty" label and current value.
// Returns the inner HTML; caller wraps in <select class="...">…</select>.
function uoaOptions(currentCode, emptyLabel) {
  const cur = currentCode == null ? "" : String(currentCode);
  const opts = [`<option value="">${escapeHTML(emptyLabel)}</option>`];
  for (const u of REF_UOAS) {
    const sel = cur === String(u.code) ? " selected" : "";
    opts.push(`<option value="${u.code}"${sel}>UoA ${u.code} · ${escapeHTML(u.name)}</option>`);
  }
  return opts.join("");
}

// Resolve effective UoA for a staff member.
//   - person.uoa undefined  → inherit from unit
//   - person.uoa === 0      → "explicitly no UoA" (sentinel) — overrides unit
//   - person.uoa === N (1+) → override unit with N
//   - else                  → unit.uoa, or null if unit isn't tagged either
function effectiveUoa(person, unit) {
  if (person && typeof person.uoa === "number") {
    return person.uoa === 0 ? null : person.uoa;
  }
  if (unit && unit.uoa) return unit.uoa;
  return null;
}

// Direction indicator: h5 ÷ h. Closer to 1 = most impactful work is recent
// (rising); closer to 0 = most impactful work is older (established).
// Returns null if either value is missing.
function directionRatio(h, h5) {
  if (!h || h5 == null) return null;
  return h5 / h;
}

// Surname extractor — split on whitespace, take the last token. Handles
// hyphenated surnames as one unit ("Richardson-Walden"). Falls back to
// full name if no whitespace.
function surnameOf(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

// ────────────────────────────────────────────────────────────────────────
// Role classification from the `title` field. Bucket array order is the
// display order — chart segments left-to-right, section heads top-to-bottom.
// classifyRole checks the more-specific patterns first so "Associate
// Professor" / "Assistant Professor" / "Senior Lecturer" beat the bare
// "Professor" / "Lecturer" matches.
const ROLE_BUCKETS = [
  { key: "professor",    label: "Professors",            short: "Professor",       abbr: "Prof", color: "#1d4f91" },
  { key: "reader",       label: "Readers",               short: "Reader",          abbr: "Read", color: "#3771b8" },
  { key: "assoc-prof",   label: "Associate Professors",  short: "Assoc Prof",      abbr: "AsoP", color: "#5a96cc" },
  { key: "senior-lect",  label: "Senior Lecturers",      short: "Senior Lecturer", abbr: "SnrL", color: "#2f8a6e" },
  { key: "asst-prof",    label: "Assistant Professors",  short: "Asst Prof",       abbr: "AstP", color: "#7fb069" },
  { key: "lecturer",     label: "Lecturers",             short: "Lecturer",        abbr: "Lect", color: "#c09a4e" },
  { key: "fellow",       label: "Fellows",               short: "Fellow",          abbr: "Fell", color: "#9a73a8" },
  { key: "other",        label: "Other",                 short: "Other",           abbr: "Oth",  color: "#aaaaaa" },
];
const ROLE_INDEX = Object.fromEntries(ROLE_BUCKETS.map((b, i) => [b.key, i]));

// Filter toggles: hide anyone whose title contains "Emeritus" / "Visiting".
// Persisted in localStorage so they survive reloads. STAFF stays as the
// full set so unit editing isn't lossy — only the rendered view is filtered.
function isEmeritus(p) { return /\bemeritus\b/i.test(p?.title || ""); }
function isVisiting(p) { return /\bvisiting\b/i.test(p?.title || ""); }
function excludeEmeritus() { return localStorage.getItem("sd-exclude-emeritus") === "1"; }
function excludeVisiting() { return localStorage.getItem("sd-exclude-visiting") === "1"; }
function visibleStaff() {
  const dropE = excludeEmeritus();
  const dropV = excludeVisiting();
  if (!dropE && !dropV) return STAFF;
  return STAFF.filter(p => !(dropE && isEmeritus(p)) && !(dropV && isVisiting(p)));
}

function classifyRole(title) {
  const t = String(title || "");
  if (/associate\s+professor/i.test(t)) return "assoc-prof";
  if (/assistant\s+professor/i.test(t)) return "asst-prof";
  if (/senior\s+lecturer/i.test(t))     return "senior-lect";
  if (/professor/i.test(t))             return "professor";
  if (/reader/i.test(t))                return "reader";
  if (/lecturer/i.test(t))              return "lecturer";
  if (/fellow/i.test(t))                return "fellow";
  return "other";
}

// Data Coverage block — small horizontal bars showing how complete the data
// is for this view: how many staff have a Scholar profile set, and how many
// have a UoA assigned (either by unit default or per-person override).
function buildCoverageBlock(staff) {
  const total = staff.length;
  if (!total) return "";
  const setN = staff.filter(p => p.scholar_status === "set").length;
  const uoaN = staff.filter(p => {
    const code = (p._effective_uoa !== undefined)
      ? p._effective_uoa
      : effectiveUoa(p, CURRENT_UNIT);
    return code && code > 0;
  }).length;
  const pct = (n) => Math.round(n / total * 100);
  const row = (label, n, color, title) => {
    const w = (n / total) * 100;
    return `
      <div class="cov-row" title="${escapeAttr(title)}">
        <span class="cov-label">${label}</span>
        <div class="cov-bar"><div class="cov-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>
        <span class="cov-count">${n}<span class="rs-sub"> / ${total}</span> <span class="cov-pct">${pct(n)}%</span></span>
      </div>`;
  };
  return `
    <div class="role-coverage">
      <div class="role-stats-title">Data Coverage</div>
      ${row("Scholar",      setN, "var(--accent)", `${setN} of ${total} staff have a confirmed Google Scholar profile`)}
      ${row("UoA Assigned", uoaN, "#5d9a5e",       `${uoaN} of ${total} staff have an effective REF 2029 UoA (unit default or person override)`)}
    </div>`;
}

// Mini horizontal stacked bar for the Senior / Mid / Junior split.
// Segments are sized proportionally; counts sit inside each segment when
// there's room. Colour-coded to match the seniority scale used elsewhere
// (navy = senior, green = mid-career, tan = junior).
function renderSMJMini(senior, mid, junior) {
  const total = senior + mid + junior;
  if (!total) return `<div class="smj-empty">No staff to break down.</div>`;
  const seg = (n, cls, label) => {
    const pct = (n / total) * 100;
    if (!n) return "";
    return `<div class="smj-seg ${cls}" style="width:${pct}%" title="${label}: ${n}"><span>${n}</span></div>`;
  };
  return `
    <div class="smj-bar" role="img" aria-label="Senior ${senior}, Mid ${mid}, Junior ${junior}">
      ${seg(senior, "smj-senior", "Senior")}
      ${seg(mid,    "smj-mid",    "Mid")}
      ${seg(junior, "smj-junior", "Junior")}
    </div>
    <div class="smj-legend">
      <span class="smj-leg"><span class="sw smj-senior-sw"></span>Senior <b>${senior}</b></span>
      <span class="smj-leg"><span class="sw smj-mid-sw"></span>Mid <b>${mid}</b></span>
      <span class="smj-leg"><span class="sw smj-junior-sw"></span>Junior <b>${junior}</b></span>
    </div>`;
}

// Mini SVG: smooth bell-curve reference (Normal(μ, σ) scaled to `total`)
// with the 8 observed role-bucket bars plotted at positions 1–8, coloured
// by role. Visual replacement for the χ² text line.
function renderBellMini(counts, total, mu, sigma, refRaw, refSum) {
  // Layout: padTop for count labels above bars, padBot for x-axis role labels.
  const W = 220, H = 84, padX = 4, padTop = 10, padBot = 12;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBot;
  const pdf = (x) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
  const expectedAt = (x) => total * pdf(x) / refSum;
  const maxObs = Math.max(...Object.values(counts), 1);
  const maxExp = Math.max(...ROLE_BUCKETS.map((_, i) => expectedAt(i + 1)));
  const maxY = Math.max(maxObs, maxExp);
  const xToPx = (x) => padX + ((x - 0.5) / 8) * innerW;
  const baseY = padTop + innerH;
  const yToPx = (y) => baseY - (y / maxY) * innerH;
  // Smooth reference curve.
  const SAMPLES = 80;
  let pathD = "";
  for (let i = 0; i < SAMPLES; i++) {
    const x = 0.5 + (8 / (SAMPLES - 1)) * i;
    pathD += (i === 0 ? "M" : "L") + xToPx(x).toFixed(1) + "," + yToPx(expectedAt(x)).toFixed(1) + " ";
  }
  const areaD = pathD + ` L${xToPx(8.5).toFixed(1)},${baseY.toFixed(1)} L${xToPx(0.5).toFixed(1)},${baseY.toFixed(1)} Z`;
  // Observed bars + count label above each non-zero bar.
  const barW = (innerW / 8) * 0.55;
  const bars = ROLE_BUCKETS.map((b, i) => {
    const n = counts[b.key];
    const cx = xToPx(i + 1);
    if (!n) return "";
    const top = yToPx(n);
    const h = baseY - top;
    const labelY = Math.max(top - 1.5, padTop - 2);
    return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${b.color}" opacity="0.9"><title>${escapeHTML(b.short)}: ${n}</title></rect>
      <text class="bm-count" x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="${b.color}">${n}</text>`;
  }).join("");
  // X-axis: tiny role abbreviation under every position.
  const xLabels = ROLE_BUCKETS.map((b, i) => {
    const cx = xToPx(i + 1);
    return `<text class="bm-axis" x="${cx.toFixed(1)}" y="${(baseY + 9).toFixed(1)}" text-anchor="middle" fill="#888">${escapeHTML(b.abbr)}</text>`;
  }).join("");
  return `
    <svg class="bell-mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <path d="${areaD}" fill="var(--accent-soft)" opacity="0.4"/>
      <path d="${pathD}" fill="none" stroke="#888" stroke-width="1.1"/>
      <line x1="${padX}" y1="${baseY}" x2="${W - padX}" y2="${baseY}" stroke="#ccc" stroke-width="0.5"/>
      ${bars}
      ${xLabels}
    </svg>`;
}

// Role-distribution summary: a tight tabular bar chart on the left and a
// stats panel on the right (mode, shape, senior:mid:junior ratio, mini
// bell-curve comparison). `viewNameOverride` lets the overview-by-unit
// mode pass each unit's name in (since CURRENT_UNIT is the aggregate).
function buildRoleSummary(staff, viewNameOverride) {
  const wrap = document.createElement("div");
  wrap.className = "role-summary";
  const total = staff.length;
  if (!total) {
    wrap.innerHTML = `<div class="role-empty">No staff in this view.</div>`;
    return wrap;
  }
  const counts = Object.fromEntries(ROLE_BUCKETS.map(b => [b.key, 0]));
  for (const p of staff) counts[classifyRole(p.title)]++;
  const maxN = Math.max(...Object.values(counts), 1);
  const rows = ROLE_BUCKETS.map(b => {
    const n = counts[b.key];
    const pct = (n / maxN) * 100;
    return `
      <div class="role-row" title="${escapeAttr(b.label)}: ${n}">
        <div class="role-row-label">${escapeHTML(b.short)}</div>
        <div class="role-row-bar"><div class="role-row-fill" style="width:${pct}%;background:${b.color}"></div></div>
        <div class="role-row-count">${n}</div>
      </div>`;
  }).join("");

  // ── Stats ────────────────────────────────────────────────────────────
  // Mode (largest bucket).
  let modeKey = ROLE_BUCKETS[0].key, modeN = counts[modeKey];
  for (const b of ROLE_BUCKETS) {
    if (counts[b.key] > modeN) { modeKey = b.key; modeN = counts[b.key]; }
  }
  const modeShort = ROLE_BUCKETS.find(b => b.key === modeKey).short;
  // Centroid: weighted mean of bucket position (1=Professor … 8=Other).
  // Lower = senior-heavy, higher = junior-heavy.
  let posSum = 0;
  ROLE_BUCKETS.forEach((b, i) => { posSum += (i + 1) * counts[b.key]; });
  const centroid = posSum / total;
  // Senior / Mid / Junior split.
  // David's groupings (2026-05-23):
  //   Senior = Professor + Reader
  //   Mid    = Associate Professor + Senior Lecturer
  //   Junior = Assistant Professor + Lecturer + Fellow + Other
  const senior = counts.professor + counts.reader;
  const mid    = counts["assoc-prof"] + counts["senior-lect"];
  const junior = counts["asst-prof"] + counts.lecturer + counts.fellow + counts.other;
  // Qualitative shape from the centroid.
  let shape;
  if      (centroid <= 3.0) shape = "Top-heavy";
  else if (centroid <= 4.2) shape = "Senior-leaning";
  else if (centroid <= 5.2) shape = "Balanced";
  else if (centroid <= 6.5) shape = "Junior-leaning";
  else                       shape = "Bottom-heavy";
  // Comparison to a bell centred at mid-career (pos 4.5, σ ≈ 1.8).
  // Chi-square against that reference, scaled to a 0–1 "fit" score.
  const REF_MU = 4.5, REF_SIGMA = 1.8;
  const refPdf = (i) => Math.exp(-((i - REF_MU) ** 2) / (2 * REF_SIGMA * REF_SIGMA));
  const refRaw = ROLE_BUCKETS.map((_, i) => refPdf(i + 1));
  const refSum = refRaw.reduce((a, b) => a + b, 0);
  let chi = 0;
  ROLE_BUCKETS.forEach((b, i) => {
    const expected = total * refRaw[i] / refSum;
    const observed = counts[b.key];
    if (expected > 0.05) chi += (observed - expected) ** 2 / expected;
  });
  let bellNote;
  if      (chi < 2)   bellNote = "very close to bell";
  else if (chi < 6)   bellNote = "roughly bell-shaped";
  else if (chi < 12)  bellNote = "noticeably skewed from bell";
  else                bellNote = "far from a bell";
  // Title shows the current view's name (a specific unit, the All-staff
  // aggregate, or a UoA bucket). Overridable so overview-by-unit mode can
  // pass each unit's own name in.
  const viewName = viewNameOverride || CURRENT_UNIT?.name || "view";
  wrap.innerHTML = `
    <button class="role-copy-btn" type="button" title="Copy this card as an image to the clipboard">📋</button>
    <div class="role-summary-left">
      <div class="role-title">Staff by role (${escapeHTML(viewName)})</div>
      <div class="role-rows">${rows}</div>
      <div class="role-total">
        <div class="role-row-label">Total</div>
        <div></div>
        <div class="role-row-count">${total}</div>
      </div>
    </div>
    <div class="role-summary-right">
      <div class="role-stats-title">Distribution</div>
      <div class="rs-row"><span class="rs-k">Most common role</span><span class="rs-v">${escapeHTML(modeShort)} <span class="rs-sub">(${modeN})</span></span></div>
      <div class="rs-row"><span class="rs-k">Shape</span><span class="rs-v">${shape}</span></div>
      <div class="rs-bell-block" title="${escapeAttr(`Bell-curve comparison: ${bellNote} (χ² = ${chi.toFixed(1)}). Reference bell: Normal(μ = 4.5, σ = 1.8) centred at mid-career, scaled to this unit's total. Bars are the actual counts at each role position.`)}">
        <div class="rs-bell-label">Bell Curve Comparison</div>
        ${renderBellMini(counts, total, REF_MU, REF_SIGMA, refRaw, refSum)}
      </div>
    </div>
    <hr class="role-summary-divider">
    <div class="role-summary-bottom-left">
      <div class="rs-smj-block rs-smj-wide">
        <div class="rs-bell-label">Role Spread</div>
        ${renderSMJMini(senior, mid, junior)}
      </div>
    </div>
    <div class="role-summary-bottom-right">
      ${buildCoverageBlock(staff)}
    </div>`;
  return wrap;
}

function buildRoleSectionHead(bucketKey, count) {
  const b = ROLE_BUCKETS.find(x => x.key === bucketKey) || { label: bucketKey, color: "#aaa" };
  const div = document.createElement("div");
  div.className = "role-section-head";
  div.innerHTML = `<span class="sw" style="background:${b.color}"></span><span class="role-section-label">${b.label}</span><span class="role-section-count">${count}</span>`;
  return div;
}

function sortStaff(staff, key) {
  const arr = [...staff];
  if (key === "name") {
    arr.sort((a, b) => {
      const cmp = surnameOf(a.name).localeCompare(surnameOf(b.name));
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
    return arr;
  }
  if (key === "role") {
    arr.sort((a, b) => {
      const ia = ROLE_INDEX[classifyRole(a.title)];
      const ib = ROLE_INDEX[classifyRole(b.title)];
      if (ia !== ib) return ia - ib;
      const cmp = surnameOf(a.name).localeCompare(surnameOf(b.name));
      return cmp !== 0 ? cmp : a.name.localeCompare(b.name);
    });
    return arr;
  }
  const getKey = (p) => {
    const m = METRICS.get(p.scholar_id);
    if (!m) return null;
    if (key === "citations")  return m.citedby ?? 0;
    if (key === "hindex")     return m.hindex ?? 0;
    if (key === "h5")         return m.hindex5y ?? 0;
    return 0;
  };
  arr.sort((a, b) => {
    const av = getKey(a), bv = getKey(b);
    // null (MISSING or not-yet-hydrated) sinks to the bottom
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return a.name.localeCompare(b.name);
  });
  return arr;
}

// Overview only makes sense for aggregate views (All staff, All units in a
// school/faculty). Disable the button when a specific unit is selected — and
// if the user *was* on Overview when they switched to a single unit, fall
// back to Name sort so the screen doesn't just show one card.
function isOverviewApplicable() {
  return VIEW_MODE === "faculty" && CURRENT_UNIT?.slug === "all-staff";
}
function updateOverviewBtnState() {
  const btn = document.querySelector('.sort-btn[data-sort="overview"]');
  if (!btn) return;
  const ok = isOverviewApplicable();
  btn.disabled = !ok;
  btn.title = ok
    ? "One role-distribution card per unit (no individual people cards). Useful for school/faculty-wide views."
    : "Available when viewing All staff, or All units in a school or faculty. Pick a faculty/school in the dropdowns first.";
  if (!ok && currentSort === "overview") {
    // Silently switch sort so the view isn't broken.
    applySort("name");
  }
}

function applySort(key) {
  currentSort = key;
  localStorage.setItem("sd-sort", key);
  document.querySelectorAll(".sort-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.sort === key);
  });
  // Overview mode (or coming from it) needs a full re-render — its grid
  // contains role-summary cards instead of person cards, so the fast-reorder
  // path below doesn't apply.
  if (key === "overview" || !grid.querySelector(".person-card")) {
    renderPeople();
    return;
  }
  // Strip any role-mode decorations left over from a previous sort.
  grid.querySelectorAll(".role-summary, .role-section-head").forEach(el => el.remove());
  const vis = visibleStaff();
  const ordered = sortStaff(vis, key);
  if (key === "role") {
    // Prepend the role-distribution chart and insert section heads between
    // bucket transitions; reuse the already-hydrated card nodes.
    grid.prepend(buildRoleSummary(vis));
    const counts = {};
    for (const p of ordered) {
      const k = classifyRole(p.title);
      counts[k] = (counts[k] || 0) + 1;
    }
    let lastBucket = null;
    for (const p of ordered) {
      const bucket = classifyRole(p.title);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        grid.appendChild(buildRoleSectionHead(bucket, counts[bucket]));
      }
      const card = grid.querySelector(`[data-name="${cssEscape(p.name)}"]`);
      if (card) grid.appendChild(card);
    }
  } else {
    // Fast path — reorder existing card nodes, preserving hydrated metrics.
    for (const p of ordered) {
      const card = grid.querySelector(`[data-name="${cssEscape(p.name)}"]`);
      if (card) grid.appendChild(card);
    }
  }
  updateH5Badges(key === "h5");
}

function updateH5Badges(show) {
  for (const card of grid.querySelectorAll(".person-card")) {
    const existing = card.querySelector(".sort-traj-badge");
    if (existing) existing.remove();
    if (!show) continue;
    const name = card.dataset.name;
    const p = STAFF.find(s => s.name === name);
    const m = p && METRICS.get(p.scholar_id);
    if (!m || m.hindex5y == null) continue;
    const h5 = m.hindex5y;
    const ratio = directionRatio(m.hindex, h5);
    // Label is the h5 value itself; tone reflects ratio of recent vs lifetime h.
    let cls = "";
    if (ratio != null) {
      if      (ratio >= 0.66) cls = "rising";       // ≥ 2/3 of h-index comes from last 5y
      else if (ratio <= 0.33) cls = "established";  // ≤ 1/3 of h-index is recent
    }
    const badgeEl = card.querySelector(".badge");
    if (badgeEl) {
      const span = document.createElement("span");
      span.className = "sort-traj-badge " + cls;
      span.textContent = `h5: ${h5}`;
      span.title = ratio == null ? "" :
        `Recent h-index (h5) ${h5} · lifetime h ${m.hindex} · h5/h = ${ratio.toFixed(2)}`;
      badgeEl.insertAdjacentElement("afterend", span);
    }
  }
}

function cssEscape(s) {
  // crude — names contain no quotes or special selectors here, just escape backslash + double-quote
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".sort-btn");
  if (btn) applySort(btn.dataset.sort);
});

// "Hide emeritus" / "Hide visiting" toggles — restore state from localStorage
// at load time, re-render and update the "N hidden" pill on change.
function updateExcludedPill() {
  const pill = document.getElementById("excluded-pill");
  if (!pill) return;
  const list = collectExcludedStaff();
  if (!list.length) {
    pill.classList.add("hidden");
    pill.textContent = "";
    return;
  }
  pill.classList.remove("hidden");
  // Dedupe by name (cross-listed staff appear once per unit in the raw list).
  const uniq = new Set(list.map(r => r.name)).size;
  pill.textContent = `${uniq} hidden ⓘ`;
  pill.title = `${uniq} staff hidden by current exclusions — click for details`;
}
// Hide-emeritus / Hide-visiting are toggle chips (matching the REF 2029
// filter chip and the Sort/Scale button groups) rather than checkboxes,
// so the whole sort bar reads as one consistent set of pill toggles.
[
  { id: "exclude-emeritus", key: "sd-exclude-emeritus", read: excludeEmeritus, noun: "emeritus" },
  { id: "exclude-visiting", key: "sd-exclude-visiting", read: excludeVisiting, noun: "visiting" },
].forEach(({ id, key, read, noun }) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  // Chip shows the group name; when the hide-filter is engaged it gains a
  // 🚫 and the active fill ("Emeritus" → "Emeritus 🚫"). Tooltip explains.
  const cap = noun.charAt(0).toUpperCase() + noun.slice(1);
  const sync = (on) => {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? `${cap} 🚫` : cap;
    btn.title = on ? `${cap} hidden — click to show` : `Hide ${noun}`;
  };
  sync(read());
  btn.addEventListener("click", () => {
    const on = !(localStorage.getItem(key) === "1");
    localStorage.setItem(key, on ? "1" : "0");
    sync(on);
    renderPeople();
    updateExcludedPill();
  });
});
// Clicking the pill opens the same modal used from analytics.
document.getElementById("excluded-pill")?.addEventListener("click", openExcludedModal);

// Apply REF mode to a single card. When ON, the mini-chart is rebuilt to
// show ONLY the REF-window years that contain a publication the user has
// SELECTED for REF on this scholar's card; years with no selected output
// render as N/A. When OFF, the normal full citation chart is restored.
function setCardRefMode(card, on) {
  const chip = card.querySelector(".ref-chip");
  chip?.classList.toggle("active", on);
  card.classList.toggle("ref-mode", on);
  const id = card.querySelector(".card-metrics")?.dataset.id;
  const data = id && METRICS.get(id);
  const wrap = card.querySelector(".mini-spark-wrap");
  if (!data || !data.cites_per_year || !wrap) return;
  let html;
  if (on) {
    // Publication years of this scholar's REF-selected outputs.
    const selectedYears = new Set(
      Object.keys(refFlagsFor(id)).map(k => { const m = /^(\d{4})/.exec(k); return m ? +m[1] : null; }).filter(Boolean)
    );
    html = miniSparkline(data.cites_per_year, { ref: true, selectedYears });
  } else {
    html = miniSparkline(data.cites_per_year, {});
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  wrap.replaceWith(tmp.firstElementChild);
}

// Per-card chip — capture-phase so card-level click (modal) doesn't fire.
document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-ref-toggle]");
  if (!chip) return;
  e.stopPropagation();
  e.preventDefault();
  const card = chip.closest(".person-card");
  setCardRefMode(card, !chip.classList.contains("active"));
}, true);

// ─── Analytics ──────────────────────────────────────────────────────────────
// Cross-unit comparative dashboards. Reads from /api/scholar/<id> for every
// set staff member (mostly cached hits — fast). Computes per-unit aggregates.

// Analytics scope state — defaults to grouping by UoA (REF is the primary
// lens), whole-institution scope.
let ANALYTICS_SCOPE = { facultySlug: "__all__", schoolSlug: "__all__", unitSlug: "__all__", groupBy: "uoa" };

// Predicate shared across analytics + main grid. Honours the "Hide emeritus"
// and "Hide visiting" toggles in the sort bar.
function passesExclusions(p) {
  return !(excludeEmeritus() && isEmeritus(p))
      && !(excludeVisiting() && isVisiting(p));
}
function activeExclusionLabel() {
  const out = [];
  if (excludeEmeritus()) out.push("emeritus");
  if (excludeVisiting()) out.push("visiting");
  if (!out.length) return "";
  return "Excluding " + out.join(" + ");
}

// List every staff member currently hidden by the Hide-emeritus / Hide-visiting
// toggles, with the reason for each. Returns sorted by surname.
function collectExcludedStaff() {
  const out = [];
  const dropE = excludeEmeritus();
  const dropV = excludeVisiting();
  if (!dropE && !dropV) return out;
  const visit = (units, fac) => {
    for (const u of (units || [])) {
      if (u.disabled) continue;
      for (const p of (u.staff || [])) {
        const isE = dropE && isEmeritus(p);
        const isV = dropV && isVisiting(p);
        if (!isE && !isV) continue;
        const reason = [isE && "emeritus", isV && "visiting"].filter(Boolean).join(" + ");
        out.push({ name: p.name, title: p.title, unit: u.name, faculty: fac.name, reason });
      }
    }
  };
  for (const fac of FACULTIES) {
    for (const sch of (fac.schools || [])) visit(sch.units, fac);
    visit(fac.units, fac);
  }
  out.sort((a, b) => surnameOf(a.name).localeCompare(surnameOf(b.name)) || a.name.localeCompare(b.name));
  return out;
}

// Open a small modal listing all excluded staff. Built on demand and
// re-populated each open so it picks up toggle changes.
function openExcludedModal() {
  let modal = document.getElementById("excluded-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "excluded-modal";
    modal.className = "modal hidden";
    modal.innerHTML = `
      <div class="modal-card excluded-card">
        <button class="close" data-excluded-close aria-label="Close">×</button>
        <div id="excluded-body"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
    modal.querySelector("[data-excluded-close]").addEventListener("click", () => modal.classList.add("hidden"));
  }
  const list = collectExcludedStaff();
  const body = modal.querySelector("#excluded-body");
  if (!list.length) {
    body.innerHTML = `<h3>Excluded staff</h3>
      <p class="data-help">No exclusions active — toggle Hide emeritus / Hide visiting in the sort bar.</p>`;
  } else {
    body.innerHTML = `
      <h3>Excluded staff (${list.length})</h3>
      <p class="data-help">Hidden from the main grid and from analytics because of the
        <b>Hide emeritus</b> / <b>Hide visiting</b> toggles in the sort bar.</p>
      <table class="excluded-table">
        <thead><tr><th>Name</th><th>Title</th><th>Unit</th><th>Reason</th></tr></thead>
        <tbody>
          ${list.map(r => `<tr>
            <td><b>${escapeHTML(r.name)}</b></td>
            <td>${escapeHTML(r.title || "")}</td>
            <td>${escapeHTML(r.unit)}<br><small>${escapeHTML(r.faculty)}</small></td>
            <td><span class="excl-reason excl-${r.reason.includes("+") ? "both" : r.reason}">${escapeHTML(r.reason)}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }
  modal.classList.remove("hidden");
}

function _allActiveUnitsForScope(scope) {
  const out = [];
  for (const fac of FACULTIES) {
    if (scope.facultySlug !== "__all__" && fac.slug !== scope.facultySlug) continue;
    const schoolBlocks = (fac.schools && fac.schools.length)
      ? fac.schools.map(sch => ({ school: sch, units: sch.units || [] }))
      : [{ school: null, units: fac.units || [] }];
    for (const sb of schoolBlocks) {
      if (scope.schoolSlug !== "__all__" && (!sb.school || sb.school.slug !== scope.schoolSlug)) continue;
      for (const u of sb.units) {
        if (u.disabled) continue;
        if (scope.unitSlug !== "__all__" && u.slug !== scope.unitSlug) continue;
        out.push({ unit: u, school: sb.school, faculty: fac });
      }
    }
  }
  return out;
}

async function openAnalytics(mode) {
  // mode: "faculty" → group by unit, citation metrics first; "uoa" → group by
  // UoA, REF readiness first. Defaults to whatever's already selected.
  if (mode === "faculty") ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, groupBy: "unit" };
  else if (mode === "uoa") ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, groupBy: "uoa" };
  const modal = document.getElementById("analytics-modal");
  const body = document.getElementById("analytics-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<p class="spinner">Loading Scholar data…</p>`;
  await renderAnalyticsForScope();
}

async function renderAnalyticsForScope() {
  const body = document.getElementById("analytics-body");
  body.innerHTML = `${renderAnalyticsScopeBar()}<p class="spinner">Loading Scholar data…</p>`;
  // Re-bind the scope dropdowns immediately
  bindAnalyticsScope();

  const groupBy = ANALYTICS_SCOPE.groupBy || "uoa";
  const scopedUnits = _allActiveUnitsForScope(ANALYTICS_SCOPE);

  // REF readiness is computed from the ACTUAL selected outputs (flagged with a
  // star rating) and the impact case studies — not a venue heuristic. Load
  // those first so the scorecard reflects real curatorial decisions.
  await loadRefFlags();
  let allCases = [], refTargets = { default: { multiplier: 2.5 } };
  try { allCases = (await (await fetch("/api/case-studies")).json()).case_studies || []; } catch {}
  try { refTargets = await (await fetch("/api/ref-targets")).json(); } catch {}
  const casesByUoa = {};
  for (const c of allCases) {
    const k = String(c.uoa || "");
    (casesByUoa[k] ||= { total: 0, finished: 0 });
    casesByUoa[k].total++;
    if (c.status === "finished") casesByUoa[k].finished++;
  }

  // Walk every staff member in scope, tag with their unit/faculty/effective
  // UoA, and apply the Hide-emeritus / Hide-visiting toggles so analytics
  // matches what the main grid is showing.
  const allStaff = [];
  for (const { unit, faculty: fac } of scopedUnits) {
    for (const p of (unit.staff || [])) {
      if (!passesExclusions(p)) continue;
      allStaff.push({
        p, unit, fac,
        uoaCode: effectiveUoa(p, unit) || 0,   // 0 = no UoA
      });
    }
  }

  // Fetch Scholar payloads for set staff (cache-warm = instant), capped 6.
  const tasks = allStaff.filter(x => x.p.scholar_id && x.p.scholar_status === "set");
  const rows = [];
  const queue = tasks.slice();
  await Promise.all(Array.from({length: 6}, async () => {
    while (queue.length) {
      const { p, unit, fac, uoaCode } = queue.shift();
      try {
        const r = await fetch(`/api/scholar/${encodeURIComponent(p.scholar_id)}`);
        if (r.ok) {
          const d = await r.json();
          rows.push({
            name: p.name, unit: unit.name, unitSlug: unit.slug, faculty: fac.name,
            uoaCode,
            citedby: d.citedby ?? 0, hindex: d.hindex ?? 0, hindex5y: d.hindex5y ?? 0,
            citedby5y: d.citedby5y ?? 0,
            // Selected-for-REF outputs only (count + their star ratings).
            refPubs: refFlagCount(p.scholar_id),
            refRatings: Object.values(refFlagsFor(p.scholar_id)).filter(v => typeof v === "number"),
            cpy: d.cites_per_year || {},
          });
        }
      } catch {}
    }
  }));

  // Build aggregates — by unit OR by UoA depending on groupBy. Keep the
  // same output shape so every renderXxx() function works for both modes.
  const agg = new Map();
  const ensure = (key, name, faculty) => {
    if (!agg.has(key)) agg.set(key, {
      key, name, faculty, total: 0, set: 0, missing: 0, unchecked: 0,
      citedbySum: 0, refPubsSum: 0, hindexMean: 0, h5h_ratios: [], cpyTotal: {},
      refRatings: [],
    });
    return agg.get(key);
  };
  if (groupBy === "uoa") {
    // Pre-seed the buckets for every UoA that has ≥1 staff in scope.
    for (const x of allStaff) {
      const code = x.uoaCode;
      const u = code ? UOA_BY_CODE[code] : null;
      const key = code ? `uoa-${code}` : "uoa-none";
      const name = code ? `UoA ${code} · ${u?.name || ""}` : "No UoA assigned";
      const a = ensure(key, name, "");
      a.total++;
      if      (x.p.scholar_status === "set")     a.set++;
      else if (x.p.scholar_status === "missing") a.missing++;
      else                                       a.unchecked++;
    }
    for (const r of rows) {
      const code = r.uoaCode;
      const key = code ? `uoa-${code}` : "uoa-none";
      const a = agg.get(key);
      if (!a) continue;
      a.citedbySum += r.citedby;
      a.refPubsSum += r.refPubs;
      if (r.refRatings) a.refRatings.push(...r.refRatings);
      a.hindexMean += r.hindex;
      if (r.hindex > 0) a.h5h_ratios.push(r.hindex5y / r.hindex);
      for (const [y, v] of Object.entries(r.cpy)) a.cpyTotal[y] = (a.cpyTotal[y] || 0) + (v || 0);
    }
  } else {
    // Unit mode.
    for (const { unit, faculty: fac } of scopedUnits) {
      ensure(`unit-${unit.slug}`, unit.name, fac.name);
    }
    for (const x of allStaff) {
      const a = agg.get(`unit-${x.unit.slug}`);
      if (!a) continue;
      a.total++;
      if      (x.p.scholar_status === "set")     a.set++;
      else if (x.p.scholar_status === "missing") a.missing++;
      else                                       a.unchecked++;
    }
    for (const r of rows) {
      const a = agg.get(`unit-${r.unitSlug}`);
      if (!a) continue;
      a.citedbySum += r.citedby;
      a.refPubsSum += r.refPubs;
      if (r.refRatings) a.refRatings.push(...r.refRatings);
      a.hindexMean += r.hindex;
      if (r.hindex > 0) a.h5h_ratios.push(r.hindex5y / r.hindex);
      for (const [y, v] of Object.entries(r.cpy)) a.cpyTotal[y] = (a.cpyTotal[y] || 0) + (v || 0);
    }
  }
  const refMult = (refTargets.default && refTargets.default.multiplier) || 2.5;
  for (const a of agg.values()) {
    a.hindexMean = a.set ? a.hindexMean / a.set : 0;
    a.h5h_median = median(a.h5h_ratios);
    a.perCapita = a.set ? a.citedbySum / a.set : 0;
    a.refPerActive = a.set ? a.refPubsSum / a.set : 0;
    // REF readiness, from real selections: GPA, output target, case studies.
    a.refGpaVal = a.refRatings.length ? a.refRatings.reduce((s, v) => s + v, 0) / a.refRatings.length : null;
    a.outputsRequired = Math.round(refMult * a.set);
    if (a.key.startsWith("uoa-")) {
      const code = a.key.replace("uoa-", "");
      const cs = casesByUoa[code] || { total: 0, finished: 0 };
      a.cases = cs.total; a.casesFinished = cs.finished;
    }
  }
  // Sort UoA buckets by code (so the headers read 1 → 34) when in UoA mode.
  let aggList = [...agg.values()].filter(a => a.total > 0);
  if (groupBy === "uoa") {
    aggList.sort((a, b) => {
      const ac = parseInt(a.key.replace("uoa-", ""), 10) || 999;
      const bc = parseInt(b.key.replace("uoa-", ""), 10) || 999;
      return ac - bc;
    });
  }

  const bucketLabel = groupBy === "uoa" ? "UoAs" : "units";
  // Cross-listings doesn't fit UoA mode (a person belongs to one UoA at a time
  // in the model). Hide it there.
  const crossSection = groupBy === "uoa" ? "" : renderCrossListings();
  // UoA analytics leads with REF ranking/readiness (the REF lens); Faculty
  // analytics leads with citation metrics. Both carry the readiness cards.
  const sections = groupBy === "uoa"
    ? [renderRefReadiness(aggList, groupBy), renderVisibility(aggList), renderCitationTotals(aggList), renderMomentumQuadrant(aggList), renderHeatmap(aggList)]
    : [renderVisibility(aggList), renderCitationTotals(aggList), renderRefReadiness(aggList, groupBy), renderMomentumQuadrant(aggList), crossSection, renderHeatmap(aggList)];
  body.innerHTML = `
    ${renderAnalyticsScopeBar()}
    ${sections.join("\n")}
    <p class="analytics-foot">Computed from ${rows.length} hydrated Scholar profiles across ${aggList.length} ${bucketLabel}. ${activeExclusionLabel() ? `<span class="analytics-excl">· ${escapeHTML(activeExclusionLabel())}</span>` : ""}</p>
  `;
  bindAnalyticsScope();
}

function renderAnalyticsScopeBar() {
  const scope = ANALYTICS_SCOPE;
  const facOpts = `<option value="__all__">All faculties</option>` +
    FACULTIES.map(f => `<option value="${escapeAttr(f.slug)}" ${f.slug===scope.facultySlug?"selected":""}>${escapeHTML(f.name)}</option>`).join("");

  // Schools only meaningful for a single faculty
  const fac = FACULTIES.find(f => f.slug === scope.facultySlug);
  const schools = fac?.schools || [];
  const showSchools = scope.facultySlug !== "__all__" && schools.length > 0;
  const schoolOpts = showSchools
    ? `<option value="__all__">All schools</option>` +
      schools.map(s => `<option value="${escapeAttr(s.slug)}" ${s.slug===scope.schoolSlug?"selected":""}>${escapeHTML(s.name)}</option>`).join("")
    : `<option value="__all__">—</option>`;

  // Units restricted by faculty + school
  const scopedUnits = _allActiveUnitsForScope({...scope, unitSlug: "__all__"});
  const unitOpts = `<option value="__all__">All units</option>` +
    scopedUnits.map(({unit}) => `<option value="${escapeAttr(unit.slug)}" ${unit.slug===scope.unitSlug?"selected":""}>${escapeHTML(unit.name)}</option>`).join("");

  const groupBy = scope.groupBy || "unit";
  const excl = activeExclusionLabel();
  return `<div class="analytics-scope">
    <label class="a-groupby" title="Aggregate every section by REF ${REF_YEAR} UoA bucket or by unit">Group by
      <select id="a-groupby">
        <option value="uoa"  ${groupBy==="uoa"?"selected":""}>UoA</option>
        <option value="unit" ${groupBy==="unit"?"selected":""}>Unit</option>
      </select>
    </label>
    <span class="a-sep" aria-hidden="true"></span>
    <label>Faculty <select id="a-fac">${facOpts}</select></label>
    <label class="${showSchools?'':'sc-hidden'}">School <select id="a-sch" ${showSchools?'':'disabled'}>${schoolOpts}</select></label>
    <label>Unit <select id="a-unit">${unitOpts}</select></label>
    <span class="a-spacer"></span>
    <button class="tb-btn" id="a-reset" title="Reset to whole-institution view">Reset</button>
    <button class="tb-btn" id="a-print" title="Export this analytics view as PDF (browser print dialog)">⤓ PDF</button>
  </div>
  ${excl ? `<button class="analytics-excl-note" type="button" id="a-excl-open" title="Click to see the excluded staff">${escapeHTML(excl)} — inherited from main view.</button>` : ""}`;
}

function bindAnalyticsScope() {
  const fac = document.getElementById("a-fac");
  const sch = document.getElementById("a-sch");
  const u   = document.getElementById("a-unit");
  const grp = document.getElementById("a-groupby");
  const rst = document.getElementById("a-reset");
  const prn = document.getElementById("a-print");
  fac?.addEventListener("change", () => {
    ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, facultySlug: fac.value, schoolSlug: "__all__", unitSlug: "__all__" };
    renderAnalyticsForScope();
  });
  sch?.addEventListener("change", () => {
    ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, schoolSlug: sch.value, unitSlug: "__all__" };
    renderAnalyticsForScope();
  });
  u?.addEventListener("change", () => {
    ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, unitSlug: u.value };
    renderAnalyticsForScope();
  });
  grp?.addEventListener("change", () => {
    ANALYTICS_SCOPE = { ...ANALYTICS_SCOPE, groupBy: grp.value };
    renderAnalyticsForScope();
  });
  rst?.addEventListener("click", () => {
    ANALYTICS_SCOPE = { facultySlug: "__all__", schoolSlug: "__all__", unitSlug: "__all__", groupBy: ANALYTICS_SCOPE.groupBy || "uoa" };
    renderAnalyticsForScope();
  });
  prn?.addEventListener("click", () => {
    // Tag <body> so the analytics-only print stylesheet kicks in, print, then strip.
    document.body.classList.add("printing-analytics");
    const cleanup = () => {
      document.body.classList.remove("printing-analytics");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);
  });
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid-1] + s[mid]) / 2;
}

function renderVisibility(aggList) {
  const sorted = [...aggList].sort((a, b) =>
    (b.set / Math.max(b.total, 1)) - (a.set / Math.max(a.total, 1))
  );
  const rows = sorted.map(a => {
    const total = Math.max(a.total, 1);
    const setPct = (a.set / total) * 100;
    const missPct = (a.missing / total) * 100;
    const uncPct = (a.unchecked / total) * 100;
    return `<tr>
      <th>${escapeHTML(a.name)}<small>${escapeHTML(a.faculty)}</small></th>
      <td>
        <div class="vis-bar">
          <span class="vis-set" style="width:${setPct}%" title="${a.set} on Scholar"></span>
          <span class="vis-miss" style="width:${missPct}%" title="${a.missing} missing"></span>
          <span class="vis-unc" style="width:${uncPct}%" title="${a.unchecked} unchecked"></span>
        </div>
      </td>
      <td class="vis-pct">${Math.round(setPct)}%</td>
    </tr>`;
  }).join("");
  return `<section class="analytics-section">
    <h4>1. Faculty visibility map</h4>
    <p class="analytics-q">Where is Scholar systematically blind?</p>
    <table class="vis-table"><tbody>${rows}</tbody></table>
    <p class="analytics-note">Per unit: dark blue = on Scholar · orange = MISSING · grey = unchecked. Sorted by % set descending.
    Practice-based and book-publishing disciplines sit at the bottom because Scholar can't index their primary outputs.</p>
  </section>`;
}

function renderCitationTotals(aggList) {
  const sorted = [...aggList].filter(a => a.citedbySum > 0).sort((a, b) => b.citedbySum - a.citedbySum);
  const maxTotal = Math.max(...sorted.map(a => a.citedbySum), 1);
  const maxPC = Math.max(...sorted.map(a => a.perCapita), 1);
  const rows = sorted.map(a => `<tr>
    <th scope="row">${escapeHTML(a.name)}<small>${escapeHTML(a.faculty)}</small></th>
    <td>
      <div class="abar-cell" title="Total citations: ${a.citedbySum.toLocaleString()} (across ${a.set} active Scholar profiles)">
        <div class="abar abar-total"><span style="width:${(a.citedbySum/maxTotal)*100}%"></span></div>
        <b>${a.citedbySum.toLocaleString()}</b>
      </div>
    </td>
    <td>
      <div class="abar-cell" title="Per active staff: ${Math.round(a.perCapita).toLocaleString()} citations (${a.citedbySum.toLocaleString()} ÷ ${a.set})">
        <div class="abar abar-pc"><span style="width:${(a.perCapita/maxPC)*100}%"></span></div>
        <b>${Math.round(a.perCapita).toLocaleString()}</b>
      </div>
    </td>
  </tr>`).join("");
  return `<section class="analytics-section">
    <h4>2. Citation totals & per-capita</h4>
    <p class="analytics-q">Which unit pulls the most citation weight — absolutely (left) and per researcher (right)?</p>
    <table class="abar-table">
      <thead>
        <tr>
          <th class="abar-col-unit"></th>
          <th class="abar-col-total"><span class="abar-sw abar-sw-total"></span> Total citations</th>
          <th class="abar-col-pc"><span class="abar-sw abar-sw-pc"></span> Per active staff</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="analytics-note">
      <b>Total</b> bars are scaled against the largest absolute total, <b>Per active</b> bars
      against the largest per-capita value — so a unit can have a short Total bar but a long
      Per-active bar (or vice versa). Absolute totals can be dominated by one mega-cited
      individual; per-capita reveals broadly strong units versus one-star units.
    </p>
  </section>`;
}

function renderRefReadiness(aggList, groupBy) {
  const byUoa = groupBy === "uoa";
  const sorted = [...aggList].filter(a => a.set > 0)
    .sort((a, b) => (b.refPubsSum / Math.max(b.outputsRequired, 1)) - (a.refPubsSum / Math.max(a.outputsRequired, 1)));
  const cards = sorted.map(a => {
    const total = a.refPubsSum;
    const need = a.outputsRequired || 0;
    // Tier from outputs-vs-target (the headline readiness signal).
    const tier = (rag => ({ ok: "good", warn: "ok", under: "low", na: "low" }[rag]))(targetRag(total, need));
    const gpa = a.refGpaVal;
    const csCell = byUoa
      ? `<div><b>${a.cases || 0}</b><span>case studies${a.casesFinished ? ` · ${a.casesFinished} fin.` : ""}</span></div>`
      : `<div><b>${a.set}/${a.total}</b><span>active staff</span></div>`;
    return `<div class="ref-card ref-tier-${tier}">
      <h5>${escapeHTML(a.name)}</h5>
      <div class="ref-card-grid">
        <div><b>${total}<small> / ${need}</small></b><span>selected outputs / target</span></div>
        <div class="rag-${gpaRag(gpa)}"><b>${gpa == null ? "—" : gpa.toFixed(2)}</b><span>mean GPA</span></div>
        ${csCell}
      </div>
    </div>`;
  }).join("") || `<p class="analytics-note">No outputs have been selected for REF yet — set a star rating on people's outputs.</p>`;
  return `<section class="analytics-section">
    <h4>3. REF ${REF_YEAR} readiness scorecard</h4>
    <p class="analytics-q">For each ${byUoa ? "UoA" : "unit"}: how do the <em>selected</em> outputs and impact case studies stack up against the submission target?</p>
    <div class="ref-grid">${cards}</div>
    <p class="analytics-note">Counts the actual outputs flagged for REF (with their star ratings) and the impact case studies recorded${byUoa ? " for each UoA" : ""} — not a venue heuristic. Target = multiplier × active staff (set in Settings). Cards tint green when selections meet the target, amber when close, red when short.</p>
  </section>`;
}

function renderMomentumQuadrant(aggList) {
  const points = aggList.filter(a => a.set > 1 && a.h5h_median != null).map(a => ({
    name: a.name, x: a.hindexMean, y: a.h5h_median, size: a.set,
  }));
  if (!points.length) return "";
  const W = 600, H = 320, pad = 40;
  const xMax = Math.max(...points.map(p => p.x), 5);
  const yMax = Math.max(...points.map(p => p.y), 1);
  const sx = (x) => pad + (x / xMax) * (W - pad * 2);
  const sy = (y) => H - pad - (y / yMax) * (H - pad * 2);
  const dots = points.map(p => {
    const r = Math.sqrt(p.size) * 2 + 3;
    return `<g>
      <circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="${r}" fill="var(--accent)" opacity="0.55"></circle>
      <text x="${sx(p.x) + r + 3}" y="${sy(p.y) + 3}" font-size="9">${escapeHTML(p.name.slice(0,28))}</text>
    </g>`;
  }).join("");
  return `<section class="analytics-section">
    <h4>4. Recent-momentum quadrant</h4>
    <p class="analytics-q">Which units are rising vs consolidating?</p>
    <svg class="quad" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="#bbb"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H-pad}" stroke="#bbb"/>
      <text x="${W/2}" y="${H-8}" text-anchor="middle" font-size="10" fill="#666">Mean lifetime h-index →</text>
      <text x="14" y="${H/2}" text-anchor="middle" font-size="10" fill="#666" transform="rotate(-90 14 ${H/2})">Median h5 ÷ h ratio →</text>
      ${dots}
    </svg>
    <p class="analytics-note">X-axis = mean lifetime h-index (volume/seniority). Y-axis = median ratio of recent h-index to lifetime h-index (recency share).
    Top-right = established AND currently rising. Bottom-right = consolidating Emeriti-heavy. Top-left = young unit with momentum. Dot size = number of active staff.</p>
  </section>`;
}

function renderCrossListings() {
  // Walk faculties, collect people-by-id with all (unit) memberships. Units
  // can live directly under a faculty or under a school inside it — guard
  // both since either array can be absent after the Markdown loader drops
  // empty collections.
  const map = new Map();
  const visit = (u, fac) => {
    if (!u || u.disabled) return;
    for (const p of (u.staff || [])) {
      const key = p.staff_id || p.name;
      if (!map.has(key)) map.set(key, { name: p.name, units: [] });
      map.get(key).units.push(`${u.name} (${fac.name})`);
    }
  };
  for (const fac of FACULTIES) {
    for (const sch of (fac.schools || [])) {
      for (const u of (sch.units || [])) visit(u, fac);
    }
    for (const u of (fac.units || [])) visit(u, fac);
  }
  const multi = [...map.values()].filter(p => p.units.length > 1)
                                  .sort((a, b) => b.units.length - a.units.length || a.name.localeCompare(b.name));
  if (!multi.length) return `<section class="analytics-section">
    <h4>5. Cross-listed staff</h4>
    <p class="analytics-q">Who appears in multiple units?</p>
    <p class="analytics-note">No staff are currently cross-listed across multiple units.</p>
  </section>`;
  const rows = multi.map(p => `<tr>
    <th>${escapeHTML(p.name)}</th>
    <td><span class="cl-count">${p.units.length}</span></td>
    <td>${p.units.map(u => `<span class="cl-pill">${escapeHTML(u)}</span>`).join("")}</td>
  </tr>`).join("");
  return `<section class="analytics-section">
    <h4>5. Cross-listed staff</h4>
    <p class="analytics-q">Who appears in multiple units — the faculty's bridge-workers?</p>
    <table class="cl-table"><tbody>${rows}</tbody></table>
    <p class="analytics-note">${multi.length} staff cross-listed across ${[...new Set(multi.flatMap(p => p.units))].length} units.
    These individuals often anchor cross-cutting MAs, research clusters, or institutes.</p>
  </section>`;
}

function renderHeatmap(aggList) {
  const present = aggList.filter(a => Object.keys(a.cpyTotal).length).sort((a,b) => b.citedbySum - a.citedbySum);
  if (!present.length) return "";
  const allYears = new Set();
  for (const a of present) Object.keys(a.cpyTotal).forEach(y => allYears.add(+y));
  const years = [...allYears].sort();
  // Clip to last 20 years
  const last20 = years.slice(-20);
  const maxV = Math.max(1, ...present.flatMap(a => last20.map(y => a.cpyTotal[y] || 0)));
  const cellW = 18, cellH = 14;
  const labelW = 200;
  const W = labelW + last20.length * cellW;
  const H = present.length * cellH + 24;
  const cells = present.map((a, i) => {
    return last20.map((y, j) => {
      const v = a.cpyTotal[y] || 0;
      const intensity = Math.sqrt(v / maxV);
      const fill = `rgba(11, 47, 94, ${intensity.toFixed(2)})`;
      return `<rect x="${labelW + j*cellW}" y="${24 + i*cellH}" width="${cellW-1}" height="${cellH-1}" fill="${fill}"><title>${escapeHTML(a.name)} · ${y}: ${v} cites</title></rect>`;
    }).join("");
  }).join("");
  const yearLabels = last20.map((y, j) => `<text x="${labelW + j*cellW + cellW/2}" y="18" text-anchor="middle" font-size="9" fill="#666">${y % 100}</text>`).join("");
  const unitLabels = present.map((a, i) => `<text x="${labelW - 6}" y="${24 + i*cellH + cellH - 4}" text-anchor="end" font-size="9" fill="#222">${escapeHTML(a.name.slice(0,30))}</text>`).join("");
  return `<section class="analytics-section">
    <h4>6. Citation-by-year heatmap</h4>
    <p class="analytics-q">When did each unit accumulate its citations?</p>
    <svg class="heatmap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid meet">
      ${yearLabels}${unitLabels}${cells}
    </svg>
    <p class="analytics-note">Darker = more citations that year. Hover any cell for the exact number. The rightmost column is the current year and reads paler (still in progress).</p>
  </section>`;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-analytics-faculty")) openAnalytics("faculty");
  if (e.target.closest("#tb-analytics-uoa")) openAnalytics("uoa");
  if (e.target.closest("[data-analytics-close]")) document.getElementById("analytics-modal").classList.add("hidden");
});
document.getElementById("analytics-modal")?.addEventListener("click", (e) => {
  const m = e.currentTarget;
  if (e.target === m) m.classList.add("hidden");
});

// ─── Data editor ────────────────────────────────────────────────────────────
// Edit staff.json from inside the dashboard. Add/remove staff, add/remove
// units, change names, titles, IDs, status. POSTed back to /api/staff and
// written to disk (with timestamped .bak backup).

// Cache freshness map, populated on every Data editor open. Keyed by scholar_id.
let SCHOLAR_CACHE_INDEX = {};

async function loadScholarCacheIndex() {
  try {
    const r = await fetch("/api/scholar-cache-index");
    if (!r.ok) return;
    SCHOLAR_CACHE_INDEX = await r.json();
  } catch (_) { /* preview mode — leave empty, rows just won't show dates */ }
}

function openDataEditor() {
  const ed = document.getElementById("data-editor");
  ed.innerHTML = "";
  // Kick off the cache-index fetch in parallel. When it lands, we re-decorate
  // every staff row with its freshness badge.
  loadScholarCacheIndex().then(() => decorateAllStaffFreshness(ed));
  // Render each faculty as a top-level group containing schools (if any) and units.
  FACULTIES.forEach(fac => ed.appendChild(buildFacultyEditor(fac)));
  // Footer add-faculty button
  const addFac = document.createElement("button");
  addFac.className = "tb-btn data-add-fac";
  addFac.textContent = "+ Add faculty";
  addFac.onclick = () => {
    const name = prompt("Faculty name (e.g. 'Science & Technology')");
    if (!name) return;
    const school = prompt("School name (optional)", "");
    const url = prompt("Faculty homepage URL (optional)", "");
    const slug = slugify(name);                  // auto — never asked of the user
    const newFac = { slug, name, school: school || "", url: url || "", units: [] };
    ed.insertBefore(buildFacultyEditor(newFac), addFac);
  };
  ed.appendChild(addFac);

  document.getElementById("data-status").textContent = "";
  document.getElementById("data-modal").classList.remove("hidden");
}

// Derive a URL-safe identifier from a display name. Only used when the user
// creates a new faculty / unit; existing slugs are never rewritten.
function slugify(s) {
  return String(s).toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unit";
}

// Scholar trash — restore people removed in a save (30-day retention).
async function openTrash() {
  const modal = document.getElementById("trash-modal");
  modal.classList.remove("hidden");
  const body = document.getElementById("trash-body");
  body.innerHTML = `<p class="spinner">Loading…</p>`;
  let d = { trash: [], retention_days: 30 };
  try { d = await (await fetch("/api/trash")).json(); } catch {}
  const items = d.trash || [];
  const rows = items.map(it => {
    const p = it.person || {};
    const when = it.deleted_at ? new Date(it.deleted_at).toLocaleDateString() : "";
    return `<div class="csm-row">
      <span class="csm-title">${escapeHTML(p.name || "(unnamed)")}</span>
      <span class="csm-meta">${escapeHTML(p.title || "")} · from ${escapeHTML(it.unit_name || it.unit_slug || "?")} · deleted ${escapeHTML(when)}</span>
      <button class="tb-btn" data-trash-restore="${escapeAttr(it.id)}">Restore</button>
      <button class="tb-btn csm-del" data-trash-purge="${escapeAttr(it.id)}" title="Delete forever">🗑</button>
    </div>`;
  }).join("") || `<p class="cs-empty">Trash is empty.</p>`;
  body.innerHTML = `
    <div class="tr-top"><h3>Trash</h3>${items.length ? `<button class="tb-btn dz-btn" id="trash-empty">Empty trash</button>` : ""}</div>
    <p class="csm-intro">People removed when you save the data editor are kept here for ${d.retention_days || 30} days, then deleted automatically. Restoring returns a person to their original unit and reloads.</p>
    ${rows}`;
  body.querySelectorAll("[data-trash-restore]").forEach(b => b.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", id: b.dataset.trashRestore }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "restore failed");
      alert(`Restored to “${j.unit || "its unit"}”. Reloading…`);
      location.reload();
    } catch (e) { alert("Restore failed: " + e.message); }
  }));
  body.querySelectorAll("[data-trash-purge]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Delete this person permanently? This cannot be undone.")) return;
    try { await fetch("/api/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "purge", id: b.dataset.trashPurge }) }); openTrash(); }
    catch (e) { alert("Failed: " + e.message); }
  }));
  body.querySelector("#trash-empty")?.addEventListener("click", async () => {
    if (!confirm("Permanently empty the trash? This cannot be undone.")) return;
    try { await fetch("/api/trash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "empty" }) }); openTrash(); }
    catch (e) { alert("Failed: " + e.message); }
  });
}

function buildFacultyEditor(fac) {
  const block = document.createElement("section");
  block.className = "data-faculty";
  block.dataset.slug = fac.slug;
  block.innerHTML = `
    <header class="data-faculty-head">
      <input class="data-faculty-name" value="${escapeAttr(fac.name)}" placeholder="Faculty name">
      <input class="data-faculty-url"  value="${escapeAttr(fac.url || '')}" placeholder="https://…  (faculty homepage)" type="url">
      <span class="data-faculty-id" title="Internal identifier — derived from the faculty name when added.">id: <code>${escapeHTML(fac.slug)}</code></span>
    </header>
    <div class="data-faculty-body"></div>
    <div class="data-faculty-actions">
      <button class="data-add-school">+ Add school</button>
      <button class="data-add-unit-direct" title="Add a unit directly under this faculty (no school)">+ Add unit (no school)</button>
    </div>
  `;
  const body = block.querySelector(".data-faculty-body");
  // Render schools layer (new shape)
  (fac.schools || []).forEach(sch => body.appendChild(buildSchoolEditor(sch)));
  // Render direct units (legacy shape, faculties without schools)
  (fac.units || []).forEach(u => body.appendChild(buildUnitEditor(u)));

  block.querySelector(".data-add-school").onclick = () => {
    const name = prompt("New school name (e.g. 'School of Engineering')");
    if (!name) return;
    const url = prompt("School homepage URL (optional)", "");
    const slug = slugify(name);
    body.appendChild(buildSchoolEditor({ slug, name, url: url || "", units: [] }));
  };
  block.querySelector(".data-add-unit-direct").onclick = () => {
    const name = prompt("New unit name");
    if (!name) return;
    const slug = slugify(name);
    body.appendChild(buildUnitEditor({ slug, name, source: "(manually added)", last_scraped: "", staff: [] }));
  };
  return block;
}

function buildSchoolEditor(sch) {
  const card = document.createElement("details");
  card.className = "data-school";
  card.dataset.slug = sch.slug;
  card.open = true;
  const unitCount = (sch.units || []).length;
  card.innerHTML = `
    <summary class="data-school-summary">
      <input class="data-school-name" value="${escapeAttr(sch.name)}" placeholder="School name">
      <input class="data-school-url"  value="${escapeAttr(sch.url || '')}" placeholder="https://…  (school page)" type="url">
      <span class="data-school-id" title="Internal identifier — derived from the school name when added.">id: <code>${escapeHTML(sch.slug)}</code></span>
      <span class="data-school-count">${unitCount} unit${unitCount===1?'':'s'}</span>
    </summary>
    <div class="data-school-units"></div>
    <button class="data-add-unit-to-school">+ Add unit to this school</button>
  `;
  const unitsHost = card.querySelector(".data-school-units");
  (sch.units || []).forEach(u => unitsHost.appendChild(buildUnitEditor(u)));
  card.querySelector(".data-add-unit-to-school").onclick = (e) => {
    e.preventDefault();
    const name = prompt("New unit name");
    if (!name) return;
    const slug = slugify(name);
    unitsHost.appendChild(buildUnitEditor({ slug, name, source: "(manually added)", last_scraped: "", staff: [] }));
  };
  // Clicking the inputs shouldn't toggle the accordion
  card.querySelectorAll("input, button").forEach(el => el.addEventListener("click", (e) => e.stopPropagation()));
  return card;
}

function buildUnitEditor(unit) {
  const card = document.createElement("details");
  card.className = "data-unit";
  card.dataset.slug = unit.slug;
  card.open = false;   // start collapsed — give user an overview of every unit at once
  const isDisabled = unit.disabled === true;
  if (isDisabled) card.classList.add("data-unit-disabled");
  card.innerHTML = `
    <summary data-hint="click to expand">
      <input class="data-unit-name" value="${escapeAttr(unit.name)}" placeholder="Unit name">
      <span class="data-unit-slug" title="Internal identifier — used for URLs and cache keys. Derived from the unit name when added.">id: <code class="data-slug-text">${escapeHTML(unit.slug)}</code></span>
      <select class="data-unit-uoa" title="Default REF 2029 Unit of Assessment for this unit. Individual staff can override below.">
        ${uoaOptions(unit.uoa, "— no default UoA —")}
      </select>
      <span class="data-unit-count">${unit.staff.length}</span>
      <label class="data-unit-active" title="If unchecked, this unit is excluded from the 'All staff' view and faculty-level aggregations. The unit still appears in the dropdown.">
        <input type="checkbox" class="data-unit-active-cb" ${isDisabled ? "" : "checked"}>
        <span class="data-unit-active-label">active</span>
      </label>
      <button class="data-unit-savemd" title="Download this unit as a Markdown file (the version currently saved to disk)">⤓ .md</button>
    </summary>
    <table class="data-table">
      <thead>
        <tr><th>Name</th><th>Title</th><th>Staff ID</th><th>Scholar ID</th><th>Status</th><th>UoA</th><th></th></tr>
      </thead>
      <tbody></tbody>
    </table>
    <button class="data-add-row">+ Add staff</button>
  `;
  // Clicking the UoA select shouldn't toggle the accordion.
  card.querySelector(".data-unit-uoa").addEventListener("click", (e) => e.stopPropagation());
  const tbody = card.querySelector("tbody");
  unit.staff.forEach(p => tbody.appendChild(buildStaffRow(p)));
  card.querySelector(".data-add-row").onclick = () =>
    tbody.appendChild(buildStaffRow({name: "", title: "", staff_id: "", scholar_id: null, scholar_status: "unchecked"}));
  // Download this unit's Markdown file (the on-disk version).
  card.querySelector(".data-unit-savemd").onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadUnitFile(unit.slug);
  };
  // Live-update the cross-hatch + italic styling when active toggle flips.
  // Stops propagation so the toggle doesn't also collapse/expand the details accordion.
  const activeCb = card.querySelector(".data-unit-active-cb");
  activeCb.addEventListener("click", (e) => e.stopPropagation());
  activeCb.addEventListener("change", (e) => {
    card.classList.toggle("data-unit-disabled", !e.target.checked);
  });
  return card;
}

function buildStaffRow(p) {
  const tr = document.createElement("tr");
  tr.className = "data-staff-row";
  // Display the full Scholar URL so it's easy to click through, copy, paste.
  // On save we extract just the user=ID portion regardless of what was pasted.
  const scholarUrl = p.scholar_id
    ? `https://scholar.google.com/citations?user=${p.scholar_id}&hl=en`
    : "";
  tr.innerHTML = `
    <td><input class="r-name"    value="${escapeAttr(p.name)}"      placeholder="Full name"></td>
    <td><input class="r-title"   value="${escapeAttr(p.title)}"     placeholder="Title"></td>
    <td><input class="r-staff-id"  value="${escapeAttr(p.staff_id)}" placeholder="123456"></td>
    <td class="r-scholar-cell">
      <input class="r-scholar" type="url" value="${escapeAttr(scholarUrl)}"
             placeholder="https://scholar.google.com/citations?user=…  (paste full URL or just the ID)">
      ${p.scholar_id ? `<a class="r-scholar-open" href="${escapeAttr(scholarUrl)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>` : ``}
      <span class="r-last-scraped" data-id="${escapeAttr(p.scholar_id || '')}"></span>
    </td>
    <td>
      <select class="r-status">
        <option value="set"       ${p.scholar_status === "set"       ? "selected" : ""}>set</option>
        <option value="missing"   ${p.scholar_status === "missing"   ? "selected" : ""}>missing</option>
        <option value="unchecked" ${p.scholar_status === "unchecked" || !p.scholar_status ? "selected" : ""}>unchecked</option>
      </select>
    </td>
    <td>
      <select class="r-uoa" title="REF 2029 UoA for this individual. Leave on 'inherit' to follow the unit's default.">
        ${uoaOptions(p.uoa, "(inherit unit)")}
      </select>
    </td>
    <td class="data-row-actions">
      <button class="data-row-edit" title="View cached Scholar payload">ⓘ</button>
      <button class="data-row-del"  title="Delete this staff row">🗑</button>
    </td>
  `;
  tr.querySelector(".data-row-del").onclick = () => { tr.remove(); scheduleDataEditorAutosave(); };
  tr.querySelector(".data-row-edit").onclick = (e) => {
    e.preventDefault();
    // No-op when marked missing — the red X is a status indicator, not a
    // button to inspect a non-existent profile.
    if (tr.querySelector(".r-status").value === "missing") return;
    openStaffDetailModal(tr);
  };
  // Reflect the edit-vs-missing state in the action button. If status changes
  // to "missing", swap the ✎ for a red X (no profile to inspect); changing
  // back to set/unchecked restores ✎.
  const statusSel = tr.querySelector(".r-status");
  const syncActionButton = () => {
    const editBtn = tr.querySelector(".data-row-edit");
    if (statusSel.value === "missing") {
      editBtn.classList.add("is-missing");
      editBtn.textContent = "n/a";
      editBtn.title = "No Google Scholar profile";
    } else {
      editBtn.classList.remove("is-missing");
      editBtn.textContent = "ⓘ";
      editBtn.title = "View cached Scholar payload";
    }
  };
  statusSel.addEventListener("change", syncActionButton);
  syncActionButton();
  return tr;
}

// Open the per-staff Scholar payload modal, layered above the Data editor.
// Shows the cached payload (metrics, sparkline, recent pubs, raw JSON) so
// bad data can be spotted and either force-refreshed or cleared. The payload
// itself isn't directly editable (it's a cache of Google Scholar) — Force
// refresh and Clear cache are the levers for correcting it.
async function openStaffDetailModal(rowTr) {
  const modal = document.getElementById("staff-detail-modal");
  const body = document.getElementById("staff-detail-body");
  // Read the *current* values from the row inputs rather than the originally-
  // built p object, in case the user just edited the Scholar ID without saving.
  const scholarRaw = rowTr.querySelector(".r-scholar").value;
  const scholarId = parseScholarId(scholarRaw);
  const status = rowTr.querySelector(".r-status").value;
  const name = rowTr.querySelector(".r-name").value || "(unnamed)";
  const title = rowTr.querySelector(".r-title").value || "";

  body.innerHTML = `
    <h3>${escapeHTML(name)}</h3>
    <div class="affil">${escapeHTML(title)}</div>
    <div class="staff-detail-pane"><p class="spinner">Loading Scholar payload…</p></div>
  `;
  modal.classList.remove("hidden");
  const pane = body.querySelector(".staff-detail-pane");

  if (status === "missing") {
    pane.innerHTML = `<p class="affil">Marked <code>missing</code> — no Scholar profile to fetch.</p>`;
    return;
  }
  if (!scholarId) {
    pane.innerHTML = `<p class="affil">No Scholar ID set for ${escapeHTML(name)}. Paste a profile URL into the Scholar field on the row first, then re-open.</p>`;
    return;
  }

  await renderStaffDetailPayload(pane, scholarId, name);
  // After a refresh/clear inside the pane, freshness badges on the underlying
  // Data editor may be stale. Re-decorate when the modal closes.
}

function closeStaffDetailModal() {
  const modal = document.getElementById("staff-detail-modal");
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  // Re-pull cache index so any Force-refresh / Clear-cache done inside the
  // modal is reflected in the row badges underneath.
  loadScholarCacheIndex().then(() => decorateAllStaffFreshness(document.getElementById("data-editor")));
}

async function renderStaffDetailPayload(pane, scholarId, name) {
  pane.innerHTML = `<p class="spinner">Loading Scholar payload for ${escapeHTML(name)}…</p>`;
  try {
    const r = await fetch(`/api/scholar/${encodeURIComponent(scholarId)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "fetch failed");
    const cpy = d.cites_per_year || {};
    const fetchedIso = d._fetched_iso || "";
    const fetchedLabel = fetchedIso
      ? new Date(fetchedIso).toLocaleString()
      : "unknown";
    pane.innerHTML = `
      <div class="data-detail-head">
        <div>
          <strong>${escapeHTML(d.name || name)}</strong>
          <span class="affil">${escapeHTML(cleanAffil(d.affiliation) || "")}</span>
        </div>
        <div class="data-detail-actions">
          <a href="https://scholar.google.com/citations?user=${encodeURIComponent(scholarId)}"
             target="_blank" rel="noopener">open on Scholar ↗</a>
          <button class="data-detail-refresh">↻ Force refresh</button>
          <button class="data-detail-clear">🗑 Clear cache</button>
        </div>
      </div>

      <div class="data-detail-metrics">
        <span><b>${fmt(d.citedby)}</b> citations</span>
        <span><b>${fmt(d.citedby5y)}</b> 5y</span>
        <span><b>${fmt(d.hindex)}</b> h-index</span>
        <span><b>${fmt(d.hindex5y)}</b> h5</span>
        <span><b>${fmt(d.i10index)}</b> i10</span>
        <span><b>${fmt(d.i10index5y)}</b> i10-5y</span>
      </div>

      ${sparkline(cpy)}

      <h5>Recent publications (REF ${REF_YEAR} window, from ${REF_START_YEAR})</h5>
      ${renderPubs((d.recent_publications || []).filter(p => (p.year || 0) >= REF_START_YEAR))}

      <p class="cache-note">
        ${d._from_cache ? "Served from cache" : "Fresh fetch"} ·
        last fetched: <span class="data-detail-fetched">${escapeHTML(fetchedLabel)}</span>
      </p>

      <details class="deep">
        <summary>Raw Scholar payload (JSON)</summary>
        <pre>${escapeHTML(JSON.stringify(d, null, 2))}</pre>
      </details>
    `;
    // Pin the citation chart to its right edge so the latest years show
    // first; older years are reachable by scrolling/swiping left.
    requestAnimationFrame(() => {
      const sc = pane.querySelector(".sparkline-scroll");
      if (sc) sc.scrollLeft = sc.scrollWidth;
    });

    pane.querySelector(".data-detail-refresh").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = "refreshing…";
      try {
        const rr = await fetch(`/api/scholar/${encodeURIComponent(scholarId)}?refresh=1`);
        const dd = await rr.json();
        if (!rr.ok) throw new Error(dd.error || "refresh failed");
        await renderStaffDetailPayload(pane, scholarId, name);
      } catch (err) {
        btn.disabled = false; btn.textContent = "↻ Force refresh";
        alert("Refresh failed: " + err.message);
      }
    };
    pane.querySelector(".data-detail-clear").onclick = async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Delete cached Scholar payload for ${name}? The next fetch will hit Scholar fresh.`)) return;
      btn.disabled = true; btn.textContent = "clearing…";
      try {
        const rr = await fetch(`/api/scholar/${encodeURIComponent(scholarId)}`, { method: "DELETE" });
        const dd = await rr.json();
        if (!rr.ok) throw new Error(dd.error || "clear failed");
        pane.innerHTML = `<p class="affil">Cache cleared${dd.cleared ? "" : " (nothing to clear)"}. Re-open to refetch.</p>`;
      } catch (err) {
        btn.disabled = false; btn.textContent = "🗑 Clear cache";
        alert("Clear failed: " + err.message);
      }
    };
  } catch (e) {
    const msg = String(e.message || e);
    const isRl = /429|rate-limit/i.test(msg);
    const url = `https://scholar.google.com/citations?user=${encodeURIComponent(scholarId)}&hl=en`;
    pane.innerHTML = `
      <div class="modal-err">
        <p class="modal-err-title">${isRl ? "Google Scholar is rate-limiting" : "Scholar fetch failed"}</p>
        <p class="modal-err-detail">${escapeHTML(msg)}</p>
        <p class="modal-err-actions">
          <a class="modal-err-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHTML(url)} ↗</a>
        </p>
        <p class="modal-err-actions">
          <button class="modal-err-retry" type="button">↻ Retry</button>
          <span class="modal-err-hint">${isRl ? "Scholar rate-limits aggressively; wait a minute and retry." : "Click Retry to fetch again."}</span>
        </p>
      </div>`;
    pane.querySelector(".modal-err-retry")?.addEventListener("click", () => {
      renderStaffDetailPayload(pane, scholarId, name);
    });
  }
}

// Walk every staff row in the Data editor and stamp its `.r-last-scraped`
// span with a freshness badge derived from SCHOLAR_CACHE_INDEX. Older than
// 30 days = "stale" (amber); never cached = empty.
function decorateAllStaffFreshness(root) {
  const STALE_DAYS = 30;
  const now = Date.now() / 1000;
  root.querySelectorAll(".r-last-scraped").forEach(span => {
    const id = span.dataset.id;
    if (!id) { span.textContent = ""; return; }
    const entry = SCHOLAR_CACHE_INDEX[id];
    if (!entry || !entry.fetched_at) {
      span.textContent = "not cached";
      span.className = "r-last-scraped never-cached";
      span.title = "No cached Scholar fetch on disk yet. Will fetch on next view.";
      return;
    }
    const ageDays = (now - entry.fetched_at) / 86400;
    const label = relativeDays(ageDays);
    span.textContent = label;
    span.className = "r-last-scraped" + (ageDays > STALE_DAYS ? " stale" : "");
    const iso = entry.fetched_iso ? new Date(entry.fetched_iso).toLocaleString() : "";
    span.title = `Last scraped: ${iso || label}`;
  });
}

function relativeDays(d) {
  if (d < 1)   return "today";
  if (d < 2)   return "1 day ago";
  if (d < 30)  return `${Math.floor(d)} days ago`;
  if (d < 60)  return "1 month ago";
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} year${d > 730 ? "s" : ""} ago`;
}

// Extract Scholar user-ID from anything the user pasted into the field:
// a full URL, a partial URL, or a bare ID. Returns null if empty / unrecognised.
function parseScholarId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/[?&]user=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // Fall back: if it looks like a bare 10–14 char alphanumeric ID, accept it.
  if (/^[A-Za-z0-9_-]{8,20}$/.test(s)) return s;
  return null;
}

// Read the live data-editor DOM into the faculties payload. `blankNames` is
// the count of staff rows that have no name yet (used to gate auto-save —
// posting a blank-name row would 400). Shared by manual Save and auto-save.
function collectDataEditorPayload() {
  let blankNames = 0;
  const collectStaff = (card) => [...card.querySelectorAll("tbody tr")].map(tr => {
    const uoaRaw = tr.querySelector(".r-uoa")?.value || "";
    const name = tr.querySelector(".r-name").value.trim();
    if (!name) blankNames++;
    return {
      name,
      title:       tr.querySelector(".r-title").value.trim(),
      staff_id:   tr.querySelector(".r-staff-id").value.trim(),
      scholar_id:  parseScholarId(tr.querySelector(".r-scholar").value),
      scholar_status: tr.querySelector(".r-status").value,
      // Persist UoA as integer code, or omit when "inherit unit" is selected.
      ...(uoaRaw ? { uoa: parseInt(uoaRaw, 10) } : {}),
    };
  }).filter(p => p.name);
  const collectUnit = (card) => {
    const uoaRaw = card.querySelector(".data-unit-uoa")?.value || "";
    return {
      slug: card.dataset.slug,
      name: card.querySelector(".data-unit-name").value.trim(),
      source: "", last_scraped: "",
      disabled: !card.querySelector(".data-unit-active-cb").checked,
      ...(uoaRaw ? { uoa: parseInt(uoaRaw, 10) } : {}),
      staff: collectStaff(card),
    };
  };
  const collectSchool = (schBlock) => ({
    slug:  schBlock.dataset.slug,
    name:  schBlock.querySelector(".data-school-name").value.trim(),
    url:   schBlock.querySelector(".data-school-url").value.trim(),
    units: [...schBlock.querySelectorAll(":scope > .data-school-units > .data-unit")].map(collectUnit),
  });
  const faculties = [...document.querySelectorAll(".data-faculty")].map(fb => ({
    slug: fb.dataset.slug,
    name: fb.querySelector(".data-faculty-name").value.trim(),
    url:  fb.querySelector(".data-faculty-url").value.trim(),
    schools: [...fb.querySelectorAll(":scope > .data-faculty-body > .data-school")].map(collectSchool),
    units:   [...fb.querySelectorAll(":scope > .data-faculty-body > .data-unit")].map(collectUnit),
  }));
  return { payload: { faculties }, blankNames };
}

async function saveDataEditor() {
  const status = document.getElementById("data-status");
  status.textContent = "Saving…";
  status.className = "data-status";
  const { payload } = collectDataEditorPayload();
  try {
    const r = await fetch("/api/staff", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    status.textContent = `Saved ${j.units} units. Reloading…`;
    status.classList.add("ok");
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    status.textContent = `Save failed: ${e.message}`;
    status.classList.add("err");
  }
}

// Quiet auto-save: persists data-editor edits without reloading, so a new
// user who adds a person and forgets to click Save doesn't lose it. Debounced;
// skipped while any staff row is still nameless (that would fail validation).
let _autoSaveTimer = null;
function scheduleDataEditorAutosave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(autoSaveDataEditor, 1200);
}
async function autoSaveDataEditor() {
  const status = document.getElementById("data-status");
  const { payload, blankNames } = collectDataEditorPayload();
  if (blankNames > 0) {   // a half-entered new row — wait until it has a name
    if (status) { status.textContent = "Unsaved — finish naming the new person…"; status.className = "data-status"; }
    return;
  }
  try {
    const r = await fetch("/api/staff", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    if (status) {
      status.textContent = `All changes saved automatically ✓${j.trashed ? ` · ${j.trashed} moved to Trash` : ""}`;
      status.className = "data-status ok";
    }
    loadScholarCacheIndex().then(() => decorateAllStaffFreshness(document.getElementById("data-editor")));
  } catch (e) {
    if (status) { status.textContent = `Auto-save failed: ${e.message} — click Save to retry`; status.className = "data-status err"; }
  }
}

// Data-editor auto-save + Scholar-URL → status wiring. Delegated on the
// persistent #data-editor container so it survives each re-render.
(function wireDataEditorAutosave() {
  const ed = document.getElementById("data-editor");
  if (!ed) return;
  ed.addEventListener("input", (e) => {
    const t = e.target;
    // Entering a Scholar URL flips the row's status to "set" automatically
    // (so it actually gets fetched); clearing it reverts a "set" to unchecked.
    if (t.classList && t.classList.contains("r-scholar")) {
      const statusSel = t.closest("tr")?.querySelector(".r-status");
      if (statusSel) {
        if (parseScholarId(t.value)) statusSel.value = "set";
        else if (statusSel.value === "set") statusSel.value = "unchecked";
        statusSel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    scheduleDataEditorAutosave();
  });
  ed.addEventListener("change", () => scheduleDataEditorAutosave());
})();

document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-data")) openDataEditor();
  if (e.target.closest("[data-data-close]")) document.getElementById("data-modal").classList.add("hidden");
  if (e.target.closest("[data-staff-detail-close]")) closeStaffDetailModal();
  if (e.target.closest("#data-save")) saveDataEditor();
  if (e.target.closest("#data-trash")) openTrash();
  if (e.target.closest("[data-trash-close]")) document.getElementById("trash-modal").classList.add("hidden");
  if (e.target.id === "trash-modal") e.target.classList.add("hidden");
  if (e.target.closest("#data-load-unit")) document.getElementById("data-load-input")?.click();
  // Toolbar unit-file controls
  if (e.target.closest("#tb-load-unit")) document.getElementById("data-load-input")?.click();
  if (e.target.closest("#tb-save-unit")) saveCurrentUnit();
  if (e.target.closest("#tb-save-faculty")) saveFacultyBundle();
  if (e.target.closest("#tb-new-unit")) newUnitFlow();
  if (e.target.closest("#a-excl-open")) openExcludedModal();
  // Export menu — Print and Save-as-PDF both open the browser print
  // dialog (PDF is just "Print → Save as PDF"); the print stylesheet
  // does the rest.
  if (e.target.closest("#tb-print") || e.target.closest("#tb-pdf")) {
    closeToolbarMenus();
    setTimeout(() => window.print(), 60);
  }
  // Shareable Markdown export of the current scope (zip, or single .md).
  if (e.target.closest("#tb-export-data")) { closeToolbarMenus(); exportScopeData(); }
  // JSON snapshot, scoped to the current view's units.
  if (e.target.closest("#tb-export-json")) {
    closeToolbarMenus();
    const scope = currentScope();
    const url = `/api/export.json?slugs=${encodeURIComponent(scope.slugs.join(","))}`
              + `&name=${encodeURIComponent(scope.name)}`;
    const a = document.createElement("a");
    a.href = url; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  }
  if (e.target.closest("#tb-quit")) {
    if (SERVER_DOWN) showRestartInstructions();
    else quitServer();
  }
});

// ─── Toolbar dropdown menus (Data, Export) ───────────────────────────────
// Lightweight popovers anchored under their trigger button. One open at a
// time; click-away and Escape close them; picking an item closes too.
function closeToolbarMenus() {
  document.querySelectorAll(".tb-menu.open").forEach(m => {
    m.classList.remove("open");
    m.querySelector(".tb-menu-btn")?.setAttribute("aria-expanded", "false");
    m.querySelector(".tb-menu-pop")?.setAttribute("hidden", "");
  });
}
function openToolbarMenu(menu) {
  const wasOpen = menu.classList.contains("open");
  closeToolbarMenus();
  if (wasOpen) return;             // toggle off if it was already open
  menu.classList.add("open");
  menu.querySelector(".tb-menu-btn")?.setAttribute("aria-expanded", "true");
  menu.querySelector(".tb-menu-pop")?.removeAttribute("hidden");
}
// Update the Export menu's labels to reflect the current view scope, so
// it reads "Export Unit" / "Export School" / "Export All units" etc.
function refreshExportMenu() {
  const scope = currentScope();
  const trigger = document.getElementById("tb-export-menu");
  const scopeEl = document.getElementById("tb-export-scope");
  const dataLbl = document.getElementById("tb-export-data-label");
  if (trigger) trigger.textContent = `Export ${scope.noun}`;
  if (scopeEl) scopeEl.textContent = `${scope.label} · ${scope.slugs.length} unit${scope.slugs.length === 1 ? "" : "s"}`;
  if (dataLbl) {
    dataLbl.textContent = scope.slugs.length === 1
      ? "Export unit (.md)…"
      : `Export ${scope.noun} (.zip)…`;
  }
}
// Relabel the Data menu's Refresh item to the current scope.
function refreshDataMenu() {
  const scope = currentScope();
  const lbl = document.getElementById("tb-refresh-label");
  if (lbl) lbl.textContent = `Refresh ${scope.noun}…`;
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".tb-menu-btn");
  if (btn) {
    e.preventDefault();
    if (btn.id === "tb-export-menu") refreshExportMenu();
    if (btn.id === "tb-data-menu") refreshDataMenu();
    if (btn.id === "tb-ref-menu") {
      const on = localStorage.getItem("sd-ref-all") === "1";
      const lbl = document.getElementById("tb-ref-window-label");
      if (lbl) lbl.textContent = on ? `Remove REF ${REF_YEAR} highlight` : `Highlight REF ${REF_YEAR} window`;
    }
    openToolbarMenu(btn.closest(".tb-menu"));
    return;
  }
  // Click on a menu item → let its own handler run, then close.
  if (e.target.closest(".tb-menu-item")) {
    closeToolbarMenus();
    return;
  }
  // Click anywhere else → close any open menu.
  if (!e.target.closest(".tb-menu")) closeToolbarMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeToolbarMenus();
});

// ─── About + Settings dialogs ─────────────────────────────────────────────
async function openAbout() {
  const m = document.getElementById("about-modal");
  m.classList.remove("hidden");
  let a = {};
  try { a = await (await fetch("/api/about")).json(); } catch {}
  document.getElementById("about-version").textContent =
    `Version ${a.version || "?"}${a.frozen ? " · packaged app" : " · source"}`;
  document.getElementById("about-body").innerHTML = `
    <p class="about-tag">A staff metrics dashboard surfacing Google Scholar
       citations, h-index and REF 2029 readiness at unit, school and
       faculty level.</p>
    <dl class="about-dl">
      <dt>Author</dt><dd>${escapeHTML(a.author || "David M. Berry")}</dd>
      <dt>Project</dt><dd><a href="${escapeAttr(a.homepage || "#")}" target="_blank" rel="noopener">${escapeHTML((a.homepage || "").replace(/^https?:\/\//, "")) || "—"}</a></dd>
      <dt>Data folder</dt><dd><code>${escapeHTML(a.data_dir || "—")}</code></dd>
      <dt>Contents</dt><dd>${a.unit_files ?? "?"} unit file(s) · ${a.cached_profiles ?? "?"} cached Scholar profile(s)</dd>
    </dl>
    <p class="about-note">${escapeHTML(a.license || "Proof-of-concept.")}
       Scholar metrics are noisy and under-represent practice-based output —
       treat them as indicative, not definitive.</p>`;
}

// Substantive in-app guidance. Plain HTML, no fetch — always available.
function openHelp() {
  const m = document.getElementById("help-modal");
  m.classList.remove("hidden");
  document.getElementById("help-body").innerHTML = `
    <h2 class="help-h">Using Scholar Dashboard</h2>
    <p class="help-lead">A local tool for surveying Google&nbsp;Scholar metrics and preparing a
       REF&nbsp;${REF_YEAR} submission across Faculty → School → Unit, or by Unit of Assessment.
       Everything is stored on your machine; nothing is uploaded.</p>

    <h3 class="help-s">1 · Choosing what you're looking at</h3>
    <p>The two tabs at the top switch the lens. <strong>By Faculty</strong> drills Faculty → School →
       Unit; <strong>By UoA</strong> gathers everyone tagged to a Unit of Assessment, across units.
       The <em>Sort</em> and <em>Filter</em> bar reorders the cards (citations, h-index, h5, or
       grouped by role) and can hide emeritus/visiting staff. <em>Analytics</em> (top right) gives
       cross-unit comparisons.</p>

    <h3 class="help-s">2 · Scholar data &amp; rate limits</h3>
    <p>Each person with a Google&nbsp;Scholar profile URL is fetched and cached locally. Google
       rate-limits aggressively, so the app fetches conservatively and pauses after a block — if a
       card shows an error, give it a few minutes rather than forcing repeated refreshes. Cache
       lifetime and cooldowns live in <em>File → Settings → Scholar fetch tuning</em>.</p>

    <h3 class="help-s">3 · Tagging people to a UoA</h3>
    <p>A unit has a default UoA; any person can override it via the UoA chip on their card (click it
       to assign or remove). The <strong>By UoA</strong> view then collects everyone with that
       effective tag, regardless of home unit.</p>

    <h3 class="help-s">4 · Flagging outputs &amp; star ratings</h3>
    <p>Open a person's card to see their publications in the REF window
       (${REF_START_YEAR}–${REF_END_YEAR}). Each output has a rating selector:
       <em>Not REF / 1* / 2* / 2–3* / 3* / 3–4* / 4*</em>. Choosing a star rating flags the output
       for REF and records its quality band (the in-between bands store as 2.5 / 3.5). The
       <strong>REF&nbsp;${REF_YEAR}</strong> filter chip re-draws each card's chart to show only the
       years with a selected output, with N/A for empty years.</p>

    <h3 class="help-s">5 · GPA &amp; quality profile</h3>
    <p>The reports compute a mean output <strong>GPA</strong> (the average of the star ratings) per
       scholar and per UoA, plus a quality profile (the share of outputs at each band). The UoA
       report opens with a colour-coded readiness dashboard — green / amber / red — for outputs vs
       target, GPA, how many outputs are rated, and case-study progress.</p>

    <h3 class="help-s">6 · Impact case studies (REF3)</h3>
    <p>In <strong>By UoA</strong> view a case-studies panel appears. Each case study follows the
       REF3 shape. <em>References to the research</em> are picked by scholar → output (only your
       rated outputs are offered). <em>Contributors</em> are the staff who did the underpinning
       research — use <em>＋ from references</em> to pull in the authors of the chosen outputs, then
       add or remove anyone. Case studies import/export as Markdown (a template is in
       <code>docs/</code>).</p>

    <h3 class="help-s">7 · Reports</h3>
    <p><strong>Report</strong> (next to the UoA selector) builds the full UoA report: readiness
       dashboard, quality profile, narrative/environment, selected outputs with ratings, and every
       case study — ready to print or save as PDF. <em>REF → REF selection report</em> lists flagged
       outputs and GPA per scholar for whatever you're currently viewing.</p>

    <h3 class="help-s">8 · Saving, sharing &amp; backups</h3>
    <p>In <strong>By UoA</strong> view, <em>File → Save UoA…</em> writes one self-contained
       <code>…_UoA.json</code> bundle (units, cached publications with ratings, profiles, case
       studies and narrative); <em>Load…</em> re-imports it. In Faculty view, Save/Load work on a
       single unit's Markdown file. Every export carries a version stamp so older copies can warn on
       import. Your data folder can be relocated in <em>Settings → Data &amp; reset</em>, where
       <em>Show Folder</em> reveals it in Finder.</p>

    <p class="help-foot">Scholar metrics are noisy and under-represent practice-based and
       non-indexed work — treat them as indicative, not definitive.</p>`;
}

async function openSettings() {
  const m = document.getElementById("settings-modal");
  m.classList.remove("hidden");
  const body = document.getElementById("settings-body");
  body.innerHTML = `<p class="spinner">Loading…</p>`;
  let about = {}, targets = { default: { multiplier: 2.5, min_per_person: 1, max_per_person: 5 } };
  let fetchCfg = { cooldown_minutes: 10, idle_minutes: 20, cache_ttl_days: 7 };
  try { about = await (await fetch("/api/about")).json(); } catch {}
  try { targets = await (await fetch("/api/ref-targets")).json(); } catch {}
  try { fetchCfg = await (await fetch("/api/settings")).json(); } catch {}
  const t = targets.default || { multiplier: 2.5, min_per_person: 1, max_per_person: 5 };
  // Danger-zone targets: every faculty, and every UoA currently in use.
  const dzFaculties = (FACULTIES || []).map(f =>
    `<div class="dz-row"><span class="dz-name">${escapeHTML(f.name)}</span>
      <button class="tb-btn dz-btn" data-del-fac="${escapeAttr(f.name)}">Delete this faculty</button></div>`).join("")
    || `<p class="set-help">No faculties loaded.</p>`;
  const dzUoas = [...new Set((UNITS || []).filter(u => !u.disabled && u.slug !== "all-staff")
      .flatMap(u => (u.staff || []).map(p => effectiveUoa(p, u)).filter(Boolean)))]
    .sort((a, b) => a - b)
    .map(c => `<div class="dz-row"><span class="dz-name">UoA ${c}${UOA_BY_CODE[c]?.name ? " · " + escapeHTML(UOA_BY_CODE[c].name) : ""}</span>
      <button class="tb-btn dz-btn" data-clear-uoa="${c}">Clear relations</button></div>`).join("")
    || `<p class="set-help">No UoAs tagged.</p>`;
  const allSchools = [...new Set((FACULTIES || []).flatMap(f => (f.schools || []).map(s => s.name)))].sort();
  const dzSchoolOpts = allSchools.map(n => `<option value="${escapeAttr(n)}">${escapeHTML(n)}</option>`).join("");
  const dzUnitOpts = (UNITS || []).filter(u => u.slug !== "all-staff")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(u => `<option value="${escapeAttr(u.slug)}">${escapeHTML(u.name)}</option>`).join("");
  const scale = localStorage.getItem("sd-spark-mode") === "per-card" ? "per-card" : "cohort";
  const sort  = localStorage.getItem("sd-sort") || "name";
  const sortOpts = [["name","Name"],["citations","Citations"],["hindex","h-index"],
                    ["h5","h5-index"],["role","Stack by role"],["overview","Overview"]]
    .map(([v,l]) => `<option value="${v}" ${v===sort?"selected":""}>${l}</option>`).join("");
  body.innerHTML = `
    <section class="set-sec">
      <h4>Display defaults</h4>
      <div class="set-row">
        <label>Card chart scale</label>
        <div class="set-scale">
          <button class="filter-btn ${scale==="cohort"?"active":""}" data-set-scale="cohort">Cohort</button>
          <button class="filter-btn ${scale==="per-card"?"active":""}" data-set-scale="per-card">Per-card</button>
        </div>
      </div>
      <div class="set-row">
        <label for="set-sort">Default sort</label>
        <select id="set-sort" class="unit-select">${sortOpts}</select>
      </div>
    </section>

    <section class="set-sec">
      <h4>REF assessment</h4>
      <p class="set-help">The exercise year names the “REF &lt;year&gt;” chip and reports;
         the window bounds which publication years count as eligible.</p>
      <div class="set-grid3">
        <label>Exercise year <input type="number" id="set-ref-year" step="1" min="2029" max="2100" value="${fetchCfg.ref_year || 2029}"></label>
        <label>Window start <input type="number" id="set-ref-start" step="1" min="1900" max="2100" value="${fetchCfg.ref_window_start || 2021}"></label>
        <label>Window end <input type="number" id="set-ref-end" step="1" min="1900" max="2100" value="${fetchCfg.ref_window_end || 2028}"></label>
      </div>
      <button class="tb-btn" id="set-save-ref">Save REF settings</button>
      <span class="set-saved" id="set-ref-saved"></span>
      <p class="set-help">Changing the window re-evaluates which outputs are eligible. Reload to refresh all labels.</p>
    </section>

    <section class="set-sec">
      <h4>REF ${REF_YEAR} targets <span class="set-sub">(default for all UoAs)</span></h4>
      <p class="set-help">Used by REF readiness analytics. A submission needs roughly
         (active FTE × multiplier) outputs, with each person contributing between
         the min and max.</p>
      <div class="set-grid3">
        <label>Multiplier <input type="number" id="set-mult" step="0.1" min="0" value="${t.multiplier}"></label>
        <label>Min / person <input type="number" id="set-min" step="1" min="0" value="${t.min_per_person}"></label>
        <label>Max / person <input type="number" id="set-max" step="1" min="1" value="${t.max_per_person}"></label>
      </div>
      <button class="tb-btn" id="set-save-targets">Save targets</button>
      <span class="set-saved" id="set-targets-saved"></span>
    </section>

    <section class="set-sec">
      <h4>Data &amp; reset</h4>
      <dl class="about-dl">
        <dt>Data folder</dt>
        <dd class="set-folder-row"><code id="set-data-root">${escapeHTML(about.user_root || about.data_dir || "—")}</code>
          <button class="tb-btn tb-btn-sm" id="set-show-folder" title="Reveal the data folder in Finder">Show Folder</button></dd>
        <dt>Cache folder</dt><dd><code>${escapeHTML(about.cache_dir || "—")}</code></dd>
        <dt>Contents</dt><dd>${about.unit_files ?? "?"} unit file(s) · ${about.cached_profiles ?? "?"} cached profile(s)</dd>
      </dl>
      <div class="set-btns">
        <button class="tb-btn" id="set-move-folder">Move data folder…</button>
        <button class="tb-btn" id="set-clear-cache">Clear Scholar cache</button>
        <button class="tb-btn" id="set-reset-prefs">Reset preferences</button>
      </div>
      <span class="set-saved" id="set-folder-saved"></span>
      <p class="set-help">Moving the data folder copies everything to the new location (a dated backup zip is written first; the originals are left in place). You'll be asked to quit and reopen so the change takes effect. Clearing the cache removes downloaded Scholar metrics (re-fetched on next view); your staff/unit data is untouched. Reset preferences clears zoom, sort, filters and scale on this device.</p>
    </section>

    <section class="set-sec set-danger">
      <h4>Danger zone</h4>
      <div class="dz-box">
        <div class="dz-item">
          <div class="dz-desc"><strong>Delete a faculty</strong>
            <p>Permanently removes the faculty and every unit file under it. A copy is written to <code>data/.bak</code> first, but there is no in-app undo.</p></div>
        </div>
        ${dzFaculties}
        <div class="dz-item dz-sep">
          <div class="dz-desc"><strong>Delete a school</strong>
            <p>Removes the school and every unit file under it (backed up to <code>data/.bak</code>).</p></div>
        </div>
        <div class="dz-row"><select class="csm-uoa" id="dz-school-sel">${dzSchoolOpts || `<option value="">— none —</option>`}</select>
          <button class="tb-btn dz-btn" id="dz-del-school" ${allSchools.length ? "" : "disabled"}>Delete school</button></div>
        <div class="dz-item dz-sep">
          <div class="dz-desc"><strong>Delete a unit</strong>
            <p>Removes a single unit file (backed up to <code>data/.bak</code>).</p></div>
        </div>
        <div class="dz-row"><select class="csm-uoa" id="dz-unit-sel">${dzUnitOpts}</select>
          <button class="tb-btn dz-btn" id="dz-del-unit">Delete unit</button></div>
        <div class="dz-item dz-sep">
          <div class="dz-desc"><strong>Clear a UoA's relations</strong>
            <p>Removes the UoA tag from units and people and unassigns its impact case studies. Staff, units and case-study content are kept — only the “who is included” relations are cleared.</p></div>
        </div>
        ${dzUoas}
      </div>
    </section>

    <section class="set-sec">
      <details class="set-details">
        <summary>Scholar fetch tuning</summary>
        <p class="set-warn">⚠ Advanced. Shortening the cooldown or cache lifetime makes the app hit Google Scholar harder — Scholar rate-limits aggressively and can temporarily block your IP. The defaults are deliberately conservative. Only change these if you understand the risk.</p>
        <div class="set-grid3">
          <label>Cooldown (min)<input type="number" id="set-cooldown" step="1" min="0" max="180" value="${fetchCfg.cooldown_minutes}"></label>
          <label>Idle shutdown (min)<input type="number" id="set-idle" step="1" min="0" max="1440" value="${fetchCfg.idle_minutes}"></label>
          <label>Cache lifetime (days)<input type="number" id="set-ttl" step="0.5" min="0.04" max="365" value="${fetchCfg.cache_ttl_days}"></label>
        </div>
        <p class="set-help">Cooldown = pause after Scholar rate-limits us (0 disables). Idle shutdown = auto-quit the local server after inactivity (0 = never). Cache lifetime = how long a profile is reused before re-fetching. Idle changes apply within ~30s; the rest apply immediately.</p>
        <button class="tb-btn" id="set-save-fetch">Save fetch settings</button>
        <span class="set-saved" id="set-fetch-saved"></span>
      </details>
    </section>`;

  // Display defaults — apply immediately + persist.
  body.querySelectorAll("[data-set-scale]").forEach(b => b.addEventListener("click", () => {
    applySparkMode(b.dataset.setScale);
    body.querySelectorAll("[data-set-scale]").forEach(x => x.classList.toggle("active", x === b));
  }));
  body.querySelector("#set-sort")?.addEventListener("change", (e) => applySort(e.target.value));

  // REF targets — save to backend.
  body.querySelector("#set-save-ref")?.addEventListener("click", async () => {
    const saved = body.querySelector("#set-ref-saved");
    let year = parseInt(body.querySelector("#set-ref-year").value, 10) || 2029;
    if (year < 2029) {
      alert("The REF exercise year cannot be earlier than 2029 — that is the current exercise. Resetting to 2029.");
      year = 2029;
      body.querySelector("#set-ref-year").value = 2029;
    }
    // Changing the exercise year relabels every chip and report and
    // re-scopes eligibility, so make the user confirm it's deliberate.
    if (year !== REF_YEAR &&
        !confirm(`Change the REF exercise year from ${REF_YEAR} to ${year}?\n\n`
               + `This relabels every "REF" chip and report and re-scopes which `
               + `publication years count as eligible. Existing flags are kept.`)) {
      return;
    }
    const payload = {
      ref_year:         year,
      ref_window_start: parseInt(body.querySelector("#set-ref-start").value, 10) || 2021,
      ref_window_end:   parseInt(body.querySelector("#set-ref-end").value, 10) || 2028,
    };
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error();
      REF_YEAR = d.ref_year; REF_START_YEAR = d.ref_window_start; REF_END_YEAR = d.ref_window_end;
      applyRefLabels();
      saved.textContent = "Saved ✓ — reload to refresh all labels"; setTimeout(() => saved.textContent = "", 4000);
    } catch (e) { saved.textContent = "Save failed"; }
  });

  body.querySelector("#set-save-targets")?.addEventListener("click", async () => {
    const payload = {
      uoa: "default",
      multiplier: parseFloat(body.querySelector("#set-mult").value) || 2.5,
      min_per_person: parseInt(body.querySelector("#set-min").value, 10) || 1,
      max_per_person: parseInt(body.querySelector("#set-max").value, 10) || 5,
    };
    const saved = body.querySelector("#set-targets-saved");
    try {
      const r = await fetch("/api/ref-targets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("save failed");
      saved.textContent = "Saved ✓"; setTimeout(() => saved.textContent = "", 2500);
    } catch (e) { saved.textContent = "Save failed"; }
  });

  // Data & reset.
  body.querySelector("#set-clear-cache")?.addEventListener("click", async () => {
    if (!confirm("Delete all cached Scholar metrics? Staff data is kept; metrics re-fetch on next view.")) return;
    try {
      const r = await fetch("/api/clear-cache", { method: "POST" });
      const d = await r.json();
      alert(`Cleared ${d.removed} cached profile(s). Reloading…`);
      location.reload();
    } catch (e) { alert("Couldn't clear cache: " + e.message); }
  });
  body.querySelector("#set-reset-prefs")?.addEventListener("click", () => {
    if (!confirm("Reset zoom, sort, filters and scale to defaults on this device?")) return;
    ["sd-zoom","sd-sort","sd-spark-mode","sd-ref-all","sd-exclude-emeritus",
     "sd-exclude-visiting","sd-view-mode"].forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  // Danger zone — delete a whole faculty (type-to-confirm).
  body.querySelectorAll("[data-del-fac]").forEach(b => b.addEventListener("click", async () => {
    const name = b.dataset.delFac;
    const typed = prompt(`This permanently deletes the faculty “${name}” and ALL of its unit files.\n\n`
      + `A backup is written to data/.bak, but there's no in-app undo.\n\n`
      + `Type the faculty name exactly to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== name) { alert("That didn't match the faculty name — nothing was deleted."); return; }
    try {
      const r = await fetch("/api/delete-faculty", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "delete failed");
      alert(`Deleted “${name}” — ${d.removed} unit file(s) removed. Reloading…`);
      location.reload();
    } catch (e) { alert("Delete failed: " + e.message); }
  }));
  // Danger zone — delete a school.
  body.querySelector("#dz-del-school")?.addEventListener("click", async () => {
    const name = body.querySelector("#dz-school-sel")?.value;
    if (!name) return;
    if (!confirm(`Delete the school “${name}” and ALL its unit files?\n\nBacked up to data/.bak; no in-app undo.`)) return;
    try {
      const r = await fetch("/api/delete-school", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "failed");
      alert(`Deleted “${name}” — ${d.removed} unit file(s). Reloading…`); location.reload();
    } catch (e) { alert("Delete failed: " + e.message); }
  });
  // Danger zone — delete a single unit.
  body.querySelector("#dz-del-unit")?.addEventListener("click", async () => {
    const sel = body.querySelector("#dz-unit-sel");
    const slug = sel?.value, label = sel?.selectedOptions[0]?.textContent || slug;
    if (!slug) return;
    if (!confirm(`Delete the unit “${label}” and all its staff entries?\n\nBacked up to data/.bak; no in-app undo.`)) return;
    try {
      const r = await fetch("/api/delete-unit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "failed");
      alert(`Deleted “${label}”. Reloading…`); location.reload();
    } catch (e) { alert("Delete failed: " + e.message); }
  });
  // Danger zone — clear a UoA's relations (keeps underlying data).
  body.querySelectorAll("[data-clear-uoa]").forEach(b => b.addEventListener("click", async () => {
    const code = b.dataset.clearUoa;
    if (!confirm(`Clear all relations for UoA ${code}?\n\n`
      + `This removes the UoA tag from units and people and unassigns its impact case studies. `
      + `Staff, units and case-study content are NOT deleted.`)) return;
    try {
      const r = await fetch("/api/clear-uoa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "clear failed");
      alert(`Cleared UoA ${code}: ${d.units_cleared} unit default(s), ${d.people_cleared} person override(s), ${d.case_studies_unassigned} case stud(ies) unassigned. Reloading…`);
      location.reload();
    } catch (e) { alert("Clear failed: " + e.message); }
  }));

  // Reveal the data folder in the OS file browser.
  body.querySelector("#set-show-folder")?.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/open-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!r.ok) throw new Error((await r.json()).error || "couldn't open");
    } catch (e) { alert("Couldn't open the folder: " + e.message); }
  });

  // Relocate the data folder: native picker on macOS, typed path elsewhere.
  body.querySelector("#set-move-folder")?.addEventListener("click", async () => {
    const saved = body.querySelector("#set-folder-saved");
    let loc = {};
    try { loc = await (await fetch("/api/data-location")).json(); } catch {}
    let path = "";
    if (loc.can_choose) {
      const c = await (await fetch("/api/choose-folder")).json();
      if (c.cancelled || !c.path) return;
      path = c.path;
    } else {
      path = prompt("Type the full path of the folder to hold the data:", loc.data_root || "");
      if (!path) return;
    }
    if (!confirm(`Move the Scholar Dashboard data folder to:\n\n${path}\n\n`
               + `A dated backup will be made first and the current files left in place. Continue?`)) return;
    saved.textContent = "Copying…";
    try {
      const r = await fetch("/api/data-location", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "move failed");
      if (d.unchanged) { saved.textContent = "Already there."; return; }
      saved.textContent = "Moved ✓";
      const root = document.getElementById("set-data-root");
      if (root) root.textContent = d.data_root;
      alert(`Data copied to:\n${d.data_root}\n\nBackup: ${d.backup}\n\n`
          + `Quit and reopen Scholar Dashboard for the new location to take effect.`);
    } catch (e) { saved.textContent = ""; alert("Move failed: " + e.message); }
  });

  // Scholar fetch tuning — persisted server-side, applied live.
  body.querySelector("#set-save-fetch")?.addEventListener("click", async () => {
    const saved = body.querySelector("#set-fetch-saved");
    const payload = {
      cooldown_minutes: parseFloat(body.querySelector("#set-cooldown").value),
      idle_minutes:     parseFloat(body.querySelector("#set-idle").value),
      cache_ttl_days:   parseFloat(body.querySelector("#set-ttl").value),
    };
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("save failed");
      saved.textContent = "Saved ✓"; setTimeout(() => saved.textContent = "", 2500);
    } catch (e) { saved.textContent = "Save failed"; }
  });
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-settings") || e.target.closest("#tb-help-settings")) openSettings();
  if (e.target.closest("#tb-ref-report")) openRefReport();
  if (e.target.closest("#tb-ref-targets")) openSettings();
  if (e.target.closest("#tb-ref-window")) applyGlobalRefMode(localStorage.getItem("sd-ref-all") !== "1");
  if (e.target.closest("#tb-help"))      openHelp();
  if (e.target.closest("#tb-help-about") || e.target.closest("#tb-about")) openAbout();
  if (e.target.closest("[data-about-close]"))    document.getElementById("about-modal").classList.add("hidden");
  if (e.target.closest("[data-help-close]"))     document.getElementById("help-modal").classList.add("hidden");
  if (e.target.closest("[data-settings-close]")) document.getElementById("settings-modal").classList.add("hidden");
  if (e.target.closest("[data-ref-report-close]")) document.getElementById("ref-report-modal").classList.add("hidden");
  // Click on the dimmed backdrop closes.
  if (e.target.id === "about-modal")    e.target.classList.add("hidden");
  if (e.target.id === "help-modal")     e.target.classList.add("hidden");
  if (e.target.id === "settings-modal") e.target.classList.add("hidden");
  if (e.target.id === "ref-report-modal") e.target.classList.add("hidden");
});

// ─── REF selection report ─────────────────────────────────────────────────
// Lists, for the current scope (Unit / School / Faculty / UoA / All), each
// scholar with ≥1 REF-flagged output and *only* their flagged outputs.
// Becomes §3 of the UoA report later; useful standalone now.
// ─── Text / rich-text report rendering ────────────────────────────────────
// Reports can be exported as text (charts replaced by text) for pasting into
// other documents. We build Markdown, render a minimal rich-text preview from
// it, and offer Copy-as-rich-text / Copy-Markdown / Download .md.
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = []; let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const ln of md.split("\n")) {
    if (/^### /.test(ln))      { closeList(); out.push(`<h3>${esc(ln.slice(4))}</h3>`); }
    else if (/^## /.test(ln))  { closeList(); out.push(`<h2>${esc(ln.slice(3))}</h2>`); }
    else if (/^# /.test(ln))   { closeList(); out.push(`<h1>${esc(ln.slice(2))}</h1>`); }
    else if (/^- /.test(ln))   { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${esc(ln.slice(2))}</li>`); }
    else if (ln.trim() === "") { closeList(); }
    else                       { closeList(); out.push(`<p>${esc(ln)}</p>`); }
  }
  closeList();
  return out.join("");
}
function _flashBtn(b, t) { const o = b.textContent; b.textContent = t; setTimeout(() => { b.textContent = o; }, 1500); }
function showTextReport(filenameBase, md) {
  const modal = document.getElementById("text-report-modal");
  const body = document.getElementById("text-report-body");
  modal.classList.remove("hidden");
  body.innerHTML = `
    <div class="tr-top">
      <h3>Text version</h3>
      <div class="tr-actions">
        <button class="tb-btn" id="tr-copy">Copy (rich text)</button>
        <button class="tb-btn" id="tr-copymd">Copy Markdown</button>
        <button class="tb-btn primary" id="tr-dl">⤓ Download .md</button>
      </div>
    </div>
    <p class="tr-hint">Charts and badges replaced with text, for pasting into Word, an email or another report. “Copy (rich text)” keeps the headings and lists when pasted into a word processor.</p>
    <div class="tr-rich" id="tr-rich">${mdToHtml(md)}</div>`;
  body.querySelector("#tr-dl").addEventListener("click", () => {
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${filenameBase}.md`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  });
  body.querySelector("#tr-copymd").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(md); _flashBtn(body.querySelector("#tr-copymd"), "Copied ✓"); }
    catch { alert("Copy failed — select the text manually."); }
  });
  body.querySelector("#tr-copy").addEventListener("click", async () => {
    const html = document.getElementById("tr-rich").innerHTML;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([md], { type: "text/plain" }),
      })]);
      _flashBtn(body.querySelector("#tr-copy"), "Copied ✓");
    } catch {
      try { await navigator.clipboard.writeText(md); _flashBtn(body.querySelector("#tr-copy"), "Copied (plain) ✓"); }
      catch { alert("Copy failed."); }
    }
  });
}

// ─── REF quality profile / GPA ────────────────────────────────────────────
// Ratings are stored per flagged output as numbers (1, 2, 2.5, 3, 3.5, 4);
// 2.5/3.5 are the "X–Y*" bands. A legacy `true` means flagged-but-unrated.
const REF_BAND_LABELS = { 1: "1*", 2: "2*", 2.5: "2–3*", 3: "3*", 3.5: "3–4*", 4: "4*" };
function refRatingLabel(r) { return REF_BAND_LABELS[r] || (r === true ? "unrated" : ""); }
function refRatingValue(r) { return (typeof r === "number") ? r : null; }   // null = excluded from GPA

// Mean GPA across the rated outputs in a flags object; null if none rated.
function refGpa(flags) {
  const vals = Object.values(flags || {}).map(refRatingValue).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
// Count of outputs per band across a list of flags objects (+ rated/unrated tallies).
function refStarProfile(flagsList) {
  const bands = { 4: 0, 3.5: 0, 3: 0, 2.5: 0, 2: 0, 1: 0, unrated: 0 };
  let rated = 0, total = 0;
  for (const flags of flagsList) {
    for (const r of Object.values(flags || {})) {
      total++;
      if (typeof r === "number" && bands[r] !== undefined) { bands[r]++; rated++; }
      else bands.unrated++;
    }
  }
  return { bands, rated, total };
}
// Traffic-light band for a GPA value (REF-ish: ≥3 strong, ≥2 developing).
function gpaRag(gpa) { return gpa == null ? "na" : gpa >= 3 ? "ok" : gpa >= 2 ? "warn" : "under"; }
// Traffic-light for outputs achieved vs target.
function targetRag(have, need) {
  if (!need) return "ok";
  return have >= need ? "ok" : have >= 0.7 * need ? "warn" : "under";
}
// A compact star-profile bar (segments sized by share of rated outputs) with
// a "% at 4*/3*/2*" style legend. Returns HTML.
function refProfileBar(profile) {
  const { bands, rated } = profile;
  if (!rated) return `<span class="qp-empty">no rated outputs yet</span>`;
  const order = [4, 3.5, 3, 2.5, 2, 1];
  const seg = order.map(b => {
    const pct = (bands[b] / rated) * 100;
    if (!pct) return "";
    return `<span class="qp-seg qp-b${String(b).replace(".", "_")}" style="width:${pct.toFixed(1)}%" title="${REF_BAND_LABELS[b]}: ${bands[b]} (${pct.toFixed(0)}%)"></span>`;
  }).join("");
  const legend = order.filter(b => bands[b]).map(b =>
    `<span class="qp-key"><span class="qp-dot qp-b${String(b).replace(".", "_")}"></span>${REF_BAND_LABELS[b]} ${Math.round(bands[b] / rated * 100)}%</span>`).join("");
  return `<div class="qp-bar">${seg}</div><div class="qp-legend">${legend}</div>`;
}

// One colour-coded tile for the at-a-glance readiness dashboard.
// rag ∈ ok|warn|under|na → green / amber / red / grey.
function ragTile(label, value, rag, note) {
  return `<div class="rag-tile rag-${rag}">
    <span class="rag-val">${escapeHTML(String(value))}</span>
    <span class="rag-label">${escapeHTML(label)}</span>
    ${note ? `<span class="rag-note">${escapeHTML(note)}</span>` : ""}
  </div>`;
}

function deSlugTitle(pubKey) {
  // "2025-some-title-slug" → "2025 · Some title slug" (lossy fallback used
  // only when a flagged pub isn't in the cached recent-publications list).
  const m = /^(\d{4}|n\.d\.)-(.*)$/.exec(pubKey || "");
  if (!m) return pubKey || "Untitled";
  const title = m[2].replace(/-/g, " ");
  return `${m[1]} · ${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

async function openRefReport() {
  const modal = document.getElementById("ref-report-modal");
  const body  = document.getElementById("ref-report-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<p class="spinner">Building report…</p>`;
  await loadRefFlags();
  const scope = currentScope();

  // Unique scholars in the current view that have at least one flag.
  const seen = new Map();
  for (const p of (STAFF || [])) {
    if (p.scholar_id && refFlagCount(p.scholar_id) > 0 && !seen.has(p.scholar_id)) {
      seen.set(p.scholar_id, p);
    }
  }
  const scholars = [...seen.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  if (!scholars.length) {
    body.innerHTML = `
      <h3>REF selection — ${escapeHTML(scope.label)}</h3>
      <p class="affil">No publications have been flagged for REF in this view yet.
      Open a person's card and tick the <strong>REF</strong> box on their
      ${REF_START_YEAR}–${REF_END_YEAR} outputs.</p>`;
    return;
  }

  // Fetch cached payloads in one batch to get publication details.
  let batch = {};
  try {
    const ids = scholars.map(p => p.scholar_id);
    batch = await (await fetch("/api/scholar-batch?ids=" + encodeURIComponent(ids.join(",")))).json();
  } catch { /* fall back to slug-derived titles */ }

  // Targets + case studies for the readiness summary.
  let targets = { default: { multiplier: 2.5, min_per_person: 1, max_per_person: 5 } };
  let cases = [];
  try { targets = await (await fetch("/api/ref-targets")).json(); } catch {}
  const uoaCodes = new Set(scholars.map(p => String((p._effective_uoa ?? effectiveUoa(p, CURRENT_UNIT)) || "")).filter(Boolean));
  try {
    const all = (await (await fetch("/api/case-studies")).json()).case_studies || [];
    cases = all.filter(c => uoaCodes.has(String(c.uoa)));
  } catch {}
  const mult = (targets.default && targets.default.multiplier) || 2.5;

  let totalOutputs = 0;
  const flagsList = [];   // for the UoA-level star profile
  const sections = scholars.map(p => {
    const flags = refFlagsFor(p.scholar_id);
    flagsList.push(flags);
    const flaggedKeys = Object.keys(flags);
    const pubs = (batch[p.scholar_id]?.recent_publications) || [];
    const byKey = new Map(pubs.map(pub => [pub.pub_key, pub]));
    let pubCites = 0;
    const rows = flaggedKeys.map(key => {
      const band = refRatingLabel(flags[key]);
      const chip = band ? `<span class="rr-band band-${String(flags[key]).replace(".", "_")}">${band}</span>` : "";
      const pub = byKey.get(key);
      if (pub) {
        pubCites += (pub.num_citations || 0);
        return `<li>${chip}<span class="rr-pt">${escapeHTML(pub.title || "Untitled")}</span>
          <span class="rr-pm">${escapeHTML(String(pub.year || "n.d."))}${pub.venue ? " · " + escapeHTML(pub.venue) : ""} · cited by ${fmt(pub.num_citations)}</span></li>`;
      }
      return `<li>${chip}<span class="rr-pt">${escapeHTML(deSlugTitle(key))}</span>
        <span class="rr-pm">flagged — not in the cached recent list (refresh this profile to confirm)</span></li>`;
    }).join("");
    totalOutputs += flaggedKeys.length;
    const uoa = p._effective_uoa ?? effectiveUoa(p, CURRENT_UNIT);
    const m = METRICS.get(p.scholar_id) || batch[p.scholar_id] || {};
    const gpa = refGpa(flags);
    return `<div class="rr-scholar">
      <div class="rr-head">
        <span class="rr-name">${escapeHTML(p.name)}</span>
        <span class="rr-meta">${escapeHTML(p.title || "")}${uoa ? " · UoA " + uoa : ""}</span>
      </div>
      <div class="rr-scholar-stats">
        <span><strong>${flaggedKeys.length}</strong> REF pubs</span>
        <span class="rr-gpa rag-${gpaRag(gpa)}"><strong>${gpa == null ? "—" : gpa.toFixed(2)}</strong> GPA</span>
        <span><strong>${fmt(pubCites)}</strong> cites (these)</span>
        <span><strong>${fmt(m.citedby)}</strong> total cites</span>
        <span><strong>${fmt(m.hindex)}</strong> h-index</span>
      </div>
      <ol class="rr-pubs">${rows}</ol>
    </div>`;
  }).join("");
  const profile = refStarProfile(flagsList);
  const uoaGpa = refGpa(Object.assign({}, ...flagsList.map((f, i) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [i + ":" + k, v])))));

  // UoA readiness summary.
  const required = Math.round(mult * scholars.length);
  const onTarget = totalOutputs >= required;
  const csByStatus = { not_started: 0, draft: 0, proof: 0, finished: 0 };
  cases.forEach(c => { csByStatus[c.status] = (csByStatus[c.status] || 0) + 1; });
  const stats = `
    <div class="rr-stats">
      <div class="rr-stat">
        <span class="rr-stat-n">${totalOutputs}<span class="rr-stat-of"> / ${required}</span></span>
        <span class="rr-stat-l">outputs flagged / target <span class="rr-readiness ${onTarget ? "ok" : "under"}">${onTarget ? "on target" : (required - totalOutputs) + " to go"}</span></span>
      </div>
      <div class="rr-stat">
        <span class="rr-stat-n">${cases.length}</span>
        <span class="rr-stat-l">case studies · ${csByStatus.finished} finished · ${csByStatus.proof} proof · ${csByStatus.draft} draft</span>
      </div>
      <div class="rr-stat">
        <span class="rr-stat-n rag-${gpaRag(uoaGpa)}">${uoaGpa == null ? "—" : uoaGpa.toFixed(2)}</span>
        <span class="rr-stat-l">mean output GPA${profile.rated < profile.total ? ` · ${profile.total - profile.rated} unrated` : ""}</span>
      </div>
      <div class="rr-stat">
        <span class="rr-stat-n">${scholars.length}</span>
        <span class="rr-stat-l">scholars with flagged outputs</span>
      </div>
    </div>
    <div class="rr-profile">
      <div class="qp-title">Output quality profile <span class="qp-sub">${profile.rated} rated output${profile.rated === 1 ? "" : "s"}</span></div>
      ${refProfileBar(profile)}
    </div>`;

  body.innerHTML = `
    <div class="rr-top">
      <div>
        <h3>REF ${REF_YEAR} selection — ${escapeHTML(scope.label)}</h3>
        <p class="rr-sub">${scholars.length} scholar${scholars.length === 1 ? "" : "s"} · ${totalOutputs} flagged output${totalOutputs === 1 ? "" : "s"} · generated ${escapeHTML(new Date().toLocaleString())}</p>
      </div>
      <div class="rr-top-actions">
        <button class="tb-btn" id="rr-text">≡ Text version</button>
        <button class="tb-btn primary" id="rr-print">Print / PDF</button>
      </div>
    </div>
    ${stats}
    ${sections}`;

  // Print = the live modal DOM, not a re-render: whatever is in this report
  // above prints verbatim (only chrome is hidden by the print stylesheet).
  // Keep it that way — see the "STALENESS GUARD" note in style.css @media print.
  body.querySelector("#rr-print")?.addEventListener("click", () => {
    document.body.classList.add("printing-ref-report");
    const done = () => { document.body.classList.remove("printing-ref-report"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 60);
  });

  // Text version — charts → text, for pasting into other documents.
  body.querySelector("#rr-text")?.addEventListener("click", () => {
    const L = [`# REF ${REF_YEAR} selection — ${scope.label}`, "",
      `Generated ${new Date().toLocaleString()}`, "",
      `- Scholars with flagged outputs: ${scholars.length}`,
      `- Outputs flagged: ${totalOutputs} of ${required} target`,
      `- Mean output GPA: ${uoaGpa == null ? "—" : uoaGpa.toFixed(2)}`, "",
      "## Output quality profile", ""];
    [4, 3.5, 3, 2.5, 2, 1].forEach(b => {
      if (profile.bands[b]) L.push(`- ${REF_BAND_LABELS[b]}: ${profile.bands[b]} (${Math.round(profile.bands[b] / profile.rated * 100)}%)`);
    });
    if (profile.total > profile.rated) L.push(`- Unrated: ${profile.total - profile.rated}`);
    L.push("", "## Selected outputs by scholar", "");
    for (const p of scholars) {
      const flags = refFlagsFor(p.scholar_id);
      const keys = Object.keys(flags);
      if (!keys.length) continue;
      const gpa = refGpa(flags);
      const byKey = new Map(((batch[p.scholar_id]?.recent_publications) || []).map(pub => [pub.pub_key, pub]));
      L.push(`### ${p.name}${p.title ? " — " + p.title : ""}  (GPA ${gpa == null ? "—" : gpa.toFixed(2)})`);
      keys.forEach(k => {
        const pub = byKey.get(k);
        const t = pub ? `${pub.title} (${pub.year || "n.d."})` : deSlugTitle(k);
        L.push(`- [${refRatingLabel(flags[k]) || "unrated"}] ${t}`);
      });
      L.push("");
    }
    showTextReport(`ref-selection-${(scope.name || "report")}`, L.join("\n"));
  });
}

// ─── REF impact case studies ──────────────────────────────────────────────
const CS_STATES = [
  { key: "not_started", label: "Not started", cls: "cs-st-none" },
  { key: "draft",       label: "Draft",       cls: "cs-st-draft" },
  { key: "proof",       label: "Proof",       cls: "cs-st-proof" },
  { key: "finished",    label: "Finished",    cls: "cs-st-done" },
];

// Render the case-studies panel above the people grid — only in By UoA view.
async function renderCaseStudies() {
  const panel = document.getElementById("uoa-cs");
  if (!panel) return;
  const code = document.getElementById("uoa-select")?.value;
  if (VIEW_MODE !== "uoa" || !code) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
  panel.classList.remove("hidden");
  let items = [];
  try { items = (await (await fetch("/api/case-studies?uoa=" + encodeURIComponent(code))).json()).case_studies || []; } catch {}
  const uoaName = UOA_BY_CODE[code]?.name || "";
  const cards = items.map(cs => {
    const st = CS_STATES.find(s => s.key === cs.status) || CS_STATES[0];
    const updated = cs.updated_at ? new Date(cs.updated_at).toLocaleDateString() : "";
    const slot = cs.slot
      ? `<span class="cs-slot-badge" title="Slotted for inclusion">№${cs.slot}</span>`
      : `<span class="cs-slot-badge cs-slot-draft" title="A candidate not yet slotted for inclusion">Candidate</span>`;
    return `<button class="cs-cardx" data-cs-edit="${escapeAttr(cs.id)}">
      <span class="cs-badges"><span class="cs-status ${st.cls}">${st.label}</span>${slot}</span>
      <span class="cs-title">${escapeHTML(cs.title || "Untitled case study")}</span>
      <span class="cs-meta">${(cs.references||[]).length} output(s) · ${(cs.contributors||[]).length} contributor(s)${updated ? " · updated " + escapeHTML(updated) : ""}</span>
    </button>`;
  }).join("");
  panel.innerHTML = `
    <div class="cs-panel-head">
      <h2>Impact case studies — UoA ${escapeHTML(code)}${uoaName ? " · " + escapeHTML(uoaName) : ""} <span class="cs-count">${items.length}</span></h2>
      <div class="cs-actions">
        <button class="tb-btn" id="cs-import" title="Import case studies from Markdown (.md) files">⬆ Import…</button>
        <button class="tb-btn" id="cs-export-all" ${items.length ? "" : "disabled"} title="Download this UoA's case studies as a .zip of Markdown files">⤓ Export all</button>
        <button class="tb-btn primary" id="cs-new">＋ New case study</button>
        <input type="file" id="cs-import-input" accept=".md,text/markdown,text/plain" multiple hidden>
      </div>
    </div>
    <div class="cs-grid">${cards || `<div class="cs-empty">
      <p>No case studies yet for this UoA.</p>
      <button class="tb-btn" id="cs-demo">✨ Start from a demo</button>
      <span class="cs-empty-hint">creates an editable example REF3 case study you can adapt or delete · or Import from Markdown (template in docs/)</span>
    </div>`}</div>`;
  document.getElementById("cs-new")?.addEventListener("click", () => openCaseStudyEditor(null, code));
  document.getElementById("cs-demo")?.addEventListener("click", () => createDemoCaseStudy(code));
  document.getElementById("cs-export-all")?.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/case-studies.zip?uoa=${encodeURIComponent(code)}`; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  });
  const importInput = document.getElementById("cs-import-input");
  document.getElementById("cs-import")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        const text = await f.text();
        const r = await fetch("/api/case-study-import", { method: "POST", headers: { "Content-Type": "text/markdown" }, body: text });
        if (r.ok) ok++; else fail++;
      } catch { fail++; }
    }
    alert(`Imported ${ok} case stud${ok === 1 ? "y" : "ies"}${fail ? `, ${fail} failed (check the UoA: header / template)` : ""}.`);
    renderCaseStudies();
  });
  panel.querySelectorAll("[data-cs-edit]").forEach(b => b.addEventListener("click", () => {
    const cs = items.find(c => c.id === b.dataset.csEdit);
    if (cs) openCaseStudyEditor(cs, code);
  }));
}

// Seed an editable demo case study (REF3-shaped placeholder) to help a
// user start when a UoA has none. Persisted as a normal draft; opens the
// editor so they can adapt it. Not auto-created — only on the demo button.
async function createDemoCaseStudy(code) {
  const uoaName = UOA_BY_CODE[code]?.name || "";
  const demo = {
    uoa: code,
    title: `Demo: research from this UoA reshaping practice`,
    status: "draft",
    period: "2018–2024",
    summary: "One paragraph (~100 words) stating the impact: what changed beyond academia, for whom, and its reach and significance. Replace this with your own.",
    underpinning_research: "Summarise the key findings and the research that produced them (typically 2–6 outputs from this UoA, 2021–2028). Note who did it and when.",
    details: "Narrate the impact: the pathway from research to effect, the beneficiaries, and evidence of reach and significance. Reference the corroborating sources below.",
    corroborating_sources: ["e.g. testimonial from a stakeholder", "e.g. policy document / report URL", "e.g. press or usage figures"],
    references: [], contributors: [],
    note: "demo seed",
  };
  try {
    const r = await fetch("/api/case-study", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(demo) });
    const d = await r.json();
    await renderCaseStudies();
    if (d.case_study) openCaseStudyEditor(d.case_study, code);
  } catch (e) { alert("Couldn't create demo: " + e.message); }
}

// Live word counter — shows "N / LIMIT words", red when over. REF gives
// indicative limits (e.g. ~100 words for an impact summary); we surface
// them as guides, not hard blocks.
function wireWordCount(textarea, counter, limit) {
  if (!textarea || !counter) return;
  const upd = () => {
    const n = (textarea.value.trim().match(/\S+/g) || []).length;
    counter.textContent = `${n} / ${limit} words`;
    counter.classList.toggle("over", n > limit);
  };
  textarea.addEventListener("input", upd);
  upd();
}

// REF3-template editor for one case study.
async function openCaseStudyEditor(cs, uoaCode) {
  const modal = document.getElementById("cs-modal");
  const body  = document.getElementById("cs-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<p class="spinner">Loading…</p>`;
  cs = cs || { uoa: uoaCode, status: "not_started", references: [], contributors: [], versions: [] };
  await loadRefFlags();

  // Inclusion slot: the case studies already in this UoA tell us which slots
  // are taken; the per-UoA "required" count bounds how many slots there are.
  let uoaCases = [], uoaMeta = {};
  try { uoaCases = (await (await fetch("/api/case-studies?uoa=" + encodeURIComponent(uoaCode))).json()).case_studies || []; } catch {}
  try { uoaMeta = await (await fetch("/api/uoa-meta?uoa=" + encodeURIComponent(uoaCode))).json(); } catch {}
  const requiredDefault = Math.max(2, Math.ceil((STAFF || []).length / 12));   // indicative
  let csRequired = uoaMeta.case_studies_required || requiredDefault;
  const takenSlots = new Map(uoaCases.filter(c => c.id !== cs.id && c.slot).map(c => [Number(c.slot), c.title || "untitled"]));
  const slotOptionsHtml = (required, current) =>
    [`<option value="">Draft / candidate (not for inclusion)</option>`]
      .concat(Array.from({ length: required }, (_, i) => i + 1).map(n => {
        const taken = takenSlots.has(n);
        const sel = String(current) === String(n);
        return `<option value="${n}" ${sel ? "selected" : ""} ${taken && !sel ? "disabled" : ""}>`
             + `№${n} of ${required}${taken && !sel ? " — taken by “" + escapeHTML(takenSlots.get(n)) + "”" : ""}</option>`;
      })).join("");

  // UoA scholars (current view) + their flagged outputs for the picker.
  const scholars = [...new Map((STAFF || []).filter(p => p.scholar_id).map(p => [p.scholar_id, p])).values()];
  const flaggedIds = scholars.filter(p => refFlagCount(p.scholar_id) > 0).map(p => p.scholar_id);
  let batch = {};
  if (flaggedIds.length) {
    try { batch = await (await fetch("/api/scholar-batch?ids=" + encodeURIComponent(flaggedIds.join(",")))).json(); } catch {}
  }
  // Faceted Scholar → Output picker: only REF-rated outputs in this UoA.
  const ratingLabel = (r) => ({ 1: "1*", 2: "2*", 2.5: "2–3*", 3: "3*", 3.5: "3–4*", 4: "4*" }[r] || "");
  const refByScholar = [];          // [{ sid, name, outputs: [{id, label}] }]
  const refLabelById = new Map();   // id → display label (for the chosen list)
  for (const p of scholars) {
    const flags = refFlagsFor(p.scholar_id);
    const keys = Object.keys(flags);
    if (!keys.length) continue;
    const byKey = new Map(((batch[p.scholar_id]?.recent_publications) || []).map(pub => [pub.pub_key, pub]));
    const outputs = keys.map(k => {
      const id = p.scholar_id + ":" + k;
      const pub = byKey.get(k);
      const base = pub ? `${pub.title || "Untitled"} (${pub.year || "n.d."})` : deSlugTitle(k);
      const rl = ratingLabel(flags[k]);
      const label = rl ? `${base} · ${rl}` : base;
      refLabelById.set(id, label);
      return { id, label };
    });
    refByScholar.push({ sid: p.scholar_id, name: p.name, outputs });
  }
  // Working list of chosen reference ids (ordered); saved verbatim.
  const chosenRefs = [...(cs.references || [])];
  const refDisplay = (id) => refLabelById.get(id)
    || (() => { const [, k] = id.split(/:(.+)/); return deSlugTitle(k || id); })();
  // Contributors = the staff who conducted the underpinning research (REF3
  // "Details of staff…"). Normally the authors of the referenced outputs, so
  // we let the user pull those in automatically, then add/remove any UoA staff.
  const allStaff = [...new Map((STAFF || []).map(p => [(p.staff_id || p.scholar_id || p.name), p])).values()]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const contribKeyOf = (p) => p.staff_id || p.scholar_id || p.name;
  const contribLabelById = new Map(allStaff.map(p => [contribKeyOf(p), p.name || p.staff_id || "(unnamed)"]));
  const scholarToContribKey = new Map(allStaff.filter(p => p.scholar_id).map(p => [p.scholar_id, contribKeyOf(p)]));
  const chosenContribs = [...(cs.contributors || [])];
  const contribDisplay = (id) => contribLabelById.get(id) || id;
  const statusOpts = CS_STATES.map(s => `<option value="${s.key}" ${s.key === cs.status ? "selected" : ""}>${s.label}</option>`).join("");
  const versions = (cs.versions || []).slice().reverse()
    .map(v => `<li>${escapeHTML(new Date(v.ts).toLocaleString())} — <strong>${escapeHTML(v.status)}</strong>${v.note ? " · " + escapeHTML(v.note) : ""}</li>`).join("");

  body.innerHTML = `
    <h3>${cs.id ? "Edit" : "New"} impact case study <span class="cs-uoa-tag">UoA ${escapeHTML(uoaCode)}</span></h3>
    <div class="cs-form">
      <label class="cs-f">Title<input id="cs-title" type="text" value="${escapeAttr(cs.title || "")}"></label>
      <div class="cs-row2">
        <label class="cs-f">Status <span class="cs-f-hint">(authoring progress)</span><select id="cs-status">${statusOpts}</select></label>
        <label class="cs-f">Period of underpinning research<input id="cs-period" type="text" placeholder="e.g. 2018–2024" value="${escapeAttr(cs.period || "")}"></label>
      </div>
      <div class="cs-row2">
        <label class="cs-f">Inclusion <span class="cs-f-hint">(which slot in the submission, if any)</span><select id="cs-slot">${slotOptionsHtml(csRequired, cs.slot || "")}</select></label>
        <label class="cs-f">Case studies required for this UoA<input id="cs-required" type="number" min="0" max="50" value="${csRequired}"></label>
      </div>
      <label class="cs-f">Summary of the impact <span class="wordcount" id="cs-summary-wc"></span><textarea id="cs-summary" rows="3">${escapeHTML(cs.summary || "")}</textarea></label>
      <label class="cs-f">Underpinning research<textarea id="cs-underpinning" rows="4">${escapeHTML(cs.underpinning_research || "")}</textarea></label>
      <div class="cs-f"><span class="cs-f-label">References to the research (REF-flagged outputs)</span>
        ${refByScholar.length ? `<div class="cs-ref-picker">
          <select id="cs-ref-scholar" class="cs-ref-sel"><option value="">Scholar…</option>${
            refByScholar.map((s, i) => `<option value="${i}">${escapeHTML(s.name)} (${s.outputs.length})</option>`).join("")}</select>
          <select id="cs-ref-output" class="cs-ref-sel" disabled><option value="">Output…</option></select>
          <button type="button" class="tb-btn" id="cs-ref-add" disabled>Add</button>
        </div>
        <ul class="cs-ref-chosen" id="cs-ref-chosen"></ul>`
        : '<p class="cs-empty">No REF-flagged outputs in this UoA yet — set a rating on people\'s outputs first.</p>'}</div>
      <label class="cs-f">Details of the impact<textarea id="cs-details" rows="5">${escapeHTML(cs.details || "")}</textarea></label>
      <label class="cs-f">Sources to corroborate <span class="cs-f-hint">(one per line)</span><textarea id="cs-sources" rows="3">${escapeHTML((cs.corroborating_sources || []).join("\n"))}</textarea></label>
      <div class="cs-f"><span class="cs-f-label">Contributors <span class="cs-f-hint">(staff who conducted the underpinning research)</span></span>
        <div class="cs-ref-picker">
          <select id="cs-contrib-sel" class="cs-ref-sel"><option value="">Add staff…</option>${
            allStaff.map(p => `<option value="${escapeAttr(contribKeyOf(p))}">${escapeHTML(p.name || p.staff_id || "(unnamed)")}</option>`).join("")}</select>
          <button type="button" class="tb-btn" id="cs-contrib-add" disabled>Add</button>
          <button type="button" class="tb-btn" id="cs-contrib-from-refs" title="Add the authors of the outputs selected above">＋ from references</button>
        </div>
        <ul class="cs-ref-chosen" id="cs-contrib-chosen"></ul></div>
      ${versions ? `<details class="cs-versions"><summary>Version history (${(cs.versions || []).length})</summary><ul>${versions}</ul></details>` : ""}
    </div>
    <div class="data-actions">
      ${cs.id ? `<button class="tb-btn cs-danger" id="cs-delete">Delete</button>` : ""}
      ${cs.id ? `<button class="tb-btn" id="cs-download">⤓ Download .md</button>` : ""}
      <span class="data-actions-spacer"></span>
      <span class="set-saved" id="cs-saved"></span>
      <button class="tb-btn" data-cs-close>Cancel</button>
      <button class="tb-btn primary" id="cs-save">Save</button>
    </div>`;

  // REF gives an indicative ~100-word limit for the impact summary.
  wireWordCount(body.querySelector("#cs-summary"), body.querySelector("#cs-summary-wc"), 100);

  // Faceted references picker — scholar → output → Add, with a removable list.
  const refScholarSel = body.querySelector("#cs-ref-scholar");
  const refOutputSel  = body.querySelector("#cs-ref-output");
  const refAddBtn     = body.querySelector("#cs-ref-add");
  const refChosenEl   = body.querySelector("#cs-ref-chosen");
  const renderChosen = () => {
    if (!refChosenEl) return;
    refChosenEl.innerHTML = chosenRefs.length
      ? chosenRefs.map(id => `<li class="cs-ref-pill"><span>${escapeHTML(refDisplay(id))}</span>` +
          `<button type="button" class="cs-ref-rm" data-ref-id="${escapeAttr(id)}" title="Remove">×</button></li>`).join("")
      : `<li class="cs-ref-none">No outputs selected yet.</li>`;
  };
  const fillOutputs = () => {
    if (!refOutputSel) return;
    const s = refByScholar[refScholarSel.value];
    const avail = s ? s.outputs.filter(o => !chosenRefs.includes(o.id)) : [];
    refOutputSel.innerHTML = `<option value="">Output…</option>` +
      avail.map(o => `<option value="${escapeAttr(o.id)}">${escapeHTML(o.label)}</option>`).join("");
    refOutputSel.disabled = !s || !avail.length;
    refAddBtn.disabled = true;
  };
  refScholarSel?.addEventListener("change", fillOutputs);
  refOutputSel?.addEventListener("change", () => { refAddBtn.disabled = !refOutputSel.value; });
  refAddBtn?.addEventListener("click", () => {
    const id = refOutputSel.value;
    if (id && !chosenRefs.includes(id)) chosenRefs.push(id);
    renderChosen(); fillOutputs();
  });
  refChosenEl?.addEventListener("click", (ev) => {
    const b = ev.target.closest(".cs-ref-rm"); if (!b) return;
    const i = chosenRefs.indexOf(b.dataset.refId);
    if (i >= 0) chosenRefs.splice(i, 1);
    renderChosen(); fillOutputs();
  });
  renderChosen();

  // Contributors picker — same UI; "from references" pulls in the authors of
  // the chosen outputs (the usual REF3 starting point), then editable freely.
  const contribSel     = body.querySelector("#cs-contrib-sel");
  const contribAddBtn  = body.querySelector("#cs-contrib-add");
  const contribFromRef = body.querySelector("#cs-contrib-from-refs");
  const contribChosenEl = body.querySelector("#cs-contrib-chosen");
  const renderContribs = () => {
    if (!contribChosenEl) return;
    contribChosenEl.innerHTML = chosenContribs.length
      ? chosenContribs.map(id => `<li class="cs-ref-pill"><span>${escapeHTML(contribDisplay(id))}</span>` +
          `<button type="button" class="cs-ref-rm" data-contrib-id="${escapeAttr(id)}" title="Remove">×</button></li>`).join("")
      : `<li class="cs-ref-none">No contributors yet — add staff, or pull in the authors of the references above.</li>`;
  };
  contribSel?.addEventListener("change", () => { contribAddBtn.disabled = !contribSel.value; });
  contribAddBtn?.addEventListener("click", () => {
    const id = contribSel.value;
    if (id && !chosenContribs.includes(id)) chosenContribs.push(id);
    contribSel.value = ""; contribAddBtn.disabled = true; renderContribs();
  });
  contribFromRef?.addEventListener("click", () => {
    let added = 0;
    for (const refId of chosenRefs) {
      const key = scholarToContribKey.get(refId.split(":")[0]);
      if (key && !chosenContribs.includes(key)) { chosenContribs.push(key); added++; }
    }
    renderContribs();
    if (!added) contribFromRef.textContent = "✓ all already added";
    setTimeout(() => { contribFromRef.textContent = "＋ from references"; }, 1800);
  });
  contribChosenEl?.addEventListener("click", (ev) => {
    const b = ev.target.closest(".cs-ref-rm"); if (!b) return;
    const i = chosenContribs.indexOf(b.dataset.contribId);
    if (i >= 0) chosenContribs.splice(i, 1);
    renderContribs();
  });
  renderContribs();

  body.querySelector("#cs-download")?.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = `/api/case-study.md?id=${encodeURIComponent(cs.id)}`; a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  });

  // Bumping "required" rebuilds the slot dropdown so more/fewer slots show.
  const slotSel = body.querySelector("#cs-slot");
  body.querySelector("#cs-required")?.addEventListener("input", (e) => {
    const n = Math.max(0, parseInt(e.target.value, 10) || 0);
    csRequired = n;
    slotSel.innerHTML = slotOptionsHtml(n, slotSel.value);
  });

  body.querySelector("#cs-save").addEventListener("click", async () => {
    const reqN = Math.max(0, parseInt(body.querySelector("#cs-required").value, 10) || 0);
    const payload = {
      id: cs.id, uoa: uoaCode,
      title:  body.querySelector("#cs-title").value.trim(),
      status: body.querySelector("#cs-status").value,
      slot:   body.querySelector("#cs-slot").value || null,
      period: body.querySelector("#cs-period").value.trim(),
      summary: body.querySelector("#cs-summary").value.trim(),
      underpinning_research: body.querySelector("#cs-underpinning").value.trim(),
      details: body.querySelector("#cs-details").value.trim(),
      corroborating_sources: body.querySelector("#cs-sources").value.split("\n").map(s => s.trim()).filter(Boolean),
      references:   chosenRefs.slice(),
      contributors: chosenContribs.slice(),
    };
    try {
      // Persist the per-UoA "required" count if the user changed it.
      if (reqN !== (uoaMeta.case_studies_required || 0)) {
        await fetch("/api/uoa-meta", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uoa: uoaCode, case_studies_required: reqN }) });
      }
      const r = await fetch("/api/case-study", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error("save failed");
      modal.classList.add("hidden");
      renderCaseStudies();
    } catch (e) { body.querySelector("#cs-saved").textContent = "Save failed"; }
  });
  body.querySelector("#cs-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this case study? This can't be undone.")) return;
    try {
      await fetch("/api/case-study", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cs.id }) });
      modal.classList.add("hidden");
      renderCaseStudies();
    } catch (e) { alert("Delete failed: " + e.message); }
  });
}

// ─── Impact case-study manager (Data menu) ────────────────────────────────
// A cross-UoA view of every case study: reassign between UoAs, surface and
// assign unassigned ones, and delete unwanted ones (with a warning).
async function openCaseStudyManager() {
  const modal = document.getElementById("cs-manager-modal");
  modal.classList.remove("hidden");
  document.getElementById("cs-manager-body").innerHTML = `<p class="spinner">Loading case studies…</p>`;
  let items = [];
  try { items = (await (await fetch("/api/case-studies")).json()).case_studies || []; } catch {}
  renderCaseStudyManager(items);
}
function renderCaseStudyManager(items) {
  const body = document.getElementById("cs-manager-body");
  const groups = new Map();
  for (const c of items) {
    const k = (c.uoa && String(c.uoa).trim()) ? String(c.uoa) : "";
    (groups.get(k) || groups.set(k, []).get(k)).push(c);
  }
  const uoaOptions = (cur) => `<option value="">— Unassigned —</option>` +
    Array.from({ length: 34 }, (_, i) => i + 1).map(n => {
      const nm = UOA_BY_CODE[n]?.name ? `UoA ${n} · ${UOA_BY_CODE[n].name}` : `UoA ${n}`;
      return `<option value="${n}" ${String(cur) === String(n) ? "selected" : ""}>${escapeHTML(nm)}</option>`;
    }).join("");
  const orderedKeys = [...groups.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : (parseInt(a, 10) || 999) - (parseInt(b, 10) || 999));
  const rowHtml = (list) => list.map(c => {
    const st = CS_STATES.find(s => s.key === c.status) || CS_STATES[0];
    return `<div class="csm-row" data-id="${escapeAttr(c.id)}">
      <span class="cs-status ${st.cls}">${st.label}</span>
      <span class="cs-slot-badge ${c.slot ? "" : "cs-slot-draft"}">${c.slot ? "№" + c.slot : "Candidate"}</span>
      <span class="csm-title">${escapeHTML(c.title || "Untitled case study")}</span>
      <span class="csm-meta">${(c.references || []).length} out · ${(c.contributors || []).length} contrib</span>
      <select class="csm-uoa" data-id="${escapeAttr(c.id)}" title="Reassign this case study to a UoA">${uoaOptions(c.uoa)}</select>
      <button class="tb-btn csm-del" data-id="${escapeAttr(c.id)}" title="Delete this case study">🗑</button>
    </div>`;
  }).join("");
  const groupsHtml = orderedKeys.map(k => {
    const list = groups.get(k);
    const label = k === "" ? "Unassigned — not in any UoA"
      : (UOA_BY_CODE[k]?.name ? `UoA ${k} · ${UOA_BY_CODE[k].name}` : `UoA ${k}`);
    return `<section class="csm-group ${k === "" ? "csm-group-unassigned" : ""}">
      <h4>${escapeHTML(label)} <span class="cs-count">${list.length}</span></h4>${rowHtml(list)}</section>`;
  }).join("") || `<p class="cs-empty">No impact case studies yet — create one from the By-UoA view.</p>`;
  body.innerHTML = `
    <h3>Manage impact case studies</h3>
    <p class="csm-intro">Reassign a case study to another UoA, pick up unassigned ones, or delete those you don't need. ${items.length} total · generated ${escapeHTML(new Date().toLocaleString())}.</p>
    ${groupsHtml}`;
  body.querySelectorAll(".csm-uoa").forEach(sel => sel.addEventListener("change", async () => {
    try {
      await fetch("/api/case-study", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sel.dataset.id, uoa: sel.value || "" }) });
      openCaseStudyManager();
      renderCaseStudies();
    } catch (e) { alert("Reassign failed: " + e.message); }
  }));
  body.querySelectorAll(".csm-del").forEach(btn => btn.addEventListener("click", async () => {
    const cs = items.find(c => c.id === btn.dataset.id);
    if (!confirm(`Delete the case study “${cs?.title || "Untitled"}”?\n\nThis permanently removes it and its references, contributors and version history. This cannot be undone.`)) return;
    try {
      await fetch("/api/case-study", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: btn.dataset.id }) });
      openCaseStudyManager();
      renderCaseStudies();
    } catch (e) { alert("Delete failed: " + e.message); }
  }));
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-cs-manager")) openCaseStudyManager();
  if (e.target.closest("[data-csm-close]")) document.getElementById("cs-manager-modal").classList.add("hidden");
  if (e.target.id === "cs-manager-modal") e.target.classList.add("hidden");
  if (e.target.closest("[data-tr-close]")) document.getElementById("text-report-modal").classList.add("hidden");
  if (e.target.id === "text-report-modal") e.target.classList.add("hidden");
  if (e.target.closest("[data-cs-close]")) document.getElementById("cs-modal").classList.add("hidden");
  if (e.target.id === "cs-modal") e.target.classList.add("hidden");
  if (e.target.closest("#tb-uoa-report") || e.target.closest("#uoa-report-btn")) buildUoaReport();
  if (e.target.closest("[data-uoa-report-close]")) document.getElementById("uoa-report-modal").classList.add("hidden");
  if (e.target.id === "uoa-report-modal") e.target.classList.add("hidden");
});

// ─── UoA report ───────────────────────────────────────────────────────────
// One printable document for a UoA: cover + editable narrative + selected
// (REF-flagged) outputs per scholar + full impact case studies (REF3 order).
async function buildUoaReport() {
  const code = document.getElementById("uoa-select")?.value;
  if (VIEW_MODE !== "uoa" || !code) {
    alert("Switch to the By UoA view and pick a UoA first — the report is per-UoA.");
    return;
  }
  const modal = document.getElementById("uoa-report-modal");
  const body  = document.getElementById("uoa-report-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<p class="spinner">Assembling UoA report…</p>`;
  await loadRefFlags();

  const uoaName = UOA_BY_CODE[code]?.name || "";
  const scholars = [...new Map((STAFF || []).filter(p => p.scholar_id).map(p => [p.scholar_id, p])).values()];
  const flaggedIds = scholars.filter(p => refFlagCount(p.scholar_id) > 0).map(p => p.scholar_id);
  let batch = {};
  if (flaggedIds.length) {
    try { batch = await (await fetch("/api/scholar-batch?ids=" + encodeURIComponent(flaggedIds.join(",")))).json(); } catch {}
  }
  let cases = [], meta = { narrative: "" };
  try { cases = (await (await fetch("/api/case-studies?uoa=" + encodeURIComponent(code))).json()).case_studies || []; } catch {}
  try { meta = await (await fetch("/api/uoa-meta?uoa=" + encodeURIComponent(code))).json(); } catch {}

  const pubTitle = (sid, key) => {
    const pub = ((batch[sid]?.recent_publications) || []).find(p => p.pub_key === key);
    return pub ? `${pub.title} (${pub.year || "n.d."})` : deSlugTitle(key);
  };
  const nameByStaffId = new Map(scholars.map(p => [(p.staff_id || p.name), p.name]));

  // Targets for the readiness dashboard.
  let targets = { default: { multiplier: 2.5 } };
  try { targets = await (await fetch("/api/ref-targets")).json(); } catch {}
  const mult = (targets[code] && targets[code].multiplier) || (targets.default && targets.default.multiplier) || 2.5;

  // Outputs section — only scholars with flags, flagged pubs only.
  let totalOutputs = 0;
  const flagsList = [];
  const outputsHtml = scholars.filter(p => refFlagCount(p.scholar_id) > 0).map(p => {
    const flags = refFlagsFor(p.scholar_id);
    flagsList.push(flags);
    const keys = Object.keys(flags);
    totalOutputs += keys.length;
    const gpa = refGpa(flags);
    const rows = keys.map(k => {
      const band = refRatingLabel(flags[k]);
      const chip = band ? `<span class="rr-band band-${String(flags[k]).replace(".", "_")}">${band}</span>` : "";
      return `<li>${chip}${escapeHTML(pubTitle(p.scholar_id, k))}</li>`;
    }).join("");
    return `<div class="ur-scholar"><div class="ur-sc-name">${escapeHTML(p.name)} <span class="ur-sc-meta">${escapeHTML(p.title || "")}</span>` +
      `<span class="ur-sc-gpa rag-${gpaRag(gpa)}">GPA ${gpa == null ? "—" : gpa.toFixed(2)}</span></div><ol>${rows}</ol></div>`;
  }).join("") || `<p class="ur-empty">No outputs flagged for REF in this UoA yet.</p>`;
  const profile = refStarProfile(flagsList);
  const uoaGpa = refGpa(Object.assign({}, ...flagsList.map((f, i) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [i + ":" + k, v])))));
  const required = Math.round(mult * scholars.length);

  // Case-studies section — full REF3 render. Slotted-for-inclusion first
  // (by number), candidates/drafts after.
  const byStatus = { not_started: 0, draft: 0, proof: 0, finished: 0 };
  cases.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const slottedCount = cases.filter(c => c.slot).length;
  cases = cases.slice().sort((a, b) => (a.slot || 99) - (b.slot || 99));
  const casesHtml = cases.map(c => {
    const st = CS_STATES.find(s => s.key === c.status) || CS_STATES[0];
    const slotTag = c.slot
      ? `<span class="ur-cs-slot">Case study ${c.slot}</span>`
      : `<span class="ur-cs-slot ur-cs-slot-draft">Candidate</span>`;
    const refs = (c.references || []).map(r => {
      const [sid, key] = r.split(/:(.+)/);
      const band = refRatingLabel(refFlagsFor(sid)[key]);
      const chip = band ? `<span class="rr-band band-${String(refFlagsFor(sid)[key]).replace(".", "_")}">${band}</span>` : "";
      return `<li>${chip}${escapeHTML(pubTitle(sid, key))}</li>`;
    }).join("");
    const contribs = (c.contributors || []).map(id => escapeHTML(nameByStaffId.get(id) || id)).join(", ");
    const sources = (c.corroborating_sources || []).map(s => `<li>${escapeHTML(s)}</li>`).join("");
    const sec = (label, txt) => txt ? `<div class="ur-cs-sec"><h5>${label}</h5><p>${escapeHTML(txt).replace(/\n/g, "<br>")}</p></div>` : "";
    return `<article class="ur-cs">
      <h4>${slotTag} ${escapeHTML(c.title || "Untitled case study")} <span class="cs-status ${st.cls}">${st.label}</span></h4>
      ${c.period ? `<p class="ur-cs-period">Underpinning research: ${escapeHTML(c.period)}</p>` : ""}
      ${sec("Summary of the impact", c.summary)}
      ${sec("Underpinning research", c.underpinning_research)}
      ${refs ? `<div class="ur-cs-sec"><h5>References to the research</h5><ol>${refs}</ol></div>` : ""}
      ${sec("Details of the impact", c.details)}
      ${sources ? `<div class="ur-cs-sec"><h5>Sources to corroborate</h5><ul>${sources}</ul></div>` : ""}
      ${contribs ? `<p class="ur-cs-contrib">Contributors: ${contribs}</p>` : ""}
    </article>`;
  }).join("") || `<p class="ur-empty">No impact case studies recorded for this UoA yet.</p>`;

  const today = new Date().toLocaleDateString();
  body.innerHTML = `
    <div class="ur-top">
      <div>
        <h2 class="ur-title">UoA ${escapeHTML(code)}${uoaName ? " · " + escapeHTML(uoaName) : ""}</h2>
        <p class="ur-sub">REF ${REF_YEAR} submission report · ${escapeHTML(window.__UNIVERSITY__ || "University")} · generated ${escapeHTML(new Date().toLocaleString())}</p>
      </div>
      <div class="rr-top-actions">
        <button class="tb-btn" id="ur-text">≡ Text version</button>
        <button class="tb-btn primary" id="ur-print">Print / PDF</button>
      </div>
    </div>
    <div class="ur-stats">
      <span><strong>${scholars.length}</strong> staff</span>
      <span><strong>${totalOutputs}</strong> outputs flagged</span>
      <span><strong>${cases.length}</strong> case studies</span>
      <span class="ur-stat-sub">${byStatus.finished} finished · ${byStatus.proof} proof · ${byStatus.draft} draft · ${byStatus.not_started} not started</span>
    </div>

    <div class="ur-rag" role="group" aria-label="Readiness at a glance">
      ${ragTile("Outputs vs target", `${totalOutputs} / ${required}`,
                targetRag(totalOutputs, required),
                totalOutputs >= required ? "on target" : `${required - totalOutputs} to go`)}
      ${ragTile("Mean output GPA", uoaGpa == null ? "—" : uoaGpa.toFixed(2), gpaRag(uoaGpa),
                uoaGpa == null ? "rate the outputs" : uoaGpa >= 3 ? "strong" : uoaGpa >= 2 ? "developing" : "low")}
      ${ragTile("Outputs rated", `${profile.rated} / ${profile.total}`,
                profile.total === 0 ? "na" : profile.rated === profile.total ? "ok" : profile.rated >= 0.5 * profile.total ? "warn" : "under",
                profile.total === 0 ? "none flagged" : profile.rated === profile.total ? "all rated" : `${profile.total - profile.rated} unrated`)}
      ${ragTile("Impact case studies", String(cases.length),
                cases.length === 0 ? "under" : byStatus.finished >= 1 ? "ok" : "warn",
                byStatus.finished >= 1 ? `${byStatus.finished} finished` : cases.length ? "in progress" : "none yet")}
    </div>

    <section class="ur-section">
      <h3>Output quality profile <span class="ur-count">${profile.rated}/${profile.total}</span></h3>
      <div class="rr-profile">${refProfileBar(profile)}</div>
    </section>

    <section class="ur-section">
      <h3>Narrative / environment <span class="wordcount" id="ur-narr-wc"></span></h3>
      <textarea id="ur-narrative" class="ur-narrative" rows="5" placeholder="Describe the UoA's research environment, strategy and vitality…">${escapeHTML(meta.narrative || "")}</textarea>
      <div class="ur-narrative-print" id="ur-narrative-print">${escapeHTML(meta.narrative || "")}</div>
      <div class="ur-narrative-actions"><button class="tb-btn" id="ur-save-narrative">Save narrative</button><span class="set-saved" id="ur-narr-saved"></span></div>
    </section>

    <section class="ur-section">
      <h3>Selected outputs <span class="ur-count">${totalOutputs}</span></h3>
      ${outputsHtml}
    </section>

    <section class="ur-section">
      <h3>Impact case studies <span class="ur-count">${cases.length}</span></h3>
      ${casesHtml}
    </section>`;

  // Indicative environment-statement guide (FTE-scaled in REF; 500 here).
  wireWordCount(body.querySelector("#ur-narrative"), body.querySelector("#ur-narr-wc"), 500);
  // Keep the print-only narrative div in sync so the printed PDF shows the
  // full text (a <textarea> won't expand to its content on paper).
  const narrTa = body.querySelector("#ur-narrative");
  const narrPrint = body.querySelector("#ur-narrative-print");
  narrTa?.addEventListener("input", () => { narrPrint.textContent = narrTa.value; });

  body.querySelector("#ur-save-narrative")?.addEventListener("click", async () => {
    const saved = body.querySelector("#ur-narr-saved");
    try {
      const r = await fetch("/api/uoa-meta", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uoa: code, narrative: body.querySelector("#ur-narrative").value }) });
      if (!r.ok) throw new Error();
      saved.textContent = "Saved ✓"; setTimeout(() => saved.textContent = "", 2500);
    } catch { saved.textContent = "Save failed"; }
  });
  body.querySelector("#ur-print")?.addEventListener("click", () => {
    document.body.classList.add("printing-uoa-report");
    const done = () => { document.body.classList.remove("printing-uoa-report"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 60);
  });

  // Text version — the whole report as Markdown (charts → text).
  body.querySelector("#ur-text")?.addEventListener("click", () => {
    const narr = body.querySelector("#ur-narrative")?.value || meta.narrative || "";
    const L = [`# UoA ${code}${uoaName ? " · " + uoaName : ""} — REF ${REF_YEAR} submission report`, "",
      `${window.__UNIVERSITY__ || "University"} · generated ${new Date().toLocaleString()}`, "",
      "## Readiness", "",
      `- Staff: ${scholars.length}`,
      `- Selected outputs: ${totalOutputs} of ${required} target`,
      `- Mean output GPA: ${uoaGpa == null ? "—" : uoaGpa.toFixed(2)}`,
      `- Outputs rated: ${profile.rated} of ${profile.total}`,
      `- Impact case studies: ${cases.length} (${byStatus.finished} finished, ${byStatus.proof} proof, ${byStatus.draft} draft)`, "",
      "## Output quality profile", ""];
    [4, 3.5, 3, 2.5, 2, 1].forEach(b => {
      if (profile.bands[b]) L.push(`- ${REF_BAND_LABELS[b]}: ${profile.bands[b]} (${Math.round(profile.bands[b] / profile.rated * 100)}%)`);
    });
    L.push("", "## Narrative / environment", "", narr.trim() || "_(not yet written)_", "",
      "## Selected outputs", "");
    for (const p of scholars.filter(s => refFlagCount(s.scholar_id) > 0)) {
      const flags = refFlagsFor(p.scholar_id);
      const gpa = refGpa(flags);
      L.push(`### ${p.name}${p.title ? " — " + p.title : ""}  (GPA ${gpa == null ? "—" : gpa.toFixed(2)})`);
      Object.keys(flags).forEach(k => L.push(`- [${refRatingLabel(flags[k]) || "unrated"}] ${pubTitle(p.scholar_id, k)}`));
      L.push("");
    }
    L.push("## Impact case studies", "");
    for (const c of cases) {
      const slot = c.slot ? `Case study ${c.slot}` : "Draft / candidate";
      L.push(`### ${slot}: ${c.title || "Untitled case study"} (${c.status})`);
      if (c.period) L.push(`Underpinning research: ${c.period}`);
      if (c.summary) L.push("", `**Summary of the impact.** ${c.summary}`);
      if (c.underpinning_research) L.push("", `**Underpinning research.** ${c.underpinning_research}`);
      const refs = (c.references || []).map(r => { const [sid, key] = r.split(/:(.+)/); return pubTitle(sid, key); });
      if (refs.length) { L.push("", "References to the research:"); refs.forEach(t => L.push(`- ${t}`)); }
      if (c.details) L.push("", `**Details of the impact.** ${c.details}`);
      const srcs = c.corroborating_sources || [];
      if (srcs.length) { L.push("", "Sources to corroborate:"); srcs.forEach(s => L.push(`- ${s}`)); }
      const contribs = (c.contributors || []).map(id => nameByStaffId.get(id) || id);
      if (contribs.length) L.push("", `Contributors: ${contribs.join(", ")}`);
      L.push("");
    }
    showTextReport(`uoa-${code}-report`, L.join("\n"));
  });
}

// ─── Server liveness ────────────────────────────────────────────────────
// The backend kills itself after 20 minutes of no real requests, so we
// poll /api/heartbeat every 60s. When it fails, the Quit button swaps to
// Restart and a banner appears across the top of the page.
let SERVER_DOWN = false;
async function checkHeartbeat() {
  try {
    const r = await fetch("/api/heartbeat", { cache: "no-store" });
    if (!r.ok) throw new Error("heartbeat " + r.status);
    if (SERVER_DOWN) setServerDown(false);
  } catch (_) {
    if (!SERVER_DOWN) setServerDown(true);
  }
}
function setServerDown(down) {
  SERVER_DOWN = down;
  // Quit lives in the File menu now; update just its label span so we
  // don't clobber the menu-item markup.
  const label = document.getElementById("tb-quit-label");
  if (label) label.textContent = down ? "Restart…" : "Quit";
  const item = document.getElementById("tb-quit");
  if (item) {
    item.title = down
      ? "Local server has stopped (idle timeout). Click for restart instructions."
      : "Stop the local Scholar Dashboard server";
    item.classList.toggle("tb-restart", down);
  }
  let banner = document.getElementById("server-down-banner");
  if (down) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "server-down-banner";
      banner.className = "server-down-banner";
      banner.innerHTML = `Local server has stopped (idle for 20 min). <button type="button" class="link-btn" id="server-down-restart">Show restart instructions</button>`;
      document.body.prepend(banner);
    }
  } else if (banner) {
    banner.remove();
  }
}
function showRestartInstructions() {
  alert("Scholar Dashboard server has stopped.\n\nTo restart:\n  • Double-click Scholar-Dashboard.app in the project folder, or\n  • Run start.command\n\nThen reload this tab.");
}
document.addEventListener("click", (e) => {
  if (e.target.closest("#server-down-restart")) showRestartInstructions();
});
// Kick off polling after first load, then every 60s. Heartbeat itself is
// excluded from idle-tracking on the backend so this never keeps the server
// awake.
setTimeout(checkHeartbeat, 5000);
setInterval(checkHeartbeat, 60000);

// Toolbar Quit — gracefully stop the local Flask server. Replaces the page
// with a "Server stopped" message so the user can't accidentally keep
// poking at a dead dashboard.
async function quitServer() {
  if (!confirm("Stop the local Scholar Dashboard server?\n\nYou can re-launch by double-clicking Scholar-Dashboard.app.")) return;
  try {
    await fetch("/api/shutdown", { method: "POST" });
  } catch (_) { /* the server killed itself, the fetch may error — fine */ }
  document.documentElement.innerHTML = `
    <head><meta charset="utf-8"><title>Scholar Dashboard — stopped</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             color: #1a1a1a; background: #faf8f4; margin: 0;
             display: flex; align-items: center; justify-content: center; min-height: 100vh; }
      .card { background: #fff; border: 1px solid #e0ddd6; border-radius: 12px;
              padding: 2rem 2.5rem; max-width: 32rem; text-align: center;
              box-shadow: 0 4px 20px rgba(0,0,0,.06); }
      h1 { color: #1d4f91; margin: 0 0 .5rem; font-size: 1.4rem; }
      p  { color: #6b6b6b; line-height: 1.5; }
      code { background: #f0eee8; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
    </style></head>
    <body><div class="card">
      <h1>◐ Scholar Dashboard — stopped</h1>
      <p>The local server is no longer running.</p>
      <p>To restart, double-click <code>Scholar-Dashboard.app</code> in the project folder.</p>
      <p>You can close this tab.</p>
    </div></body>`;
}

// Toolbar "Save unit" — download the currently-selected unit's Markdown file.
// In UoA mode it instead saves the whole UoA as one self-contained bundle.
function saveCurrentUnit() {
  if (VIEW_MODE === "uoa") { saveUoaBundle(); return; }
  if (!CURRENT_UNIT || CURRENT_UNIT.slug === "all-staff") {
    alert("Select a single unit first — \"Save unit\" downloads one unit's file. "
        + "(The current view is an aggregate, not a single unit.)");
    return;
  }
  downloadUnitFile(CURRENT_UNIT.slug);
}

// Download a self-contained bundle for a scope: its unit files + cached pubs
// (with ratings) + REF flags + profiles + impact case studies + UoA
// narratives. One <name>_UoA.json / _Faculty.json that Load re-ingests.
function saveBundle(scope) {
  if (!scope || !scope.slugs || !scope.slugs.length) {
    alert("Nothing to bundle in the current view.");
    return;
  }
  const code = scope.kind === "uoa" ? (document.getElementById("uoa-select")?.value || "") : "";
  const name = scope.label || scope.name || "";
  const url = `/api/bundle.json?kind=${encodeURIComponent(scope.kind)}`
            + `&code=${encodeURIComponent(code)}`
            + `&slugs=${encodeURIComponent(scope.slugs.join(","))}`
            + `&name=${encodeURIComponent(name)}`
            + `&file=${encodeURIComponent(scope.name)}`;
  const a = document.createElement("a");
  a.href = url; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

// UoA mode: bundle the selected UoA.
function saveUoaBundle() {
  const code = document.getElementById("uoa-select")?.value;
  if (!code) { alert("Pick a UoA first — \"Save\" in UoA mode bundles the selected UoA."); return; }
  saveBundle(currentScope());
}

// Faculty mode: bundle the current scope (whole faculty / school / everything).
// A faculty bundle carries every unit in scope plus the case studies and
// narratives for every UoA those units' staff belong to.
function saveFacultyBundle() {
  const scope = currentScope();
  if (scope.kind === "unit") {
    // A single unit is selected — a faculty bundle still makes sense for its
    // whole faculty, so widen to the faculty it sits in.
    const facSlug = document.getElementById("faculty-select")?.value;
    if (facSlug && facSlug !== "__all__") {
      const slugs = UNITS.filter(u => !u.disabled && u.slug !== "all-staff" && u._facultySlug === facSlug).map(u => u.slug);
      const fac = FACULTIES.find(f => f.slug === facSlug);
      return saveBundle({ kind: "faculty", label: fac?.name || facSlug, slugs, name: facSlug });
    }
  }
  saveBundle(scope);
}

// Describe what the current view covers, for scope-aware Export. Returns
// { kind, label, noun, slugs, name } where kind ∈ unit|school|faculty|uoa|all.
function currentScope() {
  const activeUnits = (pred) =>
    UNITS.filter(u => !u.disabled && u.slug !== "all-staff" && pred(u));

  if (VIEW_MODE === "uoa") {
    const code = document.getElementById("uoa-select")?.value;
    if (code) {
      const slugs = activeUnits(u =>
        (u.staff || []).some(p => String(effectiveUoa(p, u)) === String(code))
      ).map(u => u.slug);
      const nm = UOA_BY_CODE[code]?.name ? `UoA ${code} · ${UOA_BY_CODE[code].name}` : `UoA ${code}`;
      return { kind: "uoa", label: nm, noun: "UoA", slugs, name: `uoa-${code}` };
    }
  } else {
    const facSlug  = document.getElementById("faculty-select")?.value;
    const schSlug  = document.getElementById("school-select")?.value;
    const unitSlug = document.getElementById("unit-select")?.value;
    const aggregate = ["", "__all__", "__fac-all__", "all-staff"];
    // A single real unit is selected.
    if (unitSlug && !aggregate.includes(unitSlug)) {
      const u = UNITS.find(x => x.slug === unitSlug);
      if (u) return { kind: "unit", label: u.name, noun: "Unit", slugs: [u.slug], name: u.slug };
    }
    // A school within a faculty.
    if (schSlug && schSlug !== "__all__" && facSlug && facSlug !== "__all__") {
      const fac = FACULTIES.find(f => f.slug === facSlug);
      const sch = fac?.schools?.find(s => s.slug === schSlug);
      const slugs = activeUnits(u => u._facultySlug === facSlug && u._schoolSlug === schSlug).map(u => u.slug);
      return { kind: "school", label: sch?.name || schSlug, noun: "School", slugs, name: schSlug };
    }
    // A whole faculty.
    if (facSlug && facSlug !== "__all__") {
      const fac = FACULTIES.find(f => f.slug === facSlug);
      const slugs = activeUnits(u => u._facultySlug === facSlug).map(u => u.slug);
      return { kind: "faculty", label: fac?.name || facSlug, noun: "Faculty", slugs, name: facSlug };
    }
  }
  // Everything.
  const slugs = activeUnits(() => true).map(u => u.slug);
  return { kind: "all", label: "All units", noun: "All units", slugs, name: "all-units" };
}

// Download the current scope as a shareable bundle that round-trips via
// "Load unit file": a single .md for one unit, or a .zip of unit files
// for a school / faculty / all. These files re-import into another copy.
function exportScopeData() {
  const scope = currentScope();
  if (!scope.slugs.length) { alert("Nothing to export in the current view."); return; }
  if (scope.slugs.length === 1) {
    downloadUnitFile(scope.slugs[0]);   // single unit → its .md directly
    return;
  }
  const url = `/api/export-units.zip?slugs=${encodeURIComponent(scope.slugs.join(","))}`
            + `&name=${encodeURIComponent(scope.name)}`;
  const a = document.createElement("a");
  a.href = url; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

// Toolbar "New unit" — prompt for the unit's main info, build a Markdown unit
// file, POST it to the server, then reload so it appears in the pickers.
async function newUnitFlow() {
  const faculty = prompt("New unit — Faculty name:");
  if (!faculty || !faculty.trim()) return;
  const school = (prompt("School name (optional — leave blank for none):", "") || "").trim();
  const unitName = prompt("Unit name:");
  if (!unitName || !unitName.trim()) return;
  const uoaStr = (prompt("Default UoA code 1–34 (optional — leave blank):", "") || "").trim();
  const uoaNum = uoaStr ? parseInt(uoaStr, 10) : null;
  if (uoaStr && (!uoaNum || uoaNum < 1 || uoaNum > 34)) {
    alert(`"${uoaStr}" is not a UoA code between 1 and 34.`);
    return;
  }
  const slug = slugify(unitName);
  const univ = window.__UNIVERSITY__ || "University";
  let md = `University: ${univ}\nFaculty: ${faculty.trim()}\n`;
  if (school) md += `School: ${school}\n`;
  md += `Unit: ${unitName.trim()}\nSlug: ${slug}\n`;
  if (uoaNum) md += `UoA: ${uoaNum}\n`;
  md += `Active: yes\n\n`;   // no staff yet
  try {
    const r = await fetch("/api/unit-file", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: md,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "create failed");
    alert(`Created unit "${d.unit}". Reloading…`);
    location.reload();
  } catch (err) {
    alert("Could not create unit: " + err.message);
  }
}

// ── Copy role-summary card as PNG ────────────────────────────────────────
// Lazy-loads html2canvas from a CDN on first use. Tries the modern Clipboard
// API (image/png); if that fails (permission denied / older browser), falls
// back to triggering a PNG download.
let _html2canvasPromise = null;
function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (_html2canvasPromise) return _html2canvasPromise;
  _html2canvasPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error("Could not load html2canvas from CDN"));
    document.head.appendChild(s);
  });
  return _html2canvasPromise;
}

async function copyRoleCardToClipboard(cardEl, btn) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const h2c = await loadHtml2Canvas();
    const canvas = await h2c(cardEl, {
      backgroundColor: "#ffffff", scale: 2, useCORS: true, logging: false,
    });
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("Canvas → blob failed");
    let copied = false;
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copied = true;
      } catch (_) { /* fall through to download */ }
    }
    if (copied) {
      btn.textContent = "✓";
    } else {
      // Fallback: download the PNG
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const title = cardEl.querySelector(".role-title")?.textContent || "staff-by-role";
      a.href = url;
      a.download = title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      btn.textContent = "⤓";
    }
  } catch (err) {
    console.error("Copy card failed:", err);
    btn.textContent = "✕";
    btn.title = "Copy failed: " + (err.message || err);
  } finally {
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1400);
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".role-copy-btn");
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  const card = btn.closest(".role-summary");
  if (card) copyRoleCardToClipboard(card, btn);
});

// Per-card single-person retry. Clicked when a card shows "Scholar fetch
// failed" or "rate-limited" — re-fetches just that one ID (forced fresh)
// and re-renders all card slots sharing the ID.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".m-retry");
  if (!btn) return;
  e.stopPropagation();
  e.preventDefault();
  const id = btn.dataset.retryId;
  if (!id) return;
  const slots = [...document.querySelectorAll(`.card-metrics[data-id="${cssEscape(id)}"]`)];
  slots.forEach(s => { s.innerHTML = `<span class="m-load">retrying…</span>`; });
  try {
    const r = await fetch(`/api/scholar/${encodeURIComponent(id)}?refresh=1`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "fetch failed");
    clearStale(id);
    slots.forEach(s => renderCardMetrics(s, id, d));
  } catch (err) {
    const msg = String(err.message || err);
    markStale(id);
    slots.forEach(s => {
      s.innerHTML = `<span class="m-fail" title="${escapeAttr(msg)}">Retry failed <button class="m-retry" type="button" data-retry-id="${escapeAttr(id)}" title="Retry this person">↻</button></span>`;
    });
  }
});

// Download one unit's Markdown file from the server (the on-disk version).
function downloadUnitFile(slug) {
  const a = document.createElement("a");
  a.href = `/api/unit-file?slug=${encodeURIComponent(slug)}`;
  a.download = `${slug}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Load a unit Markdown file from disk: POST it to the server, which parses
// and writes it into data/. The dashboard then reloads to pick it up.
document.getElementById("data-load-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";   // reset so the same file can be re-picked later
  if (!file) return;
  const status = document.getElementById("data-status");
  status.textContent = `Loading ${file.name}…`;
  status.className = "data-status";
  try {
    const text = await file.text();
    // A bundle (UoA or Faculty, current or legacy format) is JSON with our
    // format marker; anything else is treated as a single unit Markdown file.
    let bundle = null;
    try {
      const j = JSON.parse(text);
      const fmt = j && j._meta && (j._meta.format || ""), kind = j && j._meta && (j._meta.kind || "");
      if (fmt === "scholar-dashboard-bundle" || fmt === "scholar-dashboard-uoa-bundle"
          || kind === "bundle" || kind === "uoa-bundle") bundle = j;
    } catch { /* not JSON → unit file */ }

    if (bundle) {
      // Detect a collision with data already loaded, and offer to overwrite
      // (clear the existing scope first) so a re-import leaves nothing stale.
      const scope = bundle.scope || {};
      let overwrite = false;
      let collides = false, what = "this bundle";
      if (scope.kind === "faculty" && scope.name) {
        collides = (FACULTIES || []).some(f => f.name === scope.name);
        what = `the faculty “${scope.name}”`;
      } else if (scope.kind === "uoa" && scope.code) {
        collides = (UNITS || []).some(u => !u.disabled &&
          (u.staff || []).some(p => String(effectiveUoa(p, u)) === String(scope.code)));
        what = `UoA ${scope.code}`;
      }
      if (collides) {
        overwrite = confirm(`${what} already exists in this copy.\n\n`
          + `OK = Overwrite: remove the existing ${scope.kind === "faculty" ? "units in that faculty" : "case studies for that UoA"} first, then import (no stray data).\n`
          + `Cancel = Merge: keep what's there and merge the bundle in.`);
      }
      status.textContent = `Importing${overwrite ? " (overwrite)" : ""}…`;
      const r = await fetch("/api/bundle-import" + (overwrite ? "?overwrite=1" : ""), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: text,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "bundle import failed");
      (d.warnings || []).forEach(w => console.warn("bundle import:", w));
      const s = d.summary || {};
      const label = d.kind === "uoa" ? `UoA ${(d.name || "").replace(/^UoA\s*/i, "")}`
                 : (d.name || "bundle");
      let msg = `Imported ${label}: ${s.units || 0} unit(s), ${s.scholars || 0} cached profile(s), `
              + `${s.case_studies || 0} case stud${(s.case_studies === 1) ? "y" : "ies"}`
              + `${s.removed ? `, ${s.removed} old item(s) removed` : ""}.`;
      if (d.warnings && d.warnings.length) msg += ` ⚠ ${d.warnings.length} warning(s) — see console.`;
      status.textContent = msg + " Reloading…";
      status.className = "data-status ok";
      setTimeout(() => location.reload(), 1200);
      return;
    }

    const r = await fetch("/api/unit-file", {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: text,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "load failed");
    (d.warnings || []).forEach(w => console.warn("unit-file load:", w));
    let msg = `Loaded "${d.unit}" — ${d.staff} staff.`;
    if (d.warnings && d.warnings.length) msg += ` ${d.warnings.length} line(s) skipped (see console).`;
    status.textContent = msg + " Reloading…";
    status.className = "data-status ok";
    setTimeout(() => location.reload(), 1000);
  } catch (err) {
    status.textContent = "Load failed: " + err.message;
    status.className = "data-status err";
  }
});

// Click on the data-modal backdrop (outside the white card) closes it.
// Same behaviour as the person-detail modal — see closeModal() above.
const dataModalEl = document.getElementById("data-modal");
dataModalEl?.addEventListener("click", (e) => {
  if (e.target === dataModalEl) dataModalEl.classList.add("hidden");
});
// Staff-detail modal: clicking its own backdrop closes it without touching
// the Data editor beneath.
const staffDetailModalEl = document.getElementById("staff-detail-modal");
staffDetailModalEl?.addEventListener("click", (e) => {
  if (e.target === staffDetailModalEl) closeStaffDetailModal();
});
// Escape closes whichever modal is on top. Staff-detail wins over Data
// modal so you don't accidentally lose your unsaved Data edits when
// dismissing the payload viewer.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (staffDetailModalEl && !staffDetailModalEl.classList.contains("hidden")) {
    closeStaffDetailModal();
    return;
  }
  dataModalEl?.classList.add("hidden");
});

// Global REF 2029 toggle in the toolbar — flips every set card together.
// State persists across reloads via localStorage so a switched-on REF view
// survives unit switches and refreshes.
function applyGlobalRefMode(on) {
  document.getElementById("tb-ref-all")?.classList.toggle("active", on);
  document.querySelectorAll(".person-card").forEach(card => setCardRefMode(card, on));
  localStorage.setItem("sd-ref-all", on ? "1" : "0");
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#tb-ref-all");
  if (!btn) return;
  applyGlobalRefMode(!btn.classList.contains("active"));
});

// Toolbar: spark scale mode toggle. "cohort" = every card shares one
// y-axis (productivity is comparable, but a 74k-cite outlier crushes
// everyone else); "per-card" = each card normalises to its own peak
// (shape is readable but cards aren't comparable). Persist across
// reloads. Re-call the card metrics renderer to redraw without a full
// page reload.
function applySparkMode(mode) {
  const norm = mode === "per-card" ? "per-card" : "cohort";
  localStorage.setItem("sd-spark-mode", norm);
  // Reflect the active button in the sort bar's Scale-by group.
  for (const btn of document.querySelectorAll(".scale-btn")) {
    btn.classList.toggle("active", btn.dataset.scale === norm);
  }
  // Redraw all currently-rendered sparklines from the in-memory METRICS
  // cache. No network round-trip.
  for (const slot of document.querySelectorAll(".card-metrics")) {
    const id = slot.dataset.id;
    const d = id && METRICS.get(id);
    if (d) renderCardMetrics(slot, id, d);
  }
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".scale-btn");
  if (!btn) return;
  applySparkMode(btn.dataset.scale);
});

// Toolbar: card font-size zoom. Persist between sessions so it sticks.
const ZOOM_STEPS = [0.75, 0.85, 0.95, 1.0, 1.1, 1.25, 1.4];
let zoomIdx = (() => {
  const saved = parseFloat(localStorage.getItem("sd-zoom"));
  const i = ZOOM_STEPS.indexOf(saved);
  return i >= 0 ? i : 3;     // 1.0
})();
function applyZoom() {
  document.documentElement.style.setProperty("--card-font-scale", ZOOM_STEPS[zoomIdx]);
  localStorage.setItem("sd-zoom", ZOOM_STEPS[zoomIdx]);
}
applyZoom();
const ZOOM_RESET_IDX = 3;   // the 1.0 step
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-zoom]");
  if (!btn) return;
  const dir = btn.dataset.zoom;
  if (dir === "+")      zoomIdx = Math.min(zoomIdx + 1, ZOOM_STEPS.length - 1);
  else if (dir === "-") zoomIdx = Math.max(zoomIdx - 1, 0);
  else                  zoomIdx = ZOOM_RESET_IDX;   // "0" = reset
  applyZoom();
});

// Toolbar: refresh-all button. Force-refreshes every set staff member's
// Scholar cache through a modal with progress + ETA + cancel. Cancelling
// drains the remaining queue without firing more requests so we don't make
// Scholar's rate-limit worse.
let _refreshAborted = false;

function fmtETA(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `~${Math.ceil(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `~${m} min ${s ? s + " s" : ""}`.trim();
}

function openRefreshModal(total) {
  _refreshAborted = false;
  const modal = document.getElementById("refresh-modal");
  document.getElementById("refresh-bar-fill").style.width = "0%";
  document.getElementById("refresh-count").textContent = `0 / ${total}`;
  document.getElementById("refresh-eta").textContent = "Starting…";
  const cancelBtn = document.getElementById("refresh-cancel");
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => {
    _refreshAborted = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelling…";
  };
  modal.classList.remove("hidden");
}

function updateRefreshModal(done, total, startedAt, lastStatus) {
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById("refresh-bar-fill").style.width = pct.toFixed(1) + "%";
  document.getElementById("refresh-count").textContent = `${done} / ${total}`;
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(elapsed, 0.001);
  const remaining = (total - done) / Math.max(rate, 0.001);
  const eta = fmtETA(remaining);
  document.getElementById("refresh-eta").textContent =
    (lastStatus ? lastStatus + " · " : "") + (eta ? `ETA ${eta}` : "");
}

function closeRefreshModal() {
  document.getElementById("refresh-modal").classList.add("hidden");
}

// Force-refresh every set staff member in the current scope. Bound to the
// per-scope ↻ Refresh buttons that sit beside the staff count in both the
// Faculty and UoA pickers.
async function runScopeRefresh() {
  const ids = STAFF.filter(p => p.scholar_id && (p.scholar_status || "set") === "set")
                   .map(p => p.scholar_id);
  if (!ids.length) return;
  if (!confirm(`Force-refresh ${ids.length} Scholar profiles?\n\nThis hits Google Scholar once per person and takes roughly ${Math.ceil(ids.length * 0.6 / 2)}s at the polite throttle.`)) return;

  openRefreshModal(ids.length);
  const startedAt = Date.now();
  let done = 0;
  let lastStatus = "";
  const q = ids.slice();
  // 2 workers × 600ms — same polite throttle as card hydration on misses.
  await Promise.all(Array.from({length: 2}, async () => {
    while (q.length) {
      if (_refreshAborted) return;
      const id = q.shift();
      try {
        const r = await fetch(`/api/scholar/${encodeURIComponent(id)}?refresh=1`);
        if (r.status === 429) {
          // Scholar (or our cooldown) is rate-limiting — stop hammering.
          _refreshAborted = true;
          lastStatus = "Scholar rate-limited — stopped";
          updateRefreshModal(done, ids.length, startedAt, lastStatus);
          return;
        }
        if (r.ok) clearStale(id);
      } catch { /* network blip; continue */ }
      done++;
      updateRefreshModal(done, ids.length, startedAt, lastStatus);
      // Polite gap between worker requests.
      await new Promise(rs => setTimeout(rs, 600));
    }
  }));

  // Wrap up. If aborted, leave the modal open briefly with the final state.
  if (_refreshAborted) {
    document.getElementById("refresh-eta").textContent = lastStatus || "Cancelled";
    document.getElementById("refresh-cancel").textContent = "Close";
    document.getElementById("refresh-cancel").disabled = false;
    document.getElementById("refresh-cancel").onclick = closeRefreshModal;
    return;
  }
  document.getElementById("refresh-eta").textContent = "Done — reloading…";
  setTimeout(() => location.reload(), 600);
}
// Refresh lives in the Data menu and refreshes the current view's scope.
document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-refresh")) runScopeRefresh();
});

async function loadStaff() {
  // Try Flask backend first; fall back to static staff.json (preview mode).
  // Use `cache: 'no-store'` so a staff.json save (e.g. someone setting a unit
  // UoA via the Data editor) is picked up on the next reload, not served from
  // browser cache. Was previously biting us during dev: the in-memory UNITS
  // array was missing fields the API now returned.
  // Load REF flags + the configured REF year/window in parallel with the
  // staff payload so per-card chips and labels are correct on first paint.
  loadRefFlags();
  loadRefConfig();
  let data;
  try {
    const r = await fetch("/api/staff", { cache: "no-store" });
    if (!r.ok) throw new Error("no backend");
    data = await r.json();
  } catch {
    const r = await fetch("staff.json", { cache: "no-store" });
    data = await r.json();
    window.__STATIC_MODE__ = true;
  }
  // Stash the university name (used when creating a new unit file).
  window.__UNIVERSITY__ = data.university || "University";
  // Pull the live app version from the backend and update the toolbar.
  fetch("/api/version").then(r => r.ok ? r.json() : null).then(v => {
    if (v?.version) {
      const el = document.getElementById("tb-version");
      if (el) el.textContent = `v${v.version}`;
    }
  }).catch(() => {});
  // Surface any data-file parse warnings to the console for visibility.
  if (Array.isArray(data._parse_warnings) && data._parse_warnings.length) {
    console.warn(`Scholar Dashboard: ${data._parse_warnings.length} data-file parse warning(s):`);
    data._parse_warnings.forEach(w => console.warn("  " + w));
  }

  // Three shapes supported, in order of preference:
  //   - new {faculties: [{name, units: [...]}, ...]}
  //   - {units: [...]}
  //   - legacy {staff: [...]}
  FACULTIES = [];
  if (Array.isArray(data.faculties) && data.faculties.length) {
    FACULTIES = data.faculties.slice();
  } else if (Array.isArray(data.units) && data.units.length) {
    FACULTIES = [{ slug: "default", name: data.faculty || "Faculty",
                   school: data.school || "", units: data.units }];
  } else {
    FACULTIES = [{ slug: "default", name: data.unit || "Faculty", school: "",
                   units: [{ slug: "default", name: data.unit || "Unit", staff: data.staff || [] }] }];
  }
  // Flatten units across the optional faculty→school→unit hierarchy. Each unit
  // gets _faculty / _facultySlug / _school / _schoolSlug stamped on it so the
  // dropdown, breadcrumb, and analytics can refer back to its place in the tree.
  UNITS = [];
  for (const f of FACULTIES) {
    const facBase = { _faculty: f.name, _facultySlug: f.slug };
    // Schools layer (new shape)
    for (const sch of (f.schools || [])) {
      for (const u of (sch.units || [])) {
        UNITS.push({ ...u, ...facBase, _school: sch.name, _schoolSlug: sch.slug });
      }
    }
    // Legacy: faculty with units directly (no schools)
    for (const u of (f.units || [])) {
      UNITS.push({ ...u, ...facBase, _school: null, _schoolSlug: null });
    }
  }
  UNITS.sort((a, b) => a.name.localeCompare(b.name));

  // Synthesise an "All staff" view at the top of the dropdown: every person
  // across every active unit, deduped by staff_id. Units with `disabled: true`
  // are skipped — useful for joint-venture units that sit awkwardly inside
  // the faculty hierarchy.
  if (UNITS.length > 1) {
    const seen = new Map();
    for (const u of UNITS) {
      if (u.disabled) continue;
      for (const p of u.staff) {
        const key = p.staff_id || p.name;
        if (!seen.has(key)) {
          // Stamp the person's effective UoA on the synthetic record so
          // renderPeople can show a UoA chip without walking back to find
          // the parent unit. Person override (p.uoa) wins over unit default.
          seen.set(key, { ...p, units: [u.name], _effective_uoa: effectiveUoa(p, u) });
        } else {
          seen.get(key).units.push(u.name);
        }
      }
    }
    const allUnit = {
      slug: "all-staff",
      name: "All staff",
      source: "synthetic — aggregated from all units",
      staff: [...seen.values()],
      _faculty: "All",
      _facultySlug: "all",
    };
    UNITS.unshift(allUnit);
  }

  // Populate the Faculty dropdown (with an "All faculties" entry on top).
  const facSel = document.getElementById("faculty-select");
  facSel.innerHTML =
    `<option value="__all__">All faculties</option>` +
    FACULTIES.map(f =>
      `<option value="${escapeAttr(f.slug)}">${escapeHTML(f.name)}</option>`
    ).join("");

  // School + Unit dropdowns. The school selector shows up only when the chosen
  // faculty actually has schools; the unit dropdown narrows accordingly.
  const schoolSel = document.getElementById("school-select");
  const sel = document.getElementById("unit-select");
  const formatOpt = (u) => {
    const tag = u.disabled ? " · inactive" : "";
    return `<option value="${escapeAttr(u.slug)}">${escapeHTML(u.name)} (${u.staff.length})${tag}</option>`;
  };
  function renderSchoolOptions(facultySlug) {
    const fac = FACULTIES.find(f => f.slug === facultySlug);
    const schools = fac?.schools || [];
    const schoolRow = document.querySelectorAll(".school-row");
    if (facultySlug === "__all__" || !schools.length) {
      schoolRow.forEach(el => el.style.display = "none");
      schoolSel.innerHTML = `<option value="__all__">All schools</option>`;
      return;
    }
    schoolRow.forEach(el => el.style.display = "");
    schoolSel.innerHTML =
      `<option value="__all__">All schools</option>` +
      schools.map(s => `<option value="${escapeAttr(s.slug)}">${escapeHTML(s.name)}</option>`).join("");
  }
  function renderUnitOptions(facultySlug, schoolSlug) {
    let opts = "";
    const allUnit = UNITS.find(u => u.slug === "all-staff");
    if (allUnit && facultySlug === "__all__") {
      opts += `<option value="all-staff">${escapeHTML(allUnit.name)} (${allUnit.staff.length})</option>`;
    }
    // When a specific faculty is chosen, surface an aggregate "All units in
    // {faculty}" option so the user can see every staff member in that
    // faculty without dropping all the way down to a single unit.
    if (facultySlug !== "__all__") {
      const facUnits = UNITS.filter(u =>
        u._facultySlug === facultySlug && !u.disabled && u.slug !== "all-staff"
        && (!schoolSlug || schoolSlug === "__all__" || u._schoolSlug === schoolSlug)
      );
      const total = facUnits.reduce((n, u) => n + (u.staff?.length || 0), 0);
      const fac = FACULTIES.find(f => f.slug === facultySlug);
      const label = (schoolSlug && schoolSlug !== "__all__")
        ? `All units in this school`
        : `All units in ${fac?.name || "faculty"}`;
      if (total > 0) {
        opts += `<option value="__fac-all__">${escapeHTML(label)} (${total})</option>`;
      }
    }
    if (facultySlug === "__all__") {
      // Cross-faculty: group by faculty with optgroups.
      for (const f of FACULTIES) {
        const facUnits = UNITS.filter(u => u._facultySlug === f.slug)
                              .sort((a, b) => a.name.localeCompare(b.name));
        if (!facUnits.length) continue;
        opts += FACULTIES.length > 1 ? `<optgroup label="${escapeAttr(f.name)}">` : ``;
        opts += facUnits.map(formatOpt).join("");
        opts += FACULTIES.length > 1 ? `</optgroup>` : ``;
      }
    } else if (schoolSlug && schoolSlug !== "__all__") {
      // Specific school within a faculty
      const us = UNITS.filter(u => u._facultySlug === facultySlug && u._schoolSlug === schoolSlug)
                      .sort((a, b) => a.name.localeCompare(b.name));
      opts += us.map(formatOpt).join("");
    } else {
      // Whole faculty — if it has schools, optgroup by school
      const fac = FACULTIES.find(f => f.slug === facultySlug);
      const schools = fac?.schools || [];
      if (schools.length > 1) {
        for (const sch of schools) {
          const us = UNITS.filter(u => u._facultySlug === facultySlug && u._schoolSlug === sch.slug)
                          .sort((a, b) => a.name.localeCompare(b.name));
          if (!us.length) continue;
          opts += `<optgroup label="${escapeAttr(sch.name)}">${us.map(formatOpt).join("")}</optgroup>`;
        }
      } else {
        const us = UNITS.filter(u => u._facultySlug === facultySlug)
                        .sort((a, b) => a.name.localeCompare(b.name));
        opts += us.map(formatOpt).join("");
      }
    }
    sel.innerHTML = opts;
  }

  // Restore last-selected faculty + school + unit.
  const savedFaculty = localStorage.getItem("sd-faculty") || "__all__";
  const savedSchool  = localStorage.getItem("sd-school")  || "__all__";
  const savedUnit    = localStorage.getItem("sd-unit");
  facSel.value = [...facSel.options].some(o => o.value === savedFaculty) ? savedFaculty : "__all__";
  renderSchoolOptions(facSel.value);
  schoolSel.value = [...schoolSel.options].some(o => o.value === savedSchool) ? savedSchool : "__all__";
  renderUnitOptions(facSel.value, schoolSel.value);
  const optionMatches = [...sel.options].some(o => o.value === savedUnit);
  const initialUnit = optionMatches ? savedUnit : (sel.options[0]?.value || UNITS[0]?.slug);
  sel.value = initialUnit;

  facSel.addEventListener("change", () => {
    localStorage.setItem("sd-faculty", facSel.value);
    localStorage.setItem("sd-school", "__all__");
    renderSchoolOptions(facSel.value);
    schoolSel.value = "__all__";
    renderUnitOptions(facSel.value, "__all__");
    const firstUnit = sel.options[0]?.value;
    if (firstUnit) { sel.value = firstUnit; selectUnit(firstUnit); }
  });
  schoolSel.addEventListener("change", () => {
    localStorage.setItem("sd-school", schoolSel.value);
    renderUnitOptions(facSel.value, schoolSel.value);
    const firstUnit = sel.options[0]?.value;
    if (firstUnit) { sel.value = firstUnit; selectUnit(firstUnit); }
  });
  sel.addEventListener("change", () => selectUnit(sel.value));

  // ────────────────────────────────────────────────────────────────────────
  // By-UoA picker. Populated with every UoA that has at least one staff
  // member (effective UoA = person.uoa ?? unit.uoa). Empty UoAs are hidden
  // to keep the dropdown short. If no UoAs are set anywhere yet, the picker
  // still renders but shows a hint.
  const uoaSel = document.getElementById("uoa-select");
  function renderUoaOptions() {
    const byUoa = new Map();
    for (const u of UNITS) {
      if (u.disabled || u.slug === "all-staff") continue;
      for (const p of (u.staff || [])) {
        const code = effectiveUoa(p, u);
        if (code == null) continue;
        if (!byUoa.has(code)) byUoa.set(code, 0);
        byUoa.set(code, byUoa.get(code) + 1);
      }
    }
    const codes = [...byUoa.keys()].sort((a, b) => a - b);
    if (!codes.length) {
      uoaSel.innerHTML = `<option value="">— no UoAs tagged yet —</option>`;
      return;
    }
    uoaSel.innerHTML = codes.map(c => {
      const u = UOA_BY_CODE[c];
      const label = u ? `UoA ${c} · ${u.name}` : `UoA ${c}`;
      return `<option value="${c}">${escapeHTML(label)} (${byUoa.get(c)})</option>`;
    }).join("");
  }
  renderUoaOptions();
  const savedUoa = localStorage.getItem("sd-uoa");
  if (savedUoa && [...uoaSel.options].some(o => o.value === savedUoa)) {
    uoaSel.value = savedUoa;
  }
  uoaSel.addEventListener("change", () => {
    localStorage.setItem("sd-uoa", uoaSel.value);
    selectUoa(uoaSel.value);
  });

  // View-tab click handlers. Swap which picker is visible and which selection
  // drives the staff grid.
  document.querySelectorAll(".view-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.view;
      if (mode === VIEW_MODE) return;
      VIEW_MODE = mode;
      localStorage.setItem("sd-view-mode", mode);
      applyViewMode();
    });
  });

  applyViewMode(initialUnit);
  // Reflect any persisted exclusion toggles in the sort-bar pill.
  updateExcludedPill();
}

// Toggle which picker is visible (Faculty triple vs UoA single) and re-render
// the staff grid based on the active mode. `initialUnit` is only used on
// first call from loadStaff() — subsequent calls re-use stored selections.
function applyViewMode(initialUnit) {
  document.querySelectorAll(".view-tab").forEach(t => {
    const active = t.dataset.view === VIEW_MODE;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  const facPicker = document.querySelector(".view-faculty-picker");
  const uoaPicker = document.querySelector(".view-uoa-picker");
  if (VIEW_MODE === "uoa") {
    facPicker.classList.add("hidden");
    uoaPicker.classList.remove("hidden");
    const uoaSel = document.getElementById("uoa-select");
    const code = uoaSel.value || uoaSel.options[0]?.value || "";
    if (code) { uoaSel.value = code; selectUoa(code); }
    else { STAFF = []; renderPeople(); document.getElementById("uoa-count").textContent = 0; }
  } else {
    facPicker.classList.remove("hidden");
    uoaPicker.classList.add("hidden");
    const sel = document.getElementById("unit-select");
    const slug = initialUnit || sel.value;
    if (slug) selectUnit(slug);
  }
  applyFileMenuLabels();
}

// The File menu is mode-aware. In UoA mode we only deal in bundles (that's
// the shape of the material). In Faculty mode you can save a single unit or a
// whole-faculty bundle, and Load takes a unit file or any bundle.
function applyFileMenuLabels() {
  const uoa = VIEW_MODE === "uoa";
  const set = (id, label, hint) => {
    const el = document.getElementById(id);
    if (!el) return;
    const l = el.querySelector(".tb-mi-label"), h = el.querySelector(".tb-mi-hint");
    if (l) l.textContent = label;
    if (h) h.textContent = hint;
  };
  set("tb-load-unit", "Load…",
      uoa ? "Import a complete UoA or Faculty bundle"
          : "Import a unit Markdown file or a complete bundle");
  set("tb-save-unit", uoa ? "Save UoA…" : "Save current unit…",
      uoa ? "Download the whole UoA as one bundle (units, pubs, case studies)"
          : "Download this unit as Markdown");
  // Faculty bundle save is meaningless in UoA mode (the UoA bundle covers it).
  const fac = document.getElementById("tb-save-faculty");
  if (fac) fac.hidden = uoa;
  // The REF menu (window highlight, selection/UoA reports, targets) only makes
  // sense in the By-UoA view, so hide it elsewhere.
  const refMenu = document.querySelector('.tb-menu[data-menu="ref"]');
  if (refMenu) refMenu.hidden = !uoa;
}

// Render the staff grid filtered to a single UoA code. Synthesises a unit-
// like view so the rest of the rendering pipeline (cards, hydration, sort,
// REF toggle) needs no changes. Each card carries a unit tag showing its
// home unit so the cross-unit aggregation is legible.
function selectUoa(codeRaw) {
  const code = parseInt(codeRaw, 10);
  if (!code) { STAFF = []; renderPeople(); return; }
  const u = UOA_BY_CODE[code];
  const name = u ? `UoA ${code} · ${u.name}` : `UoA ${code}`;
  const staff = [];
  for (const unit of UNITS) {
    if (unit.disabled || unit.slug === "all-staff") continue;
    for (const p of (unit.staff || [])) {
      if (effectiveUoa(p, unit) === code) {
        // Stamp the home unit on the synthetic card so the existing
        // unit-tag rendering path can show it. Also stamp effective UoA
        // for the UoA chip on the card.
        staff.push({ ...p, units: [unit.name], _effective_uoa: code });
      }
    }
  }
  CURRENT_UNIT = { slug: "all-staff", name, staff };  // reuse all-staff path so unit-tag shows
  STAFF = staff;
  document.getElementById("uoa-count").textContent = staff.length;
  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = name;
  document.title = `${name} — Scholar Dashboard`;
  // Keep whatever sort the user picked — persist across unit switches.
  document.querySelectorAll(".sort-btn").forEach(b => b.classList.toggle("active", b.dataset.sort === currentSort));
  updateOverviewBtnState();
  renderPeople();
}

function selectUnit(slug) {
  let unit;
  // Handle the synthetic "All units in {faculty}" / "All units in this school"
  // option. Reads the current faculty + school selectors so the aggregation
  // respects whatever scope the user has narrowed to.
  if (slug === "__fac-all__") {
    const facSlug = document.getElementById("faculty-select")?.value;
    const schSlug = document.getElementById("school-select")?.value;
    const fac = FACULTIES.find(f => f.slug === facSlug);
    const scope = UNITS.filter(u =>
      u._facultySlug === facSlug && !u.disabled && u.slug !== "all-staff"
      && (!schSlug || schSlug === "__all__" || u._schoolSlug === schSlug)
    );
    const seen = new Map();
    for (const u of scope) {
      for (const p of (u.staff || [])) {
        const key = p.staff_id || p.name;
        if (!seen.has(key)) {
          seen.set(key, { ...p, units: [u.name], _effective_uoa: effectiveUoa(p, u) });
        } else {
          seen.get(key).units.push(u.name);
        }
      }
    }
    let label;
    if (schSlug && schSlug !== "__all__") {
      const sch = fac?.schools?.find(s => s.slug === schSlug);
      label = `${sch?.name || "School"}: All units in this school`;
    } else {
      label = `${fac?.name || "Faculty"}: All units`;
    }
    unit = { slug: "all-staff", name: label, staff: [...seen.values()] };
  } else {
    unit = UNITS.find(u => u.slug === slug);
  }
  if (!unit) return;
  CURRENT_UNIT = unit;
  STAFF = unit.staff;
  localStorage.setItem("sd-unit", slug);
  unitCount.textContent = STAFF.length;
  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = unit.name;
  document.title = `${unit.name} — Scholar Dashboard`;
  // Update the breadcrumb to reflect the current faculty + school
  const fac = FACULTIES.find(f => f.slug === unit._facultySlug);
  const crumbFaculty = document.querySelector(".crumb .faculty");
  const crumbSchool  = document.querySelector(".crumb .school");
  if (fac && crumbFaculty) crumbFaculty.textContent = "Faculty of " + fac.name;
  if (fac && crumbSchool)  crumbSchool.textContent  = fac.school || "";
  // Persist the chosen sort across unit switches (was previously reset to "name").
  document.querySelectorAll(".sort-btn").forEach(b => b.classList.toggle("active", b.dataset.sort === currentSort));
  updateOverviewBtnState();
  renderPeople();
}

function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;"); }

function renderPeople() {
  grid.innerHTML = "";
  // Impact-case-studies panel (By UoA view only; no-ops otherwise).
  renderCaseStudies();
  // ── Overview-by-unit mode: one Staff-by-role card per unit in the current
  // school/faculty scope, no individual people cards. Useful for getting a
  // top-down picture of an aggregate view.
  if (currentSort === "overview") {
    const facSlug = document.getElementById("faculty-select")?.value;
    const schSlug = document.getElementById("school-select")?.value;
    const scope = UNITS.filter(u =>
      !u.disabled && u.slug !== "all-staff"
      && (!facSlug || facSlug === "__all__" || u._facultySlug === facSlug)
      && (!schSlug || schSlug === "__all__" || u._schoolSlug === schSlug)
    ).sort((a, b) => a.name.localeCompare(b.name));
    const visN = scope.reduce((n, u) => n + (u.staff || []).filter(p => !(excludeEmeritus() && isEmeritus(p)) && !(excludeVisiting() && isVisiting(p))).length, 0);
    document.getElementById("unit-count").textContent = visN;
    const uoaC = document.getElementById("uoa-count");
    if (uoaC) uoaC.textContent = visN;
    for (const u of scope) {
      const staff = (u.staff || []).filter(p => !(excludeEmeritus() && isEmeritus(p)) && !(excludeVisiting() && isVisiting(p)));
      // Temporarily swap CURRENT_UNIT so effectiveUoa() resolves correctly
      // for staff in this unit (no override → unit default).
      const saved = CURRENT_UNIT;
      CURRENT_UNIT = u;
      grid.appendChild(buildRoleSummary(staff, u.name));
      CURRENT_UNIT = saved;
    }
    if (!scope.length) {
      grid.innerHTML = `<p class="overview-empty">No units in the current scope.</p>`;
    }
    return;   // skip hydrateCardMetrics — overview mode has no person cards
  }
  // Always render in the active sort order — defaults to surname (Name).
  // This means switching unit reliably gives a surname-ordered grid.
  // Apply the "hide emeritus" toggle before sorting so the role chart and
  // staff-count chip match what's actually rendered.
  const vis = visibleStaff();
  const ordered = sortStaff(vis, currentSort);
  // Reflect the visible count in whichever picker's count chip is showing.
  const uc = document.getElementById("unit-count");
  if (uc) uc.textContent = vis.length;
  const uoaC = document.getElementById("uoa-count");
  if (uoaC) uoaC.textContent = vis.length;
  // "Stack by role" mode — prepend a role-distribution chart and group cards
  // by role with section headings between bucket transitions.
  const isRoleMode = currentSort === "role";
  const roleCounts = {};
  if (isRoleMode) {
    grid.appendChild(buildRoleSummary(vis));
    for (const p of ordered) {
      const k = classifyRole(p.title);
      roleCounts[k] = (roleCounts[k] || 0) + 1;
    }
  }
  let lastBucket = null;
  for (const p of ordered) {
    if (isRoleMode) {
      const bucket = classifyRole(p.title);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        grid.appendChild(buildRoleSectionHead(bucket, roleCounts[bucket]));
      }
    }
    const btn = document.createElement("button");
    const status = p.scholar_status || (p.scholar_id ? "set" : "unchecked");
    const isStale = !!(p.scholar_id && STALE_IDS.has(p.scholar_id));
    btn.className = "person-card"
      + (status === "missing" ? " is-missing" : "")
      + (isStale ? " is-stale" : "");
    btn.dataset.name = p.name;
    // No badge for "set" — the metrics chips and sparkline already say it.
    const badgeMap = {
      set:       ``,
      missing:   `<span class="badge missing">Missing on Google Scholar</span>`,
      unchecked: `<span class="badge needs">needs check</span>`,
    };
    const badge = badgeMap[status] ?? badgeMap.unchecked;
    const metricsSlot = (status === "set")
      ? `<span class="card-metrics" data-id="${escapeHTML(p.scholar_id)}"><span class="m-load">loading…</span></span>`
      : ``;
    // When viewing the synthetic "All staff" unit, label each card with the
    // person's home unit(s) so it's clear where they sit.
    const unitTag = (CURRENT_UNIT?.slug === "all-staff" && p.units?.length)
      ? `<span class="unit-tag">${escapeHTML(p.units.join(" · "))}</span>`
      : ``;
    // Effective UoA chip. Always rendered (even as "No UoA") so the chip
    // doubles as a one-click control to add/remove the person's UoA.
    // Note: _effective_uoa stamped during synthesis can be null when a
    // person was explicitly removed (sentinel uoa: 0). Treat both null and
    // undefined as "no UoA".
    const uoaCode = (p._effective_uoa !== undefined)
      ? p._effective_uoa
      : effectiveUoa(p, CURRENT_UNIT);
    const uoaTag = uoaCode
      ? `<span class="uoa-tag" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="${uoaCode}" title="Click to remove from UoA ${uoaCode}">UoA ${uoaCode}</span>`
      : `<span class="uoa-tag is-none" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="0" title="Click to assign a UoA">No UoA</span>`;
    // Top-right REF 2029 toggle chip — only for cards with Scholar data.
    const refChip = (status === "set")
      ? `<button class="ref-chip" type="button" data-ref-toggle title="Toggle REF ${REF_YEAR} publication window (${REF_START_YEAR}–${REF_END_YEAR})">REF ${REF_YEAR}</button>`
      : ``;
    // REF-flag count chip — shows N publications ticked for REF
    // submission. Click-through to the modal where the ticking happens.
    const refCount = (status === "set" && p.scholar_id) ? refFlagCount(p.scholar_id) : 0;
    const refCountChip = (status === "set" && p.scholar_id)
      ? `<span class="ref-count-chip${refCount === 0 ? " is-zero" : ""}" data-ref-chip-id="${escapeAttr(p.scholar_id)}" title="${refCount} publication${refCount === 1 ? "" : "s"} flagged for REF ${REF_YEAR}. Open the card to tick more.">REF: ${refCount}</span>`
      : ``;
    // Stack REF toggle + REF count + UoA chip in the top-right corner.
    const cornerChips = (refChip || refCountChip || uoaTag)
      ? `<span class="card-corner">${refChip}${refCountChip}${uoaTag}</span>`
      : ``;
    const staleTip = isStale ? staleDotTitle(p.scholar_id) : "";
    btn.innerHTML = `
      ${cornerChips}
      <span class="name">${escapeHTML(p.name)}${isStale ? `<span class="stale-dot" title="${escapeAttr(staleTip)}"></span>` : ""}</span>
      <span class="title" title="${escapeAttr(p.title || "")}">${escapeHTML(p.title)}</span>
      ${unitTag}
      ${metricsSlot}
      ${badge}
    `;
    btn.addEventListener("click", () => openPerson(p));
    grid.appendChild(btn);
  }
  hydrateCardMetrics();
}

// ────────────────────────────────────────────────────────────────────────
// Card-level UoA editing. Clicking a UoA chip on a card prompts removal;
// clicking a "No UoA" chip opens an inline picker. Mutates the in-memory
// FACULTIES tree by staff_id, then POSTs the whole tree to /api/staff.
// We update *every* occurrence of the person across units (cross-listed
// staff share a staff_id), since "this person is in UoA N" is a fact
// about the person, not about each unit-membership row.
function setPersonUoaEverywhere(staffId, newCode) {
  if (!staffId) return 0;
  let touched = 0;
  const apply = (p) => {
    if (newCode === undefined || newCode === null) delete p.uoa;
    else p.uoa = newCode;
    touched++;
  };
  for (const f of FACULTIES) {
    for (const sch of (f.schools || [])) {
      for (const u of (sch.units || [])) {
        for (const p of (u.staff || [])) {
          if (p.staff_id === staffId) apply(p);
        }
      }
    }
    for (const u of (f.units || [])) {
      for (const p of (u.staff || [])) {
        if (p.staff_id === staffId) apply(p);
      }
    }
  }
  return touched;
}

async function savePersonUoa(staffId, name, newCode) {
  if (!staffId) {
    alert(`Cannot update "${name}" — no staff_id on this record. Add one in the Data editor first.`);
    return false;
  }
  const touched = setPersonUoaEverywhere(staffId, newCode);
  if (!touched) {
    alert(`Could not find "${name}" (staff_id ${staffId}) in the staff tree.`);
    return false;
  }
  try {
    const r = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faculties: FACULTIES }),
    });
    if (!r.ok) throw new Error("save failed: " + r.status);
  } catch (e) {
    alert("Save failed: " + e.message);
    return false;
  }
  // Reflect in any synthetic copies in STAFF too, so re-render picks it up
  // without a full reload.
  for (const sp of STAFF) {
    if (sp.staff_id === staffId) {
      if (newCode === undefined || newCode === null) delete sp.uoa;
      else sp.uoa = newCode;
      // _effective_uoa was stamped at synthesis; update to match.
      sp._effective_uoa = (newCode && newCode !== 0) ? newCode : null;
    }
  }
  return true;
}

// UoA picker — a small centred modal overlay (not anchored to the card, so
// it never bleeds over neighbouring cards in the grid). Lists "No UoA" first,
// then all 34 UoAs; the person's current selection is highlighted.
function openUoaPicker(chip, p, currentCode) {
  document.querySelector(".uoa-picker-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "uoa-picker-overlay";
  const cur = currentCode || 0;   // 0 == No UoA
  const optHTML = (code, label, extraCls) => {
    const sel = (code === cur) ? " is-current" : "";
    return `<button type="button" class="uoa-picker-opt${extraCls || ""}${sel}" data-code="${code}">${label}${sel ? ` <span class="uoa-cur-mark">current</span>` : ""}</button>`;
  };
  overlay.innerHTML = `
    <div class="uoa-picker" role="dialog" aria-label="Set UoA">
      <div class="uoa-picker-head">Set UoA for ${escapeHTML(p.name)}</div>
      <div class="uoa-picker-list">
        ${optHTML(0, "No UoA — remove from any UoA", " uoa-picker-none")}
        ${REF_UOAS.map(u => optHTML(u.code, `UoA ${u.code} · ${escapeHTML(u.name)}`)).join("")}
      </div>
      <button type="button" class="uoa-picker-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector(".uoa-picker-cancel").onclick = (ev) => { ev.stopPropagation(); close(); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  // Scroll the current option into view so the user lands on it.
  overlay.querySelector(".uoa-picker-opt.is-current")?.scrollIntoView({ block: "center" });
  overlay.querySelectorAll(".uoa-picker-opt").forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const code = parseInt(btn.dataset.code, 10);   // 0 == No UoA
      close();
      if (code === cur) return;   // no change
      const ok = await savePersonUoa(p.staff_id, p.name, code);
      if (ok) renderPeople();
    };
  });
}

// Global handler: catch clicks on any .uoa-tag chip on a person card.
// Always opens the picker (with the current selection highlighted) — one
// consistent interaction for both assigning and removing.
document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-uoa-chip]");
  if (!chip) return;
  // Stop the card's openPerson handler from firing.
  e.stopPropagation();
  e.preventDefault();
  const staffId = chip.dataset.staffid;
  const name = chip.dataset.name;
  const current = parseInt(chip.dataset.current, 10) || 0;
  const p = STAFF.find(sp => (sp.staff_id && sp.staff_id === staffId) || sp.name === name) || { name, staff_id: staffId };
  openUoaPicker(chip, p, current);
}, true);

// Render a single card's metrics from a Scholar payload. Pulled out so
// both the batch path and the per-id fallback can share the rendering.
function renderCardMetrics(slot, id, d) {
  METRICS.set(id, {
    citedby: d.citedby, hindex: d.hindex, hindex5y: d.hindex5y,
    i10index: d.i10index, citedby5y: d.citedby5y,
    cites_per_year: d.cites_per_year,
    ref_eligible_count: d.ref_eligible_count,
    fetched_iso: d._fetched_iso,
  });
  const pair = (all, recent, label) => `
    <span class="m">
      <span class="mv">${fmt(all)}</span>
      <span class="mv-r" title="Since 5 years ago">${fmt(recent)}</span>
      <span class="mk">${label}</span>
    </span>`;
  slot.innerHTML = `
    ${pair(d.citedby,  d.citedby5y,  "cites")}
    ${pair(d.hindex,   d.hindex5y,   "h-idx")}
    ${pair(d.i10index, d.i10index5y, "i10")}
    ${miniSparkline(d.cites_per_year)}
  `;
  const card = slot.closest(".person-card");
  card?.querySelector(".recent-pubs-mini")?.remove();
  const recent = (d.recent_publications || []).slice(0, 2);
  if (recent.length) {
    const currentYear = (new Date()).getFullYear();
    const recentEl = document.createElement("span");
    recentEl.className = "recent-pubs-mini";
    recentEl.innerHTML = recent.map(pub => {
      const y = pub.year;
      const isFuture = y && y > currentYear;
      const cls = "rp" + (isFuture ? " rp-future" : "");
      return `
        <span class="${cls}" title="${isFuture ? 'Forthcoming / not yet published' : ''}">
          <span class="rp-y">${escapeHTML(String(y || "n.d."))}</span>
          <span class="rp-t">${escapeHTML(pub.title || "Untitled")}</span>
        </span>`;
    }).join("");
    slot.insertAdjacentElement("afterend", recentEl);
  }
}

async function hydrateCardMetrics() {
  if (window.__STATIC_MODE__) return;  // no backend → skip
  const slots = [...document.querySelectorAll(".card-metrics")];
  if (!slots.length) return;
  const slotsById = new Map();
  for (const s of slots) {
    const id = s.dataset.id;
    if (!id) continue;
    if (!slotsById.has(id)) slotsById.set(id, []);
    slotsById.get(id).push(s);
  }
  const ids = [...slotsById.keys()];

  // 1. Batch cache hit in one round-trip. Anything missing falls back to
  //    individual fetches below.
  let batch = {};
  try {
    const r = await fetch("/api/scholar-batch?ids=" + encodeURIComponent(ids.join(",")));
    if (r.ok) batch = await r.json();
  } catch { /* fall through — individual fetches will handle it */ }

  // Set the shared sparkline y-axis from the batch BEFORE rendering any
  // card, so all bars on the page are drawn at the same scale.
  computeGlobalMiniSparkMax(batch);

  const misses = [];
  for (const id of ids) {
    const entry = batch[id];
    if (entry && !entry.error) {
      slotsById.get(id).forEach(slot => renderCardMetrics(slot, id, entry));
    } else {
      misses.push(id);
    }
  }
  if (!misses.length) {
    // All from cache — re-apply sort/REF state and return.
    if (currentSort !== "name") applySort(currentSort);
    if (localStorage.getItem("sd-ref-all") === "1") applyGlobalRefMode(true);
    return;
  }

  // 2. Cache misses → hit /api/scholar/<id> individually, throttled.
  //    These will rescrape Scholar, so keep the polite 2-worker + 600ms
  //    backoff. Once Scholar 429s, drain the rest into a friendly message.
  const queue = misses.slice();
  let scholarBlocked = false;
  const workers = Array.from({length: 2}, async () => {
    while (queue.length) {
      if (scholarBlocked) {
        while (queue.length) {
          const id = queue.shift();
          slotsById.get(id)?.forEach(s => {
            if (s.querySelector(".m-load")) {
              s.innerHTML = `<span class="m-fail" title="Scholar is rate-limiting. Try again in a few minutes.">Scholar busy <button class="m-retry" type="button" data-retry-id="${escapeAttr(id)}" title="Retry this person">↻</button></span>`;
            }
          });
        }
        return;
      }
      const id = queue.shift();
      try {
        const r = await fetch(`/api/scholar/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error("backend " + r.status);
        const d = await r.json();
        slotsById.get(id).forEach(slot => renderCardMetrics(slot, id, d));
      } catch (e) {
        const msg = String(e);
        const isRl = msg.includes("429") || msg.includes("rate-limit");
        if (isRl) scholarBlocked = true;
        slotsById.get(id)?.forEach(s => {
          s.innerHTML = `<span class="m-fail" title="${escapeHTML(msg)}">${isRl ? "Scholar rate-limited" : "Scholar fetch failed"} <button class="m-retry" type="button" data-retry-id="${escapeAttr(id)}" title="Retry this person">↻</button></span>`;
        });
      }
      await new Promise(r => setTimeout(r, 600));
    }
  });
  await Promise.all(workers);
  // If user picked a sort that depends on Scholar data before all of it arrived,
  // re-apply now that everything is hydrated.
  if (currentSort !== "name") applySort(currentSort);
  // Re-apply the global REF 2029 toggle if it was previously on (survives reload + unit switch).
  if (localStorage.getItem("sd-ref-all") === "1") {
    applyGlobalRefMode(true);
  }
  // Reflect the saved spark-scale mode in the toolbar button label.
  applySparkMode(localStorage.getItem("sd-spark-mode") || "cohort");
}

async function openPerson(p) {
  openModal();
  // Ensure REF-flag map is loaded so the modal renders checkboxes in
  // the right state on first open.
  await loadRefFlags();
  // Effective UoA — surfaced in every modal branch so it's visible whether
  // the person is set / missing / unchecked / static-mode.
  const uoaCode = p._effective_uoa ?? effectiveUoa(p, CURRENT_UNIT);
  const uoaChip = uoaCode
    ? `<span class="modal-uoa-chip" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="${uoaCode}" title="Click to change UoA (currently ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')})">UoA ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}</span>`
    : `<span class="modal-uoa-chip is-none" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="0" title="Click to assign a UoA">No UoA — click to assign</span>`;
  modalBody.innerHTML = `
    <h3>${escapeHTML(p.name)}</h3>
    <div class="affil">${escapeHTML(p.title)}</div>
    ${uoaChip}
    <p class="spinner">Fetching live from Google Scholar…</p>
  `;
  const personStatus = p.scholar_status || (p.scholar_id ? "set" : "unchecked");
  if (personStatus === "missing") {
    modalBody.innerHTML = `
      <h3>${escapeHTML(p.name)}</h3>
      <div class="affil">${escapeHTML(p.title)}</div>
      ${uoaChip}
      <p class="missing-note"><strong>Missing on Google Scholar.</strong>
      No profile exists — or this person has chosen not to maintain one.
      Scholar metrics are not available, and on principle that absence should be
      respected rather than worked around. The institutional repository
      is the right place to find their outputs.</p>
      <p>
        ${profileLink(p)}
        <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(p.name)}"
           target="_blank" rel="noopener">search Scholar for ${escapeHTML(p.name)} ↗</a>
      </p>
    `;
    return;
  }

  if (window.__STATIC_MODE__) {
    modalBody.innerHTML = `
      <h3>${escapeHTML(p.name)}</h3>
      <div class="affil">${escapeHTML(p.title)}</div>
      ${uoaChip}
      <p class="err"><strong>Preview mode:</strong> live Scholar fetch needs the
      Flask backend running (<code>python app.py</code>). This preview only
      shows the UI shell.</p>
      ${p.scholar_id ? `<p><a href="https://scholar.google.com/citations?user=${encodeURIComponent(p.scholar_id)}" target="_blank" rel="noopener">Open ${escapeHTML(p.name)} on Google Scholar ↗</a></p>` : `<p><a href="https://scholar.google.com/scholar?q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">Search Scholar for ${escapeHTML(p.name)} ↗</a> &nbsp;·&nbsp; If they have no profile, set their status to <code>missing</code> in the Data editor.</p>`}
    `;
    return;
  }
  if (!p.scholar_id) {
    modalBody.innerHTML += `
      <p class="err">No <code>scholar_id</code> set for this person in
      the unit's data file. Find their profile at
      <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(p.name)}"
         target="_blank" rel="noopener">scholar.google.com</a>,
      copy the <code>user=…</code> value from the URL, and add it.</p>
    `;
    modalBody.querySelector(".spinner").remove();
    return;
  }
  try {
    const r = await fetch(`/api/scholar/${encodeURIComponent(p.scholar_id)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "fetch failed");
    renderPerson(p, data);
  } catch (e) {
    const msg = String(e.message || e);
    const isRl = /429|rate-limit/i.test(msg);
    // Fetch throws a TypeError when the local Flask server isn't responding
    // at all (browser couldn't open a connection). Distinguish that from a
    // Scholar-side problem so the user gets a useful next step.
    const isServerDown = (e instanceof TypeError)
      || /load failed|failed to fetch|networkerror|err_connection|fetch failed/i.test(msg);
    const url = `https://scholar.google.com/citations?user=${encodeURIComponent(p.scholar_id)}&hl=en`;
    let title, hint, body;
    if (isServerDown) {
      title = "Local server isn't responding";
      hint  = "The Scholar Dashboard server appears to have stopped. " +
              "Re-launch Scholar-Dashboard.app (or run start.command) and refresh this page.";
      body = `<p class="modal-err-detail">${escapeHTML(msg)}</p>
              <p class="modal-err-actions"><span class="modal-err-hint">${escapeHTML(hint)}</span></p>
              <p class="modal-err-actions"><button class="modal-err-retry" type="button" data-retry-id="${escapeAttr(p.scholar_id)}">↻ Try again</button></p>`;
    } else {
      title = isRl ? "Google Scholar is rate-limiting" : "Scholar fetch failed";
      hint  = isRl ? "Scholar rate-limits aggressively; wait a minute and retry." : "Click Retry to fetch again.";
      body = `<p class="modal-err-detail">${escapeHTML(msg)}</p>
              <p class="modal-err-actions">
                <a class="modal-err-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHTML(url)} ↗</a>
              </p>
              <p class="modal-err-actions">
                <button class="modal-err-retry" type="button" data-retry-id="${escapeAttr(p.scholar_id)}">↻ Retry</button>
                <span class="modal-err-hint">${escapeHTML(hint)}</span>
              </p>`;
    }
    modalBody.querySelector(".spinner").outerHTML = `
      <div class="modal-err">
        <p class="modal-err-title">${escapeHTML(title)}</p>
        ${body}
      </div>`;
    modalBody.querySelector(".modal-err-retry")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      openPerson(p);
    });
  }
}

function renderPerson(p, d) {
  const cpy = d.cites_per_year || {};
  const uoaCode = p._effective_uoa ?? effectiveUoa(p, CURRENT_UNIT);
  const uoaChip = uoaCode
    ? `<span class="modal-uoa-chip" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="${uoaCode}" title="Click to change UoA (currently ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')})">UoA ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}</span>`
    : `<span class="modal-uoa-chip is-none" data-uoa-chip data-staffid="${escapeAttr(p.staff_id || '')}" data-name="${escapeAttr(p.name)}" data-current="0" title="Click to assign a UoA">No UoA — click to assign</span>`;
  // Surface the stale state in the modal too — same dot the card carries.
  // (METRICS has been updated by this point, so the tooltip has the real
  // last-fetched timestamp.)
  const staleDotHTML = STALE_IDS.has(p.scholar_id)
    ? `<span class="stale-dot" title="${escapeAttr(staleDotTitle(p.scholar_id))}"></span>`
    : "";
  modalBody.innerHTML = `
    <h3>${escapeHTML(d.name || p.name)}${staleDotHTML}</h3>
    <div class="affil">${escapeHTML(cleanAffil(d.affiliation) || p.title)}</div>
    ${uoaChip}

    <div class="metric-row">
      <div class="metric"><div class="v">${fmt(d.citedby)}</div><div class="v-r">${fmt(d.citedby5y)} <span class="vr-tag">since 5y</span></div><div class="k">Citations</div></div>
      <div class="metric"><div class="v">${fmt(d.hindex)}</div><div class="v-r">${fmt(d.hindex5y)} <span class="vr-tag">since 5y</span></div><div class="k">h-index</div></div>
      <div class="metric"><div class="v">${fmt(d.i10index)}</div><div class="v-r">${fmt(d.i10index5y)} <span class="vr-tag">since 5y</span></div><div class="k">i10-index</div></div>
    </div>

    ${sparkline(cpy)}

    <div class="profile-block">
      <label class="profile-label" for="profile-text">Institutional profile
        <span class="profile-saved" id="profile-saved"></span></label>
      <textarea id="profile-text" class="profile-text" rows="3"
        placeholder="Institutional staff-page URL and/or a short bio for REF returns…"></textarea>
      <button class="tb-btn profile-save" id="profile-save">Save profile</button>
    </div>

    <h4 style="margin:1rem 0 .4rem;font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">
      Recent publications (REF ${REF_YEAR} window, from ${REF_START_YEAR})
      <span class="ref-summary" id="ref-summary-${escapeAttr(p.scholar_id)}">${refFlagCount(p.scholar_id)} flagged for REF</span>
    </h4>
    ${renderPubs(d.recent_publications || [], { scholarId: p.scholar_id, flags: refFlagsFor(p.scholar_id) })}

    <details class="deep">
      <summary>Deep dive: raw Scholar payload</summary>
      <pre>${escapeHTML(JSON.stringify(d, null, 2))}</pre>
    </details>

    <p class="cache-note">
      ${d._from_cache ? "Served from cache" : "Fresh fetch"} ·
      <a href="https://scholar.google.com/citations?user=${encodeURIComponent(p.scholar_id)}"
         target="_blank" rel="noopener">open on Scholar ↗</a> ·
      <a href="https://scholar.google.com/scholar?q=${encodeURIComponent(p.name)}"
         target="_blank" rel="noopener">search Scholar for ${escapeHTML(p.name)} ↗</a>
      <button class="modal-refresh" type="button" title="Re-fetch this person's metrics from Google Scholar"
              onclick="forceRefresh('${p.scholar_id}', this)">↻ Refresh Data from Google Scholar</button>
    </p>
    <p class="scrape-stamp">${d._fetched_iso
      ? `Scraped from Google Scholar on ${escapeHTML(new Date(d._fetched_iso).toLocaleString())}`
      : `Scrape time unknown`}</p>
  `;
  // Scroll the citation chart to the right edge so the most recent years
  // are visible by default. Users can swipe / drag back for older years.
  // requestAnimationFrame so layout has settled before we measure.
  requestAnimationFrame(() => {
    const scroller = modalBody.querySelector(".sparkline-scroll");
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  });
  // Institutional profile — load + wire save (keyed by staff_id/scholar_id).
  wireProfileEditor(modalBody, p);
}

// A stable per-person key for the institutional-profile store.
function personKey(p) { return String(p.staff_id || p.scholar_id || p.name || ""); }

// Load + save the institutional-profile textarea inside a person modal.
function wireProfileEditor(root, p) {
  const ta = root.querySelector("#profile-text");
  const btn = root.querySelector("#profile-save");
  const saved = root.querySelector("#profile-saved");
  if (!ta || !btn) return;
  const key = personKey(p);
  fetch("/api/scholar-meta?key=" + encodeURIComponent(key))
    .then(r => r.ok ? r.json() : null).then(d => { if (d && d.profile) ta.value = d.profile; })
    .catch(() => {});
  btn.addEventListener("click", async () => {
    try {
      const r = await fetch("/api/scholar-meta", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, profile: ta.value }) });
      if (!r.ok) throw new Error();
      if (saved) { saved.textContent = "Saved ✓"; setTimeout(() => saved.textContent = "", 2500); }
    } catch { if (saved) saved.textContent = "Save failed"; }
  });
}

// Scholar IDs whose last refresh attempt failed. Cards rendered for any of
// these IDs get a "⚠ stale" badge so the user can see at a glance which
// numbers shouldn't be trusted. Cleared on a successful refresh.
const STALE_IDS = new Set();
// Human-readable tooltip for the stale dot — surfaces when the cached data
// was last successfully fetched, if known.
function staleDotTitle(id) {
  const m = id && METRICS.get(id);
  if (m?.fetched_iso) {
    const when = new Date(m.fetched_iso).toLocaleString();
    return `Last refresh attempt failed.\nLast successful Scholar fetch: ${when}.`;
  }
  return "Last refresh attempt failed — data may be out of date.";
}

function markStale(id) {
  if (!id) return;
  STALE_IDS.add(id);
  // The stale indicator is a tiny grey dot inserted at the right end of
  // the name row (push-right via flex), with the last successful fetch
  // time in its tooltip.
  document.querySelectorAll(`.card-metrics[data-id="${cssEscape(id)}"]`).forEach(slot => {
    const card = slot.closest(".person-card");
    if (!card) return;
    card.classList.add("is-stale");
    const nameEl = card.querySelector(".name");
    if (nameEl && !nameEl.querySelector(".stale-dot")) {
      const dot = document.createElement("span");
      dot.className = "stale-dot";
      dot.title = staleDotTitle(id);
      nameEl.appendChild(dot);
    }
  });
}
function clearStale(id) {
  STALE_IDS.delete(id);
  document.querySelectorAll(`.card-metrics[data-id="${cssEscape(id)}"]`).forEach(slot => {
    const card = slot.closest(".person-card");
    card?.classList.remove("is-stale");
    card?.querySelector(".stale-dot")?.remove();
  });
}

// Force-refetch a single profile from Google Scholar (bypasses the cache).
// Reloads on success; on 429 / error restores the button, alerts the user,
// and marks the card stale. Cooldown 429s offer an explicit override.
window.forceRefresh = async (id, btn) => {
  const original = btn.textContent;
  const run = async (force) => {
    btn.textContent = "refreshing…";
    btn.disabled = true;
    let d = {};
    try {
      const url = `/api/scholar/${encodeURIComponent(id)}?refresh=1${force ? "&force=1" : ""}`;
      const r = await fetch(url);
      try { d = await r.json(); } catch { d = {}; }
      if (r.status === 429) {
        btn.textContent = original;
        btn.disabled = false;
        const remaining = d.cooldown_remaining_seconds;
        const mins = remaining ? Math.ceil(remaining / 60) : null;
        if (!force && mins) {
          // Server cooldown — offer the override.
          const ok = confirm(
            `Google Scholar 429 — server cooldown active (~${mins} min remaining).\n\n` +
            "The cooldown protects the cache from getting worse with repeated retries. " +
            "You can override it and try anyway, but Scholar's per-IP limit may still 429.\n\n" +
            "Override and try anyway?"
          );
          if (ok) {
            await run(true);
          } else {
            markStale(id);
            window.open(`https://scholar.google.com/citations?user=${encodeURIComponent(id)}&hl=en`, "_blank", "noopener");
          }
        } else {
          // Real Scholar 429 (or override failed) — mark stale, open profile.
          markStale(id);
          alert(
            "Scholar is still rate-limiting your IP.\n\n" +
            "The card has been marked ⚠ stale. Opening the Scholar profile in a new tab so you can check directly."
          );
          window.open(`https://scholar.google.com/citations?user=${encodeURIComponent(id)}&hl=en`, "_blank", "noopener");
        }
        return;
      }
      if (!r.ok) {
        btn.textContent = original;
        btn.disabled = false;
        markStale(id);
        alert(`Refresh failed: ${d.error || ("HTTP " + r.status)}\n\nThe card has been marked ⚠ stale.`);
        return;
      }
      // Success — clear any stale flag, then re-render the modal in
      // place from the fresh payload (page reload would close the modal
      // and look like "nothing happened" from the user's point of view).
      clearStale(id);
      const p = (STAFF || []).find(s => s.scholar_id === id);
      if (p && typeof openPerson === "function") {
        await openPerson(p);
      } else {
        location.reload();
      }
    } catch (e) {
      btn.textContent = original;
      btn.disabled = false;
      markStale(id);
      alert("Refresh failed: " + (e.message || e) + "\n\nThe card has been marked ⚠ stale.");
    }
  };
  await run(false);
};

function renderPubs(pubs, opts = {}) {
  if (!pubs.length) return `<p class="affil">No publications in the last two years on Scholar.</p>`;
  // `opts.scholarId` + `opts.flags` enable per-pub REF tick-boxes. Pubs
  // outside the REF 2029 window are still listed but not tickable.
  const scholarId = opts.scholarId;
  const flags = opts.flags || {};
  return pubs.map(p => {
    const y = p.year || 0;
    const inWindow = y >= REF_START_YEAR && y <= REF_END_YEAR;
    const key = p.pub_key || "";
    const val = (scholarId && key) ? flags[key] : undefined;
    const flagged = val != null && val !== false;
    const isLegacy = val === true;   // flagged before ratings existed
    const valStr = (typeof val === "number") ? String(val) : "";
    const legacyOpt = isLegacy ? `<option value="keep" selected>Flagged ✓ (set ★)</option>` : "";
    const sel = (scholarId && inWindow && key)
      ? `<select class="pub-ref-rating" title="REF status / star rating for this output"
                 data-scholar-id="${escapeAttr(scholarId)}" data-pub-key="${escapeAttr(key)}">
           ${legacyOpt}${REF_RATING_OPTS.map(([v, l]) => `<option value="${v}" ${(!isLegacy && v === valStr) ? "selected" : ""}>${l}</option>`).join("")}
         </select>`
      : `<span class="pub-ref-spacer" aria-hidden="true"></span>`;
    return `
      <div class="pub${flagged ? " pub-flagged" : ""}">
        ${sel}
        <div class="pub-body">
          <div class="pt">${escapeHTML(p.title || "Untitled")}</div>
          <div class="pm">${escapeHTML(String(p.year || "n.d."))} · ${escapeHTML(p.venue || "")} · cited by ${fmt(p.num_citations)}</div>
        </div>
      </div>
    `;
  }).join("");
}

// REF star ratings. Value is the number stored in ref_flags.json; the
// X.5 values are the "X–Y*" bands. "" = Not REF (no rating → removed).
const REF_RATING_OPTS = [
  ["", "Not REF"], ["1", "1*"], ["2", "2*"], ["2.5", "2–3*"],
  ["3", "3*"], ["3.5", "3–4*"], ["4", "4*"],
];

// Cache of REF flags from /api/ref-flags. Keyed by scholar_id → {pub_key: true}.
// Loaded once per session, updated optimistically on click.
const REF_FLAGS = new Map();
let _refFlagsLoaded = null;
async function loadRefFlags() {
  if (_refFlagsLoaded) return _refFlagsLoaded;
  _refFlagsLoaded = (async () => {
    try {
      const r = await fetch("/api/ref-flags");
      if (!r.ok) return;
      const data = await r.json();
      for (const sid in data) REF_FLAGS.set(sid, data[sid] || {});
    } catch (_) { /* offline / static mode — leave empty */ }
  })();
  return _refFlagsLoaded;
}
function refFlagsFor(scholarId) {
  return REF_FLAGS.get(scholarId) || {};
}
function refFlagCount(scholarId) {
  return Object.keys(refFlagsFor(scholarId)).length;
}

// Set a publication's REF star rating (or remove it). rating is a number
// (1, 2, 2.5, 3, 3.5, 4) to flag at that band, or null to mark Not REF.
// Optimistic local update; rolls back on server error.
async function setRefRating(scholarId, key, rating) {
  const map = REF_FLAGS.get(scholarId) || {};
  const prev = map[key];
  if (rating == null) delete map[key]; else map[key] = rating;
  REF_FLAGS.set(scholarId, map);
  try {
    const r = await fetch("/api/ref-flag", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({scholar_id: scholarId, pub_key: key, rating: rating == null ? 0 : rating}),
    });
    if (!r.ok) throw new Error("server " + r.status);
  } catch (e) {
    if (prev == null) delete map[key]; else map[key] = prev;   // roll back
    REF_FLAGS.set(scholarId, map);
    alert("Couldn't save REF rating: " + (e.message || e));
  }
}

// Wire up the per-pub rating selects anywhere in the document.
document.addEventListener("change", (e) => {
  const sel = e.target.closest(".pub-ref-rating");
  if (!sel) return;
  const sid = sel.dataset.scholarId;
  const key = sel.dataset.pubKey;
  if (!sid || !key) return;
  if (sel.value === "keep") return;   // legacy flagged-unrated; leave as-is
  const rating = sel.value === "" ? null : parseFloat(sel.value);
  setRefRating(sid, key, rating);
  // Reflect the row highlight immediately.
  sel.closest(".pub")?.classList.toggle("pub-flagged", rating != null);
  // Update the per-card REF chip + modal header running total.
  const n = refFlagCount(sid);
  const chip = document.querySelector(`[data-ref-chip-id="${CSS.escape(sid)}"]`);
  if (chip) {
    chip.textContent = `REF: ${n}`;
    chip.classList.toggle("is-zero", n === 0);
  }
  const sum = document.getElementById(`ref-summary-${sid}`);
  if (sum) sum.textContent = `${n} flagged for REF`;
});

// REF assessment year + publication window. Defaults to REF 2029
// (window 2021–2028); overridden from /api/settings via loadRefConfig().
let REF_YEAR = 2029;
let REF_START_YEAR = 2021;
let REF_END_YEAR = 2028;

// Load the configured REF year/window from Settings and relabel the static
// "REF 2029" UI bits. Called once at startup before the first render.
async function loadRefConfig() {
  try {
    const s = await (await fetch("/api/settings")).json();
    if (s.ref_year)         REF_YEAR = +s.ref_year;
    if (s.ref_window_start) REF_START_YEAR = +s.ref_window_start;
    if (s.ref_window_end)   REF_END_YEAR = +s.ref_window_end;
  } catch { /* keep defaults */ }
  applyRefLabels();
}

// Update the static DOM labels that name the REF year (chip + REF menu).
function applyRefLabels() {
  const chip = document.getElementById("tb-ref-all");
  if (chip) {
    chip.textContent = `REF ${REF_YEAR}`;
    chip.title = `REF ${REF_YEAR} window (${REF_START_YEAR}–${REF_END_YEAR}): fade citation years outside the assessment window so the REF years stand out.`;
  }
  const winLbl = document.getElementById("tb-ref-window-label");
  if (winLbl && localStorage.getItem("sd-ref-all") !== "1") winLbl.textContent = `Highlight REF ${REF_YEAR} window`;
  const tgt = document.querySelector('#tb-ref-targets .tb-mi-label');
  if (tgt) tgt.textContent = `REF ${REF_YEAR} targets…`;
}

function refFilter(cpy) {
  const out = {};
  for (const y in cpy || {}) {
    const yn = +y;
    if (yn >= REF_START_YEAR && yn <= REF_END_YEAR) out[y] = cpy[y];
  }
  return out;
}

function refFilter(cpy) {
  const out = {};
  for (const y in cpy || {}) {
    const yn = +y;
    if (yn >= REF_START_YEAR && yn <= REF_END_YEAR) out[y] = cpy[y];
  }
  return out;
}

// Fixed window for card mini-sparklines: current year + 9 prior = 10 years.
// All cards plot the same X-axis so they're visually comparable; missing
// years are zero-filled. REF mode keeps its own (2021–2028) window.
const MINI_SPARK_WINDOW_YEARS = 10;

// Shared y-axis scale across every card in the current view. Set by
// hydrateCardMetrics once the batch payload is in, so a 6946-cite researcher
// reads as visibly taller than a 300-cite researcher rather than each card
// normalising to its own peak. 0 = unset, fall back to the per-card max.
let GLOBAL_MINI_SPARK_MAX = 0;

function computeGlobalMiniSparkMax(batch) {
  const cy = (new Date()).getFullYear();
  const startY = cy - MINI_SPARK_WINDOW_YEARS + 1;
  let m = 0;
  for (const id in batch) {
    const cpy = batch[id]?.cites_per_year;
    if (!cpy) continue;
    for (let y = startY; y <= cy; y++) {
      const v = cpy[y] || 0;
      if (v > m) m = v;
    }
  }
  GLOBAL_MINI_SPARK_MAX = m;
}

function miniSparkline(cpy, opts = {}) {
  const cy = (new Date()).getFullYear();
  const cpy2 = cpy || {};
  // Build the year axis. REF mode uses the REF 2029 window; normal mode
  // uses a fixed 10-year tail so every card lines up regardless of how
  // long the researcher's career has been on Scholar.
  let years;
  if (opts.ref) {
    years = [];
    for (let y = REF_START_YEAR; y <= REF_END_YEAR; y++) years.push(y);
  } else {
    years = [];
    const startY = cy - MINI_SPARK_WINDOW_YEARS + 1;
    for (let y = startY; y <= cy; y++) years.push(y);
  }
  const vals = years.map(y => cpy2[y] || 0);
  // Per-card mode: each card normalises to its own peak instead of the
  // cohort max. Stops a single 74k-cite outlier (e.g. Andy Clark) from
  // flattening every other card in the cohort to invisibility.
  const perCardMode = localStorage.getItem("sd-spark-mode") === "per-card";
  // Local max as a safety fallback (and the default for REF mode, which has
  // a different x-axis from the normal-mode shared scale).
  const localMax = Math.max(...vals, 1);
  const rawMax = (!opts.ref && !perCardMode && GLOBAL_MINI_SPARK_MAX > 0)
    ? GLOBAL_MINI_SPARK_MAX
    : localMax;
  // Power compression on the shared y-axis. Pure linear crushed small-N
  // cohorts to invisibility next to a 6946-cite outlier (24× ratio); pure
  // sqrt over-flattered them (5× ratio reads as "everyone's about the
  // same"). x^0.7 splits the difference — 6946^0.7 / 284^0.7 ≈ 7.8×,
  // honest about who's most cited without crushing the lower-N cards.
  // REF mode and the per-card fallback stay linear — they're already
  // single-card framings.
  const SHARED_EXP = 0.7;
  const useShared = !opts.ref && !perCardMode && GLOBAL_MINI_SPARK_MAX > 0;
  const scaleY = useShared
    ? (v => (v > 0 ? Math.pow(v, SHARED_EXP) / Math.pow(rawMax, SHARED_EXP) : 0))
    : (v => v / rawMax);
  const sumV = vals.reduce((a, b) => a + b, 0);
  // Compact Google-Scholar-style framing: bottom year axis + right axis
  // with nice-step gridlines. Scaled-down version of the modal chart.
  const W = 280, H = 64;
  const padL = 0, padR = 14, padT = 6, padB = 10;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  // Let bars fill the plot width in both modes. (Previously REF mode
  // capped bar width at 18px to protect against a 1-year edge case, but
  // with the full 8-year REF window that cap left ~⅓ of the chart blank
  // on the right — read as "broken layout".) Soft cap at 40px instead so
  // a degenerate 1-year payload doesn't blow into a single huge slab.
  const bw = Math.min(plotW / Math.max(years.length, 1), 40);

  // Gridlines + right-axis ticks. Under sqrt-scale, picking nice axis
  // ticks on the raw value gives gridlines that land at sqrt-positions
  // visually — still readable because the right-axis labels show the
  // real (raw) citation counts.
  let gridSVG = "";
  if (!opts.ref && sumV > 0) {
    const step = niceAxisStep(rawMax, 2);
    const axisMax = Math.ceil(rawMax / step) * step;
    for (let t = 0; t <= axisMax; t += step) {
      const yy = padT + plotH - scaleY(t) * plotH;
      gridSVG += `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${yy}" y2="${yy}"/>`;
      if (t > 0) {
        gridSVG += `<text class="axis" x="${padL + plotW + 2}" y="${yy + 3}" text-anchor="start">${t}</text>`;
      }
    }
  }

  // selectedYears (REF mode only): restrict bars to years that hold a
  // REF-selected publication; other window years render as N/A.
  const selYears = opts.selectedYears || null;
  // Bars + year labels. Year labels show a 2-digit suffix ('17, '18…) so
  // ten of them fit comfortably under a narrow card. In REF+selection mode
  // we always show the year labels so the N/A years are legible.
  const showYears = (!opts.ref && sumV > 0) || (opts.ref && selYears);
  const bars = years.map((y, i) => {
    const x = padL + i * bw;
    const yearLabel = showYears
      ? `<text class="ms-year${y === cy ? ' current' : ''}" x="${x + bw/2}" y="${H - 2}" text-anchor="middle">'${String(y).slice(-2)}</text>`
      : "";
    // REF+selection mode: a window year with no selected output → N/A.
    if (selYears && !selYears.has(y)) {
      const baseY = padT + plotH;
      return `<line class="ms-na-tick" x1="${x + bw/2 - 3}" x2="${x + bw/2 + 3}" y1="${baseY}" y2="${baseY}"><title>${y}: no REF-selected output</title></line>` +
             `<text class="ms-na" x="${x + bw/2}" y="${baseY - 3}" text-anchor="middle">N/A</text>${yearLabel}`;
    }
    const v = vals[i];
    const isCurrent = (y === cy);
    const rawH = scaleY(v) * plotH;
    const h = isCurrent ? Math.max(rawH, 2.5) : rawH;
    const yy = padT + plotH - h;
    let cls;
    if (isCurrent)                                            cls = "current";
    else if (y >= REF_START_YEAR && y <= REF_END_YEAR)        cls = "recent";
    else                                                      cls = "";
    const tip = isCurrent
      ? `${y}: ${v} citations (partial year — ${cy} still in progress)`
      : `${y}: ${v} citations`;
    return `<rect class="${cls}" x="${x + 0.5}" y="${yy}" width="${Math.max(bw - 1, 0.5)}" height="${h}"><title>${tip}</title></rect>${yearLabel}`;
  }).join("");
  const cls = "mini-spark" + (opts.ref ? " ref-mode" : "");
  const svg = `<svg class="${cls}" viewBox="0 0 ${W} ${H}">${gridSVG}${bars}</svg>`;
  return `<span class="mini-spark-wrap">${svg}</span>`;
}

// Pick a "nice" round step for axis gridlines. Targets ~4 gridlines and
// snaps to 1 / 2 / 2.5 / 5 × 10ⁿ — same logic Google Scholar's citation
// chart uses (0, 160, 320, 480, 640 = step 160).
function niceAxisStep(maxVal, targetTicks = 4) {
  if (maxVal <= 0) return 1;
  const raw = maxVal / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5)      step = 1   * mag;
  else if (norm < 3)   step = 2   * mag;
  else if (norm < 3.5) step = 2.5 * mag;
  else if (norm < 7.5) step = 5   * mag;
  else                 step = 10  * mag;
  return step;
}

// Full-size citation history chart shown in the person modal. Modelled on
// Google Scholar's profile chart: full 4-digit year labels along the
// bottom, right-side y-axis with nice-round gridlines, light horizontal
// rules behind the bars. REF window (2021–2028) bars stay navy; current
// partial year stays grey.
function sparkline(cpy) {
  const cy = (new Date()).getFullYear();
  const cpy2 = { ...(cpy || {}) };
  const presentSet = new Set(Object.keys(cpy2).map(Number));
  if (!presentSet.size) return "";
  // Build a continuous year axis from the first known year through the
  // current year so quiet years stay visible. Track which years were in
  // the Scholar payload (real data — value may legitimately be 0) vs
  // back-filled (no data — render as a faint N/A marker, not a 0 bar).
  // Always span at least MODAL_MIN_YEARS so short careers don't sit as
  // a narrow strip hugging the right edge of the modal. Years that
  // predate the first cited year render as N/A markers (faint dashed
  // baseline + small italic "N/A"), distinct from real-zero years.
  const MODAL_MIN_YEARS = 20;
  const earliestCited = Math.min(...presentSet);
  const minY = Math.min(earliestCited, cy - MODAL_MIN_YEARS + 1);
  const maxY = cy;
  const years = [];
  for (let y = minY; y <= maxY; y++) years.push(y);
  const vals = years.map(y => cpy2[y] ?? 0);
  // hasData[i] = true only for years Scholar actually returned. Years
  // before the researcher's first cited year (back-filled to widen the
  // chart) and years between cited years that Scholar didn't return
  // both read as N/A.
  const hasData = years.map(y => presentSet.has(y));
  const rawMax = Math.max(...vals, 1);
  // Axis ceiling: round rawMax up to the next nice-step boundary so the
  // top gridline sits cleanly above the tallest bar.
  const step = niceAxisStep(rawMax);
  const axisMax = Math.ceil(rawMax / step) * step;
  const ticks = [];
  for (let v = 0; v <= axisMax; v += step) ticks.push(v);

  // Bar width is fixed so 4-digit year labels never overlap. If the
  // resulting SVG is wider than the container, the wrapper scrolls
  // horizontally rather than crushing every label into the next one.
  const BAR_W = 32;
  const H = 200;
  const padL = 6, padR = 48, padT = 14, padB = 28;
  const plotW = years.length * BAR_W;
  const W = padL + plotW + padR;
  const plotH = H - padT - padB;
  const bw = BAR_W;

  // Horizontal gridlines + right-axis labels.
  const grid = ticks.map(t => {
    const y = padT + plotH - (t / axisMax) * plotH;
    return `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${y}" y2="${y}"/>` +
           `<text class="axis" x="${padL + plotW + 6}" y="${y + 3}" text-anchor="start">${t}</text>`;
  }).join("");

  // Bars + bottom-axis year labels. Years not in the Scholar payload
  // render as a small "N/A" tick at the baseline rather than a 0-height
  // bar, so users can see the difference between "Scholar didn't return
  // a value" and "the researcher had zero citations that year".
  const bars = years.map((y, i) => {
    const x = padL + i * bw;
    const yearLabelCls = (y === cy) ? ' class="year-current"' : '';
    const yearLabel = `<text${yearLabelCls} x="${x + bw/2}" y="${H - 6}" text-anchor="middle">${y}</text>`;
    if (!hasData[i]) {
      const baseY = padT + plotH;
      return `<line class="na-tick" x1="${x + bw/2 - 3}" x2="${x + bw/2 + 3}" y1="${baseY}" y2="${baseY}"><title>${y}: no data from Scholar (N/A)</title></line>` +
             `<text class="na-label" x="${x + bw/2}" y="${baseY - 4}" text-anchor="middle">N/A</text>` +
             yearLabel;
    }
    const v = vals[i];
    const h = (v / axisMax) * plotH;
    const yy = padT + plotH - h;
    let cls = "";
    if (y === cy)                                       cls = "current";
    else if (y >= REF_START_YEAR && y <= REF_END_YEAR)  cls = "recent";
    const tip = (y === cy)
      ? `${y}: ${v} citations (partial year)`
      : `${y}: ${v} citations`;
    return `<rect class="${cls}" x="${x + 1.5}" y="${yy}" width="${Math.max(bw - 3, 0.5)}" height="${h}"><title>${tip}</title></rect>` +
           yearLabel;
  }).join("");

  // Wrap in a scroller so wide charts (long careers) scroll horizontally
  // rather than crush the year labels into each other.
  // Wrap in a scroller so wide charts (long careers) scroll horizontally
  // rather than crush the year labels into each other. The SVG renders
  // at its natural pixel size (W × H = years × 32px wide, 200px tall);
  // short careers stay compact on the left rather than stretching to
  // fill the modal and reading as cartoon-huge.
  return `<div class="sparkline-scroll">` +
    `<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${bars}</svg>` +
    `</div>`;
}

// Defensive fix for already-cached Scholar affiliation strings where
// multi-span markup got concatenated with no separator
// ("School of X,University of Y"). The backend parser has been fixed,
// but cached payloads only get rewritten on next refresh.
function cleanAffil(s) {
  if (!s) return s;
  return String(s).replace(/,([^\s])/g, ", $1").replace(/\s+/g, " ").trim();
}

function fmt(n) { return (n === null || n === undefined) ? "—" : n; }
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

loadStaff();
