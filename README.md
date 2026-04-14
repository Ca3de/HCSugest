# HCSugest

Firefox extension (MV2) that replaces the `IND8 Pick Staffing v1.9 new.xlsm`
workbook with a **cart-aware** staffing suggester.

The spreadsheet counted units in RFEA and divided by a fleet-average rate.
That's wrong twice over:

1. AAs have very different individual rates — fleet averages hide wild spread.
2. Rebin and Pack are cart-bound, not unit-bound. 1,000 items split across
   3 carts needs one rebinner, not three.

This extension fixes both by:

- Pulling per-AA UPH by sub-function from **FCLM**
  (`/reports/functionRollup`) — same endpoint as
  [`performance-validity`](https://github.com/Ca3de/performance-validity).
- Reading the **current path + dwell time** per AA from the FCLM
  `/employee/timeDetails` Gantt.
- Counting **cart backlog** from **Rodeo** (`/IND8/ItemList`) by classifying
  batches via their Scannable-ID prefix:
  - `ts*` (all items) in `WorkPool=PickingPicked` → ready-to-rebin cart.
  - `rb*` (all items) in `WorkPool=Sorted` → pack-ready cart.
  - mixed `ts*` + `rb*` → rebin-in-progress, excluded from both.
  - any `sp*` → already being packed, excluded.

## Install (Firefox, temporary)

1. `about:debugging#/runtime/this-firefox`
2. *Load Temporary Add-on*
3. Pick `manifest.json` in this repo.
4. Be signed into Midway in the same browser profile — all fetches use
   `credentials: 'include'`.

## What works in v0.1

- Rates tab: edit and persist weekly expected UPH per path (seeded from the
  workbook's D column).
- Backlog tab: hits Rodeo and shows cart counts per path.
- Debug tab: ping, FCLM rollup smoke test.
- Plan tab: runs the v0.1 optimizer over the backlog.

## What's stubbed

- Roster feed. The plan tab produces assignments only when populated; v0.1
  passes an empty roster so you'll see the capacity warnings but no AA rows
  until `fclm.rollup` intraday is wired into the popup.
- `demand.pickAAHrs` — needs the RFEA actionable-unit feed. QuickSight's
  Total Pending Customer Shipments export is the source today; we'll hit the
  underlying Rodeo/Quetzal query once we nail the URL.
- Cart-per-AA-hour rates for Rebin and Pack are currently hard-coded at 1.5
  and 2.0. Replace with learned values from FCLM Rebin/Pack sub-functions.
- Rodeo pool queries are single-page. Pagination loop is a TODO marked
  in `lib/rodeo.js`.

## Layout

```
manifest.json
background.js            message router + orchestrator
lib/
  paths.js               process-path constants, cart-state classifier
  cache.js               storage.local + TTL
  rodeo.js               Rodeo ItemList client + cart classification
  fclm.js                FCLM rollup + timeDetails (Gantt) client
  optimizer.js           v0.1 greedy assigner w/ min-dwell
popup/
  popup.{html,css,js}    main UI
icons/icon.svg
```
