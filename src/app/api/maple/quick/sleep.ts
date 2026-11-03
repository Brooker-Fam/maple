import { query } from "@/lib/db";
import { json } from "@/lib/maple/api";
import { carePersonName, careSession } from "@/lib/maple/care-store";
import type { FamilyCtx } from "@/lib/maple/family";
import { FeedEditError } from "@/lib/maple/feed";
import { memberName, summarize } from "@/lib/maple/insights";
import { holdingChanged } from "@/lib/maple/push-hooks";
import { familyCarePerson } from "@/lib/maple/push-wake";
import { catchUpSpoken, minutesSaid } from "@/lib/maple/sleep/catchup";
import { numberTries, sleepSignals, tryDayKey, tryDayLabel } from "@/lib/maple/sleep/engine";
import { goalStartKey, lastNightKey, nightWords, seesCheckins, windowOn, windowOnNight } from "@/lib/maple/sleep/goals";
import { feedCover } from "@/lib/maple/sleep/roster";
import { activeRosters } from "@/lib/maple/sleep/roster-read";
import {
  acceptHandoff,
  askHandoff,
  cancelAsk,
  deleteCheckin,
  deleteTry,
  finishTry,
  listCheckins,
  listGoals,
  listShifts,
  listTries,
  looksSameTry,
  openShift,
  reopenShift,
  rowToCheckin,
  rowToShift,
  rowToTry,
  runningTry,
  saveCheckin,
  SleepConflict,
  SleepInputError,
  startTry,
  undoFinish,
  undoHandOff,
} from "@/lib/maple/sleep/store";
import { MAX_SPAN_MS, PROTECTED_ANSWERS, TRY_OUTCOMES, type BassinetTry, type HoldingShift, type ProtectedAnswer, type RosterWindow, type SleepCheckin, type SleepGoal, type TryOutcome } from "@/lib/maple/sleep/types";
import { CHECKIN_QUESTION, cryingLine, OUTCOME_LABEL, PROTECTED_LABEL } from "@/lib/maple/sleep/words";
import { activeTimers, Conflict, createEntryOnce, getEntry, listEntries, NotFound, reopenTimer, rowToEntry, softDeleteEntry, stopTimer, StoreUnavailable, toClientEntry } from "@/lib/maple/store";
import { dayKey, formatTime, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import type { Baby, Entry, FeedData, Member, Role } from "@/lib/maple/types";
import type { Voice } from "@/lib/maple/voice";

/**
 * The sleep plan by Siri (POST /api/maple/quick): put_down, outcome,
 * asleep_in_arms, handoff, checkin and undo, the minutes_ago Siri's sleep,
 * wake and put_down take, and the one sleep line "Maple status" adds. Each
 * answers with one short spoken line; the writes are the app's own store
 * calls (sleep/store.ts), with the app's rules: a try sits on one sleep
 * entry, a holding turn is handed over in one transaction, a check-in is
 * always the speaker's own, and every time is said in the family's zone.
 *
 * Nobody is named beyond what the app shows (who holds her is on Today for
 * everyone in the family), and nothing here gives advice.
 *
 * undo puts back what the speaker's newest Siri action changed, with the
 * Undo the app's toasts use (deleteTry with the turn it ended, undoFinish,
 * undoHandOff, deleteCheckin, a soft delete with the timer it stopped, and
 * reopening a stopped timer), only while nobody has changed it since, and
 * never past a newer change of theirs: then it says so and changes nothing.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** minutes_ago goes back at most this far: the window the app's taps and the sleep store take. */
export const MAX_MINUTES_AGO = 240;
/** "Maple undo" reaches back this far, like undo_last. */
const UNDO_MINUTES = 30;
/** A second tap (Back Tap twice, a retried request) this soon after an outcome or a handoff gets that answer back. */
const AGAIN_MS = 2 * MIN;

/** The request as the quick route read it. */
export type QuickCtx = {
  fam: FamilyCtx;
  me: Member;
  baby: Baby;
  vo: Voice;
  tz: string;
  now: Date;
  /** "shortcut:<client_id>", or null without one. */
  clientId: string | null;
  body: Record<string, unknown>;
};

const say = (speak: string, extra: Record<string, unknown> = {}, status = 200) => json({ ok: true, speak, ...extra }, status);
const notDone = (speak: string, extra: Record<string, unknown> = {}, status = 200) => json({ ok: false, speak, ...extra }, status);

/** "9:42": a clock time to say, in the family's zone, without AM/PM (Siri's lines are short). */
export const clock = (at: string | number | Date, tz: string) => formatTime(at, tz).replace(/\s*[AP]M$/i, "");

/** "25 minutes", "1 hour 5 minutes" (sleep/catchup.ts, which says the catch-up and the recap). */
export { minutesSaid };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ms = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);
const near = (a: string | null | undefined, b: string | null | undefined, within = 1500) => !!a && !!b && Math.abs(ms(a) - ms(b)) <= within;

/** Where a sleep was, as Siri says it after "slept 25 minutes": "in arms", "in the bassinet". */
const SLEPT_IN: Record<string, string> = { arms: "in arms", bassinet: "in the bassinet", crib: "in the crib", carrier: "in the carrier", stroller: "in the stroller", car: "in the car seat", bed: "in a grown-up bed" };

/** A stopped sleep, spoken: "She slept 1 hour 5 minutes, in arms." ("under a minute" for a short one), never the card's "Slept · 0s · in arms". */
export function sleptWords(e: Entry, vo: Voice): string {
  const min = e.ended_at ? (ms(e.ended_at) - ms(e.started_at)) / MIN : 0;
  const place = SLEPT_IN[(e.data as { place?: string }).place ?? ""];
  return `${vo.They} slept ${minutesSaid(min)}${place ? `, ${place}` : ""}.`;
}

/**
 * When it happened: minutes_ago left out, blank or 0 is now; up to
 * MAX_MINUTES_AGO back; anything else is refused (null). `given`: a time
 * was said, so a feed it ends ends then too.
 */
export function minutesAgo(raw: unknown, now: Date): { at: Date; given: boolean } | null {
  if (raw === undefined || raw === null || raw === "") return { at: now, given: false };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_MINUTES_AGO) return null;
  if (n === 0) return { at: now, given: false };
  // A few seconds inside the store's 4-hour window, so the very edge still saves.
  return { at: new Date(now.getTime() - Math.min(n * MIN, MAX_MINUTES_AGO * MIN - 5_000)), given: true };
}

/** The spoken refusal for a minutes_ago that isn't 0 to 240. */
export function badMinutes(raw: unknown): Response {
  const n = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw.trim() : NaN);
  return notDone(
    Number.isFinite(n) && n > MAX_MINUTES_AGO ? "I can only go back up to 4 hours, so nothing was saved. Use the app for that one." : "I didn't catch how many minutes ago, so nothing was saved.",
    { error: `minutes_ago must be a number from 0 to ${MAX_MINUTES_AGO}` },
    400
  );
}

/** A spoken word for one of the values a Shortcut sends: "woke_crying", "Woke crying", "woke-crying" or "WOKE CRYING". */
function pick<T extends string>(raw: unknown, values: readonly T[], labels: Record<T, string>): T | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return values.find((v) => v === key || labels[v].toLowerCase().replace(/[\s-]+/g, "_") === key) ?? null;
}

export const parseOutcome = (raw: unknown): TryOutcome | null => pick(raw, TRY_OUTCOMES, OUTCOME_LABEL);
export const parseAnswer = (raw: unknown): ProtectedAnswer | null => pick(raw, PROTECTED_ANSWERS, PROTECTED_LABEL);

/** "try 2 tonight", "try 1 last night, a retry": the try's number in its try day (noon to noon in the family's zone). */
async function tryLabel(c: Pick<QuickCtx, "fam" | "baby" | "tz" | "now">, t: BassinetTry): Promise<string> {
  const tries = await listTries(c.fam, c.baby.id, { from: new Date(ms(t.started_at) - 2 * DAY), limit: 200 });
  const n = numberTries(tries, c.tz).get(t.id);
  return n ? `try ${n.n} ${tryDayLabel(n.day, tryDayKey(c.now, c.tz))}${n.retry ? ", a retry" : ""}` : "";
}

/** An entry this family saved under `clientId` (a Shortcut retrying the same request), or null. */
export async function entryByClient(fam: FamilyCtx, clientId: string | null): Promise<Entry | null> {
  if (!clientId) return null;
  const rows = await query(`SELECT * FROM maple_entries WHERE family_id = $1 AND client_id = $2 AND deleted_at IS NULL`, [fam.familyId, clientId]);
  if (rows === null) throw new StoreUnavailable();
  return rows.length ? rowToEntry(rows[0] as Record<string, unknown>) : null;
}

/**
 * She fell asleep while a feed was running: the feed ends when she fell
 * asleep if a time was said (and that's after the side she's on began),
 * else now by the stop rule (a paused feed ends at its pause).
 */
export async function stopFeedForSleep(fam: FamilyCtx, feed: Entry, when: { at: Date; given: boolean }, by: string): Promise<Entry> {
  if (when.given) {
    try {
      return await stopTimer(fam, feed.id, when.at, by);
    } catch (err) {
      if (!(err instanceof FeedEditError)) throw err;
    }
  }
  return stopTimer(fam, feed.id, undefined, by);
}

// ── put_down ─────────────────────────────────────────────────────────────

/** A try this family saved under that client id (a Shortcut retrying the same put down): it gets its first answer, never a twin's. */
async function tryByClient(fam: FamilyCtx, clientId: string | null): Promise<boolean> {
  if (!clientId) return false;
  const r = await query(`SELECT 1 FROM maple_sleep_tries WHERE family_id = $1 AND client_id = $2`, [fam.familyId, clientId]);
  if (r === null) throw new StoreUnavailable();
  return r.length > 0;
}

/**
 * After a retry that ended awake, the plan pauses until the next try (the
 * app's sleepSignals retry_done, the strip's "Pause until the next try"):
 * the first put down says so and saves nothing; said again within two
 * minutes, it goes ahead. The "said" moment lives on that retry
 * (pause_said_at), set without moving its updated_at. Null: go ahead.
 */
async function pauseFirst(c: QuickCtx): Promise<Response | null> {
  const tries = await listTries(c.fam, c.baby.id, { from: new Date(c.now.getTime() - 26 * HOUR), limit: 60 });
  if (!sleepSignals(tries, c.now, c.tz).has("retry_done")) return null;
  const retry = tries.find((t) => t.ended_at && t.outcome);
  if (!retry) return null;
  const rows = await query(`SELECT pause_said_at FROM maple_sleep_tries WHERE id = $1 AND family_id = $2`, [retry.id, c.fam.familyId]);
  if (rows === null) throw new StoreUnavailable();
  const said = rows[0]?.pause_said_at ? new Date(rows[0].pause_said_at as string).getTime() : NaN;
  if (Number.isFinite(said) && c.now.getTime() - said <= AGAIN_MS) return null;
  if ((await query(`UPDATE maple_sleep_tries SET pause_said_at = NOW() WHERE id = $1 AND family_id = $2`, [retry.id, c.fam.familyId])) === null) throw new StoreUnavailable();
  return notDone("The plan says pause until the next try. Say it again to try anyway.", { pause: true, try: { id: `t${retry.id}` } });
}

/**
 * Laid down in the bassinet: the app's Put down (startTry), with "Recently
 * fed" when a feed ended in the 30 minutes before, as the app pre-ticks it.
 * It sits on the running sleep, else a logged one it overlaps, else makes a
 * running bassinet sleep, and ends the holding turn. A feed still running
 * is said, never stopped (the app asks too). A second put down while she's
 * down is the try already running. Said with a time, a try already logged
 * then (Log an earlier try's twin check: starting within 3 minutes, or
 * overlapping) saves nothing; said right after a retry that ended awake,
 * the plan's pause comes first (pauseFirst).
 */
export async function putDown(c: QuickCtx): Promise<Response> {
  const when = minutesAgo(c.body.minutes_ago, c.now);
  if (!when) return badMinutes(c.body.minutes_ago);
  // The family in the try's client id (below): a retry of this request finds its own try, never a twin of it.
  const retried = await tryByClient(c.fam, c.clientId ? `${c.clientId}.f${c.fam.familyId}` : null);
  if (!retried && !(await runningTry(c.fam, c.baby.id))) {
    if (when.given) {
      const nearby = await listTries(c.fam, c.baby.id, { from: new Date(when.at.getTime() - MAX_SPAN_MS), limit: 50 });
      const twin = nearby.find((t) => t.ended_at && looksSameTry(t, when.at.getTime(), c.now.getTime(), c.now.getTime()));
      if (twin) return notDone(`A try from ${clock(twin.started_at, c.tz)} is already logged; nothing saved.`, { duplicate: true, try: { id: `t${twin.id}`, started_at: twin.started_at } });
    } else {
      const pause = await pauseFirst(c);
      if (pause) return pause;
    }
  }
  const [timers, feeds] = await Promise.all([
    activeTimers(c.fam, c.baby.id),
    listEntries(c.fam, { babyId: c.baby.id, kinds: ["feed"], from: new Date(when.at.getTime() - 30 * MIN), limit: 50 }),
  ]);
  const fed = feeds.some((e) => !e.active && !!e.ended_at && ms(e.ended_at) >= when.at.getTime() - 30 * MIN && ms(e.ended_at) <= c.now.getTime() + 5_000);
  // The family in the try's client id: the sleep a try makes takes its client id from the try's, and entries'
  // client ids are still unique across families until the contract, so two families' Shortcuts never collide.
  const clientId = c.clientId ? `${c.clientId}.f${c.fam.familyId}` : null;
  let w;
  try {
    w = await startTry(c.fam, { babyId: c.baby.id, at: when.at, putDownBy: c.me.email, tags: fed ? ["fed"] : [], note: null, by: c.me.email, source: "shortcut", clientId, device: null });
  } catch (err) {
    if (err instanceof SleepInputError) return notDone("That time doesn't fit, so nothing was saved. Use the app for that one.", {}, 400);
    throw err;
  }
  if (w.endedShift) holdingChanged({ familyId: c.fam.familyId });
  const label = await tryLabel(c, w.try);
  const tryOut = { id: `t${w.try.id}`, started_at: w.try.started_at };
  const sleep = w.sleep ? toClientEntry(w.sleep) : null;
  if (w.status === "running") {
    return say(`Already in the bassinet since ${clock(w.try.started_at, c.tz)}${label ? `, ${label}` : ""}.`, { already_running: true, try: tryOut, entry: sleep });
  }
  const bits = [label ? `${cap(label)}, down at ${clock(w.try.started_at, c.tz)}.` : `In the bassinet at ${clock(w.try.started_at, c.tz)}.`];
  if (w.endedShift) bits.push("The holding turn ended.");
  if (timers.some((e) => e.kind === "feed")) bits.push("The nursing timer is still running.");
  return say(bits.join(" "), { try: tryOut, entry: sleep, ...(w.status === "deduped" ? { deduped: true } : {}) });
}

// ── outcome ──────────────────────────────────────────────────────────────

const OUTCOME_CHOICES = TRY_OUTCOMES.map((id) => ({ id, label: OUTCOME_LABEL[id] }));

/**
 * How the running try went (finishTry): a wake ends its sleep then, picked
 * up still asleep leaves the sleep running. Without minutes_ago it ends now,
 * or when her sleep timer stopped if Woke up came first. No outcome: the
 * question and its four choices, for a Shortcut's Choose from List.
 */
export async function outcome(c: QuickCtx): Promise<Response> {
  const o = parseOutcome(c.body.outcome);
  if (!o) return notDone("How did it go: stayed asleep, woke calm, woke crying or picked up?", { choices: OUTCOME_CHOICES });
  const when = minutesAgo(c.body.minutes_ago, c.now);
  if (!when) return badMinutes(c.body.minutes_ago);
  const running = await runningTry(c.fam, c.baby.id);
  if (!running) {
    // A second tap: the try that just ended says how it went, instead of "nothing running".
    const last = (await listTries(c.fam, c.baby.id, { from: new Date(c.now.getTime() - 13 * HOUR), limit: 5 })).find((t) => t.ended_at && t.outcome);
    if (last && c.now.getTime() - ms(last.updated_at) <= AGAIN_MS) return say(endedLine(last, c.tz), { already_finished: true, try: { id: `t${last.id}` } });
    return notDone("No bassinet try is running.");
  }
  if (when.given && when.at.getTime() < ms(running.started_at)) return notDone(`That's before the try started at ${clock(running.started_at, c.tz)}, so nothing was saved.`, {}, 400);
  let w;
  try {
    w = await finishTry(c.fam, running.id, { outcome: o, ...(when.given ? { at: when.at } : {}), by: c.me.email });
  } catch (err) {
    if (err instanceof SleepInputError) return notDone("That doesn't fit the try's times, so nothing was saved. Fix it in the app.", {}, 400);
    if (err instanceof SleepConflict) return notDone("Someone changed that try just now, so nothing was saved.", {}, 409);
    throw err;
  }
  if (w.status === "already_finished") return say(endedLine(w.try, c.tz), { already_finished: true, try: { id: `t${w.try.id}` } });
  const mins = (ms(w.try.ended_at) - ms(w.try.started_at)) / MIN;
  const bits = [`${OUTCOME_LABEL[o]} ${o === "stayed_asleep" ? "for" : "after"} ${minutesSaid(mins)}.`];
  if (o === "picked_up" && w.sleep?.active) bits.push(`${c.vo.They}${c.vo.verb("'s")} still asleep, so ${c.vo.their} sleep timer keeps running.`);
  else if (w.sleepBefore?.active && w.sleep && !w.sleep.active) bits.push("Sleep timer stopped.");
  // After a crying wake, and after the retry: the app's own line (soothe, retry once, then pause until the next try).
  const signals = sleepSignals(await listTries(c.fam, c.baby.id, { from: new Date(c.now.getTime() - 26 * HOUR), limit: 60 }), c.now, c.tz);
  if (signals.has("retry_done")) bits.push(`${cryingLine(c.vo, "retry_done")}.`);
  else if (signals.has("after_crying")) bits.push(`${cryingLine(c.vo, "after_crying")}.`);
  return say(bits.join(" "), { try: { id: `t${w.try.id}`, outcome: o, ended_at: w.try.ended_at }, entry: w.sleep ? toClientEntry(w.sleep) : null });
}

const endedLine = (t: BassinetTry, tz: string) => `That try already ended at ${clock(t.ended_at!, tz)}: ${OUTCOME_LABEL[t.outcome!].toLowerCase()}.`;

// ── asleep_in_arms ───────────────────────────────────────────────────────

/** A running sleep in arms, or the sleep already running (the one-per-kind index decides a race). */
async function startSleepInArms(c: QuickCtx, at: Date, clientId: string | null): Promise<{ entry: Entry; running: boolean }> {
  try {
    const { entry } = await createEntryOnce(c.fam, { babyId: c.baby.id, kind: "sleep", startedAt: at, active: true, data: { place: "arms" }, createdBy: c.me.email, source: "shortcut", clientId });
    return { entry, running: false };
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "23505") throw err;
    const raced = (await activeTimers(c.fam, c.baby.id)).find((e) => e.kind === "sleep");
    if (raced) return { entry: raced, running: true };
    throw err;
  }
}

/**
 * Asleep in someone's arms: a running sleep with place arms, now or
 * minutes_ago. A running feed stops first, like Siri's sleep. While a try
 * runs she's in the bassinet, so it says how to log picked up instead. No
 * "sweet dreams" here: nothing should sound like the adult may doze too.
 */
export async function asleepInArms(c: QuickCtx): Promise<Response> {
  const when = minutesAgo(c.body.minutes_ago, c.now);
  if (!when) return badMinutes(c.body.minutes_ago);
  // A retry gets its first answer; a client id another kind of entry already has saves this one without it.
  const prior = await entryByClient(c.fam, c.clientId);
  if (prior?.kind === "sleep") return say(armsLine(prior, c.tz, false), { deduped: true, entry: toClientEntry(prior) });
  const clientId = prior ? null : c.clientId;
  const [timers, tryNow] = await Promise.all([activeTimers(c.fam, c.baby.id), runningTry(c.fam, c.baby.id)]);
  if (tryNow) {
    return notDone(`A bassinet try is running, since ${clock(tryNow.started_at, c.tz)}. If you picked ${c.vo.them} up still asleep, say picked up.`, { try: { id: `t${tryNow.id}` } });
  }
  const feed = timers.find((e) => e.kind === "feed");
  if (feed) await stopFeedForSleep(c.fam, feed, when, c.me.email);
  const already = timers.find((e) => e.kind === "sleep");
  if (already) return say(`${feed ? "Feed stopped. " : ""}A sleep timer is already running, since ${clock(already.started_at, c.tz)}.`, { already_running: true, entry: toClientEntry(already) });
  const r = await startSleepInArms(c, when.at, clientId);
  if (r.running) return say(`${feed ? "Feed stopped. " : ""}A sleep timer is already running, since ${clock(r.entry.started_at, c.tz)}.`, { already_running: true, entry: toClientEntry(r.entry) });
  return say(armsLine(r.entry, c.tz, !!feed), { entry: toClientEntry(r.entry) });
}

const armsLine = (e: Entry, tz: string, feedStopped: boolean) => `${feedStopped ? "Feed stopped and sleep" : "Sleep"} timer started at ${clock(e.started_at, tz)}, in arms.`;

// ── handoff ──────────────────────────────────────────────────────────────

const ADULT = (m: Member) => (m.role === "owner" || m.role === "member") && m.email !== "admin";

/**
 * Who takes the turn: whoever says it, if they aren't the one holding her;
 * from the holder, the turn's planned next person, else the only other
 * adult (an owner or member) in the family. Null: it isn't clear.
 */
export function handoffTo(shift: Pick<HoldingShift, "holder" | "next_holder">, me: string, members: readonly Member[]): string | null {
  if (me !== shift.holder) return me;
  const next = shift.next_holder ? members.find((m) => m.email === shift.next_holder && m.role !== "photos") : undefined;
  if (next && next.email !== shift.holder) return next.email;
  const others = members.filter((m) => ADULT(m) && m.email !== shift.holder);
  return others.length === 1 ? others[0].email : null;
}

/** "You have" / "Sam has". */
const has = (id: string, me: string, members: readonly Member[]) => (id === me ? "You have" : `${memberName(id, [...members])} has`);

/**
 * "Maple handoff". From the person holding her it's an ask, never a
 * handoff (the app's shift.ask, with the Handoff now notice to the phones of
 * the person asked that turned handoff reminders on): nothing changes hands until the
 * person asked has her. From anyone else it's taking over (shift.accept, on
 * the turn as it is now), with the next planned handoff, never inside the
 * next holder's protected window (store handOff), a sleep in arms that
 * runs on through it said, and the catch-up. With nobody on a turn, the
 * speaker's own starts with the ask on it, as the app's does. Saying it
 * again within two minutes (or a retry) never hands her back and never
 * sends the notice twice: it says where things stand.
 */
export async function handoff(c: QuickCtx, members: Member[]): Promise<Response> {
  const open = await openShift(c.fam, c.baby.id);
  if (!open) return startAndAsk(c, members);
  if (open.created_by === c.me.email && c.now.getTime() - ms(open.created_at) <= AGAIN_MS) {
    const recent = await listShifts(c.fam, c.baby.id, { from: new Date(c.now.getTime() - HOUR), limit: 10 });
    if (recent.some((s) => s.id !== open.id && s.ended_how === "handoff" && near(s.ended_at, open.started_at))) {
      return say(`Already handed off: ${has(open.holder, c.me.email, members).replace(/^You have$/, "you have")} ${c.vo.them} now.`, { already_handed_off: true, shift: { id: `h${open.id}` } });
    }
  }
  return open.holder === c.me.email ? askToTakeOver(c, open, members) : takeOver(c, open, members);
}

/** Who the holder's "handoff" asks: the person already asked, else the turn's planned next, else the only other adult. */
export function askWho(shift: Pick<HoldingShift, "holder" | "next_holder" | "asked_to">, members: readonly Member[]): string | null {
  const asked = shift.asked_to ? members.find((m) => m.email === shift.asked_to && m.role !== "photos") : undefined;
  if (asked && asked.email !== shift.holder) return asked.email;
  return handoffTo(shift, shift.holder, members);
}

/**
 * The holder's "handoff": asks the partner to take over now. Spoken as the
 * app's Waking sheet says it: their phone only sounds if handoff reminders
 * are on, so go wake them, and if sleepy first, the bassinet (on the back).
 * Undo takes the ask back.
 */
async function askToTakeOver(c: QuickCtx, open: HoldingShift, members: Member[]): Promise<Response> {
  const to = askWho(open, members);
  if (!to) return notDone("Who should take over? Ask in the app.");
  const name = memberName(to, members);
  const wake = `${name}'s phone only sounds if handoff reminders are on, so go wake ${name}. Getting sleepy? Put ${c.vo.them} on ${c.vo.their} back in the bassinet.`;
  const askedAt = ms(open.asked_at);
  if (open.asked_to === to && open.updated_by === c.me.email && c.now.getTime() - askedAt <= AGAIN_MS) {
    return say(`Already asked ${name} at ${clock(open.asked_at!, c.tz)}. ${wake}`, { asked: true, already_asked: true, shift: { id: `h${open.id}`, asked_to: to, asked_at: open.asked_at } });
  }
  let w;
  try {
    w = await askHandoff(c.fam, { babyId: c.baby.id, id: open.id, to, by: c.me.email, source: "shortcut", device: null });
  } catch (err) {
    if (err instanceof SleepConflict) return notDone("Someone changed the holding turn just now, so nothing was saved.", {}, 409);
    if (err instanceof SleepInputError) return notDone("Who should take over? Ask in the app.", {}, 400);
    throw err;
  }
  // The phones of the person asked with handoff reminders on hear "Handoff now" (a Shortcut has no phone of its own to leave out).
  holdingChanged({ familyId: c.fam.familyId, wake: { shiftId: w.shift.id, device: null } });
  const again = open.asked_to === to && Number.isFinite(askedAt);
  return say(`Asked ${name} ${again ? "again " : ""}to take over. ${wake}`, { asked: true, shift: { id: `h${w.shift.id}`, asked_to: to, asked_at: w.shift.asked_at } });
}

/**
 * "Maple handoff" with nobody recorded holding her: the speaker is, so, as
 * the app's ask does (askHandoff with no turn), their own turn starts with
 * the ask on it, to the only other adult. Nothing changes hands until that
 * person has her; Undo takes the ask back. With nobody clear to ask (two or
 * more other adults), it saves nothing and points to the app.
 */
async function startAndAsk(c: QuickCtx, members: Member[]): Promise<Response> {
  const to = askWho({ holder: c.me.email, next_holder: null, asked_to: null }, members);
  if (!to) return notDone("Nobody is on a holding turn right now. To ask someone to take over, use the app.");
  let w;
  try {
    w = await askHandoff(c.fam, { babyId: c.baby.id, to, by: c.me.email, source: "shortcut", device: null, clientId: c.clientId });
  } catch (err) {
    if (err instanceof SleepConflict) return notDone("Someone changed the holding turn just now, so nothing was saved.", {}, 409);
    if (err instanceof SleepInputError) return notDone("Who should take over? Ask in the app.", {}, 400);
    throw err;
  }
  holdingChanged({ familyId: c.fam.familyId, wake: { shiftId: w.shift.id, device: null } });
  const name = memberName(to, members);
  return say(
    `Started your holding turn and asked ${name} to take over. ${name}'s phone only sounds if handoff reminders are on, so go wake ${name}. Getting sleepy? Put ${c.vo.them} on ${c.vo.their} back in the bassinet.`,
    { asked: true, started: true, shift: { id: `h${w.shift.id}`, asked_to: to, asked_at: w.shift.asked_at } }
  );
}

/**
 * Anyone else's "handoff": they have her now (acceptHandoff, the app's I've
 * got her). The next planned handoff, and why it moved off the next
 * holder's protected window; a sleep in arms running on through it, so
 * they stop it if she's awake; then the app's catch-up in a few short
 * sentences (sleep/catchup.ts catchUpSpoken: the last feed with its side
 * and the next side, the last diaper, what else is running, and how to feed
 * her in the protected window of the one going off duty, by the roster).
 */
async function takeOver(c: QuickCtx, open: HoldingShift, members: Member[]): Promise<Response> {
  let w;
  try {
    w = await acceptHandoff(c.fam, open.id, { by: c.me.email, source: "shortcut", device: null, tz: c.tz });
  } catch (err) {
    if (err instanceof SleepConflict) return notDone("Someone changed the holding turn just now, so nothing was saved.", {}, 409);
    if (err instanceof SleepInputError) return notDone("That handoff doesn't fit, so nothing was saved. Use the app for that one.", {}, 400);
    throw err;
  }
  holdingChanged({ familyId: c.fam.familyId });
  const bits = [`You have ${c.vo.them} now, from ${memberName(open.holder, members)}.`];
  const why = w.handoffWhy;
  const whose = why ? (why.member === c.me.email ? "your" : `${memberName(why.member, members)}'s`) : "";
  if (why?.planned_at) bits.push(`Next handoff at ${clock(why.planned_at, c.tz)}, after ${whose} protected sleep.`);
  else if (why) bits.push(`No next handoff planned: ${whose} protected sleep runs past 12 hours from now.`);
  else if (w.shift.handoff_at) bits.push(`Next handoff at ${clock(w.shift.handoff_at, c.tz)}.`);
  const [entries, roster, care] = await Promise.all([
    listEntries(c.fam, { babyId: c.baby.id, from: new Date(c.now.getTime() - 72 * HOUR), includeActive: true, limit: 2000 }),
    activeRosters(c.fam),
    familyCarePerson(c.fam.familyId),
  ]);
  const arms = entries.find((e) => e.active && e.kind === "sleep" && (e.data as { place?: string }).place === "arms");
  if (arms) bits.push(`${c.vo.Their} sleep in arms has been running since ${clock(arms.started_at, c.tz)}; if ${c.vo.they}${c.vo.verb("'s")} awake, say Maple awake.`);
  // The catch-up, as the app's sheet has it, and the feeding plan in the protected window of the one who handed over.
  const s = summarize({ entries, baby: c.baby, members, now: c.now, vo: c.vo });
  const until = w.shift.handoff_at ? ms(w.shift.handoff_at) : c.now.getTime() + 12 * HOUR;
  const cover = feedCover(roster, open.holder, c.now.getTime(), until, c.tz);
  bits.push(...catchUpSpoken(s, { now: c.now, tz: c.tz, vo: c.vo, clock: (at) => clock(at, c.tz), armsSaid: !!arms, taker: c.me.email, cover, careMember: care?.member ?? null, name: (id) => memberName(id, members) }));
  return say(bits.join(" "), { shift: { id: `h${w.shift.id}`, handoff_at: w.shift.handoff_at }, ...(why ? { next_handoff_moved: why } : {}) });
}

// ── checkin ──────────────────────────────────────────────────────────────

const ANSWER_CHOICES = PROTECTED_ANSWERS.map((id) => ({ id, label: PROTECTED_LABEL[id] }));

/** The speaker's own check-in for last night (yes, partly or no), as Today's card saves it; saying it again changes it. */
export async function checkin(c: QuickCtx): Promise<Response> {
  const a = parseAnswer(c.body.answer ?? c.body.protected);
  if (!a) return notDone(`${CHECKIN_QUESTION} Yes, partly or not this time?`, { choices: ANSWER_CHOICES });
  if (!seesCheckins(c.me.role)) return notDone("Check-ins are for the adults who log.", {}, 403);
  const w = await saveCheckin(c.fam, { babyId: c.baby.id, member: c.me.email, protected: a, tz: c.tz, now: c.now, source: "shortcut", clientId: c.clientId, device: null });
  const night = nightWords(w.checkin.night, c.now, c.tz);
  const said = PROTECTED_LABEL[w.checkin.protected].toLowerCase();
  const speak =
    w.status === "updated"
      ? `Changed your check-in for ${night} to ${said}.`
      : w.status === "unchanged"
        ? `Your check-in for ${night} already says ${said}.`
        : `Checked in for ${night}: ${said}.`;
  return say(speak, { checkin: { night: w.checkin.night, answer: w.checkin.protected }, ...(w.status === "deduped" ? { deduped: true } : {}) });
}

// ── "Maple status" ───────────────────────────────────────────────────────

/** From this local hour the morning after (once their window is over), a check-in is due: Today's rule. */
const MORNING_HOUR = 5;

/**
 * The night a check-in is due for, or null: Today's "How did last night
 * go?" rule (SleepCheckin.tsx checkinDue), worked out on the server. An
 * owner or member an active goal (set by that night) names on that night's
 * roster, or with a protected-window target and no window of theirs at
 * all; from 5 AM and once their windows that night are over; until they've
 * checked in for it.
 */
export function checkinDueNight(o: { goals: readonly SleepGoal[]; checkins: readonly SleepCheckin[] | null; me: string; role: Role; now: Date; tz: string }): string | null {
  if (!seesCheckins(o.role) || !o.checkins || !o.me) return null;
  const night = lastNightKey(o.now, o.tz);
  if (o.checkins.some((x) => x.member === o.me && x.night === night)) return null;
  let named = false;
  const windows: RosterWindow[] = [];
  for (const g of o.goals) {
    if (g.status !== "active" || goalStartKey(g, o.tz) > night) continue;
    const mine = g.roster.filter((w) => w.member === o.me);
    const on = mine.filter((w) => windowOnNight(w, night));
    const target = g.targets.some((t) => t.kind === "protected_window" && t.member === o.me);
    if (!on.length && !(target && !mine.length)) continue;
    named = true;
    windows.push(...on);
  }
  if (!named) return null;
  const today = parseDayKey(dayKey(o.now, o.tz));
  const morning = zonedTimeToUtc(today.year, today.month, today.day, MORNING_HOUR, 0, o.tz).getTime();
  const over = Math.max(morning, ...windows.map((w) => windowOn(w, night, o.tz)[1].getTime()));
  return o.now.getTime() >= over ? night : null;
}

/**
 * The one sleep line "Maple status" adds, or null: a running try ("Robin
 * has been in the bassinet 25 minutes, since 9:42, try 2 tonight."), else
 * the open holding turn, else (for an owner or member) their check-in for
 * last night when it's due. Families with none of it hear status as before.
 * `trySleepId`: the sleep the running try sits on, which the line covers.
 */
export async function sleepStatusLine(o: { fam: FamilyCtx; baby: Baby; me: Member; members: Member[]; vo: Voice; name: string; now: Date }): Promise<{ line: string | null; trySleepId: number | null }> {
  const tz = o.baby.timezone;
  const [tryNow, shift] = await Promise.all([runningTry(o.fam, o.baby.id), openShift(o.fam, o.baby.id)]);
  if (tryNow) {
    const label = await tryLabel({ fam: o.fam, baby: o.baby, tz, now: o.now }, tryNow);
    const down = minutesSaid((o.now.getTime() - ms(tryNow.started_at)) / MIN);
    return { line: `${o.name} has been in the bassinet ${down}, since ${clock(tryNow.started_at, tz)}${label ? `, ${label}` : ""}.`, trySleepId: tryNow.sleep_entry_id };
  }
  if (shift) {
    const who = shift.holder === o.me.email ? "You've" : `${memberName(shift.holder, o.members)} has`;
    const plan = shift.handoff_at
      ? ms(shift.handoff_at) <= o.now.getTime()
        ? `; the handoff was due at ${clock(shift.handoff_at, tz)}`
        : `; handoff at ${clock(shift.handoff_at, tz)}`
      : "";
    // The person asked to take over hears that it's them, and how to say they have her.
    const asked =
      shift.asked_to === o.me.email && shift.asked_at && shift.holder !== o.me.email
        ? ` ${memberName(shift.holder, o.members)} asked you to take over at ${clock(shift.asked_at, tz)}; say Maple handoff once you have ${o.vo.them}.`
        : "";
    return { line: `${who} been holding ${o.vo.them} since ${clock(shift.started_at, tz)}${plan}.${asked}`, trySleepId: null };
  }
  if (!seesCheckins(o.me.role)) return { line: null, trySleepId: null };
  const goals = (await listGoals(o.fam, o.baby.id)).filter((g) => g.status === "active");
  if (!goals.length) return { line: null, trySleepId: null };
  const last = lastNightKey(o.now, tz);
  const checkins = await listCheckins(o.fam, o.baby.id, { from: last, to: last, member: o.me.email });
  const due = checkinDueNight({ goals, checkins, me: o.me.email, role: o.me.role, now: o.now, tz });
  return { line: due ? `Your sleep check-in for ${nightWords(due, o.now, tz)} is due.` : null, trySleepId: null };
}

// ── undo ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
/** µs since the epoch, from the row's own column (two writes in one millisecond still order). */
const us = (r: Row, col: string) => Number(r[col]);
const STAMPS = `(EXTRACT(EPOCH FROM created_at) * 1000000)::bigint AS c_us, (EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint AS u_us`;

async function rows(sql: string, params: unknown[]): Promise<Row[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Row[];
}

/** What undo can take back, newest wins. */
type Act =
  | { kind: "put_down"; at: number; t: BassinetTry }
  | { kind: "outcome"; at: number; t: BassinetTry }
  | { kind: "handoff"; at: number; s: HoldingShift }
  | { kind: "ask"; at: number; s: HoldingShift }
  | { kind: "checkin"; at: number; c: SleepCheckin }
  | { kind: "entry"; at: number; e: Entry }
  | { kind: "stop"; at: number; e: Entry };

/** The words for a log entry Siri makes or stops. */
function whatOf(e: Entry): string {
  switch (e.kind) {
    case "diaper":
      return e.data.pee && e.data.poop ? "wet and dirty diaper" : e.data.poop ? "dirty diaper" : e.data.pee ? "wet diaper" : "diaper";
    case "feed":
      return e.data.method === "bottle" ? "bottle" : (e.data as FeedData).segments?.length ? "nursing timer" : "feed";
    case "sleep":
      return "sleep timer";
    case "med":
      return /vitamin d/i.test(e.data.name ?? "") ? "vitamin D" : "medicine";
    case "tummy":
      return "tummy time";
    case "pump":
      return "pumping timer";
    default:
      return "entry";
  }
}

/**
 * A timer whose newest change (by the speaker) was its stop. A feed keeps
 * the moment Done was tapped (stopped_at), so a fix made after it isn't
 * one; a sleep, tummy time or pumping keeps no such mark, so a stopped one
 * counts as stopped.
 */
const isStop = (e: Entry) =>
  !e.active && !!e.ended_at && ["feed", "sleep", "tummy", "pump"].includes(e.kind) && (e.kind !== "feed" || near((e.data as { stopped_at?: string }).stopped_at, e.updated_at, 2000));

const changedSince = (what: string) => notDone(`${cap(what)} changed since, so nothing was undone. Fix it in the app.`, { undone: null }, 409);

/**
 * "Maple undo": takes back the speaker's newest Siri action in the last 30
 * minutes, as the app's Undo would: a put down (the try, the sleep it
 * started, and the holding turn it ended comes back), an outcome (the try
 * runs again, with the sleep timer it stopped), a handoff, a new check-in,
 * something Siri logged (a timer it stopped as it started comes back), or a
 * timer they stopped (it runs again). Only while nobody has changed it
 * since, and never past a newer change of theirs (an undo included, so
 * saying it twice takes back one thing): then it says what, and nothing is
 * undone. Her page is never touched here.
 */
export async function undo(c: QuickCtx, members: Member[]): Promise<Response> {
  const p = [c.fam.familyId, c.baby.id, c.me.email];
  const since = `NOW() - INTERVAL '${UNDO_MINUTES} minutes'`;
  const [madeTry, changedTry, madeShift, changedShift, myCheckin, madeEntry, changedEntry, myAsk] = await Promise.all([
    rows(`SELECT *, ${STAMPS} FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND source = 'shortcut' AND deleted_at IS NULL AND created_at >= ${since} ORDER BY created_at DESC, id DESC LIMIT 1`, p),
    rows(`SELECT *, ${STAMPS}, deleted_at IS NOT NULL AS gone FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND updated_at >= ${since} ORDER BY updated_at DESC, id DESC LIMIT 1`, p),
    rows(`SELECT *, ${STAMPS} FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND source = 'shortcut' AND deleted_at IS NULL AND created_at >= ${since} ORDER BY created_at DESC, id DESC LIMIT 1`, p),
    rows(`SELECT *, ${STAMPS}, deleted_at IS NOT NULL AS gone FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND updated_at >= ${since} ORDER BY updated_at DESC, id DESC LIMIT 1`, p),
    rows(`SELECT *, ${STAMPS}, deleted_at IS NOT NULL AS gone FROM maple_sleep_checkins WHERE family_id = $1 AND baby_id = $2 AND member = $3 AND updated_at >= ${since} ORDER BY updated_at DESC, id DESC LIMIT 1`, p),
    // A sleep a put down made (its client id starts tsl:) is that try's, not an entry of its own.
    rows(
      `SELECT *, ${STAMPS} FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND source = 'shortcut' AND deleted_at IS NULL AND created_at >= ${since}
         AND (client_id IS NULL OR client_id NOT LIKE 'tsl:%') ORDER BY created_at DESC, id DESC LIMIT 1`,
      p
    ),
    rows(`SELECT *, ${STAMPS}, deleted_at IS NOT NULL AS gone FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND updated_at >= ${since} ORDER BY updated_at DESC, id DESC LIMIT 1`, p),
    // Their ask on the turn still open ("Maple handoff" from the holder, or Wake [partner] in the app), while it's the turn's newest change.
    rows(
      `SELECT *, ${STAMPS}, (EXTRACT(EPOCH FROM asked_at) * 1000000)::bigint AS a_us FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND asked_to IS NOT NULL
         AND asked_at >= ${since} AND ended_at IS NULL AND deleted_at IS NULL ORDER BY asked_at DESC, id DESC LIMIT 1`,
      p
    ),
  ]);

  // ── what was done, newest first ──
  const acts: Act[] = [];
  const tA = madeTry[0];
  if (tA) acts.push({ kind: "put_down", at: us(tA, "c_us"), t: rowToTry(tA) });
  const tB = changedTry[0];
  const finished = tB && tB.gone !== true && tB.ended_at != null && tB.outcome != null ? rowToTry(tB) : null;
  if (finished && tB) acts.push({ kind: "outcome", at: us(tB, "u_us"), t: finished });
  const sA = madeShift[0];
  if (sA) acts.push({ kind: "handoff", at: us(sA, "c_us"), s: rowToShift(sA) });
  const sB = myAsk[0];
  if (sB && Math.abs(us(sB, "a_us") - us(sB, "u_us")) <= 5_000) acts.push({ kind: "ask", at: us(sB, "a_us"), s: rowToShift(sB) });
  const k = myCheckin[0];
  if (k && k.gone !== true && k.source === "shortcut") acts.push({ kind: "checkin", at: us(k, "u_us"), c: rowToCheckin(k) });
  const eA = madeEntry[0];
  if (eA) acts.push({ kind: "entry", at: us(eA, "c_us"), e: rowToEntry(eA) });
  const eB = changedEntry[0];
  const stopped = eB && eB.gone !== true ? rowToEntry(eB) : null;
  // The sleep a finish stopped is the finish's, not a stop of its own.
  const finishOwn = (e: Entry) => !!finished && finished.sleep_entry_id === e.id && ms(e.updated_at) - ms(finished.updated_at) <= 2000 && ms(e.updated_at) >= ms(finished.updated_at) - 50;
  if (stopped && eB && isStop(stopped) && !finishOwn(stopped)) acts.push({ kind: "stop", at: us(eB, "u_us"), e: stopped });
  acts.sort((a, b) => b.at - a.at);
  const act = acts[0] ?? null;

  // ── a newer change of theirs: say it, undo nothing ──
  const changes: { at: number; words: string; own?: boolean }[] = [];
  if (tB) changes.push({ at: us(tB, "u_us"), words: tB.gone === true ? "removing the bassinet try" : "the bassinet try" });
  if (changedShift[0]) {
    const s = changedShift[0];
    const sh = rowToShift(s);
    // The turn a put down ended is that put down's; an ask is the turn's own change.
    const own = (act?.kind === "put_down" && sh.ended_how === "bassinet" && near(sh.ended_at, act.t.started_at)) || (act?.kind === "ask" && act.s.id === sh.id);
    changes.push({ at: us(s, "u_us"), words: s.gone === true ? "removing the holding turn" : "the holding turn", own });
  }
  if (k) changes.push({ at: us(k, "u_us"), words: k.gone === true ? "removing your check-in" : "your check-in" });
  if (eB) {
    const e = rowToEntry(eB);
    const own = act?.kind === "outcome" && finishOwn(e);
    changes.push({ at: us(eB, "u_us"), words: eB.gone === true ? `removing the ${whatOf(e)}` : `the ${whatOf(e)}`, own });
  }
  // Her page: a medicine logged with Siri is the newest thing they did, so nothing of Maple's is taken back for it.
  const care = await careSession({ id: c.me.email, role: c.me.role, viaAdmin: false, channel: "siri" }, { familyId: c.fam.familyId, members, baby: c.baby }).catch(() => null);
  if (care?.person && care.access.write) {
    const mom = await rows(
      `SELECT (EXTRACT(EPOCH FROM created_at) * 1000000)::bigint AS c_us FROM maple_care_entries
       WHERE family_id = $1 AND created_by = $2 AND source = 'shortcut' AND deleted_at IS NULL AND created_at >= ${since} ORDER BY created_at DESC LIMIT 1`,
      [c.fam.familyId, c.me.email]
    );
    if (mom[0]) changes.push({ at: us(mom[0], "c_us"), words: `${care.access.self ? "your" : `${carePersonName(care.person, members)}'s`} medicines` });
  }
  const newer = changes.filter((x) => !x.own && x.at > (act?.at ?? 0)).sort((a, b) => b.at - a.at)[0];
  if (newer) return notDone(`Your newest change was ${newer.words.startsWith("removing") ? "" : "to "}${newer.words}, so nothing was undone. Fix it in the app.`, { undone: null });
  if (!act) return notDone(`There's nothing from Siri in the last ${UNDO_MINUTES} minutes to undo.`, { undone: null });

  try {
    switch (act.kind) {
      case "put_down":
        return await undoPutDown(c, act.t);
      case "outcome":
        return await undoOutcome(c, act.t);
      case "handoff":
        return await undoHandoff(c, act.s, members);
      case "ask":
        return await undoAsk(c, act.s);
      case "checkin":
        return await undoCheckin(c, act.c);
      case "entry":
        return await undoEntry(c, act.e);
      case "stop":
        return await undoStop(c, act.e);
    }
  } catch (err) {
    // Lost a race with another phone: what's there now stays.
    if (err instanceof SleepConflict && err.reason === "running") return notDone("Another bassinet try is running now, so nothing was undone.", { undone: null }, 409);
    if (err instanceof SleepConflict && err.reason === "open") return notDone(`Someone else is holding ${c.vo.them} now, so nothing was undone.`, { undone: null }, 409);
    if (err instanceof SleepConflict || err instanceof NotFound) return changedSince("That");
    if (err instanceof Conflict && err.reason === "clash") return notDone(`Another ${whatOf(err.entry)} is running now, so nothing was undone.`, { undone: null }, 409);
    if (err instanceof Conflict) return changedSince(`The ${whatOf(err.entry)}`);
    throw err;
  }
}

/** The put down goes: the try, the sleep it made (while it's as the try left it), and the holding turn it ended comes back. */
async function undoPutDown(c: QuickCtx, t: BassinetTry): Promise<Response> {
  if (!near(t.updated_at, t.created_at, 5) || t.ended_at) return changedSince("That bassinet try");
  const r = await deleteTry(c.fam, t.id, c.me.email, { expectUpdatedAt: t.updated_at });
  // The turn this put down ended (endOpenShift, right after the try was saved), only as it left it.
  const ended = (await listShifts(c.fam, c.baby.id, { from: new Date(ms(t.started_at) - HOUR), limit: 20 })).find(
    (s) => s.ended_how === "bassinet" && near(s.ended_at, t.started_at) && s.updated_by === c.me.email && near(s.updated_at, t.created_at, 2000)
  );
  let back = false;
  if (ended) {
    back = await reopenShift(c.fam, ended.id, { by: c.me.email, expectUpdatedAt: ended.updated_at }).then(
      () => true,
      () => false
    );
    if (back) holdingChanged({ familyId: c.fam.familyId });
  }
  const bits = [`Undone: the bassinet try from ${clock(t.started_at, c.tz)} is gone${r.sleepDeleted ? ", with the sleep it started" : ""}.`];
  if (back) bits.push("The holding turn is back on.");
  return say(bits.join(" "), { undone: { kind: "put_down", try: `t${t.id}`, ...(r.sleepDeleted ? { sleep: r.sleepDeleted.id } : {}), ...(back ? { shift_reopened: true } : {}) } });
}

/** The outcome goes: the try runs again, and the sleep the finish stopped (or put in arms) goes back as it was. */
async function undoOutcome(c: QuickCtx, t: BassinetTry): Promise<Response> {
  const s = t.sleep_entry_id ? await getEntry(c.fam, t.sleep_entry_id) : null;
  let sleep: { id: number; expectUpdatedAt: string; wasActive: boolean; place?: "bassinet" } | null = null;
  const byFinish = !!s && s.updated_by === c.me.email && ms(s.updated_at) - ms(t.updated_at) <= 2000 && ms(s.updated_at) >= ms(t.updated_at) - 50;
  if (s && byFinish && t.outcome !== "picked_up" && !s.active && near(s.ended_at, t.ended_at)) sleep = { id: s.id, expectUpdatedAt: s.updated_at, wasActive: true };
  else if (s && byFinish && t.outcome === "picked_up" && t.made_sleep && s.active && (s.data as { place?: string }).place === "arms") sleep = { id: s.id, expectUpdatedAt: s.updated_at, wasActive: false, place: "bassinet" };
  const w = await undoFinish(c.fam, t.id, { expectUpdatedAt: t.updated_at, sleep, by: c.me.email });
  const timerBack = !!sleep?.wasActive && !!w.sleep?.active;
  return say(`Undone: the bassinet try is running again${timerBack ? ", and so is the sleep timer" : ""}.`, { undone: { kind: "outcome", try: `t${t.id}`, ...(timerBack ? { sleep_reopened: true } : {}) } });
}

/** The handoff goes: the new turn is removed and the one handed over is open again (undoHandOff), each only as Siri left it. */
async function undoHandoff(c: QuickCtx, s: HoldingShift, members: Member[]): Promise<Response> {
  if (s.ended_at || !near(s.updated_at, s.created_at, 5)) return changedSince("The holding turn");
  const prev = (await listShifts(c.fam, c.baby.id, { from: new Date(ms(s.started_at) - 13 * HOUR), limit: 50 })).find(
    (x) => x.id !== s.id && x.ended_how === "handoff" && near(x.ended_at, s.started_at) && x.updated_by === c.me.email
  );
  if (!prev || !near(prev.updated_at, s.created_at, 5)) return changedSince("The holding turn");
  await undoHandOff(c.fam, { startedId: s.id, startedUpdatedAt: s.updated_at, endedId: prev.id, endedUpdatedAt: prev.updated_at, by: c.me.email });
  holdingChanged({ familyId: c.fam.familyId });
  return say(`Undone: ${has(prev.holder, c.me.email, members)} ${c.vo.them} again.`, { undone: { kind: "handoff", shift: `h${s.id}`, reopened: `h${prev.id}` } });
}

/** The ask goes (cancelAsk, the app's Undo): nobody is asked now, and the turn goes on as it was. */
async function undoAsk(c: QuickCtx, s: HoldingShift): Promise<Response> {
  await cancelAsk(c.fam, s.id, { by: c.me.email, expectUpdatedAt: s.updated_at });
  holdingChanged({ familyId: c.fam.familyId });
  return say("Undone: nobody is asked to take over now.", { undone: { kind: "ask", shift: `h${s.id}` } });
}

/** A new check-in goes; a changed one has no earlier answer kept to put back, so it stays and says so. */
async function undoCheckin(c: QuickCtx, k: SleepCheckin): Promise<Response> {
  const night = nightWords(k.night, c.now, c.tz);
  if (!near(k.created_at, k.updated_at, 5)) {
    return notDone(`Your check-in for ${night} was a change, so it stays ${PROTECTED_LABEL[k.protected].toLowerCase()}. Check in again to change it.`, { undone: null });
  }
  await deleteCheckin(c.fam, { babyId: c.baby.id, member: c.me.email, id: k.id });
  return say(`Undone: your check-in for ${night} is gone.`, { undone: { kind: "checkin", night: k.night } });
}

/** Something Siri logged goes (a soft delete, like the app's Undo), and a timer it stopped as it started runs again. */
async function undoEntry(c: QuickCtx, e: Entry): Promise<Response> {
  // Saving leaves updated_by empty: anything there now is a change since.
  if (e.updated_by) return changedSince(`The ${whatOf(e)}`);
  // A bassinet try laid on this sleep since (anyone's) sits on it: the sleep stays with it.
  if (e.kind === "sleep") {
    const onIt = await rows(`SELECT 1 FROM maple_sleep_tries WHERE family_id = $1 AND sleep_entry_id = $2 AND deleted_at IS NULL LIMIT 1`, [c.fam.familyId, e.id]);
    if (onIt.length) return notDone("A bassinet try sits on that sleep now, so nothing was undone. Fix it in the app.", { undone: null }, 409);
  }
  await softDeleteEntry(c.fam, e.id, c.me.email);
  let back: Entry | null = null;
  if (e.kind === "sleep" || e.kind === "feed") {
    const stopped = await rows(
      `SELECT * FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND deleted_at IS NULL AND NOT active AND kind IN ('feed', 'sleep') AND kind <> $4
         AND updated_at BETWEEN $5::timestamptz - INTERVAL '3 seconds' AND $5::timestamptz + INTERVAL '50 milliseconds'
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [c.fam.familyId, c.baby.id, c.me.email, e.kind, e.created_at]
    );
    const s = stopped[0] ? rowToEntry(stopped[0]) : null;
    if (s && isStop(s)) back = await reopenTimer(c.fam, s.id, c.me.email, { expectUpdatedAt: s.updated_at }).catch(() => null);
  }
  const when = e.kind === "sleep" || (e.kind === "feed" && e.data.method !== "bottle") ? "from" : "at";
  return say(`Undone: the ${whatOf(e)} ${when} ${clock(e.started_at, c.tz)} is gone${back ? `, and the ${whatOf(back)} is running again` : ""}.`, {
    undone: { kind: "entry", id: e.id, ...(back ? { reopened: back.id } : {}) },
  });
}

/** A timer they stopped runs again (the app's Done Undo), only as they left it. */
async function undoStop(c: QuickCtx, e: Entry): Promise<Response> {
  const r = await reopenTimer(c.fam, e.id, c.me.email, { expectUpdatedAt: e.updated_at });
  return say(`Undone: the ${whatOf(r)} is running again.`, { undone: { kind: "stop", id: r.id }, entry: toClientEntry(r) });
}
