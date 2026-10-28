# Search card browser checks

Bundles the production search card and Maple CSS with synthetic app hooks.
Playwright serves a reserved example origin and intercepts every request; no
production service, model or family record is accessed. Checks exercise exact
entry loading, cursor pagination, failed reads and writes, doctor questions,
viewer/offline controls, draft preservation and mobile layout.

Use the same temporary tools as `scripts/chat-ui-check`:

```sh
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/chat-search-ui/run.mjs
```

Screenshots under `test-results/maple-search-ui` contain synthetic text only.
