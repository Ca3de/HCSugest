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

// Every post-pick work pool. When we query a batch by PickBatchId we MUST
// set WorkPool to all of these — otherwise Rodeo returns a subset (typical
// default excludes Packing/Scanned/etc), and classifyBatch sees only
// partial state. E.g. a batch mid-pack would have its sp* items hidden, be
// read as 'all ts', and wrongly counted as rebin-ready. Confirmed source
// of the 26-vs-11 gap in the floor count.
const ALL_POST_PICK_WORK_POOLS = [
  'PickingPicked',
  'PickingPickedInProgress',
  'PickingPickedInTransit',
  'PickingPickedRouting',
  'PickingPickedAtDestination',
  'Inducted',
  'RebinBuffered',
  'Sorted',
  'GiftWrap',
  'Packing',
  'Scanned',
  'ProblemSolving',
  'ProcessPartial',
  'SoftwareException',
  'Crossdock',
  'PreSort',
  'TransshipSorted',
  'Palletized'
].join(',');

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
  // Include every post-pick pool so classifyBatch sees the true state of
  // the batch's items. Without this, items that moved to Packing/Scanned
  // are filtered out and a half-packed cart looks like 'all ts' to us.
  url.searchParams.set('WorkPool', ALL_POST_PICK_WORK_POOLS);
  url.searchParams.set('pager.CUSTOMER_SHIPMENTS.pageSize', String(RODEO_MAX_PAGE_SIZE));
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
      workPool:    cell(idx('Work Pool')),
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
//
// windowDays: how far back the ExSDRange filter goes. Now that the
// classifier is strict (only pure ts* or rb* qualifies), a wide window
// won't cause false positives — it just ensures we don't miss batches
// whose Expected Ship Date is older. Default 30 days.
async function getBacklogForPath({ warehouse, processPath, windowDays = 30 }) {
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
  const stateBreakdown = {
    rebin_ready: 0, pack_ready: 0, rebin_in_progress: 0,
    being_picked: 0, packing: 0, mixed: 0, unknown: 0, error: 0
  };
  for (const b of classified) {
    stateBreakdown[b.state] = (stateBreakdown[b.state] || 0) + 1;
    switch (b.state) {
      case 'rebin_ready':       rebinReady.push(b); break;
      case 'pack_ready':        packReady.push(b); break;
      case 'rebin_in_progress': rebinInProgress.push(b); break;
      // being_picked / packing / mixed / unknown / error -> excluded
      default:                  excluded.push(b);
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
    },
    // Full breakdown of what the classifier saw per state. Helps reconcile
    // Rodeo's count with a floor eyeball.
    stateBreakdown,
    totalBatchesSeen: allBatchIds.length
  };
}

// Parse the ExSD Work-Pool-by-Process-Path report into:
//   { [workPool]: { [processPath]: totalUnits } }
// Each work pool renders as its own section; within a section there's a
// table with rows per process path. The final column header is "Total".
// The section label is the text of the preceding heading (<h2>, <h3>, or
// a bolded label). We match on the PICKABLE_WORK_POOLS names.
// Find a work-pool label for a given table by walking up the DOM.
// Checks: preceding siblings (20 hops), parent's first text children,
// aria/heading text on ancestors. Returns '' if none found.
function labelForTable(table) {
  function hit(text) {
    if (!text) return '';
    for (const p of PICKABLE_WORK_POOLS) if (text.includes(p)) return p;
    return '';
  }
  // preceding siblings
  for (let el = table.previousElementSibling, hops = 0; el && hops < 20; el = el.previousElementSibling, hops++) {
    const t = (el.textContent || '').trim().slice(0, 200);
    const h = hit(t);
    if (h) return h;
  }
  // ancestor chain — check immediate header-ish children
  for (let p = table.parentElement, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
    for (const n of p.children) {
      if (n === table) break;
      const t = (n.textContent || '').trim().slice(0, 200);
      const h = hit(t);
      if (h) return h;
    }
  }
  return '';
}

function parseExSDReport(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = {};
  for (const pool of PICKABLE_WORK_POOLS) out[pool] = {};
  out._unlabeled = {}; // tables we couldn't associate with a pool

  // Strategy: every table whose tbody has ≥1 row whose first cell looks
  // like a process path is treated as a path-by-ExSD table. We read a
  // "total" column — preferring an explicit Total header, falling back
  // to the last numeric column.
  const tables = Array.from(doc.querySelectorAll('table'));
  for (const table of tables) {
    // Does this table have process-path rows?
    const bodyRows = table.querySelectorAll('tbody tr, tr');
    let pathRows = [];
    for (const tr of bodyRows) {
      const first = tr.querySelector('td, th');
      if (!first) continue;
      const key = first.textContent.trim();
      if (/^PPFracs/i.test(key)) pathRows.push({ tr, key });
    }
    if (!pathRows.length) continue;

    // Find a "Total" column index; fall back to last numeric column.
    const headerCells = Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
      .map(c => c.textContent.trim());
    let totalIdx = headerCells.findIndex(h => /^total$/i.test(h));

    const label = labelForTable(table) || '_unlabeled';
    const bucket = out[label] ||= {};

    for (const { tr, key } of pathRows) {
      const cells = tr.querySelectorAll('td, th');
      let n = NaN;
      if (totalIdx >= 0 && cells[totalIdx]) {
        n = parseInt((cells[totalIdx].textContent || '').replace(/[, ]/g, ''), 10);
      }
      if (!Number.isFinite(n)) {
        // last numeric cell
        for (let i = cells.length - 1; i > 0; i--) {
          const v = parseInt((cells[i].textContent || '').replace(/[, ]/g, ''), 10);
          if (Number.isFinite(v)) { n = v; break; }
        }
      }
      if (!Number.isFinite(n)) continue;
      // If we see the same path twice in the same bucket, keep the larger
      // (handles header-row/total-row duplicates defensively).
      bucket[key] = Math.max(bucket[key] || 0, n);
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
  // Sum labelled pools. If nothing got labelled (label detection failed),
  // fall back to the _unlabeled bucket so we're not silently empty.
  const labelled = PICKABLE_WORK_POOLS.filter(p => Object.keys(byPool[p] || {}).length > 0);
  const sources = labelled.length ? labelled : ['_unlabeled'];
  for (const pool of sources) {
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
