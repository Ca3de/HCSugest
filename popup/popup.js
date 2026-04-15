// Shared UI controller for popup and fullpage dashboard.
//
// Architecture: the popup is STATELESS. It fires commands at the background
// ("start a refresh", "start a plan"), which writes to storage.local as it
// progresses. The UI re-renders whenever storage.onChanged fires. Close the
// popup at any time — work keeps going, and reopening shows the latest
// state with no loss. The fullpage tab uses this exact same code.

const api = (typeof browser !== 'undefined') ? browser : chrome;
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function send(type, extra = {}) {
  return new Promise(resolve => {
    api.runtime.sendMessage({ type, ...extra }, resolve);
  });
}

// ------------------------------------------------------------------ Tabs
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
});

// ------------------------------------------------------------ "Open in tab"
// From the popup, open the fullpage dashboard (or focus an existing one).
const FULLPAGE_URL = api.runtime.getURL('dashboard/dashboard.html');
const openTabLink = $('#openTab');
if (openTabLink) {
  openTabLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const tabs = await new Promise(r => api.tabs.query({ url: FULLPAGE_URL }, r));
    if (tabs && tabs.length) {
      api.tabs.update(tabs[0].id, { active: true });
      api.windows && api.windows.update(tabs[0].windowId, { focused: true });
    } else {
      api.tabs.create({ url: FULLPAGE_URL });
    }
    window.close();
  });
}

// ------------------------------------------------------------------ Rates
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
  flashStatus('Rates saved.');
}

async function resetRates() {
  await send('config.set', { key: 'rates', value: null });
  await renderRates();
}

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

async function getRatesMap() {
  const rates = await loadRates();
  const out = { pick: {}, rebin: {}, pack: {} };
  for (const p of PROCESS_PATHS) {
    out.pick[p.id] = rates.pick[p.id] != null ? rates.pick[p.id] : p.defaultRate;
    if (p.usesRebin && rates.rebin[p.id] != null) out.rebin[p.id] = rates.rebin[p.id];
    if (p.usesPack  && rates.pack[p.id]  != null) out.pack[p.id]  = rates.pack[p.id];
  }
  return out;
}

$('#saveRates').addEventListener('click', saveRates);
$('#resetRates').addEventListener('click', resetRates);
$('#pullWeekly').addEventListener('click', pullWeeklyRates);

// --------------------------------------------------------------- Slack cfg
(async () => {
  const r = await send('config.get', { key: 'slackWebhook', fallback: '' });
  $('#slackWebhook').value = (r && r.value) || '';
})();
$('#saveSlack').addEventListener('click', async () => {
  const v = $('#slackWebhook').value.trim();
  await send('config.set', { key: 'slackWebhook', value: v });
  flashStatus('Slack webhook saved.');
});

// ---------------------------------------------------------- Fire commands
// Commands return IMMEDIATELY from the background. The actual work runs
// async and writes progress + results to storage.local.

async function refreshBacklog() {
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const paths = PROCESS_PATHS.map(p => p.id);
  const r = await send('job.startRefresh', { warehouse, paths });
  if (!r || !r.ok) flashStatus('Failed to start: ' + (r && r.error));
}

async function generatePlan() {
  const warehouse = $('#warehouse').value.trim() || 'IND8';
  const hc = parseInt($('#hc').value, 10);
  const hoursLeft = parseFloat($('#hoursLeft').value);
  const minDwell = parseFloat($('#minDwell').value);
  const shift = $('#shift').value;
  const expected = await getRatesMap();
  const r = await send('job.startPlan', {
    warehouse, hc, hoursLeft, minDwell, shift, expected
  });
  if (!r || !r.ok) flashStatus('Failed to start: ' + (r && r.error));
}

async function postToSlack() {
  const snap = await savedGet('snapshot');
  const plan = await savedGet('lastPlan');
  if (!plan || !plan.output) { flashStatus('Generate a plan first.'); return; }
  const payload = Slack.formatPlanForSlack({
    warehouse: plan.input.warehouse,
    hc:        plan.input.hc,
    hoursLeft: plan.input.hoursLeft,
    shift:     plan.input.shift,
    assignments: plan.output.assignments,
    warnings:    plan.output.warnings,
    backlog:     snap && snap.backlog,
    pickable:    snap && snap.pickable
  });
  const r = await send('slack.post', { payload });
  flashStatus(r && r.ok ? 'Posted to Slack.' : ('Slack error: ' + (r && r.error)));
}

$('#refreshBacklog').addEventListener('click', refreshBacklog);
$('#generatePlan').addEventListener('click', generatePlan);
$('#postSlack').addEventListener('click', postToSlack);

// ---------------------------------------------------------- Debug buttons
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
$('#clearCache').addEventListener('click', async () => {
  await send('config.set', { key: 'snapshot', value: null });
  await send('config.set', { key: 'lastPlan', value: null });
  await send('config.set', { key: 'job', value: null });
  flashStatus('Cache cleared.');
  await renderFromStorage();
});

// --------------------------------------------------- Render from storage
// Single source of truth: storage.local. Called on page load, and on any
// storage.onChanged for our keys.
async function savedGet(key) {
  const r = await send('config.get', { key, fallback: null });
  return r && r.value;
}

function setProgress(text, spinning = false) {
  const el = $('#planProgress');
  if (!el) return;
  if (!text) { el.classList.remove('active'); el.textContent = ''; return; }
  el.classList.add('active');
  el.innerHTML = (spinning ? '<span class="spinner"></span>' : '') + escapeHtml(text);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let _flashTimer = null;
function flashStatus(msg) {
  const el = $('#planStatus');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

async function renderJob() {
  const job = await savedGet('job');
  if (!job) { setProgress(''); return; }
  if (job.status === 'running') {
    setProgress(`${job.type.toUpperCase()} running · ${job.step || '…'}`, true);
    // Disable the generate button while running
    $('#generatePlan').disabled = (job.type === 'plan');
    $('#refreshBacklog').disabled = (job.type === 'refresh' || job.type === 'plan');
  } else if (job.status === 'done') {
    const dt = ((job.done - job.since) / 1000).toFixed(1);
    setProgress(`${job.type.toUpperCase()} done in ${dt}s.`);
    $('#generatePlan').disabled = false;
    $('#refreshBacklog').disabled = false;
  } else if (job.status === 'error') {
    setProgress(`${job.type.toUpperCase()} FAILED: ${job.error}`);
    $('#generatePlan').disabled = false;
    $('#refreshBacklog').disabled = false;
  }
}

async function renderBacklog() {
  const snap = await savedGet('snapshot');
  const tbody = $('#backlogTable tbody');
  tbody.innerHTML = '';
  const lastBacklog  = snap && snap.backlog  || {};
  const lastPickable = snap && snap.pickable || { totals: {} };
  PROCESS_PATHS.forEach(p => {
    const entry = lastBacklog[p.id] || {};
    const cc = entry.cartCounts || {};
    const uc = entry.unitCounts || {};
    const pickableUnits = (lastPickable.totals && lastPickable.totals[p.id]) || 0;
    const err = entry.error ? ` <span class="muted" title="${escapeHtml(entry.error)}">⚠</span>` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.label}${err}</td>
      <td class="num">${pickableUnits}</td>
      <td class="num">${cc.rebinReady ?? '–'}</td>
      <td class="num">${cc.rebinInProgress ?? '–'}</td>
      <td class="num">${cc.packReady ?? '–'}</td>
      <td class="num">${uc.rebinReady ?? '–'}</td>
      <td class="num">${uc.packReady ?? '–'}</td>
    `;
    tbody.appendChild(tr);
  });
  if (snap && snap.at) {
    const ageMin = Math.max(0, Math.round((Date.now() - snap.at) / 60000));
    $('#backlogStatus').textContent = `Snapshot · ${ageMin} min old`;
  } else {
    $('#backlogStatus').textContent = 'No snapshot yet.';
  }
}

async function renderPlanFromStorage() {
  const plan = await savedGet('lastPlan');
  const out = $('#planOutput');
  const wrap = $('#planWarnings');
  out.innerHTML = '';
  wrap.innerHTML = '';
  if (!plan || !plan.output) {
    out.innerHTML = '<p class="muted">No plan yet. Click "Generate plan" — you can close this popup while it runs.</p>';
    $('#planStatus').textContent = '';
    return;
  }
  const { assignments, warnings } = plan.output;
  if (!assignments.length) {
    out.innerHTML = `<p class="muted">No assignments. Roster returned 0 AAs — check Debug tab → "Test FCLM rollup (Pick)".</p>`;
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
        <td class="muted">${escapeHtml(a.reason || '')}</td>
      `;
      body.appendChild(tr);
    }
    out.appendChild(tbl);
  }
  for (const w of warnings) {
    const div = document.createElement('div');
    div.className = 'warning';
    div.textContent = w;
    wrap.appendChild(div);
  }
  const ageMin = Math.max(0, Math.round((Date.now() - plan.at) / 60000));
  $('#planStatus').textContent = `Plan · ${ageMin} min old`;
}

async function renderFromStorage() {
  await Promise.all([renderJob(), renderBacklog(), renderPlanFromStorage()]);
}

// Subscribe to storage changes so progress updates live while popup is open.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['hc_cfg_job'])       renderJob();
  if (changes['hc_cfg_snapshot'])  renderBacklog();
  if (changes['hc_cfg_lastPlan'])  renderPlanFromStorage();
});

// ------------------------------------------------------------------- Init
(async () => {
  await renderRates();
  await renderFromStorage();
})();
