# Saved entry times

`node scripts/timing-now-ui/run.mjs` runs MapleApp with synthetic records and intercepted HTTP in Chromium. `REVIEW_BROWSER=webkit` selects WebKit. Every request stays on the synthetic origin.

The sixteen journeys cover vitals, baby medicines, growth, ordinary notes, temperature, bottles and moments, plus concurrent edits to manual nursing and timed nursing converted to minutes. They check:

1. Choosing Now replaces a saved timestamp.
2. Now resolves at submission after a delay.
3. An unchanged time retains seconds and milliseconds.
4. An incomplete date disables Save without writing.
5. Completing the date restores Save.
6. An incomplete clock disables Save without writing.
7. Choosing Now clears the incomplete clock.
8. A rejected save retains the draft and leaves the saved timestamp unchanged.
9. Retrying Now resolves the time at the retry.
10. Concurrent corrections preserve the newer record and the draft, then require loading the latest entry before saving again.

`MAPLE_TIMING_NOW_BASELINE=7917ef1 node scripts/timing-now-ui/run.mjs` loads the original seven sheet implementations from Git. All sixteen journeys fail against those implementations: seven omit the selected Now timestamp, and nine overwrite concurrent corrections. The fixed implementations pass in Chromium and WebKit.

Use `MAPLE_TIMING_NOW_MODE=now` or `conflict` to select a group, and `MAPLE_TIMING_NOW_CASE=vitals|med|growth|note|temp|feed|moment` to select an entry kind. The feed conflict group includes bottles, manual nursing and a timed feed converted to minutes.
