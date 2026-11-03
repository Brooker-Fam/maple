/**
 * The check's clock, for a check that has to read the same at any time of day. Imported first, it stands in for Date in
 * this process: the real clock until setClock moves it, or MAPLE_CHECK_NOW (an instant, like 2026-11-03T06:30:00Z) at
 * start. Either way it runs on from where it was set, and the in-memory Postgres's NOW() follows it (PGlite reads the
 * same Date.now), so rows made with NOW() - INTERVAL agree with the code's clock. Real dates stay Dates (one prototype).
 *
 *   MAPLE_CHECK_NOW=2026-11-03T06:30:00Z DATABASE_URL= pnpm exec tsx scripts/tenancy/sleep-goals.check.ts
 */
const Real = Date;
let offset = 0;

/** Moves the clock to `at` (it runs on from there), or back to the real one with null. */
export function setClock(at: Date | string | number | null): void {
  offset = at == null ? 0 : new Real(at).getTime() - Real.now();
  if (Number.isNaN(offset)) throw new Error(`not an instant: ${String(at)}`);
}

/** Runs `fn` with the clock at `at` (running on from there), then puts the clock back where it would have been. */
export async function atClock<T>(at: Date | string | number, fn: () => Promise<T> | T): Promise<T> {
  const was = offset;
  setClock(at);
  try {
    return await fn();
  } finally {
    offset = was;
  }
}

/** The local hour and minute `now` is in a timezone ("00:31"), for a check's log line. */
export const clockIn = (tz: string, now: Date = new Date()) => now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

/** The instant a local wall-clock time is, today in that zone or on the day given (as YYYY-MM-DD). */
export function localInstant(tz: string, hhmm: string, day?: string): Date {
  const date = day ?? new Real(Real.now() + offset).toLocaleDateString("en-CA", { timeZone: tz });
  const [h, m] = hhmm.split(":").map(Number);
  // Guess as UTC, then move by the zone's offset at that guess (twice, so a clock change in between settles).
  let t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Real(t)).map((p) => [p.type, p.value]));
    const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    t += Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m) - seen;
  }
  return new Real(t);
}

function CheckDate(this: unknown, ...args: unknown[]): unknown {
  if (!new.target) return new Real(Real.now() + offset).toString();
  return args.length ? Reflect.construct(Real, args) : new Real(Real.now() + offset);
}
CheckDate.prototype = Real.prototype;
CheckDate.now = () => Real.now() + offset;
CheckDate.parse = Real.parse;
CheckDate.UTC = Real.UTC;
globalThis.Date = CheckDate as unknown as DateConstructor;

if (process.env.MAPLE_CHECK_NOW) setClock(process.env.MAPLE_CHECK_NOW);
