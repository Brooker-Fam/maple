# Chat browser checks

This isolated harness bundles the real `ChatTab`, `MessageView`, question and
chart components with Maple's actual CSS. Its first fixture replaces app and
chat hooks with synthetic state and explicitly resolved actions. Its second
fixture keeps the real `useChatThread` and AI SDK transport, while a synthetic
HTTP server returns stored messages and streamed tool results. Playwright serves
both from a reserved example origin; neither accesses a production log or model.

Checks cover history and reply loading, hidden model work, interactive question
choices and custom answers, retryable Undo/Restore failures, entry editing,
chart controls and data tables, scroll preservation, and mobile day/night views.
The real hook also exercises two pending questions and mixed question/delete
approval responses, including acknowledgment, reload, and continuation. Server
recovery is checked after a simulated connection failure, including draft
preservation and preventing accidental write retries. Authorization and database
persistence are covered by the separate chat unit/integration checks.

Install temporary tools outside application dependencies, then run:

```sh
npm install --prefix /tmp/maple-ui-tools --no-save esbuild@0.25.10 playwright@1.56.1 postcss@8.5.6
NODE_PATH=/tmp/maple-ui-tools/node_modules node /tmp/maple-ui-tools/node_modules/playwright/cli.js install --with-deps chromium
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/chat-ui-check/run.mjs
```

Screenshots in `test-results/maple-chat-ui` contain example records only.
