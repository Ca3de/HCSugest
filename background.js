// Background service worker.
//
// Two kinds of handlers:
//   * Synchronous message handlers (ping, fclm.rollup, slack.post, config.*,
//     optimize, etc.) — block on the caller and return a response.
//   * Fire-and-forget job handlers (job.startRefresh, job.startPlan) —
//     return immediately. The actual work runs in the background and writes
//     progress/results to storage.local. The UI subscribes via
//     storage.onChanged, so the popup can close and reopen without losing
//     anything.
//
// Storage keys used:
//   hc_cfg_snapshot     { backlog, pickable, at }
//   hc_cfg_lastPlan     { input, output, at }
//   hc_cfg_job          { id, type, status, step, since, done?, error? }

async function setJob(j) {
  await configSet('job', j);
}

// ----------------------------------------------------- Refresh (backlog) job
async function runRefreshJob({ warehouse, paths }) {
  const since = Date.now();
  const jobId = 'r-' + since;
  const write = step => setJob({ id: jobId, type: 'refresh', status: 'running', step, since });
  try {
    await write('Fetching pickable backlog (ExSD)…');
    const pickablePromise = Rodeo.getPickableBacklog({ warehouse }).catch(e => ({ error: String(e) }));

    await write(`Fetching cart pools for ${paths.length} paths…`);
    const CONCURRENCY = 3;
    const queue = paths.slice();
    const backlog = {};
    let doneCount = 0;
    const windowDays = msg.windowDays || 3;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const path = queue.shift();
        try {
          backlog[path] = await Rodeo.getBacklogForPath({ warehouse, processPath: path, windowDays });
        } catch (e) {
          backlog[path] = { error: String(e) };
        }
        doneCount++;
        await write(`Cart pools: ${doneCount}/${paths.length} paths…`);
      }
    }));

    const pickable = await pickablePromise;
    await configSet('snapshot', { backlog, pickable, at: Date.now() });
    await setJob({ id: jobId, type: 'refresh', status: 'done', step: 'Done.', since, done: Date.now() });
  } catch (e) {
    await setJob({ id: jobId, type: 'refresh', status: 'error', step: 'Error', since, done: Date.now(), error: String(e && e.stack || e) });
  }
}

// ---------------------------------------------------------------- Plan job
async function runPlanJob({ warehouse, hc, hoursLeft, minDwell, shift, expected }) {
  const since = Date.now();
  const jobId = 'p-' + since;
  const write = step => setJob({ id: jobId, type: 'plan', status: 'running', step, since });
  try {
    // 1. Backlog (reuse snapshot if < 10 min old; otherwise re-fetch).
    await write('Checking backlog snapshot…');
    let snap = await configGet('snapshot', null);
    if (!snap || (Date.now() - snap.at) > 10 * 60 * 1000) {
      await write('Snapshot stale — fetching Rodeo backlog…');
      await runRefreshJob({ warehouse, paths: PROCESS_PATHS.map(p => p.id) });
      snap = await configGet('snapshot', null);
    }
    const backlog  = (snap && snap.backlog)  || {};
    const pickable = (snap && snap.pickable) || { totals: {} };

    // 2. Roster (FCLM rollup + per-AA timeDetails).
    await write('Fetching FCLM roster + timeDetails…');
    const range = FCLM.shiftRange(shift || 'day');
    const parents = [FCLM_PROCESS_IDS.PICK, FCLM_PROCESS_IDS.PACK, FCLM_PROCESS_IDS.STOW];
    // FCLM doesn't tolerate 3 simultaneous requests from one session well
    // (observed: NetworkError on all 3 when fired in parallel). Performance-
    // validity serializes with backoff retry for 429s — we do the same here.
    const allRows = [];
    for (const pid of parents) {
      let attempt = 0, got = null;
      while (attempt < 3 && !got) {
        try {
          got = await FCLM.fetchFunctionRollup({
            warehouseId: warehouse, processId: pid, spanType: 'Intraday', range
          });
        } catch (e) {
          attempt++;
          if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
        }
      }
      if (got) for (const r of got) allRows.push({ ...r, parentProcessId: pid });
    }
    // functionRollup exposes badgeId, not login. Key the roster by badge.
    // (timeDetails also accepts employeeId/badge, so this is the right key.)
    const byBadge = {};
    for (const r of allRows) {
      const badge = r.badgeId || r.employeeId;
      if (!badge) continue;
      const slot = byBadge[badge] ||= {
        login: r.login || null,
        badge,
        name: r.name || badge,
        rates: {}
      };
      slot.rates[r.subFunction] = { p50: r.uph, units: r.units, hours: r.hours };
    }
    const roster0 = Object.values(byBadge);
    await write(`Fetching timeDetails for ${roster0.length} AAs…`);
    const CHUNK = 4;
    for (let i = 0; i < roster0.length; i += CHUNK) {
      const batch = roster0.slice(i, i + CHUNK);
      await Promise.all(batch.map(async slot => {
        try {
          const { segments, employee } = await FCLM.fetchTimeDetails({
            warehouseId: warehouse, employeeId: slot.badge, range
          });
          if (employee && employee.login) slot.login = employee.login;
          const cur = FCLM.currentAssignment(segments);
          if (cur) {
            slot.currentPath = cur.subFunction;
            slot.currentParent = cur.parentFunction;
            slot.startedAt = cur.startedAt;
            slot.stale = !!cur.stale;
          }
        } catch (e) { slot.error = String(e); }
      }));
      await write(`Fetching timeDetails… ${Math.min(i + CHUNK, roster0.length)}/${roster0.length}`);
    }
    const roster = roster0;

    // 3. Build demand + run optimizer.
    await write('Running optimizer…');
    const demand = {};
    const missing = [];
    for (const p of PROCESS_PATHS) {
      const e  = backlog[p.id] || {};
      const uc = e.unitCounts || {};
      const pickableUnits = (pickable.totals && pickable.totals[p.id]) || 0;
      const pickHrs  = Optimizer.aaHoursDemand({ unitsBacklog: pickableUnits,        expectedUPH: expected.pick[p.id],  role: 'pick'  });
      const rebinHrs = p.usesRebin ? Optimizer.aaHoursDemand({ unitsBacklog: uc.rebinReady || 0, expectedUPH: expected.rebin[p.id], role: 'rebin' }) : 0;
      const packHrs  = p.usesPack  ? Optimizer.aaHoursDemand({ unitsBacklog: uc.packReady  || 0, expectedUPH: expected.pack[p.id],  role: 'pack'  }) : 0;
      if (rebinHrs === null) missing.push(`${p.label} rebin`);
      if (packHrs  === null) missing.push(`${p.label} pack`);
      demand[p.id] = {
        pickAAHrs:  pickHrs  || 0,
        rebinAAHrs: (rebinHrs === null) ? 0 : rebinHrs,
        packAAHrs:  (packHrs  === null) ? 0 : packHrs
      };
    }
    const plan = Optimizer.suggest({
      hc, hoursLeft, minDwellHrs: minDwell, demand, expected: expected.pick, roster
    });
    if (missing.length) {
      plan.warnings.unshift(`Missing role rate(s): ${missing.join(', ')} — demand for these was set to 0.`);
    }

    const input  = { warehouse, hc, hoursLeft, shift };
    const output = plan;
    await configSet('lastPlan', { input, output, at: Date.now() });
    await setJob({ id: jobId, type: 'plan', status: 'done', step: `Plan · ${roster.length} AAs`, since, done: Date.now() });
  } catch (e) {
    await setJob({ id: jobId, type: 'plan', status: 'error', step: 'Error', since, done: Date.now(), error: String(e && e.stack || e) });
  }
}

// ---------------------------------------------------------- Message router
async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      return { ok: true, at: Date.now() };

    case 'fetchRaw': {
      // Re-fetch an arbitrary URL with user's credentials. Used by the Debug
      // tab's "Re-fetch full response" button when the 16 KB preview
      // wasn't enough to diagnose a parser issue.
      const res = await fetch(msg.url, { credentials: 'include' });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body };
    }

    // Fire-and-forget jobs. We start the task without awaiting so the
    // response returns immediately; the UI watches storage for updates.
    case 'job.startRefresh':
      runRefreshJob(msg).catch(e => setJob({
        type: 'refresh', status: 'error', error: String(e), since: Date.now(), done: Date.now()
      }));
      return { ok: true, started: true };

    case 'job.startPlan':
      runPlanJob(msg).catch(e => setJob({
        type: 'plan', status: 'error', error: String(e), since: Date.now(), done: Date.now()
      }));
      return { ok: true, started: true };

    // Synchronous endpoints still available for Debug tab, weekly-rates pull,
    // and anything else that wants an immediate response.
    case 'fclm.rollup': {
      const range = msg.range || FCLM.shiftRange(msg.shift || 'day');
      const rows = await FCLM.fetchFunctionRollup({
        warehouseId: msg.warehouse, processId: msg.processId, spanType: msg.spanType, range
      });
      return { ok: true, rows };
    }
    case 'fclm.weekly': {
      const now = new Date();
      const sunday = new Date(now);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      sunday.setHours(0, 0, 0, 0);
      const nextSunday = new Date(sunday);
      nextSunday.setDate(sunday.getDate() + 7);
      const rows = await FCLM.fetchFunctionRollup({
        warehouseId: msg.warehouse, processId: msg.processId, spanType: 'Week',
        range: { startDate: sunday, endDate: nextSunday, startHour: 0, endHour: 0 }
      });
      return { ok: true, rows };
    }

    case 'slack.post': {
      const webhook = (await configGet('slackWebhook', '')) || '';
      await Slack.postToSlack(webhook, msg.payload);
      return { ok: true };
    }

    case 'config.get':
      return { ok: true, value: await configGet(msg.key, msg.fallback) };
    case 'config.set':
      await configSet(msg.key, msg.value);
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

const api = (typeof browser !== 'undefined') ? browser : chrome;
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: String(e && e.stack || e) }));
  return true;
});
