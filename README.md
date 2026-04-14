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

## What works

- **Rates tab** — edit and persist weekly expected UPH per path (seeded from
  the workbook's D column). Also where the Slack webhook URL is saved.
- **Backlog tab** — hits Rodeo and shows per-path:
  - Pre-pick pickable units (from `/IND8/ExSD` pivot across `ReadyToPick` +
    `PickingNotYetPicked` + `CrossdockNotYetPicked`).
  - Rebin-ready carts, rebin-in-progress, pack-ready carts (from `/IND8/ItemList`
    batch classification via scannable-ID prefix).
  - Pagination: 1000 per page, follows `pager.CUSTOMER_SHIPMENTS.currentPage`.
- **Plan tab** — pulls the live roster (FCLM `functionRollup` Intraday across
  Pick/Pack/Stow, enriched per-AA with `timeDetails` Gantt for
  current-subFunction + dwell time), runs the optimizer, renders assignments,
  and posts to Slack on demand.
- **Debug tab** — ping, FCLM rollup smoke test.

## What's still hard-coded / TODO

- Cart-per-AA-hour rates for Rebin (1.5) and Pack (2.0) in `lib/optimizer.js`.
  Replace with learned values from FCLM Rebin/Pack sub-function UPH divided
  by observed units-per-cart (snapshotted per Refresh, rolling mean).
- Per-AA p20/p50/p80 rate distribution is currently just the rollup UPH for
  the current shift. Needs a multi-day history pull to be meaningful.
- Optimizer is greedy with dwell-lock. Swap for an ILP when the inputs stabilize.

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
