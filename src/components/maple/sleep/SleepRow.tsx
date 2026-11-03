"use client";

import { slotLabel } from "@/lib/maple/sleep/words";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { useMaple } from "../useMaple";
import { useSleepMaybe, type SleepApi } from "./useSleep";

/**
 * The sleep plan's next step, one row in Today's Up next card (UpNext.tsx):
 * "Bassinet try · 0 of 1 tonight", and Put down, which lays her down in one
 * tap (a sleep starts with the try when none is running). Tapping the words
 * opens the plan.
 *
 * Only while there's nothing more pressing about her sleep: a running try
 * or someone holding her has its own card in Right now, and while she's
 * asleep the sleep's timer card carries Put down itself (SleepTimerExtra).
 * Nursing or tummy time hides it too, since nobody lays her down then. Only
 * with a plan, and only for people who can log.
 */
export function SleepRow() {
  const s = useSleepMaybe();
  const { state } = useMaple();
  if (!s || !s.canWrite || !s.plan || s.running || s.shift) return null;
  if (state?.entries.some((e) => e.active && (e.kind === "feed" || e.kind === "tummy" || e.kind === "sleep"))) return null;
  const sub = todayWords(s);
  return (
    <div role="group" aria-label="Sleep plan" className="flex min-h-[60px] items-center gap-1 pr-3">
      <button
        type="button"
        onClick={() => s.openSheet({ kind: "plan" })}
        aria-label={`Bassinet try${sub ? `, ${sub}` : ""}. Open the sleep plan.`}
        className="flex min-h-[60px] min-w-0 flex-1 items-center gap-2.5 py-2 pl-3.5 text-left transition active:bg-mp-ink/[0.04]"
      >
        <KindBadge icon="bassinet" color={KIND_COLOR.sleep} size={32} />
        <span className="min-w-0 flex-1 leading-[18px]">
          <span className="block truncate text-[15px] leading-[20px] font-semibold text-mp-ink">Bassinet try</span>
          {sub && <span className="block truncate text-[13px] text-mp-ink-2">{sub}</span>}
        </span>
      </button>
      <PutDownButton s={s} />
    </div>
  );
}

/** "0 of 1 tonight · Naps at home": the try day so far and the try time to aim for next. */
export function todayWords(s: SleepApi): string {
  const t = s.today;
  return t ? `${t.done} of ${t.planned} ${t.label}${t.next ? ` · ${slotLabel(t.next).replace(/^The /, "")}` : ""}` : "";
}

/**
 * Put down: a 44px target around a 36px pill, quiet (a filled one is for
 * what the moment needs, like Done or her Took it once it's OK). `disabled`:
 * her sleep timer is still starting (its temporary id means nothing to the
 * server yet), as its card's own fixes wait.
 */
export function PutDownButton({ s, disabled }: { s: SleepApi; disabled?: boolean }) {
  return (
    <button type="button" disabled={s.busy || disabled} onClick={() => void s.startTry()} className="-my-1 flex min-h-[44px] shrink-0 items-center disabled:opacity-40">
      <span className="inline-flex min-h-[36px] items-center rounded-[10px] bg-mp-sunken px-3.5 text-sm font-semibold whitespace-nowrap text-mp-ink active:scale-[0.97]">Put down</span>
    </button>
  );
}
