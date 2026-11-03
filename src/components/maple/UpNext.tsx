"use client";

import { CareRow } from "./care/CareLine";
import { SleepRow } from "./sleep/SleepRow";
import { cx, tone } from "./ui";

/**
 * Up next, right under Maple's status on Today: the things beside her own
 * log that someone may do next, one row each with one action. Her next
 * medicine (Took it, care/CareLine) and the sleep plan's next step (Put
 * down, sleep/SleepRow). They used to ride on the dock as strips, which
 * made it twice as tall; here they scroll with the page and the dock stays
 * the baby's eight buttons.
 *
 * Each row decides for itself whether it shows; with neither, the card
 * isn't drawn (empty:hidden).
 */
export default function UpNext() {
  return (
    <div className={cx(tone.card, tone.divide, "overflow-hidden empty:hidden")}>
      <CareRow />
      <SleepRow />
    </div>
  );
}
