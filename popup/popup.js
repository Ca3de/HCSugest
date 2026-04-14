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
async function refreshBacklog() {
  const btn = $('#refreshBacklog');
  btn.disabled = true;
  $('#backlogStatus').textContent = 'Fetching Rodeo…';
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const paths = PROCESS_PATHS.map(p => p.id);
  const resp = await send('rodeo.backlog', { warehouse, paths });
  btn.disabled = false;

  if (!resp || !resp.ok) {
    $('#backlogStatus').textContent = 'Error: ' + (resp && resp.error);
    return;
  }
  const tbody = $('#backlogTable tbody');
  tbody.innerHTML = '';
  PROCESS_PATHS.forEach(p => {
    const entry = resp.backlog[p.id] || {};
    const cc = entry.cartCounts || {};
    const uc = entry.unitCounts || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.label}</td>
      <td class="num">${cc.rebinReady ?? '–'}</td>
      <td class="num">${cc.rebinInProgress ?? '–'}</td>
      <td class="num">${cc.packReady ?? '–'}</td>
      <td class="num">${uc.rebinReady ?? '–'}</td>
      <td class="num">${uc.packReady ?? '–'}</td>
    `;
    tbody.appendChild(tr);
  });
  $('#backlogStatus').textContent = 'Updated ' + new Date().toLocaleTimeString();
  return resp.backlog;
}
$('#refreshBacklog').addEventListener('click', refreshBacklog);

// --- Plan tab -------------------------------------------------------------
async function generatePlan() {
  $('#planStatus').textContent = 'Running…';
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const hc = parseInt($('#hc').value, 10);
  const hoursLeft = parseFloat($('#hoursLeft').value);
  const minDwell = parseFloat($('#minDwell').value);
  const shift = $('#shift').value;

  const expected = await getRatesMap();
  const backlog = await refreshBacklog();  // forces a refresh before planning
  if (!backlog) { $('#planStatus').textContent = 'Backlog fetch failed.'; return; }

  // Demand per path: pick-hours comes from a separate signal we don't have
  // yet (RFEA actionable units by path). v0.1 drives purely off the cart
  // backlog for MultiSlam rebin/pack; other paths get a placeholder.
  const demand = {};
  for (const p of PROCESS_PATHS) {
    const e = backlog[p.id] || {};
    const cc = e.cartCounts || {};
    demand[p.id] = {
      pickAAHrs:  0,                              // TODO: wire up RFEA actionable-unit feed
      rebinAAHrs: Optimizer ? Optimizer.aaHoursDemand({ cartsBacklog: cc.rebinReady || 0, role: 'rebin' }) : 0,
      packAAHrs:  Optimizer ? Optimizer.aaHoursDemand({ cartsBacklog: cc.packReady  || 0, role: 'pack'  }) : 0
    };
  }
  // Note: Optimizer lives in background context, not popup. Ask it over the wire.

  const roster = []; // TODO: populate from fclm.rollup intraday for today's shift.

  const resp = await send('optimize', {
    input: { hc, hoursLeft, minDwellHrs: minDwell, demand, expected, roster }
  });
  if (!resp || !resp.ok) { $('#planStatus').textContent = 'Optimizer error.'; return; }

  const { assignments, warnings } = resp.plan;
  renderPlan(assignments, warnings);
  $('#planStatus').textContent = 'Plan generated.';
}
$('#generatePlan').addEventListener('click', generatePlan);

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
