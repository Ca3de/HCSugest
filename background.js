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

    case 'rodeo.pickable':
      return {
        ok: true,
        pickable: await Rodeo.getPickableBacklog({ warehouse: msg.warehouse })
      };

    case 'roster': {
      // Build the per-AA roster for the current shift by:
      //   1. Pulling functionRollup Intraday for each parent process (Pick,
      //      Pack, Stow) to enumerate who worked in the shift and their UPH
      //      by subFunction.
      //   2. For each distinct login/badge, pulling timeDetails to get
      //      current assignment + startedAt.
      // Concurrency is capped; missing history is tolerated.
      const warehouse = msg.warehouse;
      const range = FCLM.shiftRange(msg.shift || 'day');
      const parents = [FCLM_PROCESS_IDS.PICK, FCLM_PROCESS_IDS.PACK, FCLM_PROCESS_IDS.STOW];
      const allRows = [];
      for (const pid of parents) {
        try {
          const rows = await FCLM.fetchFunctionRollup({
            warehouseId: warehouse, processId: pid, spanType: 'Intraday', range
          });
          for (const r of rows) allRows.push({ ...r, parentProcessId: pid });
        } catch (e) {
          // Skip this parent if FCLM chokes; we still produce a partial roster.
        }
      }
      // Group rate history by login -> subFunction.
      const byLogin = {};
      for (const r of allRows) {
        if (!r.login) continue;
        const slot = byLogin[r.login] ||= { login: r.login, badge: r.badgeId || r.employeeId, name: r.name, rates: {} };
        if (!slot.badge && r.badgeId) slot.badge = r.badgeId;
        slot.rates[r.subFunction] = {
          // v0.1 uses the rollup's own UPH as a proxy for p50. Real
          // distribution learning will replace this with historical p20/p50/p80.
          p50: r.uph, units: r.units, hours: r.hours
        };
      }
      // Enrich with current assignment via timeDetails. Cap concurrency.
      const logins = Object.keys(byLogin);
      const CHUNK = 4;
      for (let i = 0; i < logins.length; i += CHUNK) {
        const batch = logins.slice(i, i + CHUNK);
        await Promise.all(batch.map(async login => {
          const slot = byLogin[login];
          if (!slot.badge) return; // can't call timeDetails without an id
          try {
            const { segments } = await FCLM.fetchTimeDetails({
              warehouseId: warehouse, employeeId: slot.badge, range
            });
            const cur = FCLM.currentAssignment(segments);
            if (cur) {
              slot.currentPath = cur.subFunction;
              slot.currentParent = cur.parentFunction;
              slot.startedAt = cur.startedAt;
              slot.stale = !!cur.stale;
            }
          } catch (e) {
            slot.error = String(e);
          }
        }));
      }
      return { ok: true, roster: Object.values(byLogin) };
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

    case 'fclm.weekly': {
      // Week rollup for a parent process. Range is the current ISO week
      // (Sunday-anchored) per FCLM convention; startDateWeek is the anchor.
      const now = new Date();
      const sunday = new Date(now);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      sunday.setHours(0, 0, 0, 0);
      const nextSunday = new Date(sunday);
      nextSunday.setDate(sunday.getDate() + 7);
      const rows = await FCLM.fetchFunctionRollup({
        warehouseId: msg.warehouse,
        processId:   msg.processId,
        spanType:    'Week',
        range: { startDate: sunday, endDate: nextSunday, startHour: 0, endHour: 0 }
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

    case 'slack.post': {
      const webhook = (await configGet('slackWebhook', '')) || '';
      await Slack.postToSlack(webhook, msg.payload);
      return { ok: true };
    }

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
