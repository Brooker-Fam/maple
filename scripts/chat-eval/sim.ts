import { babyAge, dayKey, formatDayLabel, formatDuration, formatTime, formatTimeNear, parseWhenDetailed, zonedTimeToUtc } from "../../src/lib/maple/time";

/**
 * A made-up Maple's Log in memory: the entries a scenario starts from, and
 * what the stand-in tools change. Times are epoch milliseconds; the family's
 * clock is America/New_York, as in the app.
 */

export const TZ = "America/New_York";
export const MIN = 60_000;

export type Side = "L" | "R" | "B";
/** side null: a break. */
export type Part = { side: Side | null; start: number; end: number | null };
export type Kind = "feed" | "diaper" | "sleep" | "pump" | "med" | "tummy" | "temp" | "vitals" | "growth" | "note" | "moment" | "bath";

export type Entry = {
  id: number;
  kind: Kind;
  start: number;
  end: number | null;
  active: boolean;
  by: string;
  via: string;
  createdAt: number;
  data: Record<string, unknown>;
  parts?: Part[];
  note?: string | null;
  deleted?: boolean;
};

export type MomPlan = { name: string; also: string[]; everyH: number; max24: number; unit: string };
export type MomDose = { id: number; plan: string; at: number; by: string; via: string; createdAt: number; deleted?: boolean };

/** What the signed-in person's chat did, newest last, for undo_last. */
export type Action = { kind: "create" | "change"; tool: string; id: number; mom?: boolean; at: number };

export class ToolErr extends Error {}

export class Sim {
  now: number;
  me: string;
  bornAt: number;
  care: boolean;
  entries: Entry[] = [];
  plans: MomPlan[] = [];
  doses: MomDose[] = [];
  actions: Action[] = [];
  nextId = 801;
  nextDose = 41;

  constructor(opts: { now: number; me: string; bornAt: number; care: boolean }) {
    this.now = opts.now;
    this.me = opts.me;
    this.bornAt = opts.bornAt;
    this.care = opts.care;
  }

  clone(): Sim {
    const s = new Sim({ now: this.now, me: this.me, bornAt: this.bornAt, care: this.care });
    Object.assign(s, structuredClone({ entries: this.entries, plans: this.plans, doses: this.doses, actions: this.actions, nextId: this.nextId, nextDose: this.nextDose }));
    return s;
  }

  live(): Entry[] {
    return this.entries.filter((e) => !e.deleted);
  }

  get(id: number): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(e: Omit<Entry, "id" | "createdAt"> & { createdAt?: number }): Entry {
    const entry: Entry = { ...e, id: this.nextId++, createdAt: e.createdAt ?? Math.min(this.now, e.end ?? e.start) };
    this.entries.push(entry);
    return entry;
  }

  running(kind?: Kind): Entry[] {
    return this.live().filter((e) => e.active && (!kind || e.kind === kind));
  }

  /** A clock time or minutes ago as the tools read them, or null for "now". */
  when(at: string | null | undefined, minutesAgo: number | null | undefined, assumed: string[], label = "the time"): number | null {
    if (at && minutesAgo != null) throw new ToolErr("Give either at or minutes_ago, not both.");
    if (minutesAgo != null) return this.now - minutesAgo * MIN;
    if (!at) return null;
    const r = parseWhenDetailed(at, new Date(this.now), TZ);
    if (!r) throw new ToolErr(`Couldn't read ${label} "${at}". Use a local clock time like "3:10am", "15:10" or "yesterday 11pm", minutes_ago, or an ISO timestamp.`);
    if (r.date.getTime() > this.now + 10 * MIN) throw new ToolErr(`That time (${this.whenText(r.date.getTime())}) is in the future; it's ${this.whenText(this.now)} for Maple. Use minutes_ago or a past clock time.`);
    if (r.assumed) assumed.push(r.assumed);
    return r.date.getTime();
  }

  // ── words ──────────────────────────────────────────────────────────────

  time(ms: number): string {
    return formatTime(ms, TZ).replace(/[  ]/g, " ");
  }

  dayWord(ms: number): string {
    const label = formatDayLabel(dayKey(ms, TZ), dayKey(this.now, TZ));
    return label === "Today" ? "today" : label === "Yesterday" ? "yesterday" : `on ${label}`;
  }

  /** "2:36–2:52 AM", as the app writes a span. */
  span(a: number, b: number | null): string {
    return b == null ? `${this.time(a)}–now` : `${formatTimeNear(a, b, TZ).replace(/[\u202f\u00a0]/g, " ")}–${this.time(b)}`;
  }

  whenText(ms: number): string {
    return `${this.time(ms)} ${this.dayWord(ms)}`;
  }

  ago(ms: number): string {
    return `${formatDuration((this.now - ms) / 1000)} ago`;
  }

  zone(): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(this.now).find((p) => p.type === "timeZoneName")?.value ?? TZ;
  }

  sideMinutes(e: Entry): { L: number; R: number; B: number; breaks: number } {
    const t = { L: 0, R: 0, B: 0, breaks: 0 };
    for (const p of e.parts ?? []) {
      const m = Math.round(((p.end ?? this.now) - p.start) / MIN);
      if (p.side) t[p.side] += m;
      else t.breaks += m;
    }
    return t;
  }

  phrase(e: Entry): string {
    const d = e.data;
    switch (e.kind) {
      case "feed": {
        if (d.method === "bottle") {
          const ml = Number(d.amount_ml ?? 0);
          const milk = d.milk ? ` of ${d.milk === "breastmilk" ? "breast milk" : d.milk}` : "";
          return `${ml ? `${(ml / 29.5735).toFixed(1).replace(/\.0$/, "")} oz (${Math.round(ml)} ml) ` : ""}bottle${milk}`;
        }
        const m = this.sideMinutes(e);
        const bits = [m.L ? `L ${m.L}m` : "", m.R ? `R ${m.R}m` : "", m.B ? `back and forth ${m.B}m` : ""].filter(Boolean);
        return `breastfeed${bits.length ? `, ${bits.join(", ")}` : ""}${e.active ? " (running)" : ""}`;
      }
      case "diaper": {
        const what = d.pee && d.poop ? "wet + dirty diaper" : d.poop ? "dirty diaper" : d.pee ? "wet diaper" : "dry diaper";
        const looks = [d.color, d.texture].filter(Boolean).join(", ");
        return looks ? `${what} (${looks})` : what;
      }
      case "sleep":
        return e.active ? "sleep (running)" : `sleep ${formatDuration(((e.end ?? this.now) - e.start) / 1000)}`;
      case "med":
        return `${d.name ?? "Vitamin D"}${d.dose ? ` ${d.dose}` : ""}`;
      default:
        return e.kind.replace("_", " ");
    }
  }

  sideWord(s: Side): string {
    return s === "L" ? "left" : s === "R" ? "right" : "both sides (back and forth)";
  }

  timeline(e: Entry): string {
    return (e.parts ?? [])
      .map((p) => {
        const span = this.span(p.start, p.end);
        return p.side ? `${p.side === "B" ? "Back and forth" : p.side === "L" ? "Left" : "Right"} ${span}` : `break ${span}`;
      })
      .join(", ");
  }

  // ── what Today shows ───────────────────────────────────────────────────

  feeds(): Entry[] {
    return this.live()
      .filter((e) => e.kind === "feed")
      .sort((a, b) => a.start - b.start);
  }

  lastFeed(): Entry | undefined {
    return this.feeds().filter((e) => !e.active).pop();
  }

  /** The side the next feed starts on: the other one from the side the latest feed started on. */
  nextSide(): "left" | "right" {
    const breast = this.feeds().filter((e) => e.data.method !== "bottle");
    const latest = breast[breast.length - 1];
    const first = latest?.parts?.find((p) => p.side === "L" || p.side === "R")?.side ?? (latest?.data.first_side === "left" ? "L" : latest?.data.first_side === "right" ? "R" : null);
    return first === "L" ? "right" : "left";
  }

  counts(fromMs: number, toMs = this.now): { feeds: number; wet: number; dirty: number; sleepMin: number } {
    const inside = this.live().filter((e) => e.start >= fromMs && e.start <= toMs);
    const overlap = (e: Entry) => Math.max(0, Math.min(e.end ?? this.now, toMs) - Math.max(e.start, fromMs));
    return {
      feeds: inside.filter((e) => e.kind === "feed").length,
      wet: inside.filter((e) => e.kind === "diaper" && e.data.pee).length,
      dirty: inside.filter((e) => e.kind === "diaper" && e.data.poop).length,
      sleepMin: Math.round(this.live().filter((e) => e.kind === "sleep").reduce((n, e) => n + overlap(e), 0) / MIN),
    };
  }

  todayStart(): number {
    const k = dayKey(this.now, TZ);
    return zonedTimeToUtc(Number(k.slice(0, 4)), Number(k.slice(5, 7)), Number(k.slice(8, 10)), 0, 0, TZ).getTime();
  }

  today() {
    return this.counts(this.todayStart());
  }

  age(): { label: string; day: number } {
    const a = babyAge(new Date(this.bornAt), new Date(this.now), TZ);
    return { label: a.label.endsWith("old") ? a.label : `${a.label} old`, day: a.dayOfLife };
  }

  todayLine(): string {
    const t = this.today();
    return `Today so far: ${t.feeds} feed${t.feeds === 1 ? "" : "s"}, ${t.wet} wet, ${t.dirty} dirty, ${t.sleepMin ? `${formatDuration(t.sleepMin * 60)} of sleep` : "no sleep"} logged.`;
  }

  timerLine(e: Entry): string {
    if (e.kind === "feed") {
      const parts = e.parts ?? [];
      const cur = parts[parts.length - 1];
      const since = `since ${this.time(cur.start)} (${Math.round((this.now - cur.start) / MIN)} min)`;
      const where = !cur.side ? `paused ${since}` : cur.side === "B" ? `going back and forth (both sides) ${since}` : `on the ${this.sideWord(cur.side)} ${since}`;
      const past = parts.slice(0, -1).map((p) => (p.side ? `${p.side === "L" ? "Left" : p.side === "R" ? "Right" : "Back and forth"} ${this.span(p.start, p.end)}` : `break ${Math.round((p.end! - p.start) / MIN)} min`));
      const m = this.sideMinutes(e);
      const rest = past.length ? `; ${past.join(", ")}; total nursing ${m.L + m.R + m.B} min` : "";
      return `Nursing ${where}${rest}, started by ${e.by} [timer #${e.id}].`;
    }
    const label = e.kind === "tummy" ? "Tummy time" : e.kind === "pump" ? "Pumping" : "Sleep";
    return `${label} timer running: ${formatDuration((this.now - e.start) / 1000)} since ${this.time(e.start)} (started by ${e.by}) [timer #${e.id}].`;
  }

  timerJson(e: Entry): Record<string, unknown> {
    const base: Record<string, unknown> = { id: e.id, timer: e.kind === "feed" ? "nursing" : e.kind === "tummy" ? "tummy_time" : e.kind === "pump" ? "pumping" : "sleep", started_local: this.whenText(e.start), elapsed_minutes: Math.round((this.now - e.start) / MIN), by: e.by };
    if (e.kind !== "feed") return base;
    const parts = e.parts ?? [];
    const cur = parts[parts.length - 1];
    const m = this.sideMinutes(e);
    return {
      ...base,
      side: cur?.side ? (cur.side === "B" ? "both" : this.sideWord(cur.side)) : null,
      ...(cur?.side === "B" ? { back_and_forth: true } : {}),
      paused: !cur?.side,
      left_minutes: m.L,
      right_minutes: m.R,
      ...(m.B ? { both_minutes: m.B } : {}),
      current_side_since_local: cur?.side ? this.whenText(cur.start) : null,
      total_nursing_minutes: m.L + m.R + m.B,
      break_minutes: m.breaks,
      timeline: parts.map((p) => ({ part: p.side ? (p.side === "B" ? "both" : this.sideWord(p.side)) : "break", start_local: this.time(p.start), end_local: p.end ? this.time(p.end) : null })),
    };
  }

  lastFeedLine(): string {
    if (this.running("feed").length) return "She's nursing right now (see the timer above).";
    const f = this.lastFeed();
    if (!f) return "No feeds logged yet.";
    if (f.data.method === "bottle") return `Last feed: ${this.phrase(f)} at ${this.whenText(f.start)} (${this.ago(f.start)}).`;
    const first = f.parts?.find((p) => p.side === "L" || p.side === "R")?.side;
    const m = this.sideMinutes(f);
    const sides = [m.L ? `L ${m.L}m` : "", m.R ? `R ${m.R}m` : "", m.B ? `back and forth ${m.B}m` : ""].filter(Boolean).join(", ");
    return `Last feed: nursed at ${this.whenText(f.start)} (${this.ago(f.start)}): ${sides}${first ? `, started on the ${this.sideWord(first)}` : ""}.`;
  }

  diaperLine(): string {
    const ds = this.live()
      .filter((e) => e.kind === "diaper")
      .sort((a, b) => b.start - a.start);
    const pee = ds.find((e) => e.data.pee);
    const poop = ds.find((e) => e.data.poop);
    const bits = [pee ? `last wet ${this.ago(pee.start)} (${this.whenText(pee.start)})` : "", poop ? `last dirty ${this.ago(poop.start)} (${this.whenText(poop.start)})${poop.data.color ? `, ${poop.data.color}` : ""}` : ""].filter(Boolean);
    return bits.length ? `Diapers: ${bits.join("; ")}.` : "No diapers logged yet.";
  }

  lastSleepLine(): string | null {
    const last = this.live()
      .filter((e) => e.kind === "sleep")
      .sort((a, b) => b.start - a.start)[0];
    if (!last || last.active || !last.end) return null;
    return `Last sleep: ${formatDuration((last.end - last.start) / 1000)}, ended ${this.ago(last.end)} (${this.whenText(last.end)}).`;
  }

  nextLine(): string {
    return this.running("feed").length ? `Next feed after this one: start on the ${this.nextSide()}.` : `Next feed: offer the ${this.nextSide()} side first.`;
  }

  /** What the fixed chat puts on each user message as [App] lines (logState in mcp-tools.ts), from this log. */
  logState(care: boolean): string[] {
    const lines = [...this.running().map((e) => this.timerLine(e)), this.lastFeedLine(), this.nextLine(), this.diaperLine(), this.lastSleepLine(), this.todayLine()].filter((l): l is string => !!l);
    const top = care && this.plans[0];
    if (top) lines.push(`Brittany's next medicine: ${top.name} ${this.momState(top).short}.`);
    return lines;
  }

  momLine(): string | null {
    if (!this.care || !this.plans.length) return null;
    return `Brittany's medicines: ${this.plans.map((p) => `${p.name} ${this.momState(p).short}`).join("; ")}.`;
  }

  momState(p: MomPlan): { short: string; sentence: string; count24: number; last: MomDose | null } {
    const mine = this.doses.filter((d) => !d.deleted && d.plan === p.name).sort((a, b) => b.at - a.at);
    const last = mine[0] ?? null;
    const count24 = mine.filter((d) => d.at > this.now - 24 * 60 * MIN).length;
    if (!last) return { short: "none logged yet", sentence: "None logged yet.", count24, last };
    const okAt = last.at + p.everyH * 60 * MIN;
    const status = count24 >= p.max24 ? `${count24} of ${p.max24} ${p.unit} in 24 hours, OK after ${this.time(okAt)}` : okAt <= this.now ? `OK since ${this.time(okAt)}` : `OK after ${this.time(okAt)}`;
    return {
      short: status,
      sentence: `${p.name}: ${status}, by her schedule. Last: ${this.time(last.at)} · ${last.by}. ${count24} of ${p.max24} ${p.unit} in the last 24 hours.`,
      count24,
      last,
    };
  }
}
