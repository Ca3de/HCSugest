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
async function renderRates() {
  const stored = await send('config.get', { key: 'rates', fallback: null });
  const tbody = $('#ratesTable tbody');
  tbody.innerHTML = '';
  PROCESS_PATHS.forEach(p => {
    const current = (stored && stored.value && stored.value[p.id] != null)
      ? stored.value[p.id] : p.defaultRate;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.label} <span class="muted">${p.id}</span></td>
      <td class="num"><input type="number" step="0.5" min="1" data-path="${p.id}" value="${current}"></td>
    `;
    tbody.appendChild(tr);
  });
}

async function saveRates() {
  const map = {};
  $$('#ratesTable input').forEach(inp => {
    map[inp.dataset.path] = parseFloat(inp.value) || 0;
  });
  await send('config.set', { key: 'rates', value: map });
  $('#planStatus').textContent = 'Rates saved.';
}

async function resetRates() {
  await send('config.set', { key: 'rates', value: null });
  await renderRates();
}

async function getRatesMap() {
  const resp = await send('config.get', { key: 'rates', fallback: null });
  const stored = resp && resp.value;
  const map = {};
  PROCESS_PATHS.forEach(p => {
    map[p.id] = (stored && stored[p.id] != null) ? stored[p.id] : p.defaultRate;
  });
  return map;
}

$('#saveRates').addEventListener('click', saveRates);
$('#resetRates').addEventListener('click', resetRates);

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

  // Demand per path. Pick demand is now real: pickable units / expected UPH.
  // Rebin/Pack demand is carts / (carts-per-AA-per-hour), handled inside
  // the optimizer helper. Those constants are still hardcoded (1.5, 2.0).
  const demand = {};
  for (const p of PROCESS_PATHS) {
    const e = backlog[p.id] || {};
    const cc = e.cartCounts || {};
    const pickableUnits = (pickable.totals && pickable.totals[p.id]) || 0;
    demand[p.id] = {
      pickAAHrs:  Optimizer.aaHoursDemand({ unitsBacklog: pickableUnits, expectedUPH: expected[p.id], role: 'pick'  }),
      rebinAAHrs: Optimizer.aaHoursDemand({ cartsBacklog: cc.rebinReady || 0, role: 'rebin' }),
      packAAHrs:  Optimizer.aaHoursDemand({ cartsBacklog: cc.packReady  || 0, role: 'pack'  })
    };
  }

  const input = { hc, hoursLeft, minDwellHrs: minDwell, demand, expected, roster };
  const resp = await send('optimize', { input });
  if (!resp || !resp.ok) { $('#planStatus').textContent = 'Optimizer error.'; return; }

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
