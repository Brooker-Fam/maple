"use client";

import { shiftStatus } from "@/lib/maple/sleep/engine";
import { slotLabel } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { cx } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useSleepMaybe } from "./useSleep";

/**
 * The sleep plan's strip on top of Today's dock, where a thumb lands at 3am:
 * one tap lays her down (Put down), says how a running try went, or, while
 * someone holds her, asks the two safe things to do when they're getting
 * sleepy. Tapping the words opens the plan. Only with a plan (or a try or a
 * shift already going), and only for people who can log.
 */
export function SleepStrip() {
  const s = useSleepMaybe();
  const { state, memberName } = useMaple();
  const v = useVoice();
  const now = useNow(30_000);
  if (!s || !s.canWrite || (!s.plan && !s.running && !s.shift)) return null;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const sh = s.shift;
  const due = sh ? shiftStatus(sh, now).due : false;

  let words: string;
  let sub: string;
  let action: { label: string; onClick: () => void; strong?: boolean };
  const sleep = s.running?.sleep_entry_id ? state?.entries.find((e) => e.id === s.running!.sleep_entry_id) : undefined;
  const woke = !!sleep && !sleep.active && !!sleep.ended_at;
  if (s.running) {
    words = woke ? `${v.They} woke at ${formatTime(sleep!.ended_at!, tz)}` : "In the bassinet";
    sub = woke ? "the try is still open" : `since ${formatTime(s.running.started_at, tz)} · ${formatDuration(Math.max(0, (now.getTime() - Date.parse(s.running.started_at)) / 1000))}`;
    action = { label: "How did it go?", onClick: () => s.openSheet({ kind: "outcome", tryId: s.running!.id }), strong: woke };
  } else if (sh) {
    words = due ? "Handoff time" : `${sh.holder === state?.me.email ? "You're" : `${memberName(sh.holder)} is`} holding ${v.them}`;
    sub = sh.handoff_at ? `handoff ${formatTime(sh.handoff_at, tz)}` : `since ${formatTime(sh.started_at, tz)}`;
    action = { label: "I'm getting sleepy", onClick: () => s.openSheet({ kind: "sleepy" }), strong: true };
  } else {
    const t = s.today;
    words = "Bassinet try";
    sub = t ? `${t.done} of ${t.planned} ${t.label}${t.next ? ` · ${slotLabel(t.next).replace(/^The /, "")}` : ""}` : "";
    action = { label: "Put down", onClick: () => void s.startTry(), strong: true };
  }

  return (
    <div role="group" aria-label="Sleep plan" className="-mt-0.5 mb-1.5 flex h-11 items-center gap-1 rounded-2xl border border-(--mp-edge) bg-mp-surface pr-1 shadow-[0_1px_2px_rgb(28_38_25/0.06)]">
      <button
        type="button"
        onClick={() => s.openSheet({ kind: "plan" })}
        aria-label={`${words}${sub ? `, ${sub}` : ""}. Open the sleep plan.`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-2xl pl-2 text-left transition active:bg-mp-ink/[0.04]"
      >
        <KindBadge icon={sh && !s.running ? "hold" : "bassinet"} color={KIND_COLOR.sleep} size={28} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[17px]">
          <span className={cx("font-semibold text-mp-ink", due && "text-mp-accent-fg")}>{words}</span>
          {sub && <span className="text-mp-ink-2"> · {sub}</span>}
        </span>
      </button>
      {/* A 44px target around a 36px pill, as her strip's Took it. */}
      <button type="button" disabled={s.busy} onClick={action.onClick} className="-my-1 flex min-h-[44px] shrink-0 items-center disabled:opacity-40">
        <span
          className={cx(
            "inline-flex min-h-[36px] items-center rounded-[10px] px-3.5 text-sm font-semibold whitespace-nowrap active:scale-[0.97]",
            action.strong ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink"
          )}
        >
          {action.label}
        </span>
      </button>
    </div>
  );
}
