# Sleep plan browser checks

`node scripts/sleep-ui-check/run.mjs` runs the real sleep provider, strip, try
and holding cards and every sleep sheet (How did it go?, Getting sleepy?,
holding, a try's edit, an earlier try, the plan with its Guidance and Progress)
against synthetic app state and an in-memory stand-in for `/api/maple/sleep`.
Every request stays on `sleep.example.test`; no account, database or API is
used, and the family, baby and people are made up.

Checks cover setting up the plan, one-tap Put down (the "fed" tag after a
recent feed, earlier-time chips), outcomes with Undo, a try whose sleep was
stopped elsewhere (Woke up), the two-choice "I'm getting sleepy" sheet and the
partner handoff, the transfer steps, logging an earlier try with the duplicate
question, guidance sources and the emergency call link, progress with sample
sizes, a view-only guest, 44px targets, and 320px layouts without horizontal
scroll. Runs with reduced motion enabled; `REVIEW_BROWSER=webkit` runs it in
WebKit when Playwright WebKit is installed.
