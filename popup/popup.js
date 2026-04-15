// Popup controller. No data work happens here; the popup asks the background
// worker for everything via runtime.sendMessage.

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function send(type, extra = {}) {
  return new Promise(resolve => {
    api.runtime.sendMessage({ type, ...extra }, resolve);
  });
}

// --- Tabs -----------------------------------------------------------------
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
});

// --- Rates tab ------------------------------------------------------------
//
// Storage shape: { pick: {pathId: uph}, rebin: {pathId: uph}, pack: {pathId: uph} }.
// Only MultiSlam + Single have Rebin/Pack columns enabled (see paths.js).

async function loadRates() {
  const resp = await send('config.get', { key: 'rates', fallback: null });
  return migrateRates(resp && resp.value) || emptyRatesMap();
}

async function renderRates() {
  const rates = await loadRates();
  const tbody = $('#ratesTable tbody');
  tbody.innerHTML = '';
  PROCESS_PATHS.forEach(p => {
    const pick  = rates.pick[p.id]  != null ? rates.pick[p.id]  : p.defaultRate;
    const rebin = rates.rebin[p.id] != null ? rates.rebin[p.id] : '';
    const pack  = rates.pack[p.id]  != null ? rates.pack[p.id]  : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.label} <span class="muted">${p.id}</span></td>
      <td class="num"><input type="number" step="0.5" min="0" data-role="pick"  data-path="${p.id}" value="${pick}"></td>
      <td class="num"><input type="number" step="0.5" min="0" data-role="rebin" data-path="${p.id}" value="${rebin}" ${p.usesRebin ? '' : 'disabled'}></td>
      <td class="num"><input type="number" step="0.5" min="0" data-role="pack"  data-path="${p.id}" value="${pack}"  ${p.usesPack  ? '' : 'disabled'}></td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveRates() {
  const rates = emptyRatesMap();
  $$('#ratesTable input').forEach(inp => {
    if (inp.disabled) return;
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v) || v <= 0) return;
    rates[inp.dataset.role][inp.dataset.path] = v;
  });
  await send('config.set', { key: 'rates', value: rates });
  $('#planStatus').textContent = 'Rates saved.';
}

async function resetRates() {
  await send('config.set', { key: 'rates', value: null });
  await renderRates();
}

// Rate map consumed by the optimizer: every path gets a pick UPH (defaulted
// from the workbook), rebin/pack are populated only where set.
async function getRatesMap() {
  const rates = await loadRates();
  const out = { pick: {}, rebin: {}, pack: {} };
  for (const p of PROCESS_PATHS) {
    out.pick[p.id]  = rates.pick[p.id]  != null ? rates.pick[p.id]  : p.defaultRate;
    if (p.usesRebin && rates.rebin[p.id] != null) out.rebin[p.id] = rates.rebin[p.id];
    if (p.usesPack  && rates.pack[p.id]  != null) out.pack[p.id]  = rates.pack[p.id];
  }
  return out;
}

// Pull fleet UPH from FCLM Week rollup for Pick + Pack parents and display
// the raw subFunction → UPH list. User copies numbers into the right fields.
async function pullWeeklyRates() {
  $('#weeklyRatesOut').innerHTML = '<p class="muted">Fetching weekly rollup…</p>';
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const parents = [
    { id: FCLM_PROCESS_IDS.PICK, label: 'Pick (1003034)' },
    { id: FCLM_PROCESS_IDS.PACK, label: 'Pack (1003056)' }
  ];
  const blocks = [];
  for (const parent of parents) {
    const r = await send('fclm.weekly', { warehouse, processId: parent.id });
    if (!r || !r.ok) {
      blocks.push(`<p class="warning">Failed ${parent.label}: ${r && r.error}</p>`);
      continue;
    }
    // Aggregate fleet UPH per subFunction: sum(units) / sum(hours).
    const agg = {};
    for (const row of r.rows) {
      const sf = row.subFunction || '(unknown)';
      const slot = agg[sf] ||= { units: 0, hours: 0, n: 0 };
      slot.units += row.units || 0;
      slot.hours += row.hours || 0;
      slot.n++;
    }
    const sfRows = Object.entries(agg)
      .map(([sf, v]) => ({ sf, uph: v.hours > 0 ? v.units / v.hours : 0, n: v.n }))
      .sort((a, b) => b.uph - a.uph);
    const body = sfRows.map(x =>
      `<tr><td>${x.sf}</td><td class="num">${x.uph.toFixed(1)}</td><td class="num muted">${x.n}</td></tr>`
    ).join('');
    blocks.push(`
      <h4 style="margin:10px 0 4px;">${parent.label}</h4>
      <table><thead><tr><th>Sub-function</th><th class="num">Fleet UPH</th><th class="num">AAs</th></tr></thead>
      <tbody>${body || '<tr><td colspan=3 class="muted">no rows</td></tr>'}</tbody></table>
    `);
  }
  $('#weeklyRatesOut').innerHTML = blocks.join('');
}

$('#saveRates').addEventListener('click', saveRates);
$('#resetRates').addEventListener('click', resetRates);
$('#pullWeekly').addEventListener('click', pullWeeklyRates);

// --- Backlog tab ----------------------------------------------------------
// Module-scoped cache so generatePlan can reuse what refreshBacklog fetched.
let lastBacklog = null;
let lastPickable = null;

async function refreshBacklog() {
  const btn = $('#refreshBacklog');
  btn.disabled = true;
  $('#backlogStatus').textContent = 'Fetching Rodeo…';
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const paths = PROCESS_PATHS.map(p => p.id);

  const [bl, pk] = await Promise.all([
    send('rodeo.backlog',  { warehouse, paths }),
    send('rodeo.pickable', { warehouse })
  ]);
  btn.disabled = false;

  if (!bl || !bl.ok) { $('#backlogStatus').textContent = 'Backlog error: ' + (bl && bl.error); return; }
  if (!pk || !pk.ok) { $('#backlogStatus').textContent = 'Pickable error: ' + (pk && pk.error); return; }

  lastBacklog  = bl.backlog;
  lastPickable = pk.pickable;

  const tbody = $('#backlogTable tbody');
  tbody.innerHTML = '';
  PROCESS_PATHS.forEach(p => {
    const entry = lastBacklog[p.id] || {};
    const cc = entry.cartCounts || {};
    const uc = entry.unitCounts || {};
    const pickableUnits = (lastPickable.totals && lastPickable.totals[p.id]) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.label}</td>
      <td class="num">${pickableUnits}</td>
      <td class="num">${cc.rebinReady ?? '–'}</td>
      <td class="num">${cc.rebinInProgress ?? '–'}</td>
      <td class="num">${cc.packReady ?? '–'}</td>
      <td class="num">${uc.rebinReady ?? '–'}</td>
      <td class="num">${uc.packReady ?? '–'}</td>
    `;
    tbody.appendChild(tr);
  });
  $('#backlogStatus').textContent = 'Updated ' + new Date().toLocaleTimeString();
  return { backlog: lastBacklog, pickable: lastPickable };
}
$('#refreshBacklog').addEventListener('click', refreshBacklog);

// --- Plan tab -------------------------------------------------------------
// Module-scoped so Post-to-Slack can reuse the last plan without re-running.
let lastPlanInput = null;
let lastPlanOutput = null;

async function generatePlan() {
  $('#planStatus').textContent = 'Running…';
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const hc = parseInt($('#hc').value, 10);
  const hoursLeft = parseFloat($('#hoursLeft').value);
  const minDwell = parseFloat($('#minDwell').value);
  const shift = $('#shift').value;

  const expected = await getRatesMap();
  const fresh = await refreshBacklog();
  if (!fresh) { $('#planStatus').textContent = 'Backlog fetch failed.'; return; }
  const { backlog, pickable } = fresh;

  // Fetch the roster (rates + current assignment + dwell) from FCLM.
  $('#planStatus').textContent = 'Loading roster…';
  const rosterResp = await send('roster', { warehouse, shift });
  const roster = (rosterResp && rosterResp.ok) ? rosterResp.roster : [];
  if (!rosterResp || !rosterResp.ok) {
    $('#planStatus').textContent = 'Roster warning: ' + (rosterResp && rosterResp.error);
  }

  // Demand per path per role. Unit-based for all three roles:
  //   demandAAHrs = unitsInReadyBacklog / expectedUPH[role][path]
  // Cart classification already filtered to units in closed/ready carts.
  // If a role UPH is missing, aaHoursDemand returns null -> warn the user
  // instead of silently making the rebin/pack demand zero.
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

  // The optimizer only cares about pick UPH for AA selection; rebin/pack
  // rates already went into demand. Flatten expected.pick for the picker.
  const input = { hc, hoursLeft, minDwellHrs: minDwell, demand, expected: expected.pick, roster };
  const resp = await send('optimize', { input });
  if (!resp || !resp.ok) { $('#planStatus').textContent = 'Optimizer error.'; return; }

  if (missing.length) {
    resp.plan.warnings.unshift(`Missing role rate(s): ${missing.join(', ')} — demand for these was set to 0.`);
  }

  lastPlanInput = { warehouse, hc, hoursLeft, shift };
  lastPlanOutput = resp.plan;

  renderPlan(resp.plan.assignments, resp.plan.warnings);
  $('#planStatus').textContent = `Plan generated · ${roster.length} AAs in roster.`;
}
$('#generatePlan').addEventListener('click', generatePlan);

async function postToSlack() {
  if (!lastPlanOutput) { $('#planStatus').textContent = 'Generate a plan first.'; return; }
  $('#planStatus').textContent = 'Posting to Slack…';
  const payload = Slack.formatPlanForSlack({
    warehouse: lastPlanInput.warehouse,
    hc:        lastPlanInput.hc,
    hoursLeft: lastPlanInput.hoursLeft,
    shift:     lastPlanInput.shift,
    assignments: lastPlanOutput.assignments,
    warnings:    lastPlanOutput.warnings,
    backlog:     lastBacklog,
    pickable:    lastPickable
  });
  const r = await send('slack.post', { payload });
  $('#planStatus').textContent = r && r.ok ? 'Posted to Slack.' : ('Slack error: ' + (r && r.error));
}
$('#postSlack').addEventListener('click', postToSlack);

// Slack webhook save (in the Rates tab).
(async () => {
  const r = await send('config.get', { key: 'slackWebhook', fallback: '' });
  $('#slackWebhook').value = (r && r.value) || '';
})();
$('#saveSlack').addEventListener('click', async () => {
  const v = $('#slackWebhook').value.trim();
  await send('config.set', { key: 'slackWebhook', value: v });
  $('#planStatus').textContent = 'Slack webhook saved.';
});

function renderPlan(assignments, warnings) {
  const out = $('#planOutput');
  out.innerHTML = '';
  if (!assignments.length) {
    out.innerHTML = '<p class="muted">No assignments yet — roster feed is not wired up in v0.1.</p>';
  } else {
    const tbl = document.createElement('table');
    tbl.innerHTML = `<thead><tr>
      <th>Login</th><th>Path</th><th>Role</th><th class="num">Hours</th><th>Source</th><th>Reason</th>
    </tr></thead><tbody></tbody>`;
    const body = tbl.querySelector('tbody');
    for (const a of assignments) {
      const tr = document.createElement('tr');
      tr.className = 'assignment-row';
      tr.innerHTML = `
        <td>${a.login}</td>
        <td>${a.path || '—'}</td>
        <td>${a.role}</td>
        <td class="num">${a.hours.toFixed(1)}</td>
        <td class="source-${a.source}">${a.source}</td>
        <td class="muted">${a.reason || ''}</td>
      `;
      body.appendChild(tr);
    }
    out.appendChild(tbl);
  }

  const wrap = $('#planWarnings');
  wrap.innerHTML = '';
  for (const w of warnings) {
    const div = document.createElement('div');
    div.className = 'warning';
    div.textContent = w;
    wrap.appendChild(div);
  }
}

// --- Debug tab ------------------------------------------------------------
$('#pingBg').addEventListener('click', async () => {
  const r = await send('ping');
  $('#debugOut').textContent = JSON.stringify(r, null, 2);
});

$('#testFCLM').addEventListener('click', async () => {
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const shift = $('#shift').value;
  const r = await send('fclm.rollup', {
    warehouse, processId: FCLM_PROCESS_IDS.PICK, spanType: 'Intraday', shift
  });
  $('#debugOut').textContent = JSON.stringify(r, null, 2).slice(0, 4000);
});

// --- Init -----------------------------------------------------------------
renderRates();
