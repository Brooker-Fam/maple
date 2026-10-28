"use client";

import { useState } from "react";
import { careTime } from "@/lib/maple/care";
import { DEFAULT_TZ } from "@/lib/maple/time";
import type { DoseEntry } from "@/lib/maple/types";
import { SectionTitle, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useCareNav } from "./CareNav";
import { GROUP } from "./parts";
import type { UseCare } from "./useCare";

/** Her recent doses stay on her page, with the same correction path for planned and one-time medicines. */
export default function RecentDoses({ care }: { care: UseCare }) {
  const { state } = useMaple();
  const now = useNow(30_000);
  const nav = useCareNav();
  const [expanded, setExpanded] = useState(false);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const doses = care.state.entries.filter((entry): entry is DoseEntry => entry.kind === "dose").sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!doses.length) return null;
  const shown = expanded ? doses : doses.slice(0, 3);
  return (
    <section aria-labelledby="recent-doses">
      <SectionTitle><span id="recent-doses">Recently logged</span></SectionTitle>
      <div className={GROUP}>
        {shown.map((dose) => (
          <div key={dose.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <div className="min-w-0 flex-1 basis-[150px]">
              <p className={cx(tone.body, "text-[15px] font-medium break-words")}>{dose.data.name}</p>
              <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug tabular-nums")}>
                {dose.data.skipped ? "Skipped" : "Taken"} {careTime(dose.at, now, tz)}
                {dose.med_id == null && " · one-time medicine"}
              </p>
              {(dose.pending || dose.id < 0) && <p className={cx(tone.faint, "mt-0.5 text-xs")}>On this phone · still syncing</p>}
            </div>
            {care.access.write && (
              <button type="button" onClick={() => nav.openDoseTime(dose)} disabled={dose.id < 0 || dose.pending} aria-label={`Edit time for ${dose.data.name}, ${careTime(dose.at, now, tz)}`} className="min-h-[44px] shrink-0 px-1 text-[14px] font-medium whitespace-nowrap text-mp-accent-fg disabled:opacity-40">
                Edit time
              </button>
            )}
          </div>
        ))}
      </div>
      {doses.length > 3 && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="min-h-[44px] px-1 text-[14px] font-medium text-mp-accent-fg">
          {expanded ? "Show fewer doses" : `Show all ${doses.length} recent doses`}
        </button>
      )}
    </section>
  );
}
