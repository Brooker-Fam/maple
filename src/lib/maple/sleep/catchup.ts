/**
 * The catch-up for whoever takes over a holding turn, from the log: the last
 * feed and the next side, the last diaper, and what's running, with the next
 * planned handoff, and how her feeds are covered in the protected window of
 * the adult going off duty (the roster's `covers`: "bring her to Sam to
 * nurse", "a bottle of expressed milk"). Pure, so the app and Siri say the
 * same thing from the same facts (insights.ts summarize, as Today's Right
 * now has them; sleep/roster.ts feedCover): the catch-up sheet shows it as
 * lines (catchUpLines), and Siri's "Maple handoff" from anyone but the
 * holder says it in a few short sentences (catchUpSpoken).
 *
 * Siri's "Maple, what did I miss?" (recapWords) is its sibling: what was
 * logged since a moment (the start of the speaker's protected window, or
 * their last visit), what's going on now and the next side, in at most
 * three sentences. Only what was logged: a stretch with nothing logged says
 * so, never "no feeds".
 *
 * Every time is the family's (`tz`), and the baby is the family's own
 * (`Voice`): never a hard-coded name or pronoun.
 */
import { nextSideFor, nextSideText, nursingRuns, openSegment, type LastFed, type NextSide, type NursingRun } from "../feed";
import type { Summary } from "../insights";
import { formatRelative, formatTime } from "../time";
import type { Entry, EntryOf, FeedData, SleepPlace, StretchSide } from "../types";
import type { Voice } from "../voice";
import { handoffWhyWords, type HandoffWhy } from "./handoff";
import type { feedCover } from "./roster";
import type { BassinetTry, HoldingShift, TryOutcome } from "./types";
import { downWords, SLEEP_PLACE_LABEL } from "./words";

/** How her feeds are covered in the off-duty adult's protected window (sleep/roster.ts feedCover). */
export type FeedCover = NonNullable<ReturnType<typeof feedCover>>;

/**
 * The feeding plan for whoever takes over, from the off-duty adult's window:
 * "bring her to Sam to nurse", "a bottle of expressed milk" ("a bottle" for
 * a baby on bottles only), or "nursing, as planned" when nobody is named as
 * the one who nurses. Null when the window plans no feed or doesn't say
 * (nothing to tell, and never a word against feeding her), or when the one
 * taking over is the one who nurses. Who nurses: the goal's template (Back
 * to work), else her page's person (`careMember`) when that's the off-duty
 * adult or the one taking over.
 */
export function feedPlan(cover: FeedCover | null, o: { vo: Voice; taker: string; careMember?: string | null; name: (id: string) => string }): string | null {
  if (!cover?.covers || cover.covers === "none") return null;
  if (cover.covers === "bottle") return cover.nursing === null ? "a bottle" : "a bottle of expressed milk";
  const care = o.careMember && (o.careMember === cover.member || o.careMember === o.taker) ? o.careMember : null;
  const nurser = typeof cover.nursing === "string" ? cover.nursing : cover.nursing === undefined ? care : null;
  if (nurser && nurser === o.taker) return null;
  return nurser ? `bring ${o.vo.them} to ${o.name(nurser)} to nurse` : "nursing, as planned";
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** What the catch-up reads from the summary (Today's Right now). */
export type CatchUpSource = Pick<Summary, "active" | "lastFed" | "next" | "lastDiaper">;

export type CatchUpLine = { label: string; text: string };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ms = (v: string) => Date.parse(v);

/** "25 minutes", "1 hour 5 minutes", "under a minute". */
export function minutesSaid(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minute${r === 1 ? "" : "s"}` : ""}`;
}

/** "wet", "dirty", "wet and dirty". */
const diaperKind = (d: EntryOf<"diaper">) => (d.data.pee && d.data.poop ? "wet and dirty" : d.data.poop ? "dirty" : "wet");

const placeOf = (e: Entry) => (e.data as { place?: SleepPlace }).place;

/**
 * A sleep still running somewhere that isn't her own sleep space, the next
 * step in the safety guidance's words: from a car seat, stroller or carrier,
 * "Move her to the bassinet, on her back, as soon as you can."; from a
 * grown-up bed, "Move her to her own sleep space, on her back, as soon as you
 * can.". Null anywhere else.
 */
export function moveWords(place: SleepPlace | undefined, vo: Pick<Voice, "them" | "their">): string | null {
  if (place === "car" || place === "stroller" || place === "carrier") return `Move ${vo.them} to the bassinet, on ${vo.their} back, as soon as you can.`;
  if (place === "bed") return `Move ${vo.them} to ${vo.their} own sleep space, on ${vo.their} back, as soon as you can.`;
  return null;
}

/** The running timers other than a feed, in a few words each ("asleep since 1:45 AM (in arms), 25m", "tummy time"), with moveWords after a sleep that needs it. */
function runningParts(active: readonly Entry[], now: Date, tz: string, v: Voice): string[] {
  const running = active.filter((e) => e.kind !== "feed");
  const sleep = running.find((e) => e.kind === "sleep");
  const place = sleep ? placeOf(sleep) : undefined;
  const move = moveWords(place, v);
  const others = running.filter((e) => e.kind !== "sleep").map((e) => (e.kind === "tummy" ? "tummy time" : e.kind === "pump" ? "pumping" : e.kind));
  return [
    ...(sleep ? [`asleep since ${formatTime(sleep.started_at, tz)}${place ? ` (${SLEEP_PLACE_LABEL[place].toLowerCase()})` : ""}, ${downWords((now.getTime() - ms(sleep.started_at)) / MIN)}${move ? `. ${move}` : ""}`] : []),
    ...others,
  ];
}

/**
 * The catch-up sheet's lines ("I've got her"): Feed, Diaper, Running, If
 * hungry (the off-duty adult's window's feeding plan, when it has one) and,
 * with a next planned handoff (or why there's none), Handoff.
 */
export function catchUpLines(input: {
  summary: CatchUpSource | null;
  now: Date;
  tz: string;
  v: Voice;
  me: string;
  memberName: (email: string | null | undefined) => string;
  next: string | null;
  nextHolder: string | null;
  /** The next handoff moved off the next holder's protected window (sleep/handoff.ts). */
  why?: HandoffWhy | null;
  /** How feeds are covered in the off-duty adult's window (sleep/roster.ts feedCover), and her page's person, for who nurses. */
  cover?: FeedCover | null;
  careMember?: string | null;
}): CatchUpLine[] {
  const { summary, now, tz, v } = input;
  const out: CatchUpLine[] = [];
  const nursing = summary?.active.find((e) => e.kind === "feed") ?? null;
  const fed = summary?.lastFed ?? null;
  const side = summary?.next ? `next side ${nextSideText(summary.next)}` : null;
  if (nursing) out.push({ label: "Feed", text: `Nursing now, since ${formatTime(nursing.started_at, tz)}` });
  else if (fed) out.push({ label: "Feed", text: `Last fed ${formatTime(fed.at, tz)} (${formatRelative(fed.at, now)})${side ? ` · ${side}` : ""}` });
  else out.push({ label: "Feed", text: "No feed logged lately" });
  const diaper = summary?.lastDiaper ?? null;
  if (diaper) out.push({ label: "Diaper", text: `Last changed ${formatTime(diaper.started_at, tz)} (${formatRelative(diaper.started_at, now)}) · ${diaperKind(diaper)}` });
  else out.push({ label: "Diaper", text: "No diaper logged lately" });
  const parts = runningParts(summary?.active ?? [], now, tz, v);
  out.push({ label: "Running", text: parts.length ? parts.join(" · ").replace(/^./, (c) => c.toUpperCase()) : nursing ? "The nursing timer" : `Nothing else; ${v.they}${v.verb("'s")} awake by the log` });
  const plan = feedPlan(input.cover ?? null, { vo: v, taker: input.me, careMember: input.careMember, name: (id) => input.memberName(id) });
  if (plan && input.cover) out.push({ label: "If hungry", text: `Before ${formatTime(input.cover.end, tz)}: ${plan}` });
  const why = input.why ? handoffWhyWords(input.why, input.why.member === input.me ? "your" : input.memberName(input.why.member), tz) : null;
  if (input.next) {
    const who = input.nextHolder ? (input.nextHolder === input.me ? "you" : input.memberName(input.nextHolder)) : null;
    out.push({ label: "Handoff", text: `Next planned for ${formatTime(input.next, tz)}${who ? `, to ${who}` : ""}${why ? `, ${why}` : ""}` });
  } else if (why) out.push({ label: "Handoff", text: cap(why) });
  return out;
}

// ── said ─────────────────────────────────────────────────────────────────

const SIDE_SAID: Record<"L" | "R", string> = { L: "left", R: "right" };

/** " on the left" (one side), ", starting on the left" (both), ", starting on the left and going back and forth", ", a bottle", or "". */
function sidesSaid(run: Pick<NursingRun, "firstSide" | "order" | "backAndForth"> | null, bottle: boolean): string {
  if (bottle) return ", a bottle";
  if (!run?.firstSide) return "";
  const first = SIDE_SAID[run.firstSide];
  if (run.backAndForth) return `, starting on the ${first} and going back and forth`;
  const sides = new Set<StretchSide>(run.order);
  return sides.size <= 1 ? ` on the ${first}` : `, starting on the ${first}`;
}

/** "right is next" ("…, or whichever side feels fuller" after back and forth). */
const nextSaid = (n: NextSide) => `${SIDE_SAID[n.side]} is next${n.fuller ? ", or whichever side feels fuller" : ""}`;

/** Where a running feed is: ", on the left", ", going back and forth", ", on a break since 2:25" (`t` says the time). */
function feedWhere(e: Entry, t: (at: string | number) => string): string {
  const d = e.data as FeedData;
  const open = openSegment(d.segments);
  if (open) return open.side === "B" ? ", going back and forth" : `, on the ${SIDE_SAID[open.side]}`;
  const breakAt = d.segments?.at(-1)?.end;
  return breakAt ? `, on a break since ${t(breakAt)}` : "";
}

/** Where a sleep is, after "asleep since 1:45": ", in arms", ", in the bassinet". */
const SLEEP_IN: Partial<Record<SleepPlace, string>> = { arms: "in arms", bassinet: "in the bassinet", crib: "in the crib", carrier: "in the carrier", stroller: "in the stroller", car: "in the car seat", bed: "in a grown-up bed" };

/**
 * Siri's take-over catch-up, a few short sentences: the last feed with its
 * time and side and the next side ("Last fed at 1:10, starting on the left;
 * right is next."), the last diaper ("Wet diaper at 12:40."), what's running
 * ("Asleep since 1:45, in the bassinet."; from a car seat, stroller, carrier
 * or grown-up bed, moveWords after it), and, when the off-duty adult's
 * window plans one, how to feed her in it ("If she's hungry before 5:30:
 * bring her to Sam to nurse."). `clock` says a time the way the rest of the
 * reply does. `armsSaid`: the reply already says her sleep in arms runs on,
 * so it isn't said twice. `taker`: who is taking over.
 */
export function catchUpSpoken(
  s: CatchUpSource | null,
  o: { now: Date; tz: string; vo: Voice; clock: (at: string | number) => string; armsSaid?: boolean; taker?: string; cover?: FeedCover | null; careMember?: string | null; name?: (id: string) => string }
): string[] {
  const { vo, clock: t } = o;
  const out: string[] = [];
  const nursing = s?.active.find((e) => e.kind === "feed") ?? null;
  const fed: LastFed | null = s?.lastFed ?? null;
  if (nursing) out.push(`${vo.They}${vo.verb("'s")} nursing now${feedWhere(nursing, t)}, since ${t(nursing.started_at)}.`);
  else if (fed) out.push(`Last fed at ${t(fed.at)}${sidesSaid(fed.run, fed.kind === "bottle")}${s?.next ? `; ${nextSaid(s.next)}` : ""}.`);
  else out.push("No feed logged lately.");
  const diaper = s?.lastDiaper ?? null;
  out.push(diaper ? `${cap(diaperKind(diaper))} diaper at ${t(diaper.started_at)}.` : "No diaper logged lately.");
  const running = (s?.active ?? []).filter((e) => e.kind !== "feed");
  const sleep = running.find((e) => e.kind === "sleep");
  const bits: string[] = [];
  if (sleep && !(o.armsSaid && placeOf(sleep) === "arms")) {
    const where = SLEEP_IN[placeOf(sleep) ?? ("" as SleepPlace)];
    bits.push(`asleep since ${t(sleep.started_at)}${where ? `, ${where}` : ""}`);
  }
  for (const e of running) {
    if (e.kind === "tummy") bits.push(`tummy time since ${t(e.started_at)}`);
    else if (e.kind === "pump") bits.push(`pumping since ${t(e.started_at)}`);
  }
  if (bits.length) out.push(`${cap(bits.join("; "))}.`);
  // Asleep in a car seat, stroller, carrier or grown-up bed: the next step ("Move her to the bassinet, on her back, as soon as you can.").
  const move = sleep ? moveWords(placeOf(sleep), vo) : null;
  if (move) out.push(move);
  const plan = o.cover && o.taker && o.name ? feedPlan(o.cover, { vo, taker: o.taker, careMember: o.careMember, name: o.name }) : null;
  if (plan && o.cover) out.push(`If ${vo.they}${vo.verb("'s")} hungry before ${t(o.cover.end)}: ${plan}.`);
  return out;
}

// ── "what did I miss?" ───────────────────────────────────────────────────

const OUTCOME_SAID: Record<TryOutcome, (m: number) => string> = {
  stayed_asleep: (m) => `stayed asleep ${minutesSaid(m)}`,
  woke_calm: (m) => `woke calm after ${minutesSaid(m)}`,
  woke_crying: (m) => `woke crying after ${minutesSaid(m)}`,
  picked_up: (m) => `was picked up after ${minutesSaid(m)}`,
};
const OUTCOME_COUNT: Record<TryOutcome, string> = { stayed_asleep: "stayed asleep", woke_calm: "woke calm", woke_crying: "woke crying", picked_up: "picked up" };

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "a bassinet try that stayed asleep 1 hour 50 minutes", or "3 bassinet tries: 2 stayed asleep (the longest 1 hour 50 minutes), 1 woke calm". */
function triesSaid(tries: readonly BassinetTry[]): string | null {
  const done = tries.filter((x) => x.ended_at && x.outcome);
  if (!done.length) return null;
  const minutes = (x: BassinetTry) => (ms(x.ended_at!) - ms(x.started_at)) / MIN;
  if (done.length === 1) return `a bassinet try that ${OUTCOME_SAID[done[0].outcome!](minutes(done[0]))}`;
  const groups = (Object.keys(OUTCOME_COUNT) as TryOutcome[]).flatMap((o) => {
    const these = done.filter((x) => x.outcome === o);
    if (!these.length) return [];
    const longest = o === "stayed_asleep" && these.length > 1 ? ` (the longest ${minutesSaid(Math.max(...these.map(minutes)))})` : o === "stayed_asleep" ? ` ${minutesSaid(minutes(these[0]))}` : "";
    return [`${these.length} ${OUTCOME_COUNT[o]}${longest}`];
  });
  return `${done.length} bassinet tries: ${groups.join(", ")}`;
}

/** "1 wet diaper", "2 dirty diapers", "3 diapers (2 wet, 2 dirty)". */
function diapersSaid(diapers: readonly EntryOf<"diaper">[]): string | null {
  if (!diapers.length) return null;
  const kinds = new Set(diapers.map(diaperKind));
  if (kinds.size === 1) return `${diapers.length} ${[...kinds][0]} diaper${diapers.length === 1 ? "" : "s"}`;
  return `${diapers.length} diapers (${diapers.filter((d) => d.data.pee).length} wet, ${diapers.filter((d) => d.data.poop).length} dirty)`;
}

/**
 * "Maple, what did I miss?": what was logged since `since` (`head`: "Since
 * 10 PM"), at most three sentences: the counts ("Since 10 PM: 2 feeds, the
 * last at 1:10 AM on the left; 1 wet diaper; a bassinet try that stayed
 * asleep 1 hour 50 minutes."), what's going on now (a try, a feed, a
 * holding turn, a sleep or another timer), and the next side when no feed
 * is running. A sleep still running in a car seat, stroller, carrier or
 * grown-up bed adds moveWords after what's going on now, the one sentence
 * past three. Feeds are counted as Today counts them (feed.ts nursingRuns:
 * a stop and a start under 10 minutes apart are one feed), a bottle each;
 * a feed still running is said as going on now, not counted. `entries`:
 * the log from a little before `since` (so a feed that began then reads as
 * one), running timers included; `tries`: the bassinet tries since then;
 * `shift`: the open holding turn. Nothing from her page, and no check-ins.
 */
export function recapWords(o: {
  since: number;
  head: string;
  entries: readonly Entry[];
  tries: readonly BassinetTry[];
  shift: HoldingShift | null;
  now: Date;
  tz: string;
  vo: Voice;
  me: string;
  name: (id: string) => string;
}): string {
  const { since, now, tz, vo } = o;
  const t = (at: string | number) => formatTime(at, tz);
  const after = (at: string) => ms(at) >= since && ms(at) <= now.getTime() + MIN;
  const runs = nursingRuns(o.entries, now);
  const feeds: { start: number; said: string }[] = [
    ...runs.filter((r) => !r.live && r.start >= since).map((r) => ({ start: r.start, said: sidesSaid(r, false) })),
    ...o.entries
      .filter((e): e is EntryOf<"feed"> => e.kind === "feed" && (e.data as FeedData).method === "bottle" && after(e.started_at))
      .map((e) => ({ start: ms(e.started_at), said: ", a bottle" })),
  ].sort((a, b) => a.start - b.start);
  const diapers = o.entries.filter((e): e is EntryOf<"diaper"> => e.kind === "diaper" && after(e.started_at));
  const tries = o.tries.filter((x) => ms(x.started_at) >= since);
  const sleeps = o.entries.filter((e) => e.kind === "sleep" && !e.active && !!e.ended_at && ms(e.ended_at) > since);
  const slept = sleeps.reduce((n, e) => n + (ms(e.ended_at!) - Math.max(ms(e.started_at), since)), 0) / MIN;

  const parts: string[] = [];
  const last = feeds.at(-1);
  if (last) parts.push(`${plural(feeds.length, "feed")}, the last at ${t(last.start)}${last.said}`);
  const d = diapersSaid(diapers);
  if (d) parts.push(d);
  const tr = triesSaid(tries);
  if (tr) parts.push(tr);
  else if (slept >= 1) parts.push(`asleep ${minutesSaid(slept)} in all`);
  // Something logged, but no feed: "no feeds logged", never "no feeds" (a night nobody logged is unknown).
  if (!last && parts.length) parts.unshift("no feeds logged");
  const out = [parts.length ? `${o.head}: ${parts.join("; ")}.` : `${o.head}, nothing was logged.`];

  // What's going on now: a try, a feed, a holding turn (with a sleep in arms), a sleep, or another timer.
  const running = o.entries.filter((e) => e.active);
  const feed = running.find((e) => e.kind === "feed");
  const sleep = running.find((e) => e.kind === "sleep");
  const tryNow = o.tries.find((x) => !x.ended_at);
  const sleepWhere = (e: Entry) => {
    const where = SLEEP_IN[placeOf(e) ?? ("" as SleepPlace)];
    return where ? `, ${where}` : "";
  };
  if (tryNow) out.push(`${vo.They}${vo.verb("'s")} in the bassinet now, since ${t(tryNow.started_at)}.`);
  else if (feed) out.push(`${vo.They}${vo.verb("'s")} nursing now${feedWhere(feed, t)}, since ${t(feed.started_at)}.`);
  else if (o.shift) {
    const who = o.shift.holder === o.me ? "You've" : `${o.name(o.shift.holder)} has`;
    out.push(`${who} been holding ${vo.them} since ${t(o.shift.started_at)}${sleep ? `; ${vo.they}${vo.verb("'s been")} asleep since ${t(sleep.started_at)}` : ""}.`);
  } else if (sleep) out.push(`${vo.They}${vo.verb("'s")} asleep now, since ${t(sleep.started_at)}${sleepWhere(sleep)}.`);
  else {
    const other = running.find((e) => e.kind === "tummy" || e.kind === "pump");
    if (other) out.push(`${other.kind === "tummy" ? "Tummy time" : "Pumping"} is running, since ${t(other.started_at)}.`);
  }
  // Asleep in a car seat, stroller, carrier or grown-up bed (said with the turn or on its own): the take-over catch-up's next step.
  const move = !tryNow && !feed && sleep ? moveWords(placeOf(sleep), vo) : null;
  if (move) out.push(move);
  // The next side, as Today has it, when no feed is running.
  const next = feed ? null : nextSideFor(runs, now);
  if (next) out.push(`Start on the ${SIDE_SAID[next.side]} next${next.fuller ? ", or whichever side feels fuller" : ""}.`);
  return out.join(" ");
}

/** "Since 10 PM", "Since 3:10 AM", "Since 9:15 PM yesterday": the moment a recap counts from, said the family's way. */
export function sinceHead(since: number, now: Date, tz: string, day: (at: number) => string = (at) => formatTime(at, tz)): string {
  const clock = (now.getTime() - since > 12 * HOUR ? day(since) : formatTime(since, tz)).replace(/:00(?=\s[AP]M)/, "");
  return `Since ${clock}`;
}
