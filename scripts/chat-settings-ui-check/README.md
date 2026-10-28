Synthetic browser checks for chat setting cards and navigation. No production accounts, records, network calls, or real AI model are used.

Run with the same temporary tools as the other UI checks:

```sh
NODE_PATH=/tmp/maple-ui-tools/node_modules node scripts/chat-settings-ui-check/run.mjs
```

The fixture uses the actual setting/navigation components, theme and night preference providers, and device scoping. Its family settings endpoint is simulated. Checks cover server-confirmed Apply/Undo, phone acknowledgment failure/retry, unchanged local preference on acknowledgment retry, device and account restrictions, busy/offline controls, and navigation to the exact section or existing sheet. Server authorization and storage checks live in the settings tenancy checks.
