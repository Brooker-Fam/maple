# Time-editing browser checks

This harness bundles the real `RecentDoses`, `DoseTimeSheet`, `RecordedTimeField`,
`MomentEditor`, `Sheet`, and `ToastHost` components with synthetic state hooks. It
uses Maple's actual CSS and nursing engine. It never connects to a family log or
adds a production route.

The care action is a test double: these checks cover the sheet's interactions,
not the server's authorization or persistence. The existing care/feed checks cover
their engines separately.

CI installs temporary tools outside the application dependencies:

```sh
npm install --prefix /tmp/maple-ui-tools --no-save esbuild@0.25.10 playwright@1.56.1 postcss@8.5.6
NODE_PATH=/tmp/maple-ui-tools/node_modules node /tmp/maple-ui-tools/node_modules/playwright/cli.js install --with-deps chromium
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/ui-check/run.mjs
```

Screenshots go to `test-results/maple-ui` and contain example records only.
