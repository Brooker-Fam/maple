/**
 * For mom: the pure engine behind her medicines, check-ins and who can see
 * them. Isomorphic (the app, the care routes, Siri and the MCP tools all use
 * it), so no node or browser APIs, and no database.
 *
 * All math runs on UTC milliseconds; local days and clock times go through
 * time.ts in the family's zone. It only does arithmetic on the numbers the
 * family typed from her label or clinician: nothing here suggests, fills in
 * or calculates a dose. Guidance copy comes from guidelines.ts, never from
 * here; the lines and sentences below only read her own numbers back to her.
 */
import {
  ACETAMINOPHEN_NAMES,
  CRISIS,
  CRISIS_PARTNER,
  DIFFICULTY_HARD,
  GAD7_RESULT,
  INTRUSIVE,
  LABEL_NOT_WHILE_NURSING,
  LABEL_NOT_WHILE_NURSING_NAMES,
  MOOD_MED_NOTE,
  OPIOID_NAMES,
  OPIOID_NOTE,
  PHQ9_ITEM9,
  PHQ9_RESULT,
  STRUGGLING,
  acetaminophenOverlap,
  earlyDose,
  overDailyMax,
  type AlertTier,
  type Assessment,
} from "./guidelines";
import { memberName } from "./insights";
import { addDays, dayKey, daysBetween, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "./time";
import type {
  CareAccess,
  CarePerson,
  CarePlan,
  CareSettings,
  DoseEntry,
  LimitUnit,
  Member,
  MoodDataByKind,
  MoodEntry,
  OneTapAsk,
  PlanState,
  PlanStatus,
  Role,
  Source,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A second dose this close to another reads as the same one (two phones, Siri), like Maple's possible duplicates. */
export const RECENT_MS = 30 * MIN;

const ms = (iso: string) => Date.parse(iso);
/** Sums of half tablets and mL to two places, so 2.2 + 2.2 + 2.2 is 6.6 at a 6.6 limit, not over it. */
const r2 = (n: number) => Math.round(n * 100) / 100;
const isoAt = (t: number) => new Date(t).toISOString();

// ── Access (§9) ──────────────────────────────────────────────────────────

/** How the reader came in: the app (Google, invite or password session), a personal Siri token, or an MCP token. */
export type CareChannel = "app" | "siri" | "mcp";

/** The reader, after the admin login's `admin_as` swap: `id` is the member it acts as (or "admin" when unset). */
export type CareViewer = { id: string; role: Role; viaAdmin: boolean; channel: CareChannel };

export const NO_CARE_ACCESS: CareAccess = {
  self: false,
  read: false,
  write: false,
  private: false,
  mood: false,
  therapist: false,
  manage: false,
};

/**
 * One rule: everyone who can sign in to Maple's Log (owners, members, the
 * family's admin login and the calendar connector) sees and does everything
 * on her page. View-only guests don't see it. Roles are read fresh from
 * `members`, so a demoted or removed member loses it at once. `self` only
 * picks the wording ("your" or "Brittany's").
 */
export function careAccess(viewer: CareViewer, person: CarePerson | null, members: Member[]): CareAccess {
  if (!person) return { ...NO_CARE_ACCESS };
  const m = viewer.id === "admin" ? { role: "owner" as const } : members.find((x) => x.email === viewer.id);
  if (!m || m.role === "viewer") return { ...NO_CARE_ACCESS };
  const self = viewer.id === person.member && !viewer.viaAdmin;
  return { self, read: true, write: true, private: true, mood: true, therapist: true, manage: true };
}

/**
 * Copy is written to her ("you"). For anyone else the title gets "For {name}: "
 * and the body is left alone, so assistants can repeat it verbatim. Never
 * applied to CRISIS_PARTNER. With no care access, `name` is "mom".
 */
export function forMom(a: Assessment, name: string, self: boolean): Assessment {
  if (self || a === CRISIS_PARTNER) return a;
  return { ...a, title: `For ${name}: ${a.title}` };
}

/** Local days since the birth ("Day 4 after Maple's birth"; Days 0–14 for the blues note). Null before it's recorded. */
export function daysSinceBirth(bornAt: string | null, now: Date, tz: string): number | null {
  if (!bornAt || Number.isNaN(ms(bornAt))) return null;
  return daysBetween(dayKey(new Date(bornAt), tz), dayKey(now, tz));
}

// ── Medicines: units and status (§5.4) ───────────────────────────────────

/** "2", "2 caplets", "10 mL" → fixed; "1 or 2", "1-2", "1 to 2" (whole, at most 6 values) → options; anything else → {}. */
export function parseUnits(text: string | null | undefined): { fixed?: number; options?: number[] } {
  if (!text) return {};
  // Words in parentheses ("2 (500 mg each)") explain the dose; they aren't the count.
  const t = text.replace(/\([^)]*\)/g, " ").trim().toLowerCase();
  const choice = /^(\d+)\s*(?:or|-|–|—|to)\s*(\d+)(?:\s+[a-z]+)*\.?$/.exec(t);
  if (choice) {
    const a = Number(choice[1]);
    const b = Number(choice[2]);
    if (a >= 1 && b > a && b - a + 1 <= 6) return { options: Array.from({ length: b - a + 1 }, (_, i) => a + i) };
    return {};
  }
  const one = /^(\d+(?:\.\d+)?)(?:\s*[a-z]+)*\.?$/.exec(t);
  if (one) {
    const n = Number(one[1]);
    if (n > 0) return { fixed: n };
  }
  return {};
}

/** A limit counted per dose (Doses, or no limit at all) counts each dose as 1. */
const countsDoses = (plan: CarePlan) => !plan.limit_unit || plan.limit_unit === "doses";

/** What one dose counts toward the limit: 1 in Doses (or no unit), else its units, the fixed count, or the largest choice. Counted high, never low. */
export function unitsOf(dose: DoseEntry, plan: CarePlan): number {
  if (countsDoses(plan)) return 1;
  const u = dose.data.units;
  if (typeof u === "number" && u > 0) return u;
  const p = parseUnits(plan.units_per_dose);
  return p.fixed ?? (p.options ? Math.max(...p.options) : 1);
}

/** What the next dose will count as: the fixed count, else the smallest choice, else 1 (1 in Doses). */
export function nextUnits(plan: CarePlan): number {
  if (countsDoses(plan)) return 1;
  const p = parseUnits(plan.units_per_dose);
  return p.fixed ?? (p.options ? Math.min(...p.options) : 1);
}

/**
 * A dose saved without its count, on a plan whose limit counts tablets,
 * caplets, capsules or mL and doesn't fix how many: what it counted as
 * ("1 caplet", or the most of a choice), so whoever logged it can fix it.
 */
export function countedAs(plan: CarePlan, units: number | null | undefined): string | null {
  if (plan.max_24h == null || countsDoses(plan) || (units != null && units > 0) || parseUnits(plan.units_per_dose).fixed != null) return null;
  return unitCount(unitsOf({ data: {} } as DoseEntry, plan), plan.limit_unit);
}

/**
 * A dose of an "At set times" medicine logged more than an hour before the
 * next time it fills: that time (ISO), so the toast, Siri and the MCP can
 * say which one it counted for. `before` is the plan's doses without it.
 */
export function aheadOfSlot(plan: CarePlan, before: DoseEntry[], at: Date, tz: string): string | null {
  if (plan.schedule.type !== "times") return null;
  const st = planStatus(plan, before, at, tz);
  return st.state === "slot_next" && st.nextSlotAt && ms(st.nextSlotAt) - at.getTime() > HOUR ? st.nextSlotAt : null;
}

/** Whether a one-tap knows how much this dose is: no limit, a limit in Doses, or one fixed number each time. */
export function unitsKnown(plan: CarePlan): boolean {
  return plan.max_24h == null || countsDoses(plan) || parseUnits(plan.units_per_dose).fixed != null;
}

/** The plan's gap in minutes (As needed's "no sooner than", Every few hours' "every"), or null. */
export function gapMinutes(plan: CarePlan): number | null {
  const s = plan.schedule;
  if (s.type === "as_needed") return s.min_gap_min ?? null;
  if (s.type === "every") return s.every_min;
  return null;
}

/** The local day a course started: its start date, else the day the plan was added. */
const courseStartKey = (plan: CarePlan, tz: string) => plan.course_start ?? dayKey(new Date(plan.created_at), tz);

const isTaken = (d: DoseEntry) => !d.data.skipped;
const byAt = (a: DoseEntry, b: DoseEntry) => ms(a.at) - ms(b.at) || a.id - b.id;

/**
 * Today's slots of an At set times plan, each filled by the nearest taken or
 * skipped dose that local day (each dose fills one slot, taken in order).
 * Set times stay at their local clock time through a DST change.
 */
function slotsFor(times: string[], today: DoseEntry[], todayKey: string, tz: string) {
  const { year, month, day } = parseDayKey(todayKey);
  const slots = [...times]
    .sort()
    .map((time) => {
      const [h, m] = time.split(":").map(Number);
      return { time, at: zonedTimeToUtc(year, month, day, h, m, tz).toISOString(), filled_by: null as number | null };
    });
  for (const d of today) {
    let best: (typeof slots)[number] | null = null;
    for (const s of slots) {
      if (s.filled_by !== null) continue;
      if (!best || Math.abs(ms(s.at) - ms(d.at)) < Math.abs(ms(best.at) - ms(d.at))) best = s;
    }
    if (best) best.filled_by = d.id;
  }
  return slots;
}

/** `doses`: this plan's doses, not deleted, any order. */
export function planStatus(plan: CarePlan, doses: DoseEntry[], now: Date, tz: string): PlanStatus {
  const t = now.getTime();
  const sorted = [...doses].sort(byAt);
  const taken = sorted.filter(isTaken);
  const last = taken.length ? taken[taken.length - 1] : null;
  const window = taken.filter((d) => ms(d.at) > t - DAY);
  const count24 = r2(window.reduce((sum, d) => sum + unitsOf(d, plan), 0));
  const nu = nextUnits(plan);
  const max = plan.max_24h;

  const gap = gapMinutes(plan);
  const gapOkAt = last && gap ? ms(last.at) + gap * MIN : null;

  // At the limit: the in-window doses that must age out (oldest first) before one more fits.
  let limitOkAt: number | null = null;
  const atLimit = max != null && r2(count24 + nu) > max;
  if (atLimit) {
    let left = count24;
    for (const d of window) {
      left = r2(left - unitsOf(d, plan));
      limitOkAt = ms(d.at) + DAY;
      if (r2(left + nu) <= max) break;
    }
  }
  const nextOk = gapOkAt === null ? limitOkAt : limitOkAt === null ? gapOkAt : Math.max(gapOkAt, limitOkAt);

  const todayKey = dayKey(now, tz);
  const [dayStart, dayEnd] = [zonedStart(todayKey, tz), zonedStart(addDays(todayKey, 1), tz)];
  const today = sorted.filter((d) => ms(d.at) >= dayStart && ms(d.at) < dayEnd);

  const startKey = courseStartKey(plan, tz);
  const courseDay = daysBetween(startKey, todayKey) + 1;
  const courseDays = plan.course_end ? daysBetween(startKey, plan.course_end) + 1 : null;

  const s = plan.schedule;
  let slots: PlanStatus["slots"] = null;
  let nextSlotAt: string | null = null;

  let state: PlanState;
  if (plan.stopped_at) state = "stopped";
  else if (plan.course_end && todayKey > plan.course_end) state = "finished";
  else if ((s.type === "as_needed" || s.type === "every") && !last) state = "none";
  else if (atLimit) state = "at_limit";
  else if (gapOkAt !== null && t < gapOkAt) state = "wait";
  else if (gapOkAt !== null) state = "ok";
  else if (s.type === "as_needed" || s.type === "every") state = "unknown";
  else if (s.type === "daily") state = today.length < s.per_day ? "day_open" : "day_done";
  else {
    slots = slotsFor(s.times, today, todayKey, tz);
    const open = slots.find((x) => x.filled_by === null && ms(x.at) <= t);
    const later = slots.find((x) => x.filled_by === null && ms(x.at) > t);
    nextSlotAt = later?.at ?? null;
    state = open ? "slot_open" : later ? "slot_next" : "day_done";
  }
  if (s.type === "times" && !slots) {
    slots = slotsFor(s.times, today, todayKey, tz);
    nextSlotAt = slots.find((x) => x.filled_by === null && ms(x.at) > t)?.at ?? null;
  }

  return {
    state,
    last,
    gapOkAt: gapOkAt === null ? null : isoAt(gapOkAt),
    limitOkAt: limitOkAt === null ? null : isoAt(limitOkAt),
    nextOkAt: nextOk === null ? null : isoAt(nextOk),
    count24,
    max24: max,
    unit: plan.limit_unit,
    nextUnits: nu,
    window,
    today,
    slots,
    nextSlotAt,
    courseDay: courseDay >= 1 ? courseDay : null,
    courseDays,
  };
}

const zonedStart = (key: string, tz: string) => {
  const { year, month, day } = parseDayKey(key);
  return zonedTimeToUtc(year, month, day, 0, 0, tz).getTime();
};

/** What "Took it" does right now (§5.2): save at once, or open the Dose sheet with the reason on top. */
export type OneTapDecision = "save" | { ask: OneTapAsk };

/**
 * The dose a new one at `at` may repeat: any non-skipped dose of the plan,
 * by anyone, within 30 minutes either side of `at`. Further apart it's
 * another dose, early or not (doseNotes says so). The server's duplicate
 * check and the one-tap use this same rule.
 */
export function recentDose(plan: CarePlan, doses: DoseEntry[], at: Date, opts: { exceptId?: number } = {}): DoseEntry | null {
  void plan;
  let best: DoseEntry | null = null;
  for (const d of doses) {
    if (d.data.skipped || d.id === opts.exceptId) continue;
    const off = Math.abs(ms(d.at) - at.getTime());
    if (off >= RECENT_MS) continue;
    if (!best || off < Math.abs(ms(best.at) - at.getTime())) best = d;
  }
  return best;
}

/**
 * "Took it" saves at once, like Maple's own buttons. It asks only when it's
 * probably a dose someone already logged (anyone's within 30 minutes, "Matt
 * logged … Is this another dose?") or a once-a-day medicine already logged
 * today. Early, at the limit or with its count unknown it still saves; the
 * toast carries doseNotes. `by` is unused, kept for callers.
 */
export function oneTapDecision(plan: CarePlan, status: PlanStatus, doses: DoseEntry[], now: Date, by?: string): OneTapDecision {
  void by;
  const near = recentDose(plan, doses.filter(isTaken), now);
  if (near) return { ask: { reason: "recent", by: near.created_by, at: near.at } };
  if (status.state === "day_done") return { ask: { reason: "logged_today" } };
  return "save";
}

/** §5.5 order: ok and unknown (oldest last dose first), wait and at_limit (by nextOkAt), none, slot_open and day_open, slot_next, day_done. */
export function sortPlans<T extends { plan: CarePlan; status: PlanStatus }>(items: T[]): T[] {
  const group = (s: PlanState) =>
    s === "ok" || s === "unknown" ? 0 : s === "wait" || s === "at_limit" ? 1 : s === "none" ? 2 : s === "slot_open" || s === "day_open" ? 3 : s === "slot_next" ? 4 : s === "day_done" ? 5 : 6;
  const key = (x: T): number => {
    const st = x.status;
    if (st.state === "ok" || st.state === "unknown") return st.last ? ms(st.last.at) : 0;
    if (st.state === "wait" || st.state === "at_limit") return st.nextOkAt ? ms(st.nextOkAt) : 0;
    if (st.state === "slot_next") return st.nextSlotAt ? ms(st.nextSlotAt) : 0;
    return 0;
  };
  return [...items].sort(
    (a, b) => group(a.status.state) - group(b.status.state) || key(a) - key(b) || a.plan.sort - b.plan.sort || a.plan.id - b.plan.id
  );
}

// ── Medicines: how it reads (§5.5) ───────────────────────────────────────

/**
 * Who's reading and when: "Your" for her, "her" for everyone else; times are
 * local. `pending` adds " · on this phone, not synced" to the line. `me`
 * (the reader's member id) reads their own doses as "You".
 */
export type PlanTextCtx = { now: Date; tz: string; self: boolean; members: Member[]; pending?: boolean; me?: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Nov 3" for a 'YYYY-MM-DD'. */
export function shortDate(key: string): string {
  const { month, day } = parseDayKey(key);
  return `${MONTHS[month - 1]} ${day}`;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function zoneName(t: number, tz: string): string {
  let f = zoneFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
    zoneFormatters.set(tz, f);
  }
  return f.formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** The hour that repeats when clocks go back (1:00–1:59 AM): the same wall time an hour either side. */
function repeatedHour(t: number, tz: string): boolean {
  const p = localParts(t, tz);
  return [t - HOUR, t + HOUR].some((u) => {
    const q = localParts(u, tz);
    return q.hour === p.hour && q.day === p.day;
  });
}

/**
 * "3:05 AM", with "yesterday", "tomorrow" or a weekday when it isn't today
 * ("11:10 PM yesterday", "9:00 AM Tue"), and the zone in the repeated hour
 * ("1:30 AM EST").
 */
export function careTime(iso: string | number, now: Date, tz: string): string {
  const t = typeof iso === "number" ? iso : ms(iso);
  let s = formatTime(t, tz);
  if (repeatedHour(t, tz)) s += ` ${zoneName(t, tz)}`;
  const diff = daysBetween(dayKey(now, tz), dayKey(t, tz));
  if (diff === -1) s += " yesterday";
  else if (diff === 1) s += " tomorrow";
  else if (diff !== 0) {
    const key = dayKey(t, tz);
    const { year, month, day } = parseDayKey(key);
    s += Math.abs(diff) < 7 ? ` ${DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}` : ` ${shortDate(key)}`;
  }
  return s;
}

const fmtN = (n: number) => String(Math.round(n * 100) / 100);

/** "1 caplet", "6 caplets", "10 mL", "4 doses". */
export function unitCount(n: number, unit: LimitUnit | null): string {
  const u = unit ?? "doses";
  if (u === "mL") return `${fmtN(n)} mL`;
  return `${fmtN(n)} ${n === 1 ? u.replace(/s$/, "") : u}`;
}

/** "4 of 6 caplets", "2 of 4 doses". */
const ofMax = (status: PlanStatus) => `${fmtN(status.count24)} of ${unitCount(status.max24 ?? 0, status.unit)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "6 hours", "1 hour", "45 minutes", "1.5 hours" (her interval, read back). */
export function hoursText(min: number): string {
  if (min < 60) return plural(Math.round(min), "minute");
  const h = min / 60;
  return Number.isInteger(h) ? plural(h, "hour") : `${fmtN(h)} hours`;
}

/** "3 hours 52 minutes", "45 minutes", "less than a minute" (how long since a dose, in an alert's words). */
export function spanText(spanMs: number): string {
  const m = Math.round(Math.abs(spanMs) / MIN);
  if (m < 1) return "less than a minute";
  if (m < 60) return plural(m, "minute");
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${plural(h, "hour")} ${plural(rest, "minute")}` : plural(h, "hour");
}

/** "2 h 10 min", "25 min", "3 days" (the card sentence). */
function agoLong(spanMs: number): string {
  const m = Math.round(Math.max(0, spanMs) / MIN);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return plural(Math.floor(h / 24), "day");
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "2 h ago", "25 min ago", "just now" (the compact line). */
function agoShort(spanMs: number): string {
  const m = Math.round(Math.max(0, spanMs) / MIN);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h >= 48 ? `${Math.round(h / 24)} days ago` : `${h} h ago`;
}

/** "8:12 AM", "8:12 AM and 8:05 PM", "8:00, 2:00 and 8:00 PM". */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every plan reads the same, whoever typed it in (an assistant's too): nothing waits on a check against the label. */
export function unreviewed(plan: CarePlan): boolean {
  void plan;
  return false;
}

const suffixes = (plan: CarePlan, ctx: PlanTextCtx) => (ctx.pending ? " · on this phone, not synced" : "");

/** The compact line (Today, the Lantern, picker rows, the More subline, Siri, maple_status): "Ibuprofen OK after 9:10 PM". */
export function planLine(plan: CarePlan, status: PlanStatus, ctx: PlanTextCtx): string {
  const s = planLineStatus(plan, status, ctx);
  return `${plan.name}${status.state === "wait" ? " " : " · "}${s}`;
}

/**
 * The compact line without the name ("OK after 9:10 PM"), for Today's second
 * line. The time the reader is after comes first, so a narrow phone clips
 * the count, never the clock ("OK after 7:57 PM · 6 of 6 caplets in 24 h").
 */
export function planLineStatus(plan: CarePlan, status: PlanStatus, ctx: PlanTextCtx): string {
  const at = (iso: string | null | undefined) => (iso ? careTime(iso, ctx.now, ctx.tz) : "");
  const takenToday = status.today.filter(isTaken);
  const lastToday = takenToday[takenToday.length - 1];
  let line: string;
  switch (status.state) {
    case "wait":
      line = `OK after ${at(status.nextOkAt)}`;
      break;
    case "ok":
      line = `OK since ${at(status.gapOkAt)} · last ${at(status.last?.at)}`;
      break;
    case "at_limit":
      line = `OK after ${at(status.nextOkAt)} · ${ofMax(status)} in 24 h`;
      break;
    case "unknown":
      line = `last ${at(status.last?.at)} (${agoShort(ctx.now.getTime() - ms(status.last!.at))})`;
      break;
    case "none":
      line = "none logged yet";
      break;
    case "day_open": {
      const per = plan.schedule.type === "daily" ? plan.schedule.per_day : 1;
      line = lastToday ? `taken ${at(lastToday.at)} · ${status.today.length} of ${per} today` : "not logged today";
      break;
    }
    case "day_done": {
      const lastAny = status.today[status.today.length - 1];
      line = lastToday ? `taken ${at(lastToday.at)}` : lastAny ? `skipped ${at(lastAny.at)}` : "logged today";
      break;
    }
    case "slot_open": {
      const open = (status.slots ?? []).filter((x) => x.filled_by === null && ms(x.at) <= ctx.now.getTime());
      line = `${at(open[open.length - 1]?.at)} not logged`;
      break;
    }
    case "slot_next":
      line = lastToday ? `taken ${at(lastToday.at)} · next ${at(status.nextSlotAt)}` : `next ${at(status.nextSlotAt)}`;
      break;
    case "finished":
      line = `course finished ${shortDate(plan.course_end!)}`;
      break;
    case "stopped":
      line = `stopped ${shortDate(dayKey(new Date(plan.stopped_at!), ctx.tz))}`;
      break;
  }
  return line + suffixes(plan, ctx);
}

/** The card sentence (plan card, Dose sheet, MCP): "OK after 9:05 PM, by your schedule." */
export function planSentence(plan: CarePlan, status: PlanStatus, ctx: PlanTextCtx): string {
  const at = (iso: string | null | undefined) => (iso ? careTime(iso, ctx.now, ctx.tz) : "");
  const whose = ctx.self ? "your" : "her";
  switch (status.state) {
    case "wait":
      return `OK after ${at(status.nextOkAt)}, by ${whose} schedule.`;
    case "ok":
      return `OK since ${at(status.gapOkAt)}, by ${whose} schedule.`;
    case "at_limit":
      return `${ofMax(status)} in the last 24 hours. OK after ${at(status.nextOkAt)}, by ${whose} schedule.`;
    case "unknown":
      return `Last one ${agoLong(ctx.now.getTime() - ms(status.last!.at))} ago.`;
    case "none":
      return "None logged yet.";
    case "day_open":
    case "day_done": {
      if (plan.schedule.type === "times") return "All of today's times are logged.";
      const taken = status.today.filter(isTaken);
      if (!taken.length) return status.state === "day_done" ? "Skipped today." : "Not logged today.";
      return `Taken ${andList(taken.map((d) => at(d.at)))}.`;
    }
    case "slot_open": {
      const open = (status.slots ?? []).filter((x) => x.filled_by === null && ms(x.at) <= ctx.now.getTime());
      return `${at(open[open.length - 1]?.at)} not logged.`;
    }
    case "slot_next":
      return `Next ${at(status.nextSlotAt)}.`;
    case "finished":
      return `Course finished ${shortDate(plan.course_end!)}.`;
    case "stopped":
      return `Stopped ${shortDate(dayKey(new Date(plan.stopped_at!), ctx.tz))}.`;
  }
}

const VIA: Partial<Record<Source, string>> = { claude: "Claude", chatgpt: "ChatGPT", mcp: "an assistant", shortcut: "Siri" };

/** Who logged a dose, for "Last: 3:05 AM · Matt": "You" for the reader. */
export function loggedBy(by: string | null, ctx: { members: Member[]; me?: string }): string {
  if (by && ctx.me && by === ctx.me) return "You";
  return memberName(by, ctx.members);
}

/** " · via Claude" for a dose an assistant or Siri logged. */
export function viaText(source: Source): string {
  const v = VIA[source];
  return v ? ` · via ${v}` : "";
}

/** "Last: 3:05 AM · Matt" (· via Claude), "4 of 6 caplets in the last 24 hours" (with a limit), "Day 3 of 7" (with an end date). */
export function planMeta(plan: CarePlan, status: PlanStatus, ctx: PlanTextCtx): string[] {
  const out: string[] = [];
  const last = status.last;
  if (last) out.push(`Last: ${careTime(last.at, ctx.now, ctx.tz)} · ${loggedBy(last.created_by, ctx)}${viaText(last.source)}`);
  // At the limit the sentence already says it ("6 of 6 caplets in the last 24 hours. OK after …").
  if (plan.max_24h != null && status.state !== "at_limit") out.push(`${ofMax(status)} in the last 24 hours`);
  if (status.courseDays != null && status.courseDay != null && status.state !== "finished" && status.state !== "stopped") {
    out.push(`Day ${Math.min(status.courseDay, status.courseDays)} of ${status.courseDays}`);
  }
  return out;
}

const DAILY_WORDS: Record<number, string> = { 1: "Once a day", 2: "Twice a day" };

/** Her numbers back to her: "As needed · no sooner than every 6 hours · no more than 6 caplets in 24 hours · 2 each time · until Nov 3". */
export function scheduleSummary(plan: CarePlan): string {
  const s = plan.schedule;
  const parts: string[] = [];
  if (s.type === "as_needed") {
    parts.push("As needed");
    if (s.min_gap_min) parts.push(`no sooner than every ${hoursText(s.min_gap_min)}`);
  } else if (s.type === "every") parts.push(`Every ${hoursText(s.every_min)}`);
  else if (s.type === "daily") parts.push(DAILY_WORDS[s.per_day] ?? `${s.per_day} times a day`);
  else parts.push(andList([...s.times].sort().map(clockText)));
  if (plan.max_24h != null) parts.push(`no more than ${unitCount(plan.max_24h, plan.limit_unit)} in 24 hours`);
  if (plan.units_per_dose && !countsDoses(plan)) parts.push(`${plan.units_per_dose} each time`);
  let out = parts.join(" · ");
  if (plan.course_end) out += ` · until ${shortDate(plan.course_end)}`;
  return out;
}

/** "08:00" → "8:00 AM" (a set time, as a wall clock). */
function clockText(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ── Medicines: notes (§5.3, §5.6, §5.7) ──────────────────────────────────

/**
 * A guidelines.ts note on a plan or the list. `key` is its acks key
 * ("opioid:p12345678"); `dismiss` is its button ("Got it"), absent when it
 * can't be dismissed (overDailyMax). The title is already forMom-prefixed.
 */
export type CareNote = Assessment & { key: string; dismiss?: string };

/** Who the copy is for, and the settings the nursing notes depend on (shown unless feeding === "no"). */
export type CareNoteCtx = { name: string; self: boolean; settings: CareSettings };

/** A plan's name and its Also called names, for the name-based notes. */
const namesOf = (plan: CarePlan) => [plan.name, ...(plan.also_called ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
const anyName = (plan: CarePlan, re: RegExp) => namesOf(plan).some((n) => re.test(n));
const nursingNotesOn = (settings: CareSettings) => nursingNotesShown(settings);

/** The nursing-dependent notes (codeine/tramadol, MED_BABY_WATCH) show unless she said she isn't nursing or pumping (S10). */
export const nursingNotesShown = (settings: CareSettings) => settings.feeding !== "no";

/** Not stopped or past its end date. */
export function planActive(plan: CarePlan, now: Date, tz: string): boolean {
  return !plan.stopped_at && !(plan.course_end && dayKey(now, tz) > plan.course_end);
}

/**
 * The early note for the dose at `at` against the dose just before or just
 * after it (a back-filled dose can land inside a later one's gap), or null.
 */
function earlyAgainst(plan: CarePlan, taken: DoseEntry[], at: number): Assessment | null {
  const gap = gapMinutes(plan);
  if (!gap) return null;
  let before: DoseEntry | null = null;
  let after: DoseEntry | null = null;
  for (const d of taken) {
    const t = ms(d.at);
    if (t <= at && (!before || t > ms(before.at))) before = d;
    if (t > at && (!after || t < ms(after.at))) after = d;
  }
  const near = before && at - ms(before.at) < gap * MIN ? at - ms(before.at) : after && ms(after.at) - at < gap * MIN ? ms(after.at) - at : null;
  return near === null ? null : earlyDose(plan.name, spanText(near), hoursText(gap));
}

/** The most units in any rolling 24 hours that contains `at`, counting a dose of `units` there. */
function peak24(plan: CarePlan, taken: DoseEntry[], at: number, units: number): number {
  const ends = [at, ...taken.map((d) => ms(d.at)).filter((t) => t > at && t < at + DAY)];
  let peak = 0;
  for (const end of ends) {
    let sum = units;
    for (const d of taken) {
      const t = ms(d.at);
      if (t > end - DAY && t <= end) sum += unitsOf(d, plan);
    }
    peak = Math.max(peak, r2(sum));
  }
  return peak;
}

/** On a plan card: OPIOID_NOTE, LABEL_NOT_WHILE_NURSING, MOOD_MED_NOTE, the early note while it applies, and overDailyMax while she's over. Acked ones left out. */
export function planNotes(plan: CarePlan, status: PlanStatus, ctx: CareNoteCtx): CareNote[] {
  const acks = ctx.settings.acks ?? {};
  const out: CareNote[] = [];
  const add = (a: Assessment, key: string, dismiss?: string) => {
    if (dismiss && acks[key]) return;
    out.push({ ...forMom(a, ctx.name, ctx.self), key, ...(dismiss ? { dismiss } : {}) });
  };
  const pid = `p${plan.id}`;
  if (plan.max_24h != null && status.count24 > plan.max_24h) {
    add(overDailyMax(plan.name, unitCount(status.count24, plan.limit_unit), unitCount(plan.max_24h, plan.limit_unit)), `over:${pid}`);
  }
  if (status.state === "wait" && status.last) {
    const before = status.window.filter((d) => d.id !== status.last!.id);
    const early = earlyAgainst(plan, before, ms(status.last.at));
    if (early) add(early, `early:c${status.last.id}`);
  }
  if (nursingNotesOn(ctx.settings) && anyName(plan, LABEL_NOT_WHILE_NURSING_NAMES)) {
    add(LABEL_NOT_WHILE_NURSING, `nursing:${pid}`, "I've checked with my OB or pharmacist");
  }
  if (anyName(plan, OPIOID_NAMES)) add(OPIOID_NOTE, `opioid:${pid}`, "Got it");
  if (plan.reason === "mood") add(MOOD_MED_NOTE, `mood:${pid}`, "Got it");
  return out;
}

/** Above the Medicines list: acetaminophenOverlap when two or more active plans contain acetaminophen. */
export function listNotes(plans: CarePlan[], ctx: CareNoteCtx): CareNote[] {
  const apap = plans.filter((p) => p.contains_apap).sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (apap.length < 2) return [];
  const key = `apap:${apap.map((p) => p.id).sort((a, b) => a - b).join(",")}`;
  if (ctx.settings.acks?.[key]) return [];
  return [{ ...forMom(acetaminophenOverlap(apap[0].name, apap[1].name), ctx.name, ctx.self), key, dismiss: "It's part of my plan" }];
}

/**
 * Live in the Dose sheet before Save, then in the toast and the MCP result:
 * earlyDose (inside the gap of the dose before or after it), overDailyMax
 * (over the limit with this one), LABEL_NOT_WHILE_NURSING. `doses` is the
 * plan's doses without the one being edited (`next.id`).
 */
export function doseNotes(
  plan: CarePlan,
  doses: DoseEntry[],
  next: { at: string; units?: number | null; skipped?: boolean; id?: number },
  ctx: CareNoteCtx & { now: Date; tz: string }
): Assessment[] {
  if (next.skipped) return [];
  const { early, over } = doseFlags(plan, doses, next);
  const out = [early, over].filter((a): a is Assessment => a !== null);
  if (nursingNotesOn(ctx.settings) && anyName(plan, LABEL_NOT_WHILE_NURSING_NAMES)) out.push(LABEL_NOT_WHILE_NURSING);
  return out.map((a) => forMom(a, ctx.name, ctx.self));
}

/**
 * The two checks behind doseNotes, unprefixed: `early` (earlyDose, inside the
 * gap of the dose before or after it) and `over` (overDailyMax, over the
 * limit in some rolling 24 hours with this one; units not given count high).
 */
export function doseFlags(
  plan: CarePlan,
  doses: DoseEntry[],
  next: { at: string; units?: number | null; skipped?: boolean; id?: number }
): { early: Assessment | null; over: Assessment | null } {
  if (next.skipped) return { early: null, over: null };
  const taken = doses.filter((d) => isTaken(d) && d.id !== next.id);
  const at = ms(next.at);
  let over: Assessment | null = null;
  if (plan.max_24h != null) {
    const units = countsDoses(plan) ? 1 : next.units && next.units > 0 ? next.units : unitsOf({ data: {} } as DoseEntry, plan);
    const peak = peak24(plan, taken, at, units);
    if (peak > plan.max_24h) over = overDailyMax(plan.name, unitCount(peak, plan.limit_unit), unitCount(plan.max_24h, plan.limit_unit));
  }
  return { early: earlyAgainst(plan, taken, at), over };
}

/** A one-off whose name matches ACETAMINOPHEN_NAMES while an active plan contains acetaminophen (and the codeine/tramadol label note). */
export function oneOffNotes(name: string, plans: CarePlan[], ctx: CareNoteCtx): Assessment[] {
  const out: Assessment[] = [];
  const n = name.trim();
  if (!n) return out;
  const apap = plans.find((p) => p.contains_apap && !p.stopped_at);
  if (apap && ACETAMINOPHEN_NAMES.test(n) && normName(apap.name) !== normName(n)) out.push(acetaminophenOverlap(n, apap.name));
  if (nursingNotesOn(ctx.settings) && LABEL_NOT_WHILE_NURSING_NAMES.test(n)) out.push(LABEL_NOT_WHILE_NURSING);
  return out.map((a) => forMom(a, ctx.name, ctx.self));
}

// ── Medicines: one plan as every surface shows it ────────────────────────

/** Built once per plan for her list, the picker, Today, the Lantern, Siri and the MCP. */
export type PlanView = {
  plan: CarePlan;
  status: PlanStatus;
  line: string;
  /** `line` without the name, for Today's two-line row. */
  lineStatus: string;
  /** The app's glance (planGlance): "OK now · last 2:24 AM", "Not yet · OK after 10:55 AM · …". */
  glance: ReturnType<typeof planGlance>;
  sentence: string;
  meta: string[];
  summary: string;
  notes: CareNote[];
  oneTap: OneTapDecision;
};

/** `by` (optional) is the reader, for the one-tap's "someone else logged it" ask. */
export function planView(plan: CarePlan, doses: DoseEntry[], ctx: PlanTextCtx & CareNoteCtx, by?: string): PlanView {
  const status = planStatus(plan, doses, ctx.now, ctx.tz);
  return {
    plan,
    status,
    line: planLine(plan, status, ctx),
    lineStatus: planLineStatus(plan, status, ctx),
    glance: planGlance(plan, status, ctx),
    sentence: planSentence(plan, status, ctx),
    meta: planMeta(plan, status, ctx),
    summary: scheduleSummary(plan),
    notes: planNotes(plan, status, ctx),
    oneTap: oneTapDecision(plan, status, doses, ctx.now, by ?? ctx.me),
  };
}

// ── Medicines: how the app shows them ────────────────────────────────────

/**
 * The first Also called name that isn't just the name again ("Tylenol" for
 * Acetaminophen with Also called "Tylenol, APAP"), or null.
 */
export function planAlso(plan: Pick<CarePlan, "name" | "also_called">): string | null {
  const own = normName(plan.name);
  for (const n of (plan.also_called ?? "").split(",")) {
    const t = n.trim();
    if (t && normName(t) !== own) return t;
  }
  return null;
}

/**
 * The app's name for a medicine: "Acetaminophen (Tylenol)" when it has an
 * Also called name, so the box in her hand and the line on the screen match;
 * otherwise just the name. Used by Today's strip, the picker, her cards,
 * toasts and the Lantern. Siri and the MCP keep plan.name.
 */
export function planTitle(plan: Pick<CarePlan, "name" | "also_called">): string {
  const also = planAlso(plan);
  return also ? `${plan.name} (${also})` : plan.name;
}

/**
 * A list of rows with a Took it each (the picker) in one fixed order: her
 * list's order (plan.sort), then the order they were added (ids are random,
 * so by created_at, then id). A save never moves another medicine under the
 * thumb, as re-sorting by status would.
 */
export function listOrder<T extends { plan: CarePlan }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.plan.sort - b.plan.sort || ms(a.plan.created_at) - ms(b.plan.created_at) || a.plan.id - b.plan.id);
}

/**
 * Her most pressing medicine, by the one rule every glanceable line uses
 * (Today's strip, the Lantern, maple_status): something she can log now
 * comes before something that isn't OK yet. A set time that's passed and
 * isn't logged first, then OK again, then a medicine with doses left today,
 * then the soonest wait, then as-needed with no gap, then the next set time;
 * within a group, sortPlans' order. Null with none.
 */
const PRESSING: Partial<Record<PlanState, number>> = { slot_open: 0, ok: 1, day_open: 2, wait: 3, at_limit: 3, unknown: 4, none: 5, slot_next: 6, day_done: 7 };
export function pressingPlan<T extends { plan: CarePlan; status: PlanStatus }>(items: T[]): T | null {
  const sorted = sortPlans(items);
  const rank = (x: T) => PRESSING[x.status.state] ?? 8;
  return sorted.reduce<T | null>((best, x) => (best === null || rank(x) < rank(best) ? x : best), null);
}

/**
 * Her medicines with the most pressing one first (pressingPlan), then the
 * rest in the order given, for every capped list that's read out (Siri's
 * "Maple status", maple_status), so the one Today's strip leads with is
 * never the one the cap cuts.
 */
export function pressingFirst<T extends { plan: CarePlan; status: PlanStatus }>(items: T[]): T[] {
  const top = pressingPlan(items);
  return top ? [top, ...items.filter((x) => x !== top)] : [...items];
}

/** Not OK by her schedule yet, or nothing left to log today: Took it wears its quiet look (it still saves). */
export function notYet(status: PlanStatus): boolean {
  return status.state === "wait" || status.state === "at_limit" || status.state === "slot_next" || status.state === "day_done";
}

/**
 * The app's glance at one medicine, led by a word you can read half asleep:
 * "OK now · last 2:24 AM" or "Not yet · OK after 10:55 AM · last 4:55 AM".
 * `ready` is true for OK now, false for not yet, null where her schedule has
 * no gap to keep (the other states read as planLineStatus does). The time
 * the reader is after comes first after the word, so a narrow line clips
 * the rest. UI only: Siri's and the MCP's sentences don't change.
 */
export function planGlance(plan: CarePlan, status: PlanStatus, ctx: PlanTextCtx): { ready: boolean | null; word: string | null; detail: string; text: string } {
  // A wrapped line keeps "12:48 PM" together.
  const at = (iso: string | null | undefined) => (iso ? careTime(iso, ctx.now, ctx.tz).replace(/\s(AM|PM)\b/g, "\u00a0$1") : "");
  const tail = suffixes(plan, ctx);
  let ready: boolean | null = null;
  let word: string | null = null;
  let detail: string;
  switch (status.state) {
    case "ok":
      ready = true;
      word = "OK now";
      detail = `last ${at(status.last?.at)}`;
      break;
    case "wait":
      ready = false;
      word = "Not yet";
      detail = `OK after ${at(status.nextOkAt)}${status.last ? ` · last ${at(status.last.at)}` : ""}`;
      break;
    case "at_limit":
      ready = false;
      word = "Not yet";
      detail = `OK after ${at(status.nextOkAt)} · ${ofMax(status)} in 24 h`;
      break;
    default:
      detail = planLineStatus(plan, status, { ...ctx, pending: false });
  }
  detail += tail;
  return { ready, word, detail, text: word ? `${word} · ${detail}` : detail };
}

// ── Medicines: names (§5.4) ──────────────────────────────────────────────

/** Lowercase; drop text in parentheses and strength tokens ("200 mg"); drop punctuation; collapse spaces. */
export function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)\b|\d+(?:\.\d+)?\s*%/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Her plan's normalized names: the name and each Also called name. */
export function planNames(plan: CarePlan): string[] {
  return [...new Set(namesOf(plan).map(normName).filter(Boolean))];
}

export type PlanMatch =
  | { kind: "match"; plan: CarePlan }
  | { kind: "ambiguous"; plans: CarePlan[] }
  | { kind: "none"; plans: CarePlan[] };

/**
 * Words a name can carry beyond her plan's and still be that plan ("Tylenol
 * Extra Strength", "Advil Liqui-Gels", "my ibuprofen"): how strong, what
 * form, and filler, plus a strength's bare number ("Ibuprofen 600"). Any
 * other extra word makes it another product ("Tylenol PM", "Tylenol 3",
 * "with codeine", "sinus", a second ingredient), which never counts toward
 * the plan: it's logged as a one-time medicine, with its own notes.
 */
const SAME_PRODUCT_WORDS = new Set(
  (
    "extra strength regular maximum max rapid fast quick acting release extended er xr sr ib sodium " +
    "liqui liquid gels gel gelcaps gelcap geltabs caplets caplet tablets tablet tabs tab capsules capsule pills pill softgels softgel chewable chewables " +
    "brand generic otc oral her my his the a an some of dose"
  ).split(" ")
);

/** A bare number that's a strength ("Ibuprofen 600"), not a product's number ("Tylenol 3"). */
const strengthNumber = (w: string) => /^\d+(?:\.\d+)?$/.test(w) && Number(w) >= 10;

/** A normalized name without SAME_PRODUCT_WORDS or a bare strength: "Extra Strength Tylenol" → "tylenol". */
export function bareName(name: string): string {
  return normName(name)
    .split(" ")
    .filter((w) => w && !SAME_PRODUCT_WORDS.has(w) && !strengthNumber(w))
    .join(" ");
}

/** Whether `long` is `short` plus only SAME_PRODUCT_WORDS (both normalized, `long` containing `short` as whole words). */
function sameProduct(long: string, short: string): boolean {
  const have = new Set(short.split(" "));
  return long
    .split(" ")
    .filter((w) => !have.has(w))
    .every((w) => SAME_PRODUCT_WORDS.has(w) || strengthNumber(w));
}

/**
 * A normalized exact match on the name or an Also called name, else
 * whole-word containment either way when the extra words only say its
 * strength or form (sameProduct). A name that's part of a longer plan name
 * with other words ("tylenol" for Tylenol PM, "vitamin" for Vitamin D3) asks
 * which; one with words of its own beyond the plan's ("Tylenol 3" for
 * Tylenol) is none, a one-time medicine. Private plans only when the caller
 * is her in the app or her own Siri token (`includePrivate`). A "p12345678"
 * id matches that plan.
 */
export function matchPlan(query: string, plans: CarePlan[], opts: { includePrivate: boolean }): PlanMatch {
  const pool = plans.filter((p) => opts.includePrivate || !p.private);
  const id = /^p?(\d{8})$/i.exec(query.trim());
  if (id) {
    const hit = pool.find((p) => p.id === Number(id[1]));
    if (hit) return { kind: "match", plan: hit };
  }
  const q = normName(query);
  if (!q) return { kind: "none", plans: pool };
  const exact = pool.filter((p) => planNames(p).includes(q));
  if (exact.length === 1) return { kind: "match", plan: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", plans: exact };
  const wrap = (s: string) => ` ${s} `;
  const part = pool.filter((p) =>
    planNames(p).some((n) => (wrap(q).includes(wrap(n)) && sameProduct(q, n)) || (wrap(n).includes(wrap(q)) && sameProduct(n, q)))
  );
  if (part.length === 1) return { kind: "match", plan: part[0] };
  if (part.length > 1) return { kind: "ambiguous", plans: part };
  const loose = pool.filter((p) => planNames(p).some((n) => wrap(n).includes(wrap(q))));
  if (loose.length) return { kind: "ambiguous", plans: loose };
  return { kind: "none", plans: pool };
}

// ── Mood (§6; hers only, never in the MCP or Siri) ───────────────────────

/** A daily check-in's response: the crisis sheet (harm chip), INTRUSIVE, STRUGGLING; `blues` shows BLUES_NOTE (Days 0–14). */
export function checkinResponse(
  d: MoodDataByKind["checkin"],
  ctx: { daysSinceBirth: number | null }
): { crisis: boolean; cards: Assessment[]; blues: boolean } {
  const tags = d.tags ?? [];
  const cards: Assessment[] = [];
  if (tags.includes("scary_thoughts")) cards.push(INTRUSIVE);
  if (d.level === 1) cards.push(STRUGGLING);
  const dsb = ctx.daysSinceBirth;
  return { crisis: tags.includes("harm_self"), cards, blues: dsb !== null && dsb >= 0 && dsb <= 14 };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The fuller check-in's answers, scored for saving (phq9_score, gad7_score, item9, complete). */
export function scoreScreen(answers: {
  phq9: (0 | 1 | 2 | 3)[];
  gad7: (0 | 1 | 2 | 3)[];
  difficulty?: 0 | 1 | 2 | 3 | null;
  item9_ever: boolean;
}): MoodDataByKind["screen"] {
  const item9 = (answers.phq9[8] ?? 0) > 0;
  return {
    phq9: answers.phq9,
    gad7: answers.gad7,
    difficulty: answers.difficulty ?? null,
    phq9_score: sum(answers.phq9),
    gad7_score: answers.gad7.length ? sum(answers.gad7) : null,
    item9,
    // Set once and never cleared, even if she changes the answer with Back.
    item9_ever: answers.item9_ever || item9,
    complete: answers.phq9.length === 9 && answers.gad7.length === 7,
  };
}

/**
 * One results card. `heading` is "PHQ-9: {score} of 27" or "GAD-7: {score} of 21";
 * `tier` is null for the low bands, which carry no tier.
 */
export type ScreenCard = {
  key: "crisis" | "phq9" | "gad7" | "difficulty";
  heading?: string;
  tier: AlertTier | null;
  label?: string;
  title: string;
  body: string;
};

type Band = { tier?: AlertTier; title: string; body: string };
const band = (score: number, r: { low: Band; some: Band; positive: Band }): Band => (score >= 10 ? r.positive : score >= 5 ? r.some : r.low);

/**
 * §6.3 render order: CRISIS (item9_ever), the PHQ-9 card, the GAD-7 card,
 * DIFFICULTY_HARD. A scale she stopped partway through ("Stop here") gets no
 * score band: a partial total would reassure on questions she never answered.
 */
export function screenResults(d: MoodDataByKind["screen"]): ScreenCard[] {
  const cards: ScreenCard[] = [];
  if (d.item9_ever) cards.push({ key: "crisis", tier: CRISIS.tier, label: CRISIS.label, title: CRISIS.title, body: CRISIS.body });
  const phqDone = d.phq9.length === 9;
  const phqHeading = phqDone ? { heading: `PHQ-9: ${d.phq9_score} of 27` } : {};
  // After any self-harm answer the results never reassure (S6): no "few signs" or "some signs".
  if (d.item9_ever && (d.phq9_score < 10 || !phqDone)) {
    cards.push({ key: "phq9", ...phqHeading, tier: PHQ9_ITEM9.tier, title: PHQ9_ITEM9.title, body: PHQ9_ITEM9.body });
  } else if (phqDone) {
    const phq: Band = band(d.phq9_score, PHQ9_RESULT);
    cards.push({ key: "phq9", ...phqHeading, tier: phq.tier ?? null, title: phq.title, body: phq.body });
  }
  if (d.gad7_score !== null && d.gad7.length === 7) {
    const gad = band(d.gad7_score, GAD7_RESULT);
    cards.push({ key: "gad7", heading: `GAD-7: ${d.gad7_score} of 21`, tier: gad.tier ?? null, title: gad.title, body: gad.body });
  }
  if ((d.difficulty ?? 0) >= 2 && !cards.some((c) => c.tier === "today")) {
    cards.push({ key: "difficulty", tier: DIFFICULTY_HARD.tier, title: DIFFICULTY_HARD.title, body: DIFFICULTY_HARD.body });
  }
  return cards;
}

/** §6.5: day 14–20 after the birth, or within 7 days before the next OB visit, with no fuller check-in in 14 days and not acked. */
export function suggestFullCheckin(ctx: {
  now: Date;
  tz: string;
  bornAt: string | null;
  settings: CareSettings;
  lastScreenAt: string | null;
}): "day14" | "visit" | null {
  const s = ctx.settings;
  if (s.checkin_suggestions === false) return null;
  if (ctx.lastScreenAt && ctx.now.getTime() - ms(ctx.lastScreenAt) < 14 * DAY) return null;
  const acks = s.acks ?? {};
  const day = daysSinceBirth(ctx.bornAt, ctx.now, ctx.tz);
  if (day !== null && day >= 14 && day <= 20 && !acks[suggestAckKey("day14", s)]) return "day14";
  const visit = s.next_visit;
  if (visit && /^\d{4}-\d{2}-\d{2}$/.test(visit) && !acks[suggestAckKey("visit", s)]) {
    const until = daysBetween(dayKey(ctx.now, ctx.tz), visit);
    if (until >= 0 && until <= 7) return "visit";
  }
  return null;
}

/**
 * The ack "Not now" stores to dismiss a suggestion for good: "suggest:day14",
 * or "suggest:visit:2026-12-01" for that one visit (a later visit asks again).
 */
export function suggestAckKey(kind: "day14" | "visit", settings: CareSettings): string {
  return kind === "day14" ? "suggest:day14" : `suggest:visit:${settings.next_visit ?? ""}`;
}

/** Her newest check-in on today's local date ("Today: Up and down · Change"), or null. */
export function todayCheckin(mood: MoodEntry[], now: Date, tz: string): Extract<MoodEntry, { kind: "checkin" }> | null {
  const today = dayKey(now, tz);
  let best: Extract<MoodEntry, { kind: "checkin" }> | null = null;
  for (const m of mood) {
    if (m.kind !== "checkin" || dayKey(new Date(m.at), tz) !== today) continue;
    if (!best || ms(m.at) > ms(best.at) || (m.at === best.at && m.id > best.id)) best = m;
  }
  return best;
}

/** A check-in of today's (local) has had harm_self ticked, or today's screen has item9_ever: the crisis strip stays up. */
export function crisisToday(mood: MoodEntry[], now: Date, tz: string): boolean {
  const today = dayKey(now, tz);
  return mood.some((m) => {
    if (dayKey(new Date(m.at), tz) !== today) return false;
    if (m.kind === "checkin") return m.data.harm_ever === true || (m.data.tags ?? []).includes("harm_self");
    return m.data.item9_ever;
  });
}
