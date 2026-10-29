# Pattern-view browser checks

```sh
node scripts/patterns-ui-check/run.mjs
# Narrow a review pass without changing the fixture:
MAPLE_PATTERNS_ONLY="round1|round3" node scripts/patterns-ui-check/run.mjs
```

Use `MAPLE_UI_CHROMIUM=/path/to/chromium` when the browser is installed outside
Playwright's cache. The runner uses the repository's Playwright, esbuild and
Tailwind dependencies.

The fixture renders the actual `PatternsTab`, `DayDial`, `PatternCircles`, ribbon
and daily-total components with the actual chart and nursing calculations. Dedicated
scenarios also render `HistoryTab` with its real navigation and sticky header at the
production width, and the real `Sheet` focus lifecycle around a synthetic edit body. Only
the app store, read-only API, navigation/sheet actions and unrelated lazy Growth
chart are replaced. Every record is synthetic. Playwright serves a reserved
example origin from memory and rejects all other requests; there is no family
account, production route or write access.

The cases cover the visible default clock; keyboard view switching; narrow-phone
layout at 320 and 375 pixels; ribbon/circle totals including sleep across midnight;
an unlogged day; activity filtering; day/night windows and night appearance;
opening a day in Timeline; activity selection shared between clock and comparison;
keyboard event details with visible focus restoration, view-only event access,
and tap-to-detail visibility on a short phone; the growth shortcut even when comparison history fails;
daily totals opening as a table with an optional charts view; and failed historical
clock loading followed by a successful retry without false zero totals. Added review
cases cover optional pumped/tummy totals, keyboard table scrolling, bounded circle
paging, historical edits/deletes, late responses, last-good-data recovery, capped
days, missing newest weeks and incomplete noon-to-noon windows, plus returning
keyboard focus after the real edit sheet closes, including a remote deletion while
the Edit action is focused or its sheet is open. Sparse-log checks cover pump-only
and tummy-only days, a thirty-second sleep, sleep/nursing carried across midnight,
unlogged table rows, and the stated limits of the All date range. A fresh-snapshot
case keeps the minute clock fixed while the accepted server time advances, proving
newly logged activity appears immediately and true future events stay excluded.

Screenshots in `test-results/maple-patterns-ui` contain example records only and
are ignored by Git. These component checks do not exercise server persistence,
authorization or the WHO Growth chart, which retain their existing checks.

The synthetic store exposes revision changes, edits, deletes and held responses to
the runner. Query fixtures include alternate `now` dates, long/empty/partial logs,
pump-only/tummy-only logs, metric units and an actual History shell. These controls
exist only in the bundled test fixture; no application routes are added.
