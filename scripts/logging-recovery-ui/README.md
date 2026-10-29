# Logging recovery browser checks

Run `node scripts/logging-recovery-ui/run.mjs` after installing dependencies and Playwright Chromium. Set `REVIEW_BROWSER=webkit` to use an installed WebKit browser. The fixtures load the actual Maple app, providers and entry forms. Every request is intercepted under `logging-recovery.example.test`; records are synthetic.

The checks cover locked fields and dismissal during pending Note saves, rejected saves and successful retries, offline queuing, pump amount mode changes, preservation of untouched precision, failed cached History refreshes, and unknown birth dates across Moments, photo captions and celebrations. Explicit birth times retain their existing behavior. The runner adds a read-only provider snapshot to its temporary browser bundle for state and outbox assertions; it does not change request handling or persistence.

`LOGGING_CASE` selects a case by part of its title. To demonstrate the regressions on the pre-fix source, run with `LOGGING_BASELINE_REF=b2b12bc`. This reads the five affected components from that revision into an isolated bundle without modifying the checkout. All six cases fail on that baseline.
