/**
 * Time helpers for Maple's Log. Isomorphic: the MCP server runs in UTC while
 * the family lives in America/New_York, so anything that says "today" or
 * "3:10 AM" goes through the baby's timezone explicitly rather than the
 * runtime's local zone. DST-safe (Intl does the zone math).
 */

export const DEFAULT_TZ = "America/New_York";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
};

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a timezone. */
export function localParts(date: Date | number, tz: string = DEFAULT_TZ): Parts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(date))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

/** Minutes the zone is ahead of UTC at that instant (New York: -240 or -300). */
export function tzOffsetMinutes(date: Date | number, tz: string = DEFAULT_TZ): number {
  const t = new Date(date).getTime();
  const p = localParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - (t - (t % 1000))) / MIN);
}

/**
 * The instant a wall-clock time happens in a zone. For the hour that DST skips
 * this lands just after the gap; for the hour that repeats it picks the first.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz: string = DEFAULT_TZ
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMinutes(guess - 0, tz);
  let t = guess - off1 * MIN;
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== off1) {
    const t2 = guess - off2 * MIN;
    // Prefer the candidate that actually reads back as the requested wall time.
    const p = localParts(t2, tz);
    if (p.hour === hour && p.minute === minute) t = t2;
  }
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' for the local calendar day of an instant. */
export function dayKey(date: Date | number, tz: string = DEFAULT_TZ): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Bad date "${key}" (want YYYY-MM-DD)`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function isDayKey(key: unknown): key is string {
  return typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/** Calendar arithmetic on day keys (timezone-free). */
export function addDays(key: string, n: number): string {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Local midnight that starts this day, as an instant. */
export function startOfDay(key: string, tz: string = DEFAULT_TZ): Date {
  const { year, month, day } = parseDayKey(key);
  return zonedTimeToUtc(year, month, day, 0, 0, tz);
}

/** [start, end) instants of a local day. 23 or 25 hours long on DST days. */
export function dayBounds(key: string, tz: string = DEFAULT_TZ): [Date, Date] {
  return [startOfDay(key, tz), startOfDay(addDays(key, 1), tz)];
}

/** Whole days from a to b (b - a) by calendar date. */
export function daysBetween(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY
  );
}

// ── Parsing "when" from people and models ────────────────────────────────

const ISO_ABS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/i;
const CLOCK_RE = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a|am|a\.m\.|p|pm|p\.m\.)?$/i;
const AGO_RE = /^(?:about\s+|~)?(an?|half an|\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)(?:\s*(?:and\s*)?(\d+)\s*(m|mins?|minutes?))?\s+ago$/i;

export type ParsedWhen = {
  date: Date;
  /** Set when we had to guess, e.g. "assumed 3:10 AM (most recent)". */
  assumed?: string;
};

/**
 * The instant a local wall time happened, most recently. When DST repeats an
 * hour (clocks fall back), take the later occurrence unless it hasn't
 * happened yet.
 */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, tz: string, now: Date): Date {
  const first = zonedTimeToUtc(y, mo, d, h, mi, tz);
  const second = new Date(first.getTime() + HOUR);
  const p = localParts(second, tz);
  const repeats = p.hour === h && p.minute === mi && p.day === d;
  return repeats && second.getTime() <= now.getTime() ? second : first;
}

/** Today's (or, if that's still ahead, yesterday's) occurrence of a clock time. */
function mostRecentAt(hour: number, minute: number, now: Date, tz: string, dayOffset: number | null): { date: Date; yesterday: boolean } {
  const todayKey = dayKey(now, tz);
  if (dayOffset !== null) {
    const k = parseDayKey(addDays(todayKey, dayOffset));
    return { date: wallTime(k.year, k.month, k.day, hour, minute, tz, now), yesterday: false };
  }
  const t = parseDayKey(todayKey);
  const today = wallTime(t.year, t.month, t.day, hour, minute, tz, now);
  if (today.getTime() <= now.getTime() + 10 * MIN) return { date: today, yesterday: false };
  const y = parseDayKey(addDays(todayKey, -1));
  return { date: wallTime(y.year, y.month, y.day, hour, minute, tz, now), yesterday: true };
}

function mostRecent(hour: number, minute: number, now: Date, tz: string, dayOffset: number | null): Date {
  return mostRecentAt(hour, minute, now, tz, dayOffset).date;
}

/** A clock time read as the most recent one, noting when that meant yesterday. */
function clockWhen(hour: number, minute: number, now: Date, tz: string, dayOffset: number | null): ParsedWhen {
  const { date, yesterday } = mostRecentAt(hour, minute, now, tz, dayOffset);
  return yesterday ? { date, assumed: `assumed yesterday at ${formatTime(date, tz)} (that time hasn't come yet today)` } : { date };
}

/**
 * Resolve a time a person or model gave us, in the baby's timezone:
 *   - "now", "just now", "" → now
 *   - "20 min ago", "an hour ago", "1.5 hours ago", "2h 15m ago", "half an hour ago"
 *   - ISO with offset/Z → that instant; "2026-10-20T14:05" (no offset) → wall time in tz
 *   - "14:05", "2:05pm", "3am", "noon", "midnight" → the most recent such time
 *     (today, or yesterday if today's is still ahead)
 *   - "yesterday 11pm", "today 6:30am", "last night 2am", "this morning 7", "last night 9"
 *   - bare "3:10" → whichever of 3:10 AM / PM happened most recently, flagged as assumed
 * Returns null when the input can't be understood.
 */
export function parseWhenDetailed(input: string | null | undefined, now: Date, tz: string = DEFAULT_TZ): ParsedWhen | null {
  let raw = (input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw || raw === "now" || raw === "just now" || raw === "right now") return { date: new Date(now) };
  if (ISO_ABS_RE.test(input!.trim())) {
    const d = new Date(input!.trim());
    return Number.isNaN(d.getTime()) ? null : { date: d };
  }
  const local = ISO_LOCAL_RE.exec(raw);
  if (local) {
    const [, y, mo, d, h, mi] = local;
    if (Number(h) > 23 || Number(mi) > 59) return null;
    return { date: wallTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), tz, now) };
  }
  const ago = AGO_RE.exec(raw);
  if (ago) {
    const n = ago[1] === "a" || ago[1] === "an" ? 1 : ago[1] === "half an" ? 0.5 : Number(ago[1]);
    const unitMin = ago[2].startsWith("h") ? 60 : 1;
    const extra = ago[3] ? Number(ago[3]) : 0;
    const minutes = n * unitMin + extra;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) return null;
    return { date: new Date(now.getTime() - minutes * MIN) };
  }

  let dayOffset: number | null = null;
  const dayWord = /^(yesterday|today|last night|this morning|tonight)\b(?:\s+at)?\s*/.exec(raw);
  const word = dayWord?.[1];
  if (dayWord) {
    raw = raw.slice(dayWord[0].length).trim();
    if (word === "yesterday") dayOffset = -1;
    else if (word === "today" || word === "this morning" || word === "tonight") dayOffset = 0;
  }
  raw = raw.replace(/^at\s+/, "");
  // "last night 10pm" is yesterday evening; "last night 2am" and "tonight 1am"
  // are the most recent small hours.
  const at = (h: number, mi: number) =>
    clockWhen(h, mi, now, tz, word === "last night" ? (h >= 12 ? -1 : null) : word === "tonight" && h < 12 ? null : dayOffset);

  if (raw === "noon") return at(12, 0);
  if (raw === "midnight") return at(0, 0);

  const m = CLOCK_RE.exec(raw.replace(/\s/g, ""));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.[0];
  if (minute > 59) return null;
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (mer === "a") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return at(hour, minute);
  }
  if (hour > 23) return null;
  if (hour === 0 || hour > 12) {
    // 24-hour clock ("14:05", "0:30").
    return at(hour, minute);
  }
  // The day word settles AM/PM: "this morning 7" is 7 AM; "last night 9" is
  // 9 PM, but "last night 2" is 2 AM.
  if (word === "this morning") return at(hour === 12 ? 0 : hour, minute);
  if (word === "tonight" || word === "last night") return at(hour >= 6 && hour <= 11 ? hour + 12 : hour === 12 ? 0 : hour, minute);
  // Bare "3:10" or "3": AM or PM, whichever happened most recently.
  const am = mostRecent(hour === 12 ? 0 : hour, minute, now, tz, dayOffset);
  const pm = mostRecent(hour === 12 ? 12 : hour + 12, minute, now, tz, dayOffset);
  const pick = [am, pm]
    .filter((d) => d.getTime() <= now.getTime() + 10 * MIN)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? am;
  const label = `${hour}:${String(minute).padStart(2, "0")} ${pick === am ? "AM" : "PM"}`;
  return { date: pick, assumed: `assumed ${label} (the most recent one)` };
}

/** parseWhenDetailed without the guess note. */
export function parseWhen(input: string | null | undefined, now: Date, tz: string = DEFAULT_TZ): Date | null {
  return parseWhenDetailed(input, now, tz)?.date ?? null;
}

// ── Formatting ───────────────────────────────────────────────────────────

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** "3:10 AM" in the zone. */
export function formatTime(date: Date | number | string, tz: string = DEFAULT_TZ): string {
  let f = timeFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    timeFormatters.set(tz, f);
  }
  return f.format(new Date(date));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Today", "Yesterday", "Tue, Oct 20" (with year if not this year). */
export function formatDayLabel(key: string, todayKey: string, opts: { long?: boolean } = {}): string {
  const diff = daysBetween(key, todayKey);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const { year, month, day } = parseDayKey(key);
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const sameYear = todayKey.slice(0, 4) === key.slice(0, 4);
  const name = opts.long ? LONG_DAYS[wd] : DAYS[wd];
  return `${name}, ${MONTHS[month - 1]} ${day}${sameYear ? "" : `, ${year}`}`;
}

/** "Today 3:10 AM", "Yesterday 11:45 PM", "Tue, Oct 20 9:00 AM". */
export function formatWhen(date: Date | number | string, now: Date, tz: string = DEFAULT_TZ): string {
  const d = new Date(date);
  return `${formatDayLabel(dayKey(d, tz), dayKey(now, tz))} ${formatTime(d, tz)}`;
}

/** "12m", "1h 05m", "45s", "2d 3h". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Stopwatch style: "4:07", "1:02:09". */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "just now", "5m ago", "2h 14m ago", "3d ago"; future times read "in 5m". */
export function formatRelative(date: Date | number | string, now: Date): string {
  const diffSec = (now.getTime() - new Date(date).getTime()) / 1000;
  if (Math.abs(diffSec) < 60) return "just now";
  const label = formatDuration(Math.abs(diffSec));
  return diffSec >= 0 ? `${label} ago` : `in ${label}`;
}

// ── Age ──────────────────────────────────────────────────────────────────

export type BabyAge = {
  /** Milliseconds since birth. */
  ms: number;
  /** Completed days (24h periods). */
  days: number;
  /** Day of life: the first 24 hours are Day 1. */
  dayOfLife: number;
  weeks: number;
  /** Completed calendar months in the baby's zone. */
  months: number;
  /** "5 hours old", "3 days, 4 hours", "2 weeks, 3 days", "3 months, 1 week". */
  label: string;
  /** Compact: "5h", "3d", "2w 3d", "3mo". */
  short: string;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function babyAge(bornAt: string | Date, now: Date, tz: string = DEFAULT_TZ): BabyAge {
  const born = new Date(bornAt);
  const ms = Math.max(0, now.getTime() - born.getTime());
  const hours = Math.floor(ms / HOUR);
  const days = Math.floor(ms / DAY);
  const weeks = Math.floor(days / 7);

  const b = localParts(born, tz);
  const n = localParts(now, tz);
  let months = (n.year - b.year) * 12 + (n.month - b.month);
  if (n.day < b.day || (n.day === b.day && (n.hour < b.hour || (n.hour === b.hour && n.minute < b.minute)))) {
    months -= 1;
  }
  months = Math.max(0, months);

  let label: string;
  let short: string;
  if (hours < 24) {
    const mins = Math.floor(ms / MIN);
    label = hours < 1 ? `${plural(mins, "minute")} old` : `${plural(hours, "hour")} old`;
    short = hours < 1 ? `${mins}m` : `${hours}h`;
  } else if (days < 14) {
    const h = hours % 24;
    label = h ? `${plural(days, "day")}, ${plural(h, "hour")}` : plural(days, "day");
    short = `${days}d`;
  } else if (months < 2) {
    const d = days % 7;
    label = d ? `${plural(weeks, "week")}, ${plural(d, "day")}` : plural(weeks, "week");
    short = d ? `${weeks}w ${d}d` : `${weeks}w`;
  } else if (months < 24) {
    // Days since the last month-day anniversary, in weeks.
    const anniversaryMonth = b.month + months;
    const anniversary = zonedTimeToUtc(
      b.year + Math.floor((anniversaryMonth - 1) / 12),
      ((anniversaryMonth - 1) % 12) + 1,
      b.day,
      b.hour,
      b.minute,
      tz
    );
    const extraWeeks = Math.floor(Math.max(0, now.getTime() - anniversary.getTime()) / (7 * DAY));
    label = extraWeeks ? `${plural(months, "month")}, ${plural(extraWeeks, "week")}` : plural(months, "month");
    short = `${months}mo`;
  } else {
    const years = Math.floor(months / 12);
    const rem = months % 12;
    label = rem ? `${plural(years, "year")}, ${plural(rem, "month")}` : plural(years, "year");
    short = `${years}y`;
  }

  return { ms, days, dayOfLife: days + 1, weeks, months, label, short };
}
