// Debug sampler. Stores the most recent raw response per fetch "kind"
// (e.g. 'fclm-rollup-pick', 'rodeo-exsd', 'rodeo-pool-multislam-picking') so
// the Debug tab can show what FCLM/Rodeo actually returned. Parsers that
// return empty get logged alongside so we know which step failed.
//
// Storage key: hc_cfg_debugSamples (array, newest first, capped at 20).

const DEBUG_SAMPLES_KEY = 'debugSamples';
const DEBUG_SAMPLE_LIMIT = 20;
const DEBUG_SAMPLE_BYTES = 16000; // truncate previews to keep storage sane

async function recordSample({ kind, url, status, body, parseSummary, error }) {
  try {
    const samples = (await configGet(DEBUG_SAMPLES_KEY, [])) || [];
    const preview = typeof body === 'string'
      ? body.slice(0, DEBUG_SAMPLE_BYTES)
      : '';
    samples.unshift({
      at: Date.now(),
      kind, url, status,
      size: typeof body === 'string' ? body.length : 0,
      preview,
      parseSummary: parseSummary || null,
      error: error ? String(error) : null
    });
    samples.length = Math.min(samples.length, DEBUG_SAMPLE_LIMIT);
    await configSet(DEBUG_SAMPLES_KEY, samples);
  } catch (_) {
    // Never let debug recording break the real work.
  }
}

if (typeof self !== 'undefined') {
  self.Debug = { recordSample, DEBUG_SAMPLES_KEY };
}
