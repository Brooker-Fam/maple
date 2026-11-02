/**
 * The catch-up for whoever takes over a holding turn, from the log: the last
 * feed and the next side, the last diaper, and what's running, with the next
 * planned handoff. Pure, from the same facts Today's Right now has
 * (insights.ts summarize): the catch-up sheet shows it as lines
 * (catchUpLines).
 *
 * Every time is the family's (`tz`), and the baby is the family's own
 * (`Voice`): never a hard-coded name or pronoun.
 */
import { nextSideText } from "../feed";
import type { Summary } from "../insights";
import { formatRelative, formatTime } from "../time";
import type { Entry, EntryOf, SleepPlace } from "../types";
import type { Voice } from "../voice";
import { handoffWhyWords, type HandoffWhy } from "./handoff";
import { downWords, SLEEP_PLACE_LABEL } from "./words";

const MIN = 60_000;

/** What the catch-up reads from the summary (Today's Right now). */
export type CatchUpSource = Pick<Summary, "active" | "lastFed" | "next" | "lastDiaper">;

export type CatchUpLine = { label: string; text: string };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ms = (v: string) => Date.parse(v);

/** "wet", "dirty", "wet and dirty". */
const diaperKind = (d: EntryOf<"diaper">) => (d.data.pee && d.data.poop ? "wet and dirty" : d.data.poop ? "dirty" : "wet");

const placeOf = (e: Entry) => (e.data as { place?: SleepPlace }).place;

/** The running timers other than a feed, in a few words each ("asleep since 1:45 AM (in arms), 25m", "tummy time"). */
function runningParts(active: readonly Entry[], now: Date, tz: string): string[] {
  const running = active.filter((e) => e.kind !== "feed");
  const sleep = running.find((e) => e.kind === "sleep");
  const place = sleep ? placeOf(sleep) : undefined;
  const others = running.filter((e) => e.kind !== "sleep").map((e) => (e.kind === "tummy" ? "tummy time" : e.kind === "pump" ? "pumping" : e.kind));
  return [...(sleep ? [`asleep since ${formatTime(sleep.started_at, tz)}${place ? ` (${SLEEP_PLACE_LABEL[place].toLowerCase()})` : ""}, ${downWords((now.getTime() - ms(sleep.started_at)) / MIN)}`] : []), ...others];
}

/**
 * The catch-up sheet's lines ("I've got her"): Feed, Diaper, Running and,
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
  const parts = runningParts(summary?.active ?? [], now, tz);
  out.push({ label: "Running", text: parts.length ? parts.join(" · ").replace(/^./, (c) => c.toUpperCase()) : nursing ? "The nursing timer" : `Nothing else; ${v.they}${v.verb("'s")} awake by the log` });
  const why = input.why ? handoffWhyWords(input.why, input.why.member === input.me ? "your" : input.memberName(input.why.member), tz) : null;
  if (input.next) {
    const who = input.nextHolder ? (input.nextHolder === input.me ? "you" : input.memberName(input.nextHolder)) : null;
    out.push({ label: "Handoff", text: `Next planned for ${formatTime(input.next, tz)}${who ? `, to ${who}` : ""}${why ? `, ${why}` : ""}` });
  } else if (why) out.push({ label: "Handoff", text: cap(why) });
  return out;
}
