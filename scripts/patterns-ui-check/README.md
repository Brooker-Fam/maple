# Pattern-view browser checks

```sh
node scripts/patterns-ui-check/run.mjs
```

Use `MAPLE_UI_CHROMIUM=/path/to/chromium` when the browser is installed outside
Playwright's cache. The runner uses the repository's Playwright, esbuild and
Tailwind dependencies.

The fixture renders the actual `PatternsTab`, `DayDial`, `PatternCircles`, ribbon
and daily-total components with the actual chart and nursing calculations. Only
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
clock loading followed by a successful retry without false zero totals.

Screenshots in `test-results/maple-patterns-ui` contain example records only and
are ignored by Git. These component checks do not exercise server persistence,
authorization or the WHO Growth chart, which retain their existing checks.
