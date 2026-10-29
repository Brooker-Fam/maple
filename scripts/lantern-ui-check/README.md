# Lantern browser checks

`node scripts/lantern-ui-check/run.mjs` runs the real Lantern, timer display helpers,
and Sheet against synthetic app state and write callbacks. Every request is
restricted to `lantern.example.test`; no account or API is used.

Checks cover modal focus and restoration, background isolation, Space/Enter and
assistive activation, key-repeat suppression, touch-versus-hold behavior, drag
and swipe cancellation, the two-finger swipe guard, wake-lock cleanup, and the
forgotten-feed handoff to a finish-time sheet. Runs with reduced motion enabled.
Access checks also cover complete nursing minute values and 44px adjustments at
320–640px widths and enlarged text in day, dark and night looks. Lantern controls
remain reachable at 150% and 200% text; touch scrolling cancels holds and does not
close the screen. Chromium exercises native touch scrolling as well as pointer
cancellation; the close control stays visible above the scrolling content.

Use `REVIEW_BROWSER=webkit` to run the same checks when Playwright WebKit is
installed. Real-device screen readers and physical wake locks remain manual checks.
