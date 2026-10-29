"use client";

import { Segmented } from "./ui";

export type PatternActivity = "all" | "feeds" | "sleep" | "diapers";

/** One activity choice follows the person between the clock and comparisons. */
export function ActivityFilter({ value, onChange }: { value: PatternActivity; onChange: (value: PatternActivity) => void }) {
  return (
    <Segmented
      aria-label="Activity to show"
      className="mp-activity-picker"
      value={value}
      onChange={onChange}
      options={[
        { value: "all", label: "All" },
        { value: "feeds", label: "Feeds" },
        { value: "sleep", label: "Sleep" },
        { value: "diapers", label: "Diapers" },
      ]}
    />
  );
}
