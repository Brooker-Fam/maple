"use client";

import { motion } from "framer-motion";
import { shiftStatus } from "@/lib/maple/sleep/engine";
import type { BassinetTry, HoldingShift, TryOutcome } from "@/lib/maple/sleep/types";
import { OUTCOME_LABEL, TAG_LABEL, outcomeHint } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { Icon, KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useSleep, useSleepMaybe } from "./useSleep";

/**
 * The sleep plan on Today, for every family phone: a running bassinet try
 * (with the four outcomes as big buttons for anyone who can log) and who is
 * holding her awake (the planned handoff, and "I'm getting sleepy" first).
 * View-only guests see the same cards without buttons.
 */

const SLEEP = KIND_COLOR.sleep;
const OUTCOMES: TryOutcome[] = ["stayed_asleep", "woke_calm", "woke_crying", "picked_up"];

/** The four outcomes, big, two by two: one tap saves (Undo in its toast). */
export function OutcomeGrid({ onPick, disabled, compact }: { onPick: (o: TryOutcome) => void; disabled?: boolean; compact?: boolean }) {
  const v = useVoice();
  const hint = outcomeHint(v);
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="How did it go?">
      {OUTCOMES.map((o) => (
        <button
          key={o}
          type="button"
          disabled={disabled}
          onClick={() => onPick(o)}
          className={cx(
            "mp-control flex flex-col items-start justify-center rounded-2xl bg-mp-sunken px-3.5 text-left transition active:scale-[0.98] disabled:opacity-40",
            compact ? "min-h-[56px] py-2" : "min-h-[68px] py-2.5"
          )}
        >
          <span className="text-[15px] font-semibold text-mp-ink">{OUTCOME_LABEL[o]}</span>
          <span className="text-[12px] leading-snug text-mp-ink-2">{hint[o]}</span>
        </button>
      ))}
    </div>
  );
}

export function TryCard({ t }: { t: BassinetTry }) {
  const { state, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const sleep = t.sleep_entry_id ? state?.entries.find((e) => e.id === t.sleep_entry_id) : undefined;
  // Woke up was tapped elsewhere (the dock, Siri): the try is waiting for how it went, ending when she woke.
  const woke = !!sleep && !sleep.active && !!sleep.ended_at;
  const down = Math.max(0, (now.getTime() - Date.parse(t.started_at)) / 1000);
  const nth = s.nth(t);
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby={`try-${t.id}`}
      className={cx(tone.card, "space-y-3 px-4 py-3.5")}
    >
      <div className="flex items-start gap-3">
        <KindBadge icon="bassinet" color={SLEEP} size={40} />
        <div className="min-w-0 flex-1">
          <h3 id={`try-${t.id}`} className={cx(tone.heading, "text-[17px]")}>
            {woke ? `${v.They} woke at ${formatTime(sleep!.ended_at!, tz)}` : "In the bassinet"}
          </h3>
          <p className={cx(tone.muted, "text-[14px] leading-snug")}>
            Since {formatTime(t.started_at, tz)} · {formatDuration(down)}
            {nth ? ` · ${nth}` : ""}
            {t.put_down_by ? ` · laid down by ${memberName(t.put_down_by)}` : ""}
          </p>
          {t.tags.length > 0 && <p className={cx(tone.faint, "text-[13px]")}>{t.tags.map((x) => TAG_LABEL[x]).join(" · ")}</p>}
        </div>
      </div>
      {s.canWrite && (
        <>
          <p className={cx(tone.label)}>{woke ? "How did the try go?" : "When it ends, how did it go?"}</p>
          <OutcomeGrid disabled={s.busy} onPick={(o) => void s.finishTry(t, o, woke ? { at: new Date(sleep!.ended_at!) } : {})} />
          <div className="flex flex-wrap gap-x-1">
            <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "outcome", tryId: t.id })}>
              Tags, note or an earlier end
            </Button>
            <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "try", tryId: t.id })}>
              Edit time
            </Button>
            <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "plan", tab: "guidance" })}>
              If {v.they} {v.verb("wakes")} crying
            </Button>
          </div>
        </>
      )}
    </motion.section>
  );
}

export function ShiftCard({ sh }: { sh: HoldingShift }) {
  const { state, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(30_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const st = shiftStatus(sh, now);
  const holderIsMe = sh.holder === state?.me.email;
  const next = sh.next_holder ? memberName(sh.next_holder) : null;
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby={`shift-${sh.id}`}
      className={cx(tone.card, "space-y-3 px-4 py-3.5", st.due && "ring-2 ring-mp-accent")}
    >
      <div className="flex items-start gap-3">
        <KindBadge icon="hold" color={SLEEP} size={40} />
        <div className="min-w-0 flex-1">
          <h3 id={`shift-${sh.id}`} className={cx(tone.heading, "text-[17px]")}>
            {st.due ? "Handoff time" : `${holderIsMe ? "You're" : `${memberName(sh.holder)} is`} holding ${v.name}`}
          </h3>
          <p className={cx(tone.muted, "text-[14px] leading-snug")} role={st.due ? "status" : undefined}>
            {st.due ? `${holderIsMe ? "You've" : `${memberName(sh.holder)} has`} held ${v.them} since ${formatTime(sh.started_at, tz)}. The planned handoff was ${formatTime(sh.handoff_at!, tz)}.` : `Awake and holding since ${formatTime(sh.started_at, tz)}`}
            {!st.due && sh.handoff_at ? ` · handoff ${formatTime(sh.handoff_at, tz)} (in ${formatDuration(Math.max(0, st.minutesLeft ?? 0) * 60)})` : ""}
            {next ? ` · then ${next}` : ""}
          </p>
        </div>
      </div>
      {s.canWrite && (
        <div className="space-y-2">
          <Button className="w-full" size="lg" onClick={() => s.openSheet({ kind: "sleepy" })}>
            <Icon name="moon" size={18} /> I&apos;m getting sleepy
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="soft" onClick={() => s.openSheet({ kind: "holding", mode: "handoff" })}>
              Hand off
            </Button>
            <Button variant="soft" onClick={() => void s.startTry()}>
              Into the bassinet
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-1">
            {sh.handoff_at && (
              <Button variant="ghost" size="sm" onClick={() => void s.laterHandoff(sh, 30)}>
                Handoff 30 min later
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void s.endShift(sh)}>
              End
            </Button>
          </div>
        </div>
      )}
    </motion.section>
  );
}

/** Today's "Right now" cards for the sleep plan (nothing without a running try or an open shift, or outside a SleepProvider). */
export function SleepNow() {
  const s = useSleepMaybe();
  if (!s) return null;
  return (
    <>
      {s.running && <TryCard key={`try-${s.running.id}`} t={s.running} />}
      {s.shift && !s.running && <ShiftCard key={`shift-${s.shift.id}`} sh={s.shift} />}
    </>
  );
}
