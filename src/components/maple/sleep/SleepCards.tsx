"use client";

import { motion } from "framer-motion";
import { useRef, type ReactNode } from "react";
import { askState, shiftStatus } from "@/lib/maple/sleep/engine";
import type { BassinetTry, HoldingShift, TryOutcome } from "@/lib/maple/sleep/types";
import { downWords, OUTCOME_LABEL, SLEEP_PLACE_LABEL, STAGE_INFO, TAG_LABEL, outcomeHint, sleepyChoices } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime } from "@/lib/maple/time";
import type { Entry, SleepPlace } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
import { fixPreset } from "../FeedParts";
import { Icon, KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { useSheets } from "../sheets";
import { TAP_COOLDOWN_MS } from "../tapCooldown";
import { holdTodayTaps } from "../tapShield";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { LeftRunningAsk, useLastNight, WokeAsk } from "./LastNight";
import { useNightValue } from "./SleepCheckin";
import { useSleepMoment } from "./SleepStrip";
import { partnerOf, usePeople, useSleep, useSleepMaybe, useTryAfterWake } from "./useSleep";

/**
 * The sleep plan on Today, for every family phone: a running bassinet try
 * (with the four outcomes as big buttons for anyone who can log) and who is
 * holding her awake (the planned handoff; "I'm getting sleepy" for the
 * holder only, "Take over" for everyone else). View-only guests see the same
 * cards without buttons, and every card's header opens the plan, as the
 * Sleep plan row under Right now does.
 */

const SLEEP = KIND_COLOR.sleep;
const OUTCOMES: TryOutcome[] = ["stayed_asleep", "woke_calm", "woke_crying", "picked_up"];

/**
 * The four outcomes, big, two by two: one tap saves (Undo in its toast). On a
 * short screen (a 320x568 phone, where the dock and tab bar take nearly half)
 * they're shorter and drop their hints, so the try's card clears the dock.
 */
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
            "mp-control flex flex-col items-start justify-center rounded-2xl bg-mp-sunken px-3.5 text-left transition active:scale-[0.98] disabled:opacity-40 [@media(max-width:340px)]:px-3",
            compact ? "min-h-[56px] py-2" : "min-h-[68px] py-2.5 [@media(max-height:640px)]:min-h-[52px] [@media(max-height:640px)]:py-1.5"
          )}
        >
          <span className="text-[15px] leading-tight font-semibold text-mp-ink [@media(max-width:340px)]:text-[14px]">{OUTCOME_LABEL[o]}</span>
          <span className="text-[12px] leading-snug text-mp-ink-2 [@media(max-height:640px)]:sr-only">{hint[o]}</span>
        </button>
      ))}
    </div>
  );
}

/** A card's header: its badge, title and lines, all one button into the plan (for every role; the region keeps the title as its name). */
function CardHead({ icon, title, children }: { icon: "bassinet" | "hold"; title: string; children?: ReactNode }) {
  const s = useSleep();
  return (
    <button type="button" onClick={() => s.openSheet({ kind: "plan" })} aria-label={`${title}. Open the sleep plan.`} className="-mx-1 -my-1 flex min-h-[44px] w-[calc(100%+0.5rem)] items-start gap-3 rounded-2xl px-1 py-1 text-left transition active:bg-mp-ink/[0.04]">
      <KindBadge icon={icon} color={SLEEP} size={36} />
      <span className="min-w-0 flex-1">
        <span className={cx(tone.heading, "block text-[17px]")}>{title}</span>
        {children}
      </span>
      <Icon name="chevron-right" size={18} className="mt-1 shrink-0 text-mp-ink-3" />
    </button>
  );
}

/**
 * A running try. It is the card for the sleep it sits on too (that sleep's
 * own timer card steps aside while it runs: one sleep, one card), so it
 * says when she fell asleep when that was before she was laid down.
 */
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
  // Asleep before the transfer (in arms, a feed): when that sleep began, so the folded sleep card's start isn't lost.
  const earlier = sleep && !woke && Date.parse(t.started_at) - Date.parse(sleep.started_at) > 90_000 ? sleep : null;
  const place = earlier ? (earlier.data as { place?: SleepPlace }).place : undefined;
  const title = woke ? `${v.They} woke at ${formatTime(sleep!.ended_at!, tz)}` : "In the bassinet";
  return (
    <motion.section layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} aria-label={title} className={cx(tone.card, "space-y-3 px-4 py-3.5 [@media(max-height:640px)]:space-y-2 [@media(max-height:640px)]:py-3")}>
      <CardHead icon="bassinet" title={title}>
        <span className={cx(tone.muted, "block text-[14px] leading-snug [@media(max-height:640px)]:text-[13px]")}>
          Since {formatTime(t.started_at, tz)} · {formatDuration(down)}
          {nth ? ` · ${nth}` : ""}
          {t.put_down_by && t.put_down_by !== state?.me.email ? ` · laid down by ${memberName(t.put_down_by)}` : ""}
          {t.tags.length > 0 ? ` · ${t.tags.map((x) => TAG_LABEL[x]).join(", ")}` : ""}
        </span>
        {earlier && (
          <span className={cx(tone.muted, "block text-[13px] leading-snug")}>
            Asleep since {formatTime(earlier.started_at, tz)}
            {place && place !== "bassinet" ? ` (${SLEEP_PLACE_LABEL[place].toLowerCase()} first)` : ""}
          </span>
        )}
      </CardHead>
      {s.canWrite && (
        <>
          <p className={cx(tone.label, "[@media(max-height:640px)]:sr-only")}>{woke ? "How did the try go?" : "When it ends, how did it go?"}</p>
          <OutcomeGrid disabled={s.busy} onPick={(o) => void s.finishTry(t, o, woke ? { at: new Date(sleep!.ended_at!) } : {})} />
          <div className="flex flex-wrap gap-x-1">
            <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "outcome", tryId: t.id, details: true })}>
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

/**
 * The running sleep a sleep card already shows, so its own timer card steps
 * aside (one sleep, one card): the one a running try sits on, else, while
 * someone holds her, her sleep in arms (the turn's card shows it). Null
 * outside a SleepProvider.
 */
export function useFoldedSleepId(): number | null {
  const s = useSleepMaybe();
  const { state } = useMaple();
  if (!s) return null;
  if (s.running) return s.running.sleep_entry_id ?? null;
  if (s.shift) return (state?.entries ?? []).find((e) => e.kind === "sleep" && e.active)?.id ?? null;
  return null;
}

/** A feed logged after a running sleep began (more than 5 minutes in): she was likely awake then, so its card asks. */
export function feedAfter(sleep: Entry, entries: readonly Entry[], now: Date): Entry | null {
  const from = Date.parse(sleep.started_at) + 5 * 60_000;
  return (
    entries
      .filter((e) => e.kind === "feed" && e.id !== sleep.id && Date.parse(e.started_at) > from && Date.parse(e.started_at) <= now.getTime())
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0] ?? null
  );
}

/**
 * "Woke at 1:35 AM?" for the turn's sleep in arms: the Last night card's
 * timer left running (from 5 AM), else a feed logged after it began. Still
 * asleep lets it be, on this phone.
 */
function ArmsWokeAsk({ sleep }: { sleep: Entry }) {
  const m = useMaple();
  const ln = useLastNight();
  const now = useNow(30_000);
  const afterWake = useTryAfterWake();
  const [raw, setRaw] = useNightValue(m.state ? `maple-still-asleep:${m.state.family?.id ?? 1}:${m.state.me.email}` : null);
  if (!m.state || m.readOnly) return null;
  if (ln?.ask?.kind === "running" && ln.ask.sleep.id === sleep.id) return <LeftRunningAsk entry={sleep} />;
  const next = feedAfter(sleep, m.state.entries, now);
  let still: Record<string, number> = {};
  try {
    still = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    still = {};
  }
  if (!next || still[String(sleep.id)] === next.id) return null;
  const woke = async () => {
    const done = await m.timerCall({ action: "stop", id: sleep.id, at: next.started_at, expect_updated_at: sleep.updated_at });
    if (done) afterWake(sleep.id, new Date(next.started_at));
  };
  return <WokeAsk sleep={sleep} next={next} busy={m.timerBusy(sleep.id)} onWoke={() => void woke()} onStill={() => setRaw(JSON.stringify({ ...still, [sleep.id]: next.id }))} />;
}

/**
 * Who's holding her awake, and her sleep in arms when she fell asleep there
 * (its own timer card steps aside: one sleep, one card; Edit sleep opens
 * it, and a feed logged after it began asks Woke at). The holder gets "I'm
 * getting sleepy" (two safe choices; the strip's action is Put her down
 * while she's asleep); once they've asked someone, the bassinet stays the
 * big button with "Alex has her" under it, and ten minutes on with nobody
 * taking over, the two safe choices again. The person asked gets "I've got
 * her"; everyone else who can log, "Take over".
 */
export function ShiftCard({ sh }: { sh: HoldingShift }) {
  const { state, memberName } = useMaple();
  const s = useSleep();
  const v = useVoice();
  const now = useNow(30_000);
  const people = usePeople();
  const sheets = useSheets();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email ?? "";
  const st = shiftStatus(sh, now);
  const ask = askState(sh, now);
  const holderIsMe = sh.holder === me;
  const holder = memberName(sh.holder);
  const asked = ask.asked ? memberName(ask.to!) : null;
  const next = sh.next_holder ? memberName(sh.next_holder) : null;
  const partner = holderIsMe ? partnerOf(sh, people, me) : null;
  const sleeping = (state?.entries ?? []).find((e) => e.kind === "sleep" && e.active) ?? null;
  const choices = sleepyChoices(v, partner ? memberName(partner.email) : null);
  const title =
    holderIsMe && ask.asked
      ? ask.stale
        ? "Nobody has taken over yet"
        : `Waking ${asked}…`
      : ask.asked && ask.to === me
        ? `${holder} asked you to take over`
        : st.due
          ? "Handoff time"
          : `${holderIsMe ? "You're" : `${holder} is`} holding ${v.name}`;
  const lines = [
    st.due && !ask.asked
      ? `${holderIsMe ? "You've" : `${holder} has`} held ${v.them} since ${formatTime(sh.started_at, tz)}. The planned handoff was ${formatTime(sh.handoff_at!, tz)}.`
      : `${holderIsMe ? "Holding" : `${holder} has held ${v.them}`} since ${formatTime(sh.started_at, tz)}${!st.due && sh.handoff_at && !ask.asked ? ` · handoff ${formatTime(sh.handoff_at, tz)} (in ${formatDuration(Math.max(0, st.minutesLeft ?? 0) * 60)})` : ""}${next && !ask.asked ? ` · then ${next}` : ""}`,
    ask.asked ? `${holderIsMe ? "You" : holder} asked ${ask.to === me ? "you" : asked} at ${formatTime(ask.at!, tz)}${ask.stale ? ` (${ask.minutes} min ago)` : ""}. Nothing has changed hands yet.` : null,
    // Her sleep in arms is this card's (its timer card steps aside): when it began and how long, as that card's clock says.
    sleeping
      ? `Asleep${(sleeping.data as { place?: SleepPlace }).place === "arms" ? " in arms" : ""} since ${formatTime(sleeping.started_at, tz)} · ${downWords(Math.max(0, now.getTime() - Date.parse(sleeping.started_at)) / 60_000)}`
      : null,
  ].filter((x): x is string => !!x);

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-label={title}
      className={cx(tone.card, "space-y-3 px-4 py-3.5", (st.due || ask.stale || (ask.asked && ask.to === me)) && "ring-2 ring-mp-accent")}
    >
      <CardHead icon="hold" title={title}>
        {lines.map((l) => (
          <span key={l} className={cx(tone.muted, "block text-[14px] leading-snug")} role={st.due || ask.asked ? "status" : undefined}>
            {l}
          </span>
        ))}
      </CardHead>
      {sleeping && s.canWrite && <ArmsWokeAsk sleep={sleeping} />}
      {s.canWrite && (
        <div className="space-y-2">
          {holderIsMe ? (
            ask.asked ? (
              <>
                {/* Asked, not handed over: the bassinet stays the big, safe choice; past ten minutes, waking them again is the other. */}
                <Button className="w-full" size="lg" disabled={s.busy} onClick={() => void s.startTry()}>
                  <Icon name="bassinet" size={18} /> {choices[0].label}
                </Button>
                {ask.stale ? (
                  <Button variant="soft" className="w-full" size="lg" disabled={s.busy} onClick={() => void s.askHandoff(sh, ask.to!)}>
                    <Icon name="bell" size={18} /> Wake {asked} again
                  </Button>
                ) : (
                  <Button variant="soft" className="w-full" size="lg" disabled={s.busy} onClick={() => void s.handOff(sh, { to: ask.to! })}>
                    {asked} has {v.them}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button className="w-full" size="lg" onClick={() => s.openSheet({ kind: "sleepy" })}>
                  <Icon name="moon" size={18} /> I&apos;m getting sleepy
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="soft" onClick={() => s.openSheet({ kind: "holding", mode: "handoff", ...(partner ? { to: partner.email } : {}) })}>
                    Hand off
                  </Button>
                  {/* Asleep in arms: laying her down is the try on that sleep (the strip offers it too, in thumb reach). */}
                  <Button variant="soft" onClick={() => void s.startTry()}>
                    {sleeping ? `Put ${v.them} down` : "Into the bassinet"}
                  </Button>
                </div>
              </>
            )
          ) : ask.asked && ask.to === me ? (
            <Button className="w-full" size="lg" disabled={s.busy} onClick={() => void s.acceptHandoff(sh)}>
              I&apos;ve got {v.them}
            </Button>
          ) : (
            <Button variant="soft" className="w-full" onClick={() => s.openSheet({ kind: "holding", mode: "handoff", to: me })}>
              Take over
            </Button>
          )}
          <div className="flex flex-wrap gap-x-1">
            {holderIsMe && sh.handoff_at && !ask.asked && (
              <Button variant="ghost" size="sm" onClick={() => void s.laterHandoff(sh, 30)}>
                Handoff 30 min later
              </Button>
            )}
            {!sleeping && (
              <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => void s.asleepInArms()}>
                Asleep in arms
              </Button>
            )}
            {/* Her sleep's own times, as its timer card's Edit times opened them. */}
            {sleeping && sleeping.id > 0 && (
              <Button variant="ghost" size="sm" onClick={() => sheets.open({ kind: sleeping.kind, entry: sleeping, preset: fixPreset("current") })}>
                Edit sleep
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

/**
 * The sleep plan's row in Today's Up next card (UpNext.tsx), for everyone who
 * reads the log (view-only guests too, who have no strip or More), once the
 * family has a plan, a goal, a try or a turn. Its words open the plan. With
 * nothing going on, someone who can log gets the plan's next step here, Put
 * down, with the day's count ("0 of 1 tonight · first night stretch"); every
 * other moment (a try, a turn, after a crying wake, the morning's question)
 * rides on the dock's strip, so this row only says where the plan stands.
 */
export function SleepPlanRow() {
  const s = useSleepMaybe();
  const { state } = useMaple();
  const m = useSleepMoment();
  const cool = useRef(Number.NEGATIVE_INFINITY);
  if (!s || !state) return null;
  const open = s.goals.filter((g) => g.status === "active" || g.status === "paused").length;
  if (!s.plan && !open && !s.data.tries.length && !s.data.shifts.length) return null;
  const idle = m?.idle ? m : null;
  const goals = open ? `${open} ${open === 1 ? "goal" : "goals"}` : null;
  const sub = (
    idle
      ? [idle.sub, goals]
      : [s.plan ? `Stage ${s.plan.stage} · ${STAGE_INFO[s.plan.stage].title}` : null, s.today ? `${s.today.done} of ${s.today.planned} ${s.today.label}` : null, goals]
  )
    .filter(Boolean)
    .join(" · ");
  // Put down brings the try's card in above this row, moving the page under the thumb: for the tap cooldown a tap on
  // the page does nothing (tapShield), so a double tap's second half never lands on an outcome, Edit time or the Last fed
  // block that slid under it, and this button waits it out too.
  const putDown = () => {
    const t = performance.now();
    if (!idle || t - cool.current < TAP_COOLDOWN_MS) return;
    cool.current = t;
    holdTodayTaps();
    idle.action.onClick();
  };
  return (
    <div data-sleep-row className="flex min-h-[60px] items-center gap-1 pr-3">
      <button
        type="button"
        onClick={() => s.openSheet({ kind: "plan" })}
        aria-label={`Sleep plan${sub ? `: ${sub}` : ""}. Open the sleep plan.`}
        className={cx("flex min-h-[60px] min-w-0 flex-1 items-center gap-2.5 py-2 pl-3.5 text-left transition active:bg-mp-ink/[0.04]", !idle && "pr-1")}
      >
        <KindBadge icon={idle ? "bassinet" : "moon"} color={SLEEP} size={32} />
        <span className="min-w-0 flex-1 leading-[18px]">
          <span className={cx(tone.heading, "block text-[15px] leading-[20px]")}>Sleep plan</span>
          {sub && <span className={cx(tone.muted, "block text-[13px] leading-snug")}>{sub}</span>}
        </span>
        {!idle && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
      </button>
      {idle && (
        // A 44px target around a 36px pill, as her Took it beside it in Up next; filled only when she's asleep and a try is still to do.
        <button type="button" disabled={s.busy} onClick={putDown} className="-my-1 flex min-h-[44px] shrink-0 items-center disabled:opacity-40">
          <span className={cx("inline-flex min-h-[36px] items-center rounded-[10px] px-3.5 text-sm font-semibold whitespace-nowrap active:scale-[0.97]", idle.action.strong ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink")}>
            {idle.action.label}
          </span>
        </button>
      )}
    </div>
  );
}
