# Earlier nursing switches

`node scripts/timing-switch-ui/run.mjs` renders the complete app with intercepted
synthetic responses. It checks the reminder and menu entry points, bounded time
selection, explicit Save, failed-save recovery, another device's switch, Cancel,
and checked Undo. It cannot reach a family log.

Use `REVIEW_BROWSER=webkit` for WebKit. `MAPLE_TIMING_BASELINE=<git-ref>` bundles
the original timer UI without changing the working tree; all four cases fail
against `c8916e2`, where the earlier-switch entry points are missing.
