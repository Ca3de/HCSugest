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

// Parse the Gantt chart into segments. Performance-validity looks for
// table.ganttChart[aria-label="Time Details"]. Each row is a subFunction,
// and colored cells mark the hour-quarter ticks the AA was in that function.
// We reduce that to contiguous { subFunction, start, end } segments so the
// optimizer can compute dwell.
function parseTimeDetailsHTML(html, range) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table.ganttChart[aria-label="Time Details"]')
             || doc.querySelector('table.ganttChart');
  if (!table) return [];

  const segments = [];
  // Each row: th=subFunction, tds=time cells. Colored/occupied cells have
  // a class/style indicating activity. Without a live sample to tune on,
  // we assume any td with a non-empty background or a specific class is active.
  const rows = table.querySelectorAll('tr');
  const headerCells = rows[0] ? rows[0].querySelectorAll('th, td') : [];
  // Time axis step: compute per cell based on range span.
  const rangeMs = range.endDate - range.startDate;
  const cellCount = Math.max(1, headerCells.length - 1);
  const msPerCell = rangeMs / cellCount;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const th = row.querySelector('th');
    if (!th) continue;
    const subFunction = th.textContent.trim();
    const cells = row.querySelectorAll('td');

    let activeStart = null;
    for (let c = 0; c < cells.length; c++) {
      const td = cells[c];
      const active = isGanttCellActive(td);
      if (active && activeStart === null) activeStart = c;
      if ((!active || c === cells.length - 1) && activeStart !== null) {
        const endCol = active ? c + 1 : c;
        segments.push({
          subFunction,
          start: new Date(range.startDate.getTime() + activeStart * msPerCell),
          end:   new Date(range.startDate.getTime() + endCol * msPerCell)
        });
        activeStart = null;
      }
    }
  }
  return segments;
}

function isGanttCellActive(td) {
  if (!td) return false;
  const cls = (td.getAttribute('class') || '').toLowerCase();
  if (cls.includes('active') || cls.includes('worked') || cls.includes('filled')) return true;
  const style = (td.getAttribute('style') || '').toLowerCase();
  if (style.includes('background') && !/transparent|#fff|rgb\(255,\s*255,\s*255\)/.test(style)) return true;
  // Fallback: td has a data- attribute indicating a subFunction.
  if (td.hasAttribute('data-subfunction') || td.hasAttribute('data-function')) return true;
  return false;
}

async function fetchTimeDetails({ warehouseId, employeeId, range }) {
  const url = buildTimeDetailsUrl({ warehouseId, employeeId, range });
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`FCLM timeDetails ${res.status}`);
  const html = await res.text();
  return parseTimeDetailsHTML(html, range);
}

// Given segments, return the AA's current assignment + when they entered it.
function currentAssignment(segments, now = new Date()) {
  const active = segments
    .filter(s => s.start <= now && s.end >= now)
    .sort((a, b) => b.start - a.start)[0];
  if (active) return { subFunction: active.subFunction, startedAt: active.start };
  // Nobody is "currently" in a segment (data lag). Use the last segment.
  const last = segments.sort((a, b) => b.end - a.end)[0];
  return last ? { subFunction: last.subFunction, startedAt: last.start, stale: true } : null;
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
