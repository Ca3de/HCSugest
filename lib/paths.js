// Process paths, default rates, and cart-state rules.
// Defaults are taken from the IND8 Pick Staffing v1.9 spreadsheet
// (column D on the "IND8 Pick Staffing Model" sheet) as a seed.
// Users override these in the popup; the values live in chrome.storage.local
// under key 'hc_rates'. A real weekly-rates API can replace this later.

// Each path has a Pick rate (every path is picked). Only the "cart" paths —
// MultiSlam and Single — have Rebin + Pack roles downstream. Stow uses carts
// too but its demand model is different and is deferred.
const PROCESS_PATHS = [
  { id: 'PPFracsDonate',       label: 'Donate',        defaultRate: 70, usesRebin: false, usesPack: false },
  { id: 'PPFracsDonateHazmat', label: 'Donate Hazmat', defaultRate: 65, usesRebin: false, usesPack: false },
  { id: 'PPFracsLiquidate',    label: 'Liquidate',     defaultRate: 70, usesRebin: false, usesPack: false },
  { id: 'PPFracsLTL',          label: 'LTL',           defaultRate: 67, usesRebin: false, usesPack: false },
  { id: 'PPFracsMultiSlam',    label: 'MultiSlam',     defaultRate: 65, usesRebin: true,  usesPack: true  },
  { id: 'PPFracsOfflineHold',  label: 'Offline Hold',  defaultRate: 60, usesRebin: false, usesPack: false },
  { id: 'PPFracsRecycle',      label: 'Recycle',       defaultRate: 65, usesRebin: false, usesPack: false },
  { id: 'PPFracsRemoveHZMT',   label: 'Remove Hazmat', defaultRate: 63, usesRebin: false, usesPack: false },
  { id: 'PPFracsSingle',       label: 'Single',        defaultRate: 67, usesRebin: true,  usesPack: true  }
];

// Rates stored as { pick: {pathId: uph}, rebin: {pathId: uph}, pack: {pathId: uph} }.
// Old v0.1 storage was a flat {pathId: uph} map; migrateRates() upgrades it.
function emptyRatesMap() {
  return { pick: {}, rebin: {}, pack: {} };
}

function migrateRates(stored) {
  if (!stored) return null;
  if (stored.pick || stored.rebin || stored.pack) return stored;
  // Legacy flat map — treat as pick UPH.
  return { pick: { ...stored }, rebin: {}, pack: {} };
}

// Downstream role rates used by the MultiSlam Pack Staffing section of the
// workbook. These are placeholders until we learn them from FCLM history
// (functionRollup sub-function UPH for "Rebin" and "Pack Singles/Multis").
const DOWNSTREAM_DEFAULTS = {
  pickMaxUPH:  74.26,  // spreadsheet B6 — ceiling on pick rate
  rebinMinUPH: 345.71, // units/hr a rebinner can empty (fleet avg)
  packMinUPH:  250.74  // units/hr a packer can process
};

// FCLM parent process IDs (from Ca3de/performance-validity/content/fclm.js).
// Used with /reports/functionRollup for rate history per AA.
const FCLM_PROCESS_IDS = {
  PICK:       '1003034',
  PACK:       '1003056',
  STOW:       '1003055',
  SORT_BATCH: '1003015',
  SUPPORT_C:  '1003058',
  SUPPORT_V:  '1003059'
};

// Rodeo ShipOption set used for all FRACS queries (from the user's own Rodeo
// URLs). Building this once avoids drift.
const FRACS_SHIP_OPTIONS = [
  'vendor-returns',
  'vendor-returns-ltl',
  'vendor-returns-offline',
  'vendor-returns-offline-ltl',
  'vendor-returns-woot',
  'vendor-returns-woot-ltl',
  'vendor-returns-no-payment',
  'dstry',
  'liqu',
  'liqu-ltl',
  'dstry-ltl',
  'donation-pickup',
  'donation-pickup-ltl',
  'NA-donation-pickup'
].join(',');

// Scannable-ID prefix → item state.
//   * 'p-1-*'  picker still pulling this item from the bin
//   * 'sp*'    item is being packed (downstream of rebin)
//   * 'rb*'    item has been rebinned (moved from cart to pack)
//   * 'ts*'    item is in the cart (incl. ts0 — treated identically)
function classifyScannable(s) {
  if (!s) return 'unknown';
  const x = String(s).toLowerCase();
  if (x.startsWith('p-1-')) return 'being_picked';
  if (x.startsWith('sp')) return 'packing';
  if (x.startsWith('rb')) return 'rebinned';
  if (x.startsWith('ts')) return 'filling';
  return 'other';
}

// Per-batch state. Strict classification — every single item must match
// the qualifying prefix for its state. Any contamination disqualifies.
//
//   any item being_picked (p-1-*)        -> 'being_picked'   (excluded)
//   any item packing (sp*)               -> 'packing'        (excluded)
//   has both rb* and ts*                 -> 'rebin_in_progress'
//   STRICTLY only rb*, nothing else      -> 'pack_ready'
//   STRICTLY only ts*, nothing else      -> 'rebin_ready'
//   anything else                        -> 'mixed'          (excluded)
function classifyBatch(items) {
  if (!items || !items.length) return 'unknown';

  let hasBeingPicked = false, hasSp = false, hasRb = false, hasTs = false;
  let hasOther = false, hasUnknown = false;

  for (const item of items) {
    const sc = classifyScannable(item.scannableId);
    if (sc === 'being_picked') hasBeingPicked = true;
    else if (sc === 'packing')  hasSp = true;
    else if (sc === 'rebinned') hasRb = true;
    else if (sc === 'filling')  hasTs = true;
    else if (sc === 'other')    hasOther = true;
    else if (sc === 'unknown')  hasUnknown = true;
  }

  if (hasBeingPicked) return 'being_picked';
  if (hasSp)          return 'packing';
  if (hasRb && hasTs) return 'rebin_in_progress';

  // STRICT pack-ready: every item must be rb*. Nothing else.
  if (hasRb && !hasTs && !hasSp && !hasBeingPicked && !hasOther && !hasUnknown) {
    return 'pack_ready';
  }

  // STRICT rebin-ready: every item must be ts*. Nothing else.
  // Sourced from WorkPool=PickingPicked pool query; per-batch re-query
  // confirms all items are ts* with no P-1-, rb, sp, or unknown noise.
  if (hasTs && !hasRb && !hasSp && !hasBeingPicked && !hasOther && !hasUnknown) {
    return 'rebin_ready';
  }

  return 'mixed';
}

// Export to background/popup contexts.
if (typeof self !== 'undefined') {
  self.PROCESS_PATHS = PROCESS_PATHS;
  self.DOWNSTREAM_DEFAULTS = DOWNSTREAM_DEFAULTS;
  self.FCLM_PROCESS_IDS = FCLM_PROCESS_IDS;
  self.FRACS_SHIP_OPTIONS = FRACS_SHIP_OPTIONS;
  self.classifyScannable = classifyScannable;
  self.classifyBatch = classifyBatch;
  self.emptyRatesMap = emptyRatesMap;
  self.migrateRates = migrateRates;
}
