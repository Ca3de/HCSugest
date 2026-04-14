// Background service worker. Routes messages from the popup to the two
// clients (Rodeo, FCLM) and the optimizer. Running in the background means
// cross-origin fetches use the user's cookies without needing an open tab.

async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      return { ok: true, at: Date.now() };

    case 'rodeo.backlog': {
      // msg.warehouse, msg.paths (array of process path ids)
      const out = {};
      for (const path of msg.paths) {
        try {
          out[path] = await Rodeo.getBacklogForPath({
            warehouse: msg.warehouse,
            processPath: path,
            windowDays: msg.windowDays || 14
          });
        } catch (e) {
          out[path] = { error: String(e) };
        }
      }
      return { ok: true, backlog: out };
    }

    case 'fclm.rollup': {
      // msg.warehouse, msg.processId, msg.spanType, msg.range?
      const range = msg.range || FCLM.shiftRange(msg.shift || 'day');
      const rows = await FCLM.fetchFunctionRollup({
        warehouseId: msg.warehouse,
        processId:   msg.processId,
        spanType:    msg.spanType,
        range
      });
      return { ok: true, rows };
    }

    case 'fclm.timeDetails': {
      const range = msg.range || FCLM.shiftRange(msg.shift || 'day');
      const segments = await FCLM.fetchTimeDetails({
        warehouseId: msg.warehouse,
        employeeId:  msg.employeeId,
        range
      });
      return { ok: true, segments, current: FCLM.currentAssignment(segments) };
    }

    case 'optimize':
      return { ok: true, plan: Optimizer.suggest(msg.input) };

    case 'config.get':
      return { ok: true, value: await configGet(msg.key, msg.fallback) };

    case 'config.set':
      await configSet(msg.key, msg.value);
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

const api = (typeof browser !== 'undefined') ? browser : chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, error: String(e && e.stack || e) }));
  return true; // keep channel open for async
});
