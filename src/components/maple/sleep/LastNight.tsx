"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { SLEEP_GUIDES } from "@/lib/maple/guidelines/sleep";
import { tryDayKey } from "@/lib/maple/sleep/engine";
import { goalStartKey, lastNightKey, nightAnswers, nightPicture, plannedHandoff, type NightBar, type NightGap, type NightPicture } from "@/lib/maple/sleep/goals";
import { CHECKIN_PLACES, HANDOFF_ANSWERS, UNTIMED_TRIES, type SleepGoal } from "@/lib/maple/sleep/types";
import { checkinQuestion, dateWords, HANDOFF_LABEL, handoffQuestion, PLACE_LABEL, placeQuestion, UNTIMED_QUESTION, untimedLabels } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, formatDuration, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Voice } from "@/lib/maple/voice";
import { AskChatButton } from "../chat/AskChat";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { Button, Chip, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { AnswerButtons, checkinDue, morningOf, myWindows, useNightValue } from "./SleepCheckin";
import { useSleepMaybe, useTryAfterWake } from "./useSleep";

/**
 * Today's Last night card, from 5 AM the morning after, with no
 * notification: the night as a strip from the log (goals.ts nightPicture);
 * each stretch over 90 minutes with nothing logged between two things that
 * were, with one tap for what happened ("She slept through" logs a sleep
 * for it; "Up or feeding" and "Not sure" save nothing, and the night stays
 * partly logged); a sleep timer left running past something logged later,
 * with "Woke at" that moment; Tell Maple, which opens the chat with "Last
 * night: " typed (a photo of a paper log is read back before anything
 * saves); and the adult's own check-in ("Did you get your 10 PM–2 AM
 * sleep?") with the night's other one-tap questions, each once a night. One
 * thing at a time, so it stays small on a 320 × 568 phone. Not now hides it
 * for that night on this phone. It replaces the morning check-in card, for
 * owners and members of a family with a sleep plan or goal.
 */

type Gap = NightGap;
type Bar = NightBar;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 sleeps, 3 feeds and 1 diaper logged", "Nothing logged". */
function loggedWords(c: NightPicture["counts"]): string {
  const parts = [c.sleeps ? plural(c.sleeps, "sleep") : "", c.feeds ? plural(c.feeds, "feed") : "", c.diapers ? plural(c.diapers, "diaper") : "", c.other ? plural(c.other, "other entry", "other entries") : ""].filter(Boolean);
  if (!parts.length) return "Nothing logged";
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]} logged`;
}

const BAR_COLOR: Record<Bar["kind"], string> = { ...KIND_COLOR, try: KIND_COLOR.sleep, hold: "#7F8C6A" };

/** The night as one bar: sleeps and feeds where they were logged, other entries as ticks, and the stretches asked about outlined. */
function NightStrip({ pic, tz, ask }: { pic: NightPicture; tz: string; ask: Gap | null }) {
  const span = Math.max(1, pic.to - pic.from);
  const x = (t: number) => `${(((t - pic.from) / span) * 100).toFixed(2)}%`;
  const w = (s: number, e: number) => `max(3px, ${(((e - s) / span) * 100).toFixed(2)}%)`;
  const label = `${loggedWords(pic.counts)} between ${formatTime(pic.from, tz)} and ${formatTime(pic.to, tz)}${pic.gaps.length ? `; nothing logged ${pic.gaps.map((g) => `${formatTimeNear(g.start, g.end, tz)}–${formatTime(g.end, tz)}`).join(" and ")}` : ""}.`;
  return (
    <div>
      <div role="img" aria-label={label} data-night-strip className="relative h-7 overflow-hidden rounded-lg bg-mp-sunken">
        {pic.bars.map((b, i) => (
          <span
            key={i}
            className={cx("absolute", b.kind === "sleep" || b.kind === "try" ? "top-1 bottom-1 rounded-[5px] opacity-80" : b.kind === "hold" ? "bottom-0 h-1.5 rounded-sm opacity-70" : "top-0 bottom-0 rounded-[2px]")}
            style={{ left: x(b.start), width: w(b.start, b.end), backgroundColor: BAR_COLOR[b.kind] }}
          />
        ))}
        {ask && <span aria-hidden className="absolute top-0 bottom-0 rounded-lg border-2 border-dashed border-mp-accent-fg" style={{ left: x(ask.start), width: w(ask.start, ask.end) }} />}
      </div>
      <div aria-hidden className="mt-1 flex justify-between text-[12px] text-mp-ink-3 tabular-nums">
        <span>{formatTime(pic.from, tz)}</span>
        <span>{pic.toNow ? "now" : formatTime(pic.to, tz)}</span>
      </div>
    </div>
  );
}

type Memo = { night: string; hidden?: boolean; gaps?: number[] };
const memoKey = (family: number, me: string) => `maple-last-night:${family}:${me}`;
const readMemo = (raw: string | null | undefined, night: string): Memo => {
  try {
    const m = raw ? (JSON.parse(raw) as Memo) : null;
    return m && m.night === night ? m : { night };
  } catch {
    return { night };
  }
};

/** The safe-sleep line for "Somewhere else": the guidance's own words. */
function safeSleepLine(v: Voice): string {
  const pick = (id: string) => SLEEP_GUIDES.find((g) => g.id === id)?.body(v) ?? "";
  return [pick("safe-back"), pick("safe-room")].filter(Boolean).join(" ");
}

/** The card's one thing to answer: a title and its choices. */
function Ask({ id, title, sub, children }: { id: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h4 id={id} className={cx(tone.heading, "text-[15px] leading-snug")}>
        {title}
      </h4>
      {sub && <p className={cx(tone.muted, "-mt-1 text-[13px] leading-snug")}>{sub}</p>}
      {children}
    </section>
  );
}

export function LastNightCard() {
  const s = useSleepMaybe();
  const m = useMaple();
  const { state } = m;
  const v = useVoice();
  const now = useNow(60_000);
  const afterWake = useTryAfterWake();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const night = lastNightKey(now, tz);
  const [raw, setRaw] = useNightValue(state && s?.canWrite ? memoKey(state.family?.id ?? 1, s.me) : null);
  if (!s || !state || !s.canWrite || raw === undefined) return null;
  const active = s.goals.filter((g) => g.status === "active" && goalStartKey(g, tz) <= night);
  if (!s.plan && !active.length) return null;
  if (now.getTime() < morningOf(now, tz)) return null;
  const memo = readMemo(raw, night);
  if (memo.hidden) return null;
  const save = (next: Memo) => setRaw(JSON.stringify(next));

  const pic = nightPicture({ night, entries: state.entries, tries: s.data.tries, shifts: s.data.shifts, tz, now: now.getTime() });
  const due = checkinDue({ goals: s.goals, checkins: s.checkins, me: s.me, role: state.me.role, now, tz });
  const mine = s.checkins?.find((c) => c.member === s.me && c.night === night) ?? null;
  const said = s.checkins ? nightAnswers(s.checkins, night) : null;
  const gap = pic.gaps.find((g) => !(memo.gaps ?? []).includes(g.start)) ?? null;
  // The night's other questions, once a night, only after this adult's own answer (it carries them).
  const nightsTries = s.data.tries.some((t) => tryDayKey(Date.parse(t.started_at), tz) === night);
  const minutes = active.flatMap((g: SleepGoal) => g.targets.flatMap((t) => (t.kind === "bassinet_nights" ? [t.min_minutes] : [])))[0] ?? null;
  const handoff = mine ? plannedHandoff(active, s.data.shifts, night, tz) : null;
  const askPlace = !!mine && !!said && !said.place;
  const askUntimed = !!mine && !!said && !said.untimed && minutes != null && !nightsTries;
  const askHandoff = !!mine && !!said && !said.handoff && !!handoff;
  const elsewhere = said?.place === "elsewhere";

  const answerGap = (g: Gap) => save({ ...memo, gaps: [...(memo.gaps ?? []), g.start] });
  const sleptThrough = async (g: Gap) => {
    const saved = await m.log(
      { kind: "sleep", client_id: `lastnight-${night}-${g.start}`, started_at: new Date(g.start).toISOString(), ended_at: new Date(g.end).toISOString(), data: {} },
      { toast: `Logged: asleep ${formatTimeNear(g.start, g.end, tz)}–${formatTime(g.end, tz)}` }
    );
    if (saved) answerGap(g);
  };
  const wokeAt = async () => {
    const r = pic.leftRunning!;
    const at = r.next.started_at;
    const done = await m.timerCall({ action: "stop", id: r.sleep.id, at, expect_updated_at: r.sleep.updated_at });
    if (done) afterWake(r.sleep.id, new Date(at));
  };

  let body: ReactNode = null;
  if (pic.leftRunning) {
    const r = pic.leftRunning;
    body = (
      <Ask id="last-night-ask" title={`The sleep timer is still running from ${formatTime(r.sleep.started_at, tz)}`} sub={`${r.next.kind === "feed" ? "A feed" : "Something"} was logged at ${formatTime(r.next.started_at, tz)}.`}>
        <div className="flex flex-wrap gap-2">
          <Chip disabled={m.timerBusy(r.sleep.id)} onClick={() => void wokeAt()}>
            Woke at {formatTime(r.next.started_at, tz)}
          </Chip>
        </div>
      </Ask>
    );
  } else if (due) {
    const question = checkinQuestion(due.windows);
    body = (
      <Ask id="last-night-ask" title={question}>
        <AnswerButtons row question={question} disabled={s.busy} onPick={(a) => void s.saveCheckin(a, { night: due.night })} />
      </Ask>
    );
  } else if (gap) {
    body = (
      <Ask id="last-night-ask" title={`Nothing logged ${formatTimeNear(gap.start, gap.end, tz)}–${formatTime(gap.end, tz)}`} sub={`${formatDuration((gap.end - gap.start) / 1000)} between two things that were.`}>
        <div className="flex flex-wrap gap-2">
          <Chip disabled={s.busy} onClick={() => void sleptThrough(gap)}>
            {v.They} slept through
          </Chip>
          <Chip onClick={() => answerGap(gap)}>Up or feeding</Chip>
          <Chip
            onClick={() => {
              answerGap(gap);
              m.toast("Left as not logged: that stretch stays out of the counts.", { tone: "info" });
            }}
          >
            Not sure
          </Chip>
        </div>
      </Ask>
    );
  } else if (askPlace) {
    body = (
      <Ask id="last-night-ask" title={placeQuestion(v)}>
        <div className="flex flex-wrap gap-2">
          {CHECKIN_PLACES.map((p) => (
            <Chip key={p} disabled={s.busy} onClick={() => void s.saveCheckinExtras(night, { place: p }, `Saved: ${PLACE_LABEL[p].toLowerCase()}`)}>
              {PLACE_LABEL[p]}
            </Chip>
          ))}
        </div>
      </Ask>
    );
  } else if (askUntimed) {
    const labels = untimedLabels(minutes!);
    body = (
      <Ask id="last-night-ask" title={UNTIMED_QUESTION} sub="No try is in the log for last night.">
        <div className="flex flex-wrap gap-2">
          {UNTIMED_TRIES.map((u) => (
            <Chip key={u} disabled={s.busy} onClick={() => void s.saveCheckinExtras(night, { untimed_try: u, untimed_min: u === "no" ? null : minutes }, `Saved: ${labels[u].toLowerCase()}`)}>
              {labels[u]}
            </Chip>
          ))}
        </div>
      </Ask>
    );
  } else if (askHandoff) {
    body = (
      <Ask id="last-night-ask" title={handoffQuestion(formatTime(handoff!.at, tz))}>
        <div className="flex flex-wrap gap-2">
          {HANDOFF_ANSWERS.map((h) => (
            <Chip key={h} disabled={s.busy} onClick={() => void s.saveCheckinExtras(night, { handoff: h }, `Saved: ${HANDOFF_LABEL[h].toLowerCase()}`)}>
              {HANDOFF_LABEL[h]}
            </Chip>
          ))}
        </div>
      </Ask>
    );
  }
  // Nothing left to ask: the card goes (a "Somewhere else" answer keeps it for the safe-sleep line).
  if (!body && !elsewhere) return null;
  const windows = myWindows(s.goals, s.me, night);
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby="last-night"
      data-last-night
      className={cx(tone.card, "space-y-3 px-4 py-3.5")}
    >
      <div className="flex items-center gap-3">
        <KindBadge icon="moon" color={KIND_COLOR.sleep} size={36} />
        <div className="min-w-0 flex-1">
          <h3 id="last-night" className={cx(tone.heading, "text-[17px] leading-tight")}>
            Last night
          </h3>
          <p className={cx(tone.muted, "truncate text-[13px] leading-snug")}>
            {dateWords(night, dayKey(now, tz))} · {loggedWords(pic.counts)}
          </p>
        </div>
      </div>
      <NightStrip pic={pic} tz={tz} ask={body && !pic.leftRunning && !due ? gap : null} />
      {body}
      {elsewhere && (
        <p role="note" data-safe-sleep className={cx(tone.inset, "px-3 py-2.5 text-[13px] leading-snug text-mp-ink")}>
          {safeSleepLine(v)}
        </p>
      )}
      <div className="-mx-1 flex flex-wrap items-center gap-x-1">
        <AskChatButton prompt="Last night: " label="Last night">
          Tell Maple
        </AskChatButton>
        {(due || mine) && windows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "checkin", night })}>
            Add a note
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => save({ ...memo, hidden: true })}>
          Not now
        </Button>
      </div>
    </motion.section>
  );
}

