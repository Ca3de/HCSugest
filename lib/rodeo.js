// Rodeo client. Hits rodeo-iad.amazon.com/<warehouse>/ItemList with the
// user's Midway cookie (credentials: 'include'). Pulls FRACS backlog
// broken down by cart state using the scannable-ID classifier in paths.js.
//
// There are two pool queries per process path:
//
//   Rebin pool (ready-to-rebin + rebin-in-progress carts)
//     WorkPool=PickingPicked
//
//   Pack pool (pack-ready carts, plus rebin-in-progress that slipped forward)
//     WorkPool=Sorted
//
// For each batch ID discovered, we re-query /ItemList?PickBatchId=<id> to
// get the full batch item list and classify it with classifyBatch().
//
// TODO: pagination on the pool-level query. Rodeo renders "Page 1 / Next".
//       v0.1 only pulls the first page (48 items). Enough to validate the
//       classifier end-to-end; the loop is straightforward once the parser
//       survives real data.

const RODEO_BASE = 'https://rodeo-iad.amazon.com';

// Max page size Rodeo will honor on ItemList. Confirmed by the user.
const RODEO_MAX_PAGE_SIZE = 1000;

// Pre-pick work pools — everything that's actionable but not yet picked.
// These are the tri-selected values on the ExSD report URL.
const PICKABLE_WORK_POOLS = [
  'ReadyToPick',
  'PickingNotYetPicked',
  'CrossdockNotYetPicked'
];

function buildPoolUrl({ warehouse, workPool, processPath, startMs, endMs, page = 1, pageSize = RODEO_MAX_PAGE_SIZE }) {
  const url = new URL(`${RODEO_BASE}/${warehouse}/ItemList`);
  url.searchParams.set('ShipOption', FRACS_SHIP_OPTIONS);
  url.searchParams.set('_enabledColumns', 'on');
  url.searchParams.set('enabledColumns', 'LPN');
  url.searchParams.set('WorkPool', workPool);
  url.searchParams.set('Fracs', 'FRACS');
  url.searchParams.set('ProcessPath', processPath);
  url.searchParams.set('shipmentType', 'CUSTOMER_SHIPMENTS');
  url.searchParams.set('ExSDRange.RangeStartMillis', String(startMs));
  url.searchParams.set('ExSDRange.RangeEndMillis',   String(endMs));
  url.searchParams.set('pager.CUSTOMER_SHIPMENTS.currentPage', String(page));
  url.searchParams.set('pager.CUSTOMER_SHIPMENTS.pageSize',    String(pageSize));
  return url.toString();
}

// ExSD Work-Pool-by-Process-Path pivot report. Source for pre-pick backlog.
// yAxis=PROCESS_PATH, zAxis=WORK_POOL, shipmentTypes=CUSTOMER_SHIPMENTS.
// Response is an HTML page with one section per work pool, each containing
// a table whose rows are process paths and whose last column is "Total".
function buildExSDUrl({ warehouse }) {
  const url = new URL(`${RODEO_BASE}/${warehouse}/ExSD`);
  url.searchParams.set('yAxis', 'PROCESS_PATH');
  url.searchParams.set('zAxis', 'WORK_POOL');
  url.searchParams.set('shipmentTypes', 'CUSTOMER_SHIPMENTS');
  url.searchParams.set('exSDRange.quickRange', 'ALL');
  url.searchParams.set('exSDRange.dailyStart', '00:00');
  url.searchParams.set('exSDRange.dailyEnd',   '00:00');
  url.searchParams.set('giftOption', 'ALL');
  url.searchParams.set('fulfillmentServiceClass', 'ALL');
  url.searchParams.set('fracs', 'ALL');
  // Tri-select: three copies of workPool + _workPool=on sentinels.
  for (const wp of PICKABLE_WORK_POOLS) url.searchParams.append('workPool', wp);
  for (const _ of PICKABLE_WORK_POOLS) url.searchParams.append('_workPool', 'on');
  url.searchParams.set('processPath', '');
  url.searchParams.set('minPickPriority', 'MIN_PRIORITY');
  url.searchParams.set('shipMethod', '');
  url.searchParams.set('shipOption', '');
  url.searchParams.set('sortCode', '');
  return url.toString();
}

function buildBatchUrl({ warehouse, batchId }) {
  const url = new URL(`${RODEO_BASE}/${warehouse}/ItemList`);
  url.searchParams.set('_enabledColumns', 'on');
  url.searchParams.set('enabledColumns', 'LPN');
  url.searchParams.set('PickBatchId', batchId);
  return url.toString();
}

async function fetchHtml(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Rodeo ${res.status} ${url}`);
  return res.text();
}

// Parse a Rodeo ItemList HTML page into { rows, total, page, pageSize }.
// Header text "Showing 1 - 1000 of 4620 results" drives pagination.
function parseItemList(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Total / page metadata: "Showing 1 - 1000 of 4620 results"
  let total = null;
  const showingText = doc.body ? doc.body.textContent : '';
  const m = showingText.match(/Showing\s+[\d,]+\s*-\s*[\d,]+\s+of\s+([\d,]+)\s+results/i);
  if (m) total = parseInt(m[1].replace(/,/g, ''), 10);

  const tables = doc.querySelectorAll('table');
  let target = null;
  for (const t of tables) {
    const heads = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim());
    if (heads.includes('Pick Batch ID') && heads.includes('Scannable ID')) {
      target = t;
      break;
    }
  }
  if (!target) return { rows: [], total: total || 0 };

  const heads = Array.from(target.querySelectorAll('th')).map(th => th.textContent.trim());
  const idx = name => heads.indexOf(name);

  const rows = [];
  for (const tr of target.querySelectorAll('tbody tr')) {
    const tds = tr.querySelectorAll('td');
    if (!tds.length) continue;
    const cell = i => (i >= 0 && tds[i]) ? tds[i].textContent.trim() : '';
    rows.push({
      shipmentId:  cell(idx('Shipment ID')),
      fnSku:       cell(idx('FN SKU')),
      lpn:         cell(idx('LPN')),
      scannableId: cell(idx('Scannable ID')),
      condition:   cell(idx('Condition')),
      shipMethod:  cell(idx('Ship Method')),
      shipOption:  cell(idx('Ship Option')),
      processPath: cell(idx('Process Path')),
      pickPriority: cell(idx('Pick Priority')),
      batchId:     cell(idx('Pick Batch ID')),
      quantity:    parseInt(cell(idx('Quantity')) || '0', 10) || 0,
      status:      cell(idx('Status'))
    });
  }
  return { rows, total: total ?? rows.length };
}

// Fetch all pages of an ItemList query and concatenate rows. Caps at
// RODEO_MAX_PAGE_SIZE per page (1000). We iterate up to `maxPages` to avoid
// pathological loops.
async function fetchPoolAllPages({ warehouse, workPool, processPath, startMs, endMs, maxPages = 20 }) {
  const rows = [];
  let page = 1, total = null;
  let firstHtml = null;
  while (page <= maxPages) {
    const url = buildPoolUrl({ warehouse, workPool, processPath, startMs, endMs, page });
    const html = await fetchHtml(url);
    if (page === 1) firstHtml = { url, body: html };
    const { rows: pageRows, total: pageTotal } = parseItemList(html);
    if (total == null) total = pageTotal;
    rows.push(...pageRows);
    if (rows.length >= (total || 0) || pageRows.length < RODEO_MAX_PAGE_SIZE) break;
    page++;
  }
  // Sample one representative pool response per (pool, path) combo so we can
  // see what's actually coming back without drowning in batch queries.
  if (firstHtml && self.Debug) {
    await self.Debug.recordSample({
      kind: `rodeo-pool-${processPath}-${workPool}`,
      url: firstHtml.url, status: 200, body: firstHtml.body,
      parseSummary: { rows: rows.length, total, pages: page, uniqueBatches: new Set(rows.map(r => r.batchId)).size }
    });
  }
  return { rows, total: total || rows.length, pages: page };
}

function groupByBatch(rows) {
  const map = Object.create(null);
  for (const r of rows) {
    if (!r.batchId) continue;
    (map[r.batchId] ||= []).push(r);
  }
  return map;
}

// Given a warehouse and a process path, return the cart-level backlog.
// Each returned batch has { batchId, itemCount, units }.
async function getBacklogForPath({ warehouse, processPath, windowDays = 14 }) {
  const now = Date.now();
  const startMs = now - windowDays * 86400000;
  const endMs   = now + 86400000;

  const [rebinPool, packPool] = await Promise.all([
    fetchPoolAllPages({ warehouse, workPool: 'PickingPicked', processPath, startMs, endMs }),
    fetchPoolAllPages({ warehouse, workPool: 'Sorted',        processPath, startMs, endMs })
  ]);

  // Dedupe batch IDs across pools — a batch with items in both pools
  // (mid-state) was being classified twice, inflating the counts.
  const allBatchIds = Array.from(new Set([
    ...Object.keys(groupByBatch(rebinPool.rows)),
    ...Object.keys(groupByBatch(packPool.rows))
  ]));

  const rebinReady      = [];
  const packReady       = [];
  const rebinInProgress = [];
  const excluded        = []; // error/packing/unknown — kept for debug

  async function classify(batchIds, concurrency = 6) {
    const out = new Array(batchIds.length);
    let next = 0;
    async function worker() {
      while (next < batchIds.length) {
        const i = next++;
        const batchId = batchIds[i];
        try {
          const { rows: full } = parseItemList(await fetchHtml(buildBatchUrl({ warehouse, batchId })));
          const state = classifyBatch(full);
          const units = full.reduce((s, r) => s + (r.quantity || 1), 0);
          out[i] = { batchId, items: full.length, units, state };
        } catch (e) {
          out[i] = { batchId, items: 0, units: 0, state: 'error', error: String(e) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batchIds.length) }, worker));
    return out;
  }

  const classified = await classify(allBatchIds);

  // Bucket by batch state alone — no longer keyed off source pool, which
  // was the root of the double-counting. A batch's state is intrinsic:
  // all-ts = rebin-ready, all-rb = pack-ready, mixed ts+rb = rebin-in-progress.
  for (const b of classified) {
    switch (b.state) {
      case 'ts_only':           rebinReady.push(b); break;
      case 'pack_ready':        packReady.push(b); break;
      case 'rebin_in_progress': rebinInProgress.push(b); break;
      default:                  excluded.push(b); // packing, error, mixed, unknown
    }
  }

  return {
    processPath,
    rebinReady,
    packReady,
    rebinInProgress,
    excluded,
    cartCounts: {
      rebinReady: rebinReady.length,
      packReady:  packReady.length,
      rebinInProgress: rebinInProgress.length,
      excluded: excluded.length
    },
    unitCounts: {
      rebinReady: rebinReady.reduce((s, b) => s + b.units, 0),
      packReady:  packReady.reduce((s, b) => s + b.units, 0)
    }
  };
}

// Parse the ExSD Work-Pool-by-Process-Path report into:
//   { [workPool]: { [processPath]: totalUnits } }
// Each work pool renders as its own section; within a section there's a
// table with rows per process path. The final column header is "Total".
// The section label is the text of the preceding heading (<h2>, <h3>, or
// a bolded label). We match on the PICKABLE_WORK_POOLS names.
function parseExSDReport(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = {};
  for (const pool of PICKABLE_WORK_POOLS) out[pool] = {};

  // Strategy: walk every table, derive its section from the nearest
  // preceding heading-like node whose text matches a known work pool.
  const tables = Array.from(doc.querySelectorAll('table'));
  for (const table of tables) {
    const heads = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
      .map(th => th.textContent.trim());
    if (!heads.length) continue;
    const totalIdx = heads.findIndex(h => /^total$/i.test(h));
    if (totalIdx < 0) continue;

    // Find preceding section label.
    let label = '';
    for (let el = table.previousElementSibling, hops = 0;
         el && hops < 8; el = el.previousElementSibling, hops++) {
      const t = el.textContent && el.textContent.trim();
      if (!t) continue;
      const hit = PICKABLE_WORK_POOLS.find(p => t.includes(p));
      if (hit) { label = hit; break; }
    }
    if (!label) continue;

    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td, th');
      if (tds.length <= totalIdx) continue;
      const path = tds[0].textContent.trim();
      if (!path || /^total$/i.test(path)) continue;
      const total = parseInt(tds[totalIdx].textContent.replace(/[, ]/g, ''), 10);
      if (!Number.isFinite(total)) continue;
      out[label][path] = total;
    }
  }
  return out;
}

// Fetch pre-pick backlog. Returns per-process-path pickable totals,
// summed across ReadyToPick + PickingNotYetPicked + CrossdockNotYetPicked.
async function getPickableBacklog({ warehouse }) {
  const url = buildExSDUrl({ warehouse });
  const res = await fetch(url, { credentials: 'include' });
  const html = await res.text();
  if (!res.ok) {
    self.Debug && await self.Debug.recordSample({ kind: 'rodeo-exsd', url, status: res.status, body: html, error: `HTTP ${res.status}` });
    throw new Error(`Rodeo ExSD ${res.status}`);
  }
  const byPool = parseExSDReport(html);
  const summed = {};
  for (const pool of PICKABLE_WORK_POOLS) {
    for (const [path, count] of Object.entries(byPool[pool] || {})) {
      summed[path] = (summed[path] || 0) + count;
    }
  }
  // Log every call — this one is cheap and gets called once per refresh.
  self.Debug && await self.Debug.recordSample({
    kind: 'rodeo-exsd', url, status: res.status, body: html,
    parseSummary: {
      pools: Object.keys(byPool),
      entriesPerPool: Object.fromEntries(Object.entries(byPool).map(([k, v]) => [k, Object.keys(v).length])),
      totals: summed
    }
  });
  return { byPool, totals: summed };
}

if (typeof self !== 'undefined') {
  self.Rodeo = {
    buildPoolUrl,
    buildBatchUrl,
    buildExSDUrl,
    fetchHtml,
    parseItemList,
    parseExSDReport,
    groupByBatch,
    fetchPoolAllPages,
    getBacklogForPath,
    getPickableBacklog,
    PICKABLE_WORK_POOLS
  };
}
