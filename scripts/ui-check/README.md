# Time-editing browser checks

This harness bundles the real `RecentDoses`, `DoseTimeSheet`, `RecordedTimeField`,
`MomentEditor`, `FixTimesSheet`, `Sheet`, and `ToastHost` components with synthetic state hooks. It
uses Maple's actual CSS and nursing engine. It never connects to a family log or
adds a production route.

Nursing cases cover the real log-row route into the shared correction sheet,
including older history outside the current-state window, direct minute
adjustments, fixed-target smart choices, independent side ends and shared switch
boundaries. They check multiple time and side changes saved together, draft
recovery, complete view-only notes, and the combined preview beside the fixed
Save footer on narrow phones.
`pnpm check:maple-tenancy timer-time-correction` separately exercises revision
checks through the timer API against synthetic in-memory Postgres.

The first fixture uses synthetic actions for focused field and nursing tests.
The production-care fixture runs the actual `Dock`, `CareStrip`, `useCare`,
`CareNavProvider`, `PlanPicker`, and toast actions, with only the app store and HTTP
boundary replaced by synthetic data. It checks Took it → confirmation Edit time,
Cancel/Save, the persistent held control, the picker after a reload, exact dose
identity when timestamps collide, and version-guarded time-only PATCH requests.
It does not test the server's authorization or persistence. Existing care/feed
checks cover their engines separately.

Playwright fulfills a reserved synthetic origin from the bundled fixture files;
no local listener, production route, authentication bypass, or network is used.

CI installs temporary tools outside the application dependencies:

```sh
npm install --prefix /tmp/maple-ui-tools --no-save esbuild@0.25.10 playwright@1.56.1 postcss@8.5.6
NODE_PATH=/tmp/maple-ui-tools/node_modules node /tmp/maple-ui-tools/node_modules/playwright/cli.js install --with-deps chromium
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/ui-check/run.mjs
```

Screenshots go to `test-results/maple-ui` and contain example records only.

## App flow regressions

With the same temporary browser tools, run `pnpm check:maple-ui-review`.
It runs the shared navigation, draft, keyboard and contrast checks; daily logging
and historical dates; settings, birth and guest access; onboarding recovery;
chat navigation into settings; care history; check-in and food/drink draft recovery; and Moments
pagination, refresh and photo recovery. The API checks use in-memory Postgres
with synthetic families. UI fixtures replace only their documented boundaries
and cannot contact a production family log.

The regression cases were run against the affected code before each fix. The
optional baseline modes in individual runners load Git source through esbuild,
without swapping files in a shared worktree. CI runs the fixed tree.
