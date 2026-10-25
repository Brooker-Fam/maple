"use client";

import { useCallback, useState, type ReactNode } from "react";
import { FEED_COUNT_RULE, LAST_FED_RULE, sideMinutesText, spanText, minutesShort, type FeedCluster } from "@/lib/maple/feed";
import {
  BACK_AND_FORTH,
  BACK_AND_FORTH_SORE,
  CLUSTER_CALL,
  CLUSTER_ENOUGH,
  CLUSTER_FEEDING_NORMAL,
  CLUSTER_PAIN,
  DISCLAIMER,
  EMERGENCY_SIGNS,
  NEXT_SIDE_NOTE,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ } from "@/lib/maple/time";
import { EMERGENCY_FILL, usePhones } from "../AlertCard";
import { Icon } from "../icons";
import { Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * "Cluster feeding": the one place the app talks about clustering and going
 * back and forth. Opened from "Cluster" on Last fed, a Timeline cluster row,
 * or "Both sides" on the timer card. It says clustering is normal, to switch
 * on her cues, the sore-nipple caution, what shows she's getting enough, and
 * who to call; every line of guidance is guidelines.ts's, word for word. No
 * alert, no tier color: nothing here is a warning. With a cluster, its line
 * sits on top ("6:02–8:40 PM · 4 feeds · nursed 1h 52m").
 *
 *   const info = useClusterInfo();
 *   <button onClick={() => info.open(cluster)}>Cluster</button>
 *   {info.sheet}
 */
export default function ClusterInfoSheet({ open, onClose, cluster }: { open: boolean; onClose: () => void; cluster?: FeedCluster | null }) {
  const { state } = useMaple();
  const phones = usePhones();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const calls = [
    phones.pediatrician && { label: "Pediatrician", phone: phones.pediatrician },
    phones.afterHours && { label: "After-hours line", phone: phones.afterHours },
  ].filter((n): n is { label: string; phone: string } => !!n);
  const tel = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;

  return (
    <Sheet open={open} onClose={onClose} title="Cluster feeding">
      {cluster && (
        <div className={cx(tone.inset, "px-4 py-3")}>
          <p className={cx(tone.body, "text-[15px] font-semibold tabular-nums")}>
            {spanText(cluster.start, cluster.end, tz)} · {cluster.feeds} feeds
          </p>
          <p className={cx(tone.muted, "mt-0.5 text-[13px] tabular-nums")}>
            Nursed {minutesShort(cluster.min.total)} ({sideMinutesText(cluster.min)})
          </p>
        </div>
      )}

      <p className={cx(tone.body, "text-[17px] leading-relaxed")}>{CLUSTER_FEEDING_NORMAL}</p>

      <Group title="Going back and forth">
        <p>{BACK_AND_FORTH}</p>
        <p>{BACK_AND_FORTH_SORE}</p>
        <p>{NEXT_SIDE_NOTE}</p>
      </Group>

      <Group title="Is she getting enough?">
        <p>{CLUSTER_ENOUGH}</p>
      </Group>

      <Group title="Who to ask">
        <p>
          <span className="block text-[13px] font-semibold text-mp-ink-2">{CLUSTER_PAIN.label}</span>
          {CLUSTER_PAIN.body}
        </p>
        <p>
          <span className="block text-[13px] font-semibold text-mp-ink-2">{CLUSTER_CALL.label}</span>
          {CLUSTER_CALL.body}
        </p>
        {calls.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {calls.map((c) => (
              <a
                key={c.label}
                href={tel(c.phone)}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-mp-sunken px-3.5 text-[15px] font-semibold text-mp-ink transition active:scale-[0.97]"
              >
                <Icon name="phone" size={16} />
                {c.label}
              </a>
            ))}
          </div>
        )}
        <div className="border-t border-mp-line pt-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-danger">
            <Icon name="siren" size={16} strokeWidth={2} className="shrink-0" />
            When to call 911
          </p>
          <p className="mt-1">{EMERGENCY_SIGNS}</p>
          <a
            href="tel:911"
            className={cx("mt-3 flex min-h-[48px] items-center justify-center gap-2 rounded-[14px] text-[16px] font-semibold active:scale-[0.98]", EMERGENCY_FILL)}
          >
            <Icon name="phone" size={18} />
            Call 911
          </a>
        </div>
      </Group>

      <Group title="How the log counts it">
        <p>{FEED_COUNT_RULE}</p>
        <p>{LAST_FED_RULE}</p>
      </Group>

      <p className={cx(tone.faint, "px-1 pb-1 text-center text-[12px] leading-snug")}>{DISCLAIMER}</p>
    </Sheet>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className={cx(tone.label, "px-1")}>{title}</h3>
      <div className={cx(tone.card, "space-y-3 px-4 py-3.5 text-[15px] leading-relaxed text-mp-ink")}>{children}</div>
    </section>
  );
}

/**
 * The sheet and its opener, for any screen that offers it: render `sheet`
 * once, call `open(cluster?)` from the "Cluster" or "Both sides" tap.
 */
export function useClusterInfo(): { open: (cluster?: FeedCluster | null) => void; sheet: ReactNode } {
  const [shown, setShown] = useState<{ open: boolean; cluster: FeedCluster | null }>({ open: false, cluster: null });
  const open = useCallback((cluster?: FeedCluster | null) => setShown({ open: true, cluster: cluster ?? null }), []);
  const close = useCallback(() => setShown((s) => ({ ...s, open: false })), []);
  return { open, sheet: <ClusterInfoSheet open={shown.open} onClose={close} cluster={shown.cluster} /> };
}
