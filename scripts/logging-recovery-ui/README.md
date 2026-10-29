# Logging recovery browser checks

Run `node scripts/logging-recovery-ui/run.mjs` after installing dependencies and Playwright Chromium. Set `REVIEW_BROWSER=webkit` to use an installed WebKit browser. The fixtures load the actual Maple app, providers and entry forms. Every request is intercepted under `logging-recovery.example.test`; records are synthetic.

The checks cover locked fields and dismissal during pending saves across every basic logging form, rejected saves and successful retries, double taps, real pointer presses on disabled time nudges, temperature/vitals partial-success retries without duplicate entries, in-place photo-storage retry with the moment draft intact, a new Note's round-trip through doctor-question mode, offline queuing, pump amount mode changes, preservation of untouched precision, failed cached History refreshes, and unknown birth dates across Moments, photo captions and celebrations. Explicit birth times retain their existing behavior. The runner adds a read-only provider snapshot to its temporary browser bundle for state and outbox assertions; it does not change request handling or persistence.

`LOGGING_CASE` selects a case by part of its title. `LOGGING_BASELINE_REF` reads the affected components from an earlier revision into an isolated bundle without modifying the checkout. The original six checks fail on `b2b12bc`. The Moment save/retry cases (`LOGGING_CASE=Moment`) and Note round-trip (`LOGGING_CASE='Note can return'`) fail on `bd4ca57`.

The generic form recovery checks (`LOGGING_CASE='retains rejected'`) fail on `6048f3e`. `LOGGING_CASE='Temperature retries'` focuses on partial-success recovery.
