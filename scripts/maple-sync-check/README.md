# Maple sync browser checks

This harness mounts the production `MapleProvider` and sync warning in React,
using the production polling, timer, entry, optimistic update, and revision
handling. Playwright delays HTTP responses to reproduce overlapping polls and
writes. Every record is created from scratch, and every request is intercepted
at a reserved example origin. No application server, credentials, database, or
external service is used.

The checks cover saved feeds disappearing, stopped timers restarting, stale
revision tokens, delayed authorization/server/network failures, visible retry
warnings, recovery from unchanged responses, stalled requests, visit recap
anchors, and the diagnostics sent by the production hook. Each case runs
independently so one failure does not hide another.

Install dependencies and Chromium, then run:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm check:maple-sync
```

`MAPLE_UI_CHROMIUM` selects an existing Chromium executable.
`MAPLE_SYNC_CASE` runs cases whose names contain its value.

To verify regressions against an earlier version, put its original
`src/components/maple/useMaple.tsx` and `src/components/maple/MapleApp.tsx` in a
temporary directory and set `MAPLE_SYNC_BASELINE_DIR` to that directory. The
bundler loads the original provider and extracts its original `SyncChip`
component. Every other module still comes from the current checkout.
