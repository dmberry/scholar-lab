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
// at load time, re-render on change.
[
  { id: "exclude-emeritus", key: "sd-exclude-emeritus", read: excludeEmeritus },
  { id: "exclude-visiting", key: "sd-exclude-visiting", read: excludeVisiting },
].forEach(({ id, key, read }) => {
  const cb = document.getElementById(id);
  if (!cb) return;
  cb.checked = read();
  cb.addEventListener("change", () => {
    localStorage.setItem(key, cb.checked ? "1" : "0");
    renderPeople();
  });
});

// Apply REF 2029 mode to a single card — used by both per-card chip and global button.
function setCardRefMode(card, on) {
  const chip = card.querySelector(".ref-chip");
  const id   = card.querySelector(".card-metrics")?.dataset.id;
  const data = id && METRICS.get(id);
  if (!data?.cites_per_year) return;
  chip?.classList.toggle("active", on);
  card.classList.toggle("ref-mode", on);     // drives CSS pub-chip swap
  const spark = card.querySelector(".mini-spark");
  if (!spark) return;
  const sourceCpy = on ? refFilter(data.cites_per_year) : data.cites_per_year;
  const newHTML = miniSparkline(sourceCpy, { ref: on });
  const tmp = document.createElement("div");
  tmp.innerHTML = newHTML;
  spark.replaceWith(tmp.firstElementChild);
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

// Analytics scope state — defaults to whole faculty (all of everything).
let ANALYTICS_SCOPE = { facultySlug: "__all__", schoolSlug: "__all__", unitSlug: "__all__", groupBy: "unit" };

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

async function openAnalytics() {
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

  const groupBy = ANALYTICS_SCOPE.groupBy || "unit";
  const scopedUnits = _allActiveUnitsForScope(ANALYTICS_SCOPE);

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
            citedby5y: d.citedby5y ?? 0, refPubs: d.ref_eligible_count ?? 0,
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
      a.hindexMean += r.hindex;
      if (r.hindex > 0) a.h5h_ratios.push(r.hindex5y / r.hindex);
      for (const [y, v] of Object.entries(r.cpy)) a.cpyTotal[y] = (a.cpyTotal[y] || 0) + (v || 0);
    }
  }
  for (const a of agg.values()) {
    a.hindexMean = a.set ? a.hindexMean / a.set : 0;
    a.h5h_median = median(a.h5h_ratios);
    a.perCapita = a.set ? a.citedbySum / a.set : 0;
    a.refPerActive = a.set ? a.refPubsSum / a.set : 0;
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
  body.innerHTML = `
    ${renderAnalyticsScopeBar()}
    ${renderVisibility(aggList)}
    ${renderCitationTotals(aggList)}
    ${renderRefReadiness(aggList)}
    ${renderMomentumQuadrant(aggList)}
    ${crossSection}
    ${renderHeatmap(aggList)}
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
    <label>Faculty <select id="a-fac">${facOpts}</select></label>
    <label class="${showSchools?'':'sc-hidden'}">School <select id="a-sch" ${showSchools?'':'disabled'}>${schoolOpts}</select></label>
    <label>Unit <select id="a-unit">${unitOpts}</select></label>
    <span class="a-spacer"></span>
    <label class="a-groupby" title="Aggregate sections by unit OR by REF 2029 UoA bucket">Group by
      <select id="a-groupby">
        <option value="unit" ${groupBy==="unit"?"selected":""}>Unit</option>
        <option value="uoa"  ${groupBy==="uoa"?"selected":""}>UoA</option>
      </select>
    </label>
    <button class="tb-btn" id="a-reset" title="Reset to whole-faculty view">Reset</button>
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
    ANALYTICS_SCOPE = { facultySlug: "__all__", schoolSlug: "__all__", unitSlug: "__all__", groupBy: ANALYTICS_SCOPE.groupBy || "unit" };
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

function renderRefReadiness(aggList) {
  const sorted = [...aggList].filter(a => a.set > 0).sort((a, b) => b.refPerActive - a.refPerActive);
  const cards = sorted.map(a => {
    const total = a.refPubsSum;
    const perPerson = a.refPerActive;
    const tier = perPerson >= 4 ? "good" : perPerson >= 2 ? "ok" : "low";
    return `<div class="ref-card ref-tier-${tier}">
      <h5>${escapeHTML(a.name)}</h5>
      <div class="ref-card-grid">
        <div><b>${total}</b><span>Total REF pubs</span></div>
        <div><b>${perPerson.toFixed(1)}</b><span>Avg per person</span></div>
        <div><b>${a.set}/${a.total}</b><span>Active staff</span></div>
      </div>
    </div>`;
  }).join("");
  return `<section class="analytics-section">
    <h4>3. REF 2029 readiness scorecard</h4>
    <p class="analytics-q">How much REF-eligible material does each unit currently have?</p>
    <div class="ref-grid">${cards}</div>
    <p class="analytics-note">Each scholar needs ~4 outputs for REF. Cards tinted green if average ≥4 per person, amber 2–4, red &lt;2.
    Heuristic only — actual eligibility is judged manually per REF rules and excludes blog posts, op-eds, preprints.</p>
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
  if (e.target.closest("#tb-analytics")) openAnalytics();
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

function buildFacultyEditor(fac) {
  const block = document.createElement("section");
  block.className = "data-faculty";
  block.dataset.slug = fac.slug;
  block.innerHTML = `
    <header class="data-faculty-head">
      <input class="data-faculty-name" value="${escapeAttr(fac.name)}" placeholder="Faculty name">
      <input class="data-faculty-url"  value="${escapeAttr(fac.url || '')}" placeholder="https://…  (faculty homepage)" type="url">
      <span class="data-faculty-id" title="Internal identifier — derived from the faculty name when added.">id: <code>${escapeHTML(fac.slug)}</code></span>
      <button class="data-faculty-del" title="Delete this faculty and everything in it">✕ faculty</button>
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
  block.querySelector(".data-faculty-del").onclick = (e) => {
    e.preventDefault();
    if (confirm(`Delete "${fac.name}" and everything inside? (Backup saved automatically.)`)) {
      block.remove();
    }
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
      <button class="data-school-del" title="Delete this school and its units">✕ school</button>
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
  card.querySelector(".data-school-del").onclick = (e) => {
    e.preventDefault();
    if (confirm(`Delete "${sch.name}" and its ${unitCount} unit(s)?`)) card.remove();
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
      <button class="data-unit-del" title="Delete this entire unit">✕ unit</button>
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
  card.querySelector(".data-unit-del").onclick = (e) => {
    e.preventDefault();
    if (confirm(`Delete the entire "${unit.name}" unit and its ${unit.staff.length} staff entries? (Backup saved automatically.)`)) {
      card.remove();
    }
  };
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
  tr.querySelector(".data-row-del").onclick = () => tr.remove();
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
          <span class="affil">${escapeHTML(d.affiliation || "")}</span>
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

      <h5>Recent publications (REF 2029 window, from 2021)</h5>
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

async function saveDataEditor() {
  const status = document.getElementById("data-status");
  status.textContent = "Saving…";
  status.className = "data-status";
  const collectStaff = (card) => [...card.querySelectorAll("tbody tr")].map(tr => {
    const uoaRaw = tr.querySelector(".r-uoa")?.value || "";
    return {
      name:        tr.querySelector(".r-name").value.trim(),
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
  const payload = { faculties };
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

document.addEventListener("click", (e) => {
  if (e.target.closest("#tb-data")) openDataEditor();
  if (e.target.closest("[data-data-close]")) document.getElementById("data-modal").classList.add("hidden");
  if (e.target.closest("[data-staff-detail-close]")) closeStaffDetailModal();
  if (e.target.closest("#data-save")) saveDataEditor();
  if (e.target.closest("#data-load-unit")) document.getElementById("data-load-input")?.click();
  // Toolbar unit-file controls
  if (e.target.closest("#tb-load-unit")) document.getElementById("data-load-input")?.click();
  if (e.target.closest("#tb-save-unit")) saveCurrentUnit();
  if (e.target.closest("#tb-new-unit")) newUnitFlow();
  if (e.target.closest("#a-excl-open")) openExcludedModal();
});

// Toolbar "Save unit" — download the currently-selected unit's Markdown file.
function saveCurrentUnit() {
  if (!CURRENT_UNIT || CURRENT_UNIT.slug === "all-staff") {
    alert("Select a single unit first — \"Save unit\" downloads one unit's file. "
        + "(The current view is an aggregate, not a single unit.)");
    return;
  }
  downloadUnitFile(CURRENT_UNIT.slug);
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
    slots.forEach(s => renderCardMetrics(s, id, d));
  } catch (err) {
    const msg = String(err.message || err);
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
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".tb-zoom-btn");
  if (!btn) return;
  if (btn.dataset.zoom === "+") zoomIdx = Math.min(zoomIdx + 1, ZOOM_STEPS.length - 1);
  else                          zoomIdx = Math.max(zoomIdx - 1, 0);
  applyZoom();
});

// Toolbar: refresh-all button — force-refreshes every set staff member's
// Scholar cache in parallel (capped concurrency), then reloads cards.
document.getElementById("tb-refresh")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const ids = STAFF.filter(p => p.scholar_id && (p.scholar_status || "set") === "set")
                   .map(p => p.scholar_id);
  if (!ids.length) return;
  if (!confirm(`Force-refresh ${ids.length} Scholar profiles? This will hit Google Scholar once per person and may take ~30–60 seconds.`)) return;
  const original = btn.textContent;
  btn.disabled = true;
  let done = 0;
  const update = () => { btn.textContent = `↻ Refreshing ${done}/${ids.length}…`; };
  update();
  const q = ids.slice();
  await Promise.all(Array.from({length: 4}, async () => {
    while (q.length) {
      const id = q.shift();
      try { await fetch(`/api/scholar/${encodeURIComponent(id)}?refresh=1`); } catch {}
      done++; update();
    }
  }));
  btn.textContent = "↻ Done — reloading";
  setTimeout(() => location.reload(), 600);
});

async function loadStaff() {
  // Try Flask backend first; fall back to static staff.json (preview mode).
  // Use `cache: 'no-store'` so a staff.json save (e.g. someone setting a unit
  // UoA via the Data editor) is picked up on the next reload, not served from
  // browser cache. Was previously biting us during dev: the in-memory UNITS
  // array was missing fields the API now returned.
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
    btn.className = "person-card" + (status === "missing" ? " is-missing" : "");
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
      ? `<button class="ref-chip" type="button" data-ref-toggle title="Toggle REF 2029 publication window (2021–2028)">REF 2029</button>`
      : ``;
    // Stack REF chip + UoA chip in the top-right corner so the name has full
    // width again. UoA sits directly under REF, both right-aligned.
    const cornerChips = (refChip || uoaTag)
      ? `<span class="card-corner">${refChip}${uoaTag}</span>`
      : ``;
    btn.innerHTML = `
      ${cornerChips}
      <span class="name">${escapeHTML(p.name)}</span>
      <span class="title">${escapeHTML(p.title)}</span>
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
}

async function openPerson(p) {
  openModal();
  // Effective UoA — surfaced in every modal branch so it's visible whether
  // the person is set / missing / unchecked / static-mode.
  const uoaCode = p._effective_uoa ?? effectiveUoa(p, CURRENT_UNIT);
  const uoaChip = uoaCode
    ? `<span class="modal-uoa-chip" title="${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}">UoA ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}</span>`
    : ``;
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
    const url = `https://scholar.google.com/citations?user=${encodeURIComponent(p.scholar_id)}&hl=en`;
    modalBody.querySelector(".spinner").outerHTML = `
      <div class="modal-err">
        <p class="modal-err-title">${isRl ? "Google Scholar is rate-limiting" : "Scholar fetch failed"}</p>
        <p class="modal-err-detail">${escapeHTML(msg)}</p>
        <p class="modal-err-actions">
          <a class="modal-err-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHTML(url)} ↗</a>
        </p>
        <p class="modal-err-actions">
          <button class="modal-err-retry" type="button" data-retry-id="${escapeAttr(p.scholar_id)}">↻ Retry</button>
          <span class="modal-err-hint">${isRl ? "Scholar rate-limits aggressively; wait a minute and retry." : "Click Retry to fetch again."}</span>
        </p>
      </div>`;
    // Wire the modal's retry button to re-trigger openPerson for this person.
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
    ? `<span class="modal-uoa-chip" title="${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}">UoA ${uoaCode} · ${escapeHTML(UOA_BY_CODE[uoaCode]?.name || '')}</span>`
    : ``;
  modalBody.innerHTML = `
    <h3>${escapeHTML(d.name || p.name)}</h3>
    <div class="affil">${escapeHTML(d.affiliation || p.title)}</div>
    ${uoaChip}

    <div class="metric-row">
      <div class="metric"><div class="v">${fmt(d.citedby)}</div><div class="v-r">${fmt(d.citedby5y)} <span class="vr-tag">since 5y</span></div><div class="k">Citations</div></div>
      <div class="metric"><div class="v">${fmt(d.hindex)}</div><div class="v-r">${fmt(d.hindex5y)} <span class="vr-tag">since 5y</span></div><div class="k">h-index</div></div>
      <div class="metric"><div class="v">${fmt(d.i10index)}</div><div class="v-r">${fmt(d.i10index5y)} <span class="vr-tag">since 5y</span></div><div class="k">i10-index</div></div>
    </div>

    ${sparkline(cpy)}

    <h4 style="margin:1rem 0 .4rem;font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Recent publications (REF 2029 window, from 2021)</h4>
    ${renderPubs(d.recent_publications || [])}

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
      <button class="modal-refresh" type="button" title="Force-refresh from Google Scholar"
              onclick="forceRefresh('${p.scholar_id}', this)">↻ Refresh</button>
    </p>
    <p class="scrape-stamp">${d._fetched_iso
      ? `Scraped from Google Scholar on ${escapeHTML(new Date(d._fetched_iso).toLocaleString())}`
      : `Scrape time unknown`}</p>
  `;
}

window.forceRefresh = async (id, link) => {
  link.textContent = "refreshing…";
  await fetch(`/api/scholar/${id}?refresh=1`);
  location.reload();
};

function renderPubs(pubs) {
  if (!pubs.length) return `<p class="affil">No publications in the last two years on Scholar.</p>`;
  return pubs.map(p => `
    <div class="pub">
      <div class="pt">${escapeHTML(p.title || "Untitled")}</div>
      <div class="pm">${escapeHTML(String(p.year || "n.d."))} · ${escapeHTML(p.venue || "")} · cited by ${fmt(p.num_citations)}</div>
    </div>
  `).join("");
}

// REF 2029 publication window: 1 January 2021 – 31 December 2028.
const REF_START_YEAR = 2021;
const REF_END_YEAR = 2028;

function refFilter(cpy) {
  const out = {};
  for (const y in cpy || {}) {
    const yn = +y;
    if (yn >= REF_START_YEAR && yn <= REF_END_YEAR) out[y] = cpy[y];
  }
  return out;
}

function miniSparkline(cpy, opts = {}) {
  const cy = (new Date()).getFullYear();
  // Ensure the current year is always represented in the chart — even with 0
  // citations — so the grey "partial year" marker always appears and people
  // can read "no citations yet in YYYY" rather than mistaking 2025 for now.
  const cpy2 = { ...(cpy || {}) };
  if (!(cy in cpy2) && Object.keys(cpy2).length) cpy2[cy] = 0;
  const years = Object.keys(cpy2).map(Number).sort((a, b) => a - b);
  if (!years.length) return "";
  const vals = years.map(y => cpy2[y]);
  const maxV = Math.max(...vals, 1);
  const W = 180, H = 28;
  // In REF mode (few years), cap bar width so a single 2026 bar doesn't
  // stretch across the whole chart and read as a giant rectangle.
  const bw = opts.ref ? Math.min(W / Math.max(years.length, 1), 18) : W / years.length;
  const bars = years.map((y, i) => {
    const v = vals[i];
    // Minimum bar height for the current year so a zero/low value still appears
    // as a visible grey marker rather than disappearing entirely.
    const isCurrent = (y === cy);
    const rawH = (v / maxV) * H;
    const h = isCurrent ? Math.max(rawH, 2.5) : rawH;
    const x = i * bw;
    // Navy = REF 2029 window (2021–2028). Current partial year overrides
    // to grey even inside the window — it's still in progress.
    let cls;
    if (isCurrent)                                            cls = "current";
    else if (y >= REF_START_YEAR && y <= REF_END_YEAR)        cls = "recent";
    else                                                      cls = "";
    const tip = isCurrent
      ? `${y}: ${v} citations (partial year — ${cy} still in progress)`
      : `${y}: ${v} citations`;
    return `<rect class="${cls}" x="${x + 0.5}" y="${H - h}" width="${Math.max(bw - 1, 0.5)}" height="${h}"><title>${tip}</title></rect>`;
  }).join("");
  // Label tucked at the bottom-right, where bars rarely reach.
  const cls = "mini-spark" + (opts.ref ? " ref-mode" : "");
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

function sparkline(cpy) {
  const cy = (new Date()).getFullYear();
  const cpy2 = { ...(cpy || {}) };
  if (!(cy in cpy2) && Object.keys(cpy2).length) cpy2[cy] = 0;
  const years = Object.keys(cpy2).map(Number).sort((a, b) => a - b);
  if (!years.length) return "";
  const vals = years.map(y => cpy2[y]);
  const maxV = Math.max(...vals, 1);
  const W = 700, H = 80, pad = 18;
  const bw = (W - pad * 2) / years.length;
  const bars = years.map((y, i) => {
    const v = vals[i];
    const h = (v / maxV) * (H - pad * 2);
    const x = pad + i * bw;
    const yy = H - pad - h;
    // Navy = REF 2029 window (2021–2028); current partial year stays grey.
    let cls = "";
    if (y === cy)                                       cls = "current";
    else if (y >= REF_START_YEAR && y <= REF_END_YEAR)  cls = "recent";
    const tip = (y === cy)
      ? `${y}: ${v} citations (partial year)`
      : `${y}: ${v} citations`;
    const yearLabelCls = (y === cy) ? ' class="year-current"' : '';
    return `<rect class="${cls}" x="${x + 1}" y="${yy}" width="${bw - 2}" height="${h}"><title>${tip}</title></rect>
            <text${yearLabelCls} x="${x + bw/2}" y="${H - 4}" text-anchor="middle">${y % 100}</text>
            <text x="${x + bw/2}" y="${yy - 2}" text-anchor="middle">${v}</text>`;
  }).join("");
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

function fmt(n) { return (n === null || n === undefined) ? "—" : n; }
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

loadStaff();
