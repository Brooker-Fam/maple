# First-use logging checks

Run `node scripts/first-use-ui/run.mjs` (or `REVIEW_BROWSER=webkit node scripts/first-use-ui/run.mjs`).

The production app is bundled into a browser fixture. Every request is intercepted at an `example.test` origin; all records and identities are synthetic. Checks cover every historical entry kind across UTC midnight, local-midnight ranges without invented durations, second-preserving corrections across midnight and both DST changes, bath duration preservation and future-end validation, saved Vitamin D corrections without duplicate doses, feeding preferences, and view-only access. `FIRST_USE_CASE` runs a matching case.
