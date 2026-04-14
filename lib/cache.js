// Thin storage wrapper with TTL. All keys are namespaced with 'hc_'.
// Uses browser.storage.local (Firefox) falling back to chrome.storage.local.

const _storage = (typeof browser !== 'undefined' && browser.storage)
  ? browser.storage.local
  : chrome.storage.local;

function _get(key) {
  return new Promise(resolve => {
    _storage.get(key, r => resolve(r && r[key]));
  });
}

function _set(key, value) {
  return new Promise(resolve => {
    _storage.set({ [key]: value }, () => resolve());
  });
}

async function cacheGet(key, ttlMs) {
  const rec = await _get(`hc_cache_${key}`);
  if (!rec) return null;
  if (ttlMs != null && (Date.now() - rec.ts) > ttlMs) return null;
  return rec.v;
}

async function cacheSet(key, value) {
  await _set(`hc_cache_${key}`, { ts: Date.now(), v: value });
}

async function configGet(key, fallback) {
  const v = await _get(`hc_cfg_${key}`);
  return (v === undefined) ? fallback : v;
}

async function configSet(key, value) {
  await _set(`hc_cfg_${key}`, value);
}

if (typeof self !== 'undefined') {
  self.cacheGet = cacheGet;
  self.cacheSet = cacheSet;
  self.configGet = configGet;
  self.configSet = configSet;
}
