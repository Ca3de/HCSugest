// Staffing optimizer v0.1
//
// Input:
//   hc           total available headcount (e.g. 25)
//   hoursLeft    remaining hours in shift (e.g. 8)
//   minDwellHrs  min time an AA should stay in a role (default 5)
//   demand       per-path demand (AA-hours), derived from backlog + rates
//   rates        per-AA p50 UPH per path (from FCLM history)
//   roster       AAs currently on clock: { login, currentPath, startedAt }
//   expected     per-path user-set weekly expected rate (UPH)
//
// Output:
//   assignments  [{ login, path, hours, source }]
//   warnings     [string]
//
// Approach: a deliberately simple greedy pass. The v1 objective is honesty
// about uncertainty, not optimality:
//
//  1. Compute AA-hours of demand per path.
//  2. Hold everyone on their current path if they haven't hit minDwellHrs yet,
//     UNLESS their path is already saturated and another path is starved.
//  3. Fill remaining demand by assigning AAs in descending order of their
//     p50 rate on the needy path. Missing history -> use expected rate.
//  4. Any leftover HC becomes 'flex'. Any leftover demand becomes a warning.
//
// This is where the real IP goes over time (MIP / ILP / mini Hungarian etc).
// The interfaces are stable so you can swap the body without touching the UI.

// Demand math (per user):
//   demandAAHours = unitsInReadyBacklog / expectedUPH
// Cart classification upstream has already filtered `unitsBacklog` to units
// actually sitting in closed/ready carts, so the avg-units-per-cart factor
// is baked into the unit count. Works the same for pick/rebin/pack.
// If `expectedUPH` is missing or 0 we return null so the caller can decide
// whether to warn or fall back.
function aaHoursDemand({ unitsBacklog, expectedUPH, role }) {
  const units = unitsBacklog || 0;
  if (!units) return 0;
  if (!expectedUPH || expectedUPH <= 0) return null;
  return units / expectedUPH;
}

function bestRateForAA({ aa, path, expected }) {
  const learned = aa.rates && aa.rates[path] && aa.rates[path].p50;
  if (learned && learned > 0) return { rate: learned, source: 'learned' };
  return { rate: expected[path] || 1, source: 'expected' };
}

function hoursInRole(now, startedAt) {
  if (!startedAt) return 0;
  return Math.max(0, (now - new Date(startedAt)) / 3600000);
}

function suggest({
  hc,
  hoursLeft,
  minDwellHrs = 5,
  demand,      // { [path]: { pickAAHrs, rebinAAHrs, packAAHrs } }
  expected,    // { [path]: uph }
  roster,      // [{ login, currentPath, startedAt, rates }]
  now = new Date()
}) {
  const assignments = [];
  const warnings = [];

  // --- Step 1: materialize remaining demand as an AA-hour bucket per path+role
  const remaining = {};  // key: `${path}|${role}` -> AA-hours
  for (const path of Object.keys(demand)) {
    const d = demand[path];
    if (d.pickAAHrs)  remaining[`${path}|pick`]  = d.pickAAHrs;
    if (d.rebinAAHrs) remaining[`${path}|rebin`] = d.rebinAAHrs;
    if (d.packAAHrs)  remaining[`${path}|pack`]  = d.packAAHrs;
  }

  // --- Step 2: lock AAs who are dwelling on their path for < minDwell hrs and
  // whose path still has demand. These get carried forward as-is.
  const availableAAs = [...roster];
  const locked = [];
  for (let i = availableAAs.length - 1; i >= 0; i--) {
    const aa = availableAAs[i];
    if (!aa.currentPath) continue;
    const key = aa.currentPath;  // currentPath as returned by FCLM is the sub-function/path
    const hasDemand = Object.keys(remaining).some(k => k.startsWith(`${key}|`) && remaining[k] > 0);
    if (!hasDemand) continue;
    const dwelled = hoursInRole(now, aa.startedAt);
    if (dwelled < minDwellHrs && (hoursLeft - dwelled) > 0) {
      // Keep them on current path.
      const planHrs = Math.max(0, Math.min(hoursLeft, minDwellHrs - dwelled));
      // Pick the first role with demand for this path.
      const roleKey = Object.keys(remaining).find(k => k.startsWith(`${key}|`) && remaining[k] > 0);
      if (!roleKey) continue;
      const [path, role] = roleKey.split('|');
      const { rate, source } = bestRateForAA({ aa, path, expected });
      // Convert the AA's hours to AA-hour credit against demand.
      remaining[roleKey] = Math.max(0, remaining[roleKey] - planHrs);
      assignments.push({
        login: aa.login, path, role, hours: planHrs, source,
        reason: `dwell-lock (${dwelled.toFixed(1)}h in role, minDwell ${minDwellHrs}h)`
      });
      locked.push(aa);
      availableAAs.splice(i, 1);
    }
  }

  // --- Step 3: fill remaining demand greedily.
  // Sort (path|role) buckets descending by AA-hours; within each, pick the AA
  // with the highest p50 rate (learned > expected fallback).
  const sortBuckets = () => Object.entries(remaining)
    .filter(([, h]) => h > 0.01)
    .sort((a, b) => b[1] - a[1]);

  let safety = 0;
  while (sortBuckets().length && availableAAs.length && safety++ < 500) {
    const [bucket, hrs] = sortBuckets()[0];
    const [path, role] = bucket.split('|');
    availableAAs.sort((a, b) => {
      const ra = bestRateForAA({ aa: a, path, expected }).rate;
      const rb = bestRateForAA({ aa: b, path, expected }).rate;
      return rb - ra;
    });
    const pick = availableAAs.shift();
    const { rate, source } = bestRateForAA({ aa: pick, path, expected });
    const giveHrs = Math.min(hoursLeft, hrs);
    remaining[bucket] = Math.max(0, hrs - giveHrs);
    assignments.push({
      login: pick.login, path, role, hours: giveHrs, source,
      reason: `greedy fill, p50=${rate.toFixed(1)}`
    });
  }

  // --- Step 4: flex + warnings
  for (const aa of availableAAs) {
    assignments.push({ login: aa.login, path: null, role: 'flex', hours: hoursLeft, source: 'unassigned',
                       reason: 'no bucket had demand given min-dwell constraints' });
  }
  for (const [bucket, hrs] of Object.entries(remaining)) {
    if (hrs > 0.5) {
      const [path, role] = bucket.split('|');
      warnings.push(`UNDERSTAFFED: ${path} ${role} short ${hrs.toFixed(1)} AA-hrs`);
    }
  }
  if (hc > roster.length) {
    warnings.push(`Roster has ${roster.length} AAs but hc input is ${hc}. Consider adding ${hc - roster.length} from flex pool.`);
  }

  return { assignments, warnings };
}

if (typeof self !== 'undefined') {
  self.Optimizer = { suggest, aaHoursDemand };
}
