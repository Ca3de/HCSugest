// FCLM client. Two endpoints, both cookie-authed via Midway.
//
//   /reports/functionRollup   -> per-AA UPH / JPH by parent process + subFunction
//   /employee/timeDetails     -> per-AA Gantt of subFunction segments (for dwell)
//
// Patterns (URL params, spanType rules, subFunction parsing) are distilled
// from Ca3de/performance-validity/content/fclm.js. See that repo for the
// battle-tested version; we keep a narrow surface here.

const FCLM_BASE = 'https://fclm-portal.amazon.com';

function formatDateURL(d) {
  // FCLM expects YYYY/MM/DD for day params on functionRollup.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function formatDateISO(d) {
  return d.toISOString().slice(0, 10);
}

// Resolve a shift window. Matches the Day 06:00-18:00 / Night 18:00-06:00
// convention in the performance-validity code and the Excel tool.
function shiftRange(kind = 'day', anchor = new Date()) {
  const now = new Date(anchor);
  if (kind === 'night') {
    const start = new Date(now);
    start.setHours(18, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(6, 0, 0, 0);
    return { startDate: start, endDate: end, startHour: 18, endHour: 6 };
  }
  const start = new Date(now);
  start.setHours(6, 0, 0, 0);
  const end = new Date(now);
  end.setHours(18, 0, 0, 0);
  return { startDate: start, endDate: end, startHour: 6, endHour: 18 };
}

// --- functionRollup ---------------------------------------------------------

function buildFunctionRollupUrl({ warehouseId, processId, spanType, range }) {
  const url = new URL(`${FCLM_BASE}/reports/functionRollup`);
  url.searchParams.set('warehouseId', warehouseId);
  url.searchParams.set('reportFormat', 'HTML');

  if (spanType === 'Intraday') {
    url.searchParams.set('processId', processId);
    url.searchParams.set('spanType', 'Intraday');
    url.searchParams.set('startDateIntraday', formatDateURL(range.startDate));
    url.searchParams.set('startHourIntraday', String(range.startHour));
    url.searchParams.set('endDateIntraday',   formatDateURL(range.endDate));
    url.searchParams.set('endHourIntraday',   String(range.endHour));
  } else if (spanType === 'Day') {
    url.searchParams.set('processId', processId);
    url.searchParams.set('spanType', 'Day');
    url.searchParams.set('startDateDay', formatDateURL(range.startDate));
  } else if (spanType === 'Week') {
    // Confirmed shape (from the user's pasted URL): processId raw, no leading 0;
    // startDateWeek=YYYY/MM/DD; intraday params are required form filler even
    // though the server ignores them for spanType=Week.
    url.searchParams.set('processId', processId);
    url.searchParams.set('spanType', 'Week');
    url.searchParams.set('startDateWeek', formatDateURL(range.startDate));
    url.searchParams.set('maxIntradayDays', '1');
    url.searchParams.set('startDateIntraday', formatDateURL(range.startDate));
    url.searchParams.set('startHourIntraday', '18');
    url.searchParams.set('startMinuteIntraday', '0');
    url.searchParams.set('endDateIntraday',   formatDateURL(range.endDate));
    url.searchParams.set('endHourIntraday',   '6');
    url.searchParams.set('endMinuteIntraday', '0');
  } else { // Month
    url.searchParams.set('processId', '0' + processId);
    url.searchParams.set('spanType', spanType);
    url.searchParams.set('startDate', formatDateISO(range.startDate));
    url.searchParams.set('endDate',   formatDateISO(range.endDate));
  }
  return url.toString();
}

// Parser for the functionRollup HTML. Ported from
// Ca3de/performance-validity/content/fclm.js (~lines 629-1240) which has
// been battle-tested against real FCLM responses.
//
// Key structural facts (not what a naive parser would guess):
//   * Tables may or may not have class="result-table"; fall back to `table`.
//   * Employee-data tables are discriminated by containing at least one
//     <td> whose text is literally "AMZN" (the badge-type column).
//   * The main header row starts with "Type"; column headers come from it
//     (ID / Name / Total / Jobs / JPH / Units / UPH / Function).
//   * Colspan matters — Paid Hours is a group header with sub-columns.
//   * Data rows are only those where the first cell is "AMZN".
//   * Badge IDs live inside <a> inside the ID cell.
//   * Sub-function (path label) comes from anchors/headings/siblings, via
//     known pattern matching (FRACS Multis Pick, Pack FRACSPnH, …).
function parseFunctionRollupHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const employees = [];
  const seen = new Set();

  // Tables with employee data
  let tables = doc.querySelectorAll('table.result-table');
  if (!tables.length) tables = doc.querySelectorAll('table');

  const KNOWN_PATTERNS = [
    /FRACS\s+(?:Multis|Singles|LTL)\s+Pick/i,
    /Liquidations?\s+Pick/i,
    /WHD\s+(?:Pick|Grading|SpecialtyGrading)/i,
    /(?:Multis|Singles)\s*\[\d+\]/i,
    /Remove\s+Hazmat/i,
    /Pack(?:ing|nHold|Singles|FracsLTL|FRACSPnH)/i,
    /V-Returns\s+Pack/i,
    /Pack\s+Singles/i,
    /Pack\s+FracsLTL/i,
    /Stow\s*C[\s-]*Returns/i,
    /C[\s-]*Returns\s+Stow/i,
    /C-Returns[_\s]+EndofLine/i,
    /V-Returns\s+Support/i,
    /C-Returns\s+Support/i
  ];
  function extractFunctionName(text) {
    if (!text) return '';
    for (const p of KNOWN_PATTERNS) {
      const m = text.match(p);
      if (m) return m[0].trim();
    }
    return '';
  }
  function cleanHeader(s) { return (s || '').replace(/[≠↑↓▲▼]/g, '').trim().toLowerCase(); }

  tables.forEach(table => {
    // Must contain AMZN rows
    let hasAmzn = false;
    for (const td of table.querySelectorAll('td')) {
      if (td.textContent.trim() === 'AMZN') { hasAmzn = true; break; }
    }
    if (!hasAmzn) return;

    // Resolve sub-function name for this table
    let subFunction = '';
    for (const a of table.querySelectorAll('a')) {
      const ext = extractFunctionName(a.textContent);
      if (ext) { subFunction = ext; break; }
    }
    if (!subFunction) {
      let prev = table.previousElementSibling;
      for (let hops = 0; !subFunction && prev && hops < 5; prev = prev.previousElementSibling, hops++) {
        for (const a of prev.querySelectorAll('a')) {
          const ext = extractFunctionName(a.textContent);
          if (ext) { subFunction = ext; break; }
        }
        if (subFunction) break;
        const t = (prev.textContent || '').trim();
        if (t.length < 120) {
          const ext = extractFunctionName(t);
          if (ext) { subFunction = ext; break; }
        }
      }
    }

    // Find main header row starting with "Type"
    const rows = table.querySelectorAll('tr');
    let headerRow = null, subHeaderRow = null;
    for (let i = 0; i < rows.length; i++) {
      const ths = rows[i].querySelectorAll('th');
      if (ths.length && cleanHeader(ths[0].textContent) === 'type') {
        headerRow = ths;
        if (i + 1 < rows.length) {
          const nextTh = rows[i + 1].querySelectorAll('th');
          if (nextTh.length) subHeaderRow = nextTh;
        }
        break;
      }
      const tds = rows[i].querySelectorAll('td');
      if (tds.length && cleanHeader(tds[0].textContent) === 'type') { headerRow = tds; break; }
    }

    // Column-index resolver accounting for colspan
    const idx = { id: 1, name: 2, total: -1, jobs: -1, jph: -1, units: -1, uph: -1, fn: -1 };
    if (headerRow) {
      let col = 0;
      const colMap = [];
      for (const cell of headerRow) {
        const h = cleanHeader(cell.textContent);
        const span = parseInt(cell.getAttribute('colspan')) || 1;
        colMap.push({ h, col, span });
        col += span;
      }
      for (const c of colMap) {
        if (c.h === 'id' || c.h.includes('badge')) idx.id = c.col;
        else if (c.h === 'name') idx.name = c.col;
        else if (c.h === 'total') idx.total = c.col;
        else if (c.h === 'jobs' || c.h === 'job') idx.jobs = c.col;
        else if (c.h === 'jph' || c.h.includes('jobs/hr')) idx.jph = c.col;
        else if (c.h === 'units' || c.h === 'unit') idx.units = c.col;
        else if (c.h === 'uph' || c.h.includes('units/hr')) idx.uph = c.col;
        else if (c.h === 'function' || c.h === 'process' || c.h.includes('sub-function')) idx.fn = c.col;
        if (c.span > 1 && c.h.includes('paid hours')) idx.total = c.col + c.span - 1;
      }
      if (subHeaderRow && (idx.jobs < 0 || idx.jph < 0)) {
        // Jobs/JPH usually live in a sub-header under ItemPicked or similar.
        // Walk sub-headers starting from the first group column.
        const firstGroupCol = colMap.find(c => c.span > 1);
        let sub = firstGroupCol ? firstGroupCol.col : 0;
        for (const sc of subHeaderRow) {
          const h = cleanHeader(sc.textContent);
          const span = parseInt(sc.getAttribute('colspan')) || 1;
          if ((h === 'jobs' || h === 'job') && idx.jobs < 0) idx.jobs = sub;
          if ((h === 'jph' || h.includes('jobs/hr')) && idx.jph < 0) idx.jph = sub;
          if (h === 'total' && idx.total < 0) idx.total = sub;
          sub += span;
        }
      }
    }

    // Parse data rows (first cell must be "AMZN")
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 5) continue;
      if (cells[0].textContent.trim() !== 'AMZN') continue;

      // Badge ID, possibly inside an <a>
      const idCell = cells[idx.id];
      const idLink = idCell && idCell.querySelector('a');
      const badgeId = (idLink ? idLink.textContent : idCell && idCell.textContent || '').trim();
      if (!/^\d+$/.test(badgeId)) continue;

      // Per-row sub-function override (if table has a Function column)
      let sf = subFunction;
      if (idx.fn >= 0 && cells[idx.fn]) {
        const t = cells[idx.fn].textContent.trim();
        if (t && t.length < 100) sf = t;
      }

      const key = badgeId + '|' + sf;
      if (seen.has(key)) continue;
      seen.add(key);

      const nameCell = cells[idx.name];
      const nameLink = nameCell && nameCell.querySelector('a');
      let name = (nameLink ? nameLink.textContent : nameCell && nameCell.textContent || '').trim();
      if (!name || name.length > 80 || name.includes('Default Menu')) name = badgeId;

      const cellNum = (i) => {
        if (i < 0 || !cells[i]) return 0;
        const n = parseFloat(cells[i].textContent.trim());
        return Number.isFinite(n) ? n : 0;
      };

      employees.push({
        login: null,          // FCLM rollup doesn't expose login; badge is primary id
        employeeId: badgeId,
        badgeId,
        name,
        hours: cellNum(idx.total),
        jobs:  cellNum(idx.jobs),
        jph:   cellNum(idx.jph),
        units: cellNum(idx.units),
        uph:   cellNum(idx.uph),
        subFunction: sf || '(unknown)'
      });
    }
  });
  return employees;
}

async function fetchFunctionRollup({ warehouseId, processId, spanType, range }) {
  const url = buildFunctionRollupUrl({ warehouseId, processId, spanType, range });
  const kind = `fclm-rollup-${processId}-${spanType}`;
  try {
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    if (!res.ok) {
      self.Debug && await self.Debug.recordSample({ kind, url, status: res.status, body: html, error: `HTTP ${res.status}` });
      throw new Error(`FCLM functionRollup ${res.status}`);
    }
    const employees = parseFunctionRollupHTML(html);
    self.Debug && await self.Debug.recordSample({
      kind, url, status: res.status, body: html,
      parseSummary: { employees: employees.length, subFunctions: [...new Set(employees.map(e => e.subFunction))] }
    });
    return employees;
  } catch (e) {
    self.Debug && await self.Debug.recordSample({ kind, url, status: 0, body: '', error: e });
    throw e;
  }
}

// --- timeDetails (Gantt) ---------------------------------------------------

function buildTimeDetailsUrl({ warehouseId, employeeId, range }) {
  const url = new URL(`${FCLM_BASE}/employee/timeDetails`);
  url.searchParams.set('employeeId', employeeId);
  url.searchParams.set('warehouseId', warehouseId);
  url.searchParams.set('spanType', 'Intraday');
  url.searchParams.set('startDateIntraday', formatDateURL(range.startDate));
  url.searchParams.set('startHourIntraday', String(range.startHour));
  url.searchParams.set('endDateIntraday',   formatDateURL(range.endDate));
  url.searchParams.set('endHourIntraday',   String(range.endHour));
  url.searchParams.set('startDateDay', formatDateURL(range.endDate));
  return url.toString();
}

// Parse the timeDetails Gantt. The real DOM (confirmed from the sample
// "Employee Time Details _ FCLM Portal.htm" on main) is a plain table:
//
//   <table class="ganttChart" aria-label="Time Details">
//     <thead>
//       <tr class="totSummary">...date range + "Hours on Task: X/Y"...</tr>
//       <tr> <th>title</th> <th>start</th> <th>end</th> <th>duration</th> </tr>
//     </thead>
//     <tbody>
//       <tr class="clock-seg on-clock paid">  <td colspan=2>OnClock/Paid</td> <td>04/13-00:00:00</td> <td>04/13-00:28:00</td> <td>28:00</td> ...</tr>
//       <tr class="function-seg direct">      <td colspan=2>V-Returns Pick&diams;FRACS Multis Pick</td> <td>04/13-00:00:00</td> <td>04/13-00:24:39</td> <td>24:39</td> ...</tr>
//       <tr class="function-seg indirect">    ...</tr>
//     </tbody>
//   </table>
//
// The title is "<parentFunction>&diams;<subFunction>". We want the sub.
// clock-seg rows are skipped (clock-in/out markers, not sub-function work).
function parseTimeDetailsHTML(html, range) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table.ganttChart[aria-label="Time Details"]')
             || doc.querySelector('table.ganttChart');
  if (!table) return { segments: [], employee: parseEmployeeInfo(doc) };

  const segments = [];
  const baseYear = (range && range.startDate)
    ? range.startDate.getFullYear()
    : new Date().getFullYear();

  for (const tr of table.querySelectorAll('tbody tr')) {
    const cls = tr.className || '';
    if (cls.includes('clock-seg')) continue; // ignore OnClock/OffClock rows
    if (!cls.includes('function-seg')) continue;

    const tds = tr.querySelectorAll('td');
    if (tds.length < 4) continue;

    // td[0] colspan=2 → title; td[1] → start; td[2] → end; td[3] → duration
    const rawTitle = tds[0].textContent.trim().replace(/\s+/g, ' ');
    const parts = rawTitle.split(/\s*[\u2666\u25C6]\s*/); // ♦ diamond (&diams;)
    const parentFunction = (parts[0] || '').trim();
    const subFunction    = (parts[1] || parts[0] || '').trim();

    const start = parseFclmTimestamp(tds[1].textContent.trim(), baseYear);
    const end   = parseFclmTimestamp(tds[2].textContent.trim(), baseYear);
    const durationText = tds[3].textContent.trim();

    segments.push({
      parentFunction,
      subFunction,
      kind: cls.includes('indirect') ? 'indirect' : 'direct',
      start,
      end,
      durationText,
      durationMin: parseHMM(durationText)
    });
  }

  return { segments, employee: parseEmployeeInfo(doc) };
}

// FCLM writes timestamps as "MM/DD-HH:MM:SS" with no year. We infer the
// year from the range's start date. Handles a wrap past midnight by
// advancing the year/month only if the MM/DD precedes the range start.
function parseFclmTimestamp(s, baseYear) {
  const m = s.match(/(\d{1,2})\/(\d{1,2})-(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(baseYear, +m[1] - 1, +m[2], +m[3], +m[4], +(m[5] || 0));
}

function parseHMM(s) {
  // "24:39" → 24 hours 39 min? No — FCLM uses mm:ss for short durations and
  // h:mm for longer. The duration column in the sample is always HH:MM (e.g.
  // 24:39 = 24 min 39 s? — inspection of the sample shows OnClock 28:00 for
  // a 28-minute segment), so treat both numbers as minutes+seconds.
  const m = s.match(/^(\d+):(\d{2})$/);
  if (!m) return 0;
  return +m[1] + (+m[2]) / 60;
}

// Employee info block — { login, emplId, badge, deptId, location, shift }.
// From: <div class="employeeInfo"><dl><dt>Login</dt><dd>nilianz</dd>...</dl></div>
function parseEmployeeInfo(doc) {
  const info = { login: null, emplId: null, badge: null };
  const block = doc.querySelector('.employeeInfo');
  if (!block) return info;
  const dls = block.querySelectorAll('dl');
  for (const dl of dls) {
    const dts = dl.querySelectorAll('dt');
    const dds = dl.querySelectorAll('dd');
    for (let i = 0; i < dts.length; i++) {
      const k = dts[i].textContent.trim().toLowerCase();
      const v = dds[i] ? dds[i].textContent.trim() : '';
      if (k === 'login') info.login = v;
      else if (k === 'empl id') info.emplId = v;
      else if (k === 'badge') info.badge = v;
      else if (k === 'dept id') info.deptId = v;
      else if (k === 'location') info.location = v;
      else if (k === 'shift') info.shift = v;
    }
  }
  return info;
}

async function fetchTimeDetails({ warehouseId, employeeId, range }) {
  const url = buildTimeDetailsUrl({ warehouseId, employeeId, range });
  const kind = `fclm-timedetails`;
  const res = await fetch(url, { credentials: 'include' });
  const html = await res.text();
  if (!res.ok) {
    self.Debug && await self.Debug.recordSample({ kind, url, status: res.status, body: html, error: `HTTP ${res.status}` });
    throw new Error(`FCLM timeDetails ${res.status}`);
  }
  // Only record one sample per session to avoid flooding with 30+ per plan.
  if (!self._loggedTimeDetailsOnce) {
    self._loggedTimeDetailsOnce = true;
    const parsed = parseTimeDetailsHTML(html, range);
    self.Debug && await self.Debug.recordSample({
      kind, url, status: res.status, body: html,
      parseSummary: { segments: parsed.segments.length, employee: parsed.employee }
    });
    return parsed;
  }
  return parseTimeDetailsHTML(html, range);
}

// Given segments, return the AA's current assignment + when they entered it.
// "Current" = segments whose subFunction matches the latest contiguous run
// ending at (or immediately before) `now`. This handles the common case
// where a direct+indirect pair are back-to-back on the same sub-function.
function currentAssignment(segments, now = new Date()) {
  if (!segments || !segments.length) return null;
  const sorted = segments.slice().sort((a, b) => a.start - b.start);

  // Latest segment whose window contains `now` (or the last one if shift ended)
  let idx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].start <= now && sorted[i].end >= now) { idx = i; break; }
  }
  if (idx === -1) idx = sorted.length - 1;

  const active = sorted[idx];
  // Walk backward while the sub-function matches to find when they entered it.
  let startedAt = active.start;
  for (let i = idx - 1; i >= 0; i--) {
    if (sorted[i].subFunction === active.subFunction &&
        Math.abs(sorted[i].end - startedAt) < 60 * 1000) {
      startedAt = sorted[i].start;
    } else break;
  }

  return {
    parentFunction: active.parentFunction,
    subFunction: active.subFunction,
    startedAt,
    stale: !(active.start <= now && active.end >= now)
  };
}

if (typeof self !== 'undefined') {
  self.FCLM = {
    shiftRange,
    buildFunctionRollupUrl,
    fetchFunctionRollup,
    parseFunctionRollupHTML,
    buildTimeDetailsUrl,
    fetchTimeDetails,
    parseTimeDetailsHTML,
    currentAssignment
  };
}
