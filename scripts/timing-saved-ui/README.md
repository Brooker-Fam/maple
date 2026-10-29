# Saved time conflicts

`node scripts/timing-saved-ui/run.mjs` runs MapleApp in Chromium with synthetic records and intercepted HTTP. `REVIEW_BROWSER=webkit` runs the same checks in WebKit. No request leaves the synthetic origin.

Checks cover concurrent saved-time edits for sleep, pumping, tummy time, baths and diapers, plus a historical sleep outside the recent state response. Rejected saves preserve both the newer record and the open draft. Discarding the draft loads the newer version and permits a guarded save. Choosing Now on a saved diaper records the current time.

`MAPLE_TIMING_SAVED_BASELINE=7917ef1 node scripts/timing-saved-ui/run.mjs` loads the original sheet implementations from Git. All six conflict cases failed before the fix because the stale save overwrote the other phone's timestamp. The saved-diaper Now case failed because the old timestamp stayed unchanged. `MAPLE_TIMING_SAVED_CASE=sleep` limits the run to sleep cases; `diaper-now` selects the Now check.
