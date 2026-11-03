"use client";

import { CareRow } from "./care/CareLine";
import { SleepPlanRow } from "./sleep/SleepCards";
import { cx, tone } from "./ui";

/**
 * Up next, under Right now on Today (after the morning's Last night card):
 * the things beside the baby's own log, one row each with one action. Her
 * next medicine (Took it, care/CareLine) and the sleep plan (its words open
 * the plan; with nothing going on, Put down, sleep/SleepCards). They used to
 * ride on the dock as strips, which made it nearly twice as tall all day;
 * the dock keeps only the sleep plan's strip, and only for a moment (a try,
 * a turn, after a crying wake, the morning's question).
 *
 * Each row decides for itself whether it shows; with neither, the card isn't
 * drawn (empty:hidden).
 */
export default function UpNext() {
  return (
    <div data-up-next className={cx(tone.card, tone.divide, "overflow-hidden empty:hidden")}>
      <CareRow />
      <SleepPlanRow />
    </div>
  );
}
