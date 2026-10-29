"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useAppNav, type HistorySeg, type NavTarget } from "./AppNav";
import LogTab from "./LogTab";
import PatternsTab from "./PatternsTab";
import { Segmented } from "./ui";

/**
 * History: what happened, as a list (Timeline) or as rhythms and charts
 * (Patterns), behind one Timeline | Patterns switch that stays pinned under
 * the status bar while the page scrolls (the day headings pin under it).
 *
 * Each segment keeps its place: switching back returns to where you were,
 * with its filters and loaded weeks, because both stay mounted once seen
 * (Patterns, with its lazy WHO tables, only once it's been opened). Tapping
 * the segment you're on goes back to its top. A ribbon tap in Patterns, or
 * Today's "See all", lands on the Timeline.
 */

export default function HistoryTab() {
  const { seg, setSeg, go } = useAppNav();
  const [seen, setSeen] = useState<Record<HistorySeg, boolean>>({ timeline: seg === "timeline", patterns: seg === "patterns" });
  if (!seen[seg]) setSeen((s) => ({ ...s, [seg]: true }));
  const scroll = useRef<Record<HistorySeg, number>>({ timeline: 0, patterns: 0 });
  const last = useRef<HistorySeg>(seg);
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => setBarHeight(bar.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [seg]);

  // Back to where that segment was (once its page has drawn), and remember where the other one was left.
  useLayoutEffect(() => {
    if (last.current === seg) return;
    last.current = seg;
    window.scrollTo({ top: scroll.current[seg], behavior: "instant" });
  }, [seg]);

  const pick = (s: HistorySeg) => {
    if (s === seg) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    scroll.current[seg] = window.scrollY;
    setSeg(s);
  };
  // Patterns' "show me that day" (and anything else that goes to the Timeline from here).
  const onNavigate = (t: NavTarget) => {
    if (t === "log") {
      scroll.current[seg] = window.scrollY;
      scroll.current.timeline = 0;
      setSeg("timeline");
    } else go(t);
  };

  const bar = (
    <div ref={barRef} className="sticky top-[env(safe-area-inset-top)] z-20 -mx-4 mb-4 bg-mp-bg px-4 py-2">
      <Segmented<HistorySeg>
        aria-label="Show"
        value={seg}
        onChange={pick}
        options={[
          { value: "timeline", label: "Timeline" },
          { value: "patterns", label: "Patterns" },
        ]}
      />
    </div>
  );

  return (
    <div style={{ "--maple-history-bar": `${barHeight}px` } as CSSProperties}>
      {seen.timeline && (
        <div hidden={seg !== "timeline"}>
          <LogTab title="History" below={seg === "timeline" ? bar : null} />
        </div>
      )}
      {seen.patterns && (
        <div hidden={seg !== "patterns"}>
          <PatternsTab title="History" below={seg === "patterns" ? bar : null} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}
