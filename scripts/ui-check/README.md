# Time-editing browser checks

This harness bundles the real `RecentDoses`, `DoseTimeSheet`, `RecordedTimeField`,
`MomentEditor`, `FixTimesSheet`, `Sheet`, and `ToastHost` components with synthetic state hooks. It
uses Maple's actual CSS and nursing engine. It never connects to a family log or
adds a production route.

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
