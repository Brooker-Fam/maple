"use client";

import { CareRow } from "./care/CareLine";
import { LastNightRow } from "./sleep/LastNight";
import { SleepPlanRow } from "./sleep/SleepCards";
import { cx, tone } from "./ui";

/**
 * Up next, under Right now on Today (after the morning's Last night card):
 * the things beside the baby's own log, one row each with one action. Her
 * next medicine (Took it, care/CareLine), the sleep plan (its words open
 * the plan; with nothing going on, Put down, sleep/SleepCards), and after
 * noon, last night's questions left for later (sleep/LastNight): the folded
 * Last night card, when that one row is all it would show, stands here
 * instead of above, and its Answer opens the card again above Up next. Her
 * medicine and the plan used to ride on the dock as strips, which made it
 * nearly twice as tall all day; the dock keeps only the sleep plan's strip,
 * and only for a moment (a try, a turn, after a crying wake, the morning's
 * question).
 *
 * Each row decides for itself whether it shows; with none, the card isn't
 * drawn (empty:hidden).
 */
export default function UpNext() {
  return (
    <div data-up-next className={cx(tone.card, tone.divide, "overflow-hidden empty:hidden")}>
      <CareRow />
      <SleepPlanRow />
      <LastNightRow />
    </div>
  );
}
