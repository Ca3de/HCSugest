// Process paths, default rates, and cart-state rules.
// Defaults are taken from the IND8 Pick Staffing v1.9 spreadsheet
// (column D on the "IND8 Pick Staffing Model" sheet) as a seed.
// Users override these in the popup; the values live in chrome.storage.local
// under key 'hc_rates'. A real weekly-rates API can replace this later.

const PROCESS_PATHS = [
  { id: 'PPFracsDonate',       label: 'Donate',        defaultRate: 70 },
  { id: 'PPFracsDonateHazmat', label: 'Donate Hazmat', defaultRate: 65 },
  { id: 'PPFracsLiquidate',    label: 'Liquidate',     defaultRate: 70 },
  { id: 'PPFracsLTL',          label: 'LTL',           defaultRate: 67 },
  { id: 'PPFracsMultiSlam',    label: 'MultiSlam',     defaultRate: 65 },
  { id: 'PPFracsOfflineHold',  label: 'Offline Hold',  defaultRate: 60 },
  { id: 'PPFracsRecycle',      label: 'Recycle',       defaultRate: 65 },
  { id: 'PPFracsRemoveHZMT',   label: 'Remove Hazmat', defaultRate: 63 },
  { id: 'PPFracsSingle',       label: 'Single',        defaultRate: 67 }
];

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

// Scannable-ID prefix → batch state. Rule per spec:
//   * any 'sp*'                              -> cart is being packed (exclude)
//   * all  'ts*' (ts, ts0 treated same)      -> cart still being filled,
//                                               OR (if WorkPool=PickingPicked)
//                                               rebinnable cart
//   * all  'rb*'                             -> cart is pack-ready
//   * mixed ts+rb                            -> AA actively rebinning cart
//                                               into pack (excluded from both
//                                               ready pools)
function classifyScannable(s) {
  if (!s) return 'unknown';
  const x = String(s).toLowerCase();
  if (x.startsWith('sp')) return 'packing';
  if (x.startsWith('rb')) return 'rebinned';
  if (x.startsWith('ts')) return 'filling';
  return 'other';
}

function classifyBatch(items) {
  if (!items || !items.length) return 'unknown';
  const states = new Set(items.map(i => classifyScannable(i.scannableId)));
  if (states.has('packing')) return 'packing';
  const hasRb = states.has('rebinned');
  const hasTs = states.has('filling');
  if (hasRb && hasTs) return 'rebin_in_progress';
  if (hasRb && !hasTs) return 'pack_ready';
  if (hasTs && !hasRb) return 'ts_only';   // caller decides based on WorkPool
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
}
