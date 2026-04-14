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
  } else { // Week | Month
    url.searchParams.set('processId', '0' + processId);
    url.searchParams.set('spanType', spanType);
    url.searchParams.set('startDate', formatDateISO(range.startDate));
    url.searchParams.set('endDate',   formatDateISO(range.endDate));
  }
  return url.toString();
}

// Parse the HTML response. The page stacks one result-table per sub-function
// with a heading/caption that names the sub-function ("Multis Pick",
// "Pack Singles", "Rebin", etc). Rows contain AA identity + UPH.
//
// This is deliberately simpler than performance-validity's parser. If it
// misses sub-function labels on real responses, promote that parser's
// multi-strategy logic (lines ~630-860 of their fclm.js).
function parseFunctionRollupHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = doc.querySelectorAll('table.result-table');
  const employees = [];

  tables.forEach(table => {
    // Find the nearest heading/caption above this table for subFunction.
    let subFunction = '';
    let node = table.previousElementSibling;
    for (let hops = 0; node && hops < 3; node = node.previousElementSibling, hops++) {
      const t = node.textContent && node.textContent.trim();
      if (t && t.length < 60) { subFunction = t; break; }
    }
    const caption = table.querySelector('caption');
    if (caption && caption.textContent.trim()) subFunction = caption.textContent.trim();

    const heads = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
      .map(th => th.textContent.trim());
    const col = name => heads.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const iLogin = col('Login') >= 0 ? col('Login')
                  : heads.findIndex(h => /login/i.test(h));
    const iName  = col('Name');
    const iBadge = col('Empl ID') >= 0 ? col('Empl ID') : col('Badge');
    const iHrs   = heads.findIndex(h => /hours/i.test(h));
    const iUnits = heads.findIndex(h => /^units$/i.test(h));
    const iUPH   = heads.findIndex(h => /UPH|Units.*Hour/i.test(h));
    const iJPH   = heads.findIndex(h => /JPH|Jobs.*Hour/i.test(h));

    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const t = i => (i >= 0 && tds[i]) ? tds[i].textContent.trim() : '';
      const login = t(iLogin);
      if (!login || !/^[a-z0-9]+$/i.test(login)) continue;
      employees.push({
        login,
        name:        t(iName),
        badgeId:     t(iBadge),
        hours:       parseFloat(t(iHrs))  || 0,
        units:       parseFloat(t(iUnits))|| 0,
        uph:         parseFloat(t(iUPH))  || 0,
        jph:         parseFloat(t(iJPH))  || 0,
        subFunction: subFunction || '(unknown)'
      });
    }
  });

  return employees;
}

async function fetchFunctionRollup({ warehouseId, processId, spanType, range }) {
  const url = buildFunctionRollupUrl({ warehouseId, processId, spanType, range });
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`FCLM functionRollup ${res.status}`);
  const html = await res.text();
  return parseFunctionRollupHTML(html);
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
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`FCLM timeDetails ${res.status}`);
  const html = await res.text();
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
