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

function buildPoolUrl({ warehouse, workPool, processPath, startMs, endMs }) {
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

// Parse a Rodeo ItemList HTML page into an array of row objects.
// Column order varies by enabledColumns; we map by header text.
function parseItemList(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = doc.querySelectorAll('table');
  let target = null;
  for (const t of tables) {
    const heads = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim());
    if (heads.includes('Pick Batch ID') && heads.includes('Scannable ID')) {
      target = t;
      break;
    }
  }
  if (!target) return [];

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
  return rows;
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

  const [rebinPoolRows, packPoolRows] = await Promise.all([
    fetchHtml(buildPoolUrl({ warehouse, workPool: 'PickingPicked', processPath, startMs, endMs }))
      .then(parseItemList),
    fetchHtml(buildPoolUrl({ warehouse, workPool: 'Sorted', processPath, startMs, endMs }))
      .then(parseItemList)
  ]);

  const rebinBatchIds = Object.keys(groupByBatch(rebinPoolRows));
  const packBatchIds  = Object.keys(groupByBatch(packPoolRows));

  const rebinReady       = [];
  const packReady        = [];
  const rebinInProgress  = [];

  // Classify each batch by fetching its full item list.
  // Serialized to be polite; swap for Promise.all in small chunks if needed.
  async function classify(batchIds, sourceWorkPool) {
    const out = [];
    for (const batchId of batchIds) {
      try {
        const full = parseItemList(await fetchHtml(buildBatchUrl({ warehouse, batchId })));
        const state = classifyBatch(full);
        const units = full.reduce((s, r) => s + (r.quantity || 1), 0);
        out.push({ batchId, items: full.length, units, state, sourceWorkPool });
      } catch (e) {
        out.push({ batchId, items: 0, units: 0, state: 'error', sourceWorkPool, error: String(e) });
      }
    }
    return out;
  }

  const rebinClassified = await classify(rebinBatchIds, 'PickingPicked');
  const packClassified  = await classify(packBatchIds,  'Sorted');

  for (const b of rebinClassified) {
    // In PickingPicked, all-ts means the cart is done filling and ready to rebin.
    if (b.state === 'ts_only') rebinReady.push(b);
    else if (b.state === 'rebin_in_progress') rebinInProgress.push(b);
  }
  for (const b of packClassified) {
    if (b.state === 'pack_ready') packReady.push(b);
    else if (b.state === 'rebin_in_progress') rebinInProgress.push(b);
  }

  return {
    processPath,
    rebinReady,
    packReady,
    rebinInProgress,
    // Totals the optimizer actually consumes:
    cartCounts: {
      rebinReady: rebinReady.length,
      packReady:  packReady.length,
      rebinInProgress: rebinInProgress.length
    },
    unitCounts: {
      rebinReady: rebinReady.reduce((s, b) => s + b.units, 0),
      packReady:  packReady.reduce((s, b) => s + b.units, 0)
    }
  };
}

if (typeof self !== 'undefined') {
  self.Rodeo = {
    buildPoolUrl,
    buildBatchUrl,
    fetchHtml,
    parseItemList,
    groupByBatch,
    getBacklogForPath
  };
}
