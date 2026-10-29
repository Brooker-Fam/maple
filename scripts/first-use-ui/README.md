# First-use logging checks

Run `node scripts/first-use-ui/run.mjs` (or `REVIEW_BROWSER=webkit node scripts/first-use-ui/run.mjs`).

The production app is bundled into a browser fixture. Every request is intercepted at an `example.test` origin; all records and identities are synthetic. Checks cover every historical entry kind across UTC midnight, incomplete clocks and recovery in every baby logging form, explicit dates, future and reversed times, daylight-saving gaps, unsaved time drafts, manual nursing sides, care temperature, and birth details in Settings. They also cover local-midnight ranges without invented durations, second-preserving corrections across midnight and both DST changes, bath duration preservation, saved Vitamin D corrections without duplicate doses, feeding preferences, view-only access, and all kinds in the handoff recap. `FIRST_USE_CASE` runs a matching case.
