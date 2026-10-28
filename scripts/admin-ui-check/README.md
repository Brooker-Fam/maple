# Synthetic admin UI checks

Builds the real `AdminMetricsPage` and its drilldown, reveal and waitlist components with esbuild, then exercises them in Chromium. Only Next's Link and the surrounding Maple context are replaced. Every request is intercepted on an `.example.test` origin; unexpected APIs and external origins are blocked and fail the check. Recipient addresses are synthetic and appear in responses only after explicit reveal. This check never contacts a database, email provider or deployed app.

Use the same temporary browser tooling as the other UI checks:

```bash
npm install --prefix /tmp/maple-ui-tools --no-save esbuild@0.25.10 playwright@1.56.1 postcss@8.5.6
NODE_PATH=/tmp/maple-ui-tools/node_modules node /tmp/maple-ui-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/admin-ui-check/run.mjs
```

If Chromium is already installed, set `MAPLE_UI_CHROMIUM=/usr/bin/chromium` instead of downloading it. Synthetic screenshots are written to ignored `test-results/maple-admin-ui/`.

Covers keyboard drilldowns/reveal/send; absence of unrevealed addresses from the DOM; paging, filtering, close and authentication cleanup; preview-only requests; one explicit send with a pending lock; sent, unavailable, ineligible and uncertain outcomes; expired-preview recovery; mobile/desktop overflow; and no external network. Backend authorization, token integrity and email idempotency are separately checked by `pnpm check:maple-tenancy admin admin-details admin-email`.
