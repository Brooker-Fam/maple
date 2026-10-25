/**
 * The answers parents actually need, computed from entries. Pure and
 * isomorphic: the Today screen runs it in the browser (instant after an
 * optimistic log), and the MCP `maple_status` tool runs the same code on the
 * server, so Claude, ChatGPT and the app always agree.
 *
 * Guidance numbers and wording live in ./guidelines; this file applies them.
 * Clinical day-of-life targets use rolling 24-hour windows, never the local
 * calendar day, so a baby born at 11 PM doesn't look "behind" at midnight.
 */
import {
  feedClusters,
  feedMinutes,
  lastFedAnchor,
  nextSideFor,
  nursingRuns,
  type FeedCluster,
  type LastFed,
  type NextSide,
  type NursingRun,
} from "./feed";
import {
  ALERT_TIERS,
  BIRTH_WEIGHT_REGAIN_DAY,
  FEEDS_PER_DAY,
  FIRST_CHECKUP_NOTE,
  LATE_BLACK_STOOL,
  PALE_STOOL,
  RED_STOOL,
  WEIGHT_LOSS_CALL_PCT,
  WEIGHT_LOSS_CHECK_PCT,
  assessJaundice,
  assessTemperature,
  assessVitals,
  diaperTargets,
  feedGapRule,
  needsOwnPlan,
  tummyGoalMinutes,
  type AlertTier,
} from "./guidelines";
import { addDays, babyAge, dayBounds, dayKey, DEFAULT_TZ, formatTime, localParts, zonedTimeToUtc, type BabyAge } from "./time";
import type { Baby, Entry, EntryOf, Lifetime, Member, Side } from "./types";

export type Alert = {
  /** Stable id (e.g. "fever-123") so a family can mark it handled. */
  id: string;
  tier: AlertTier;
  title: string;
  body: string;
  entryId?: number;
};

export type DayStats = {
  /** 'YYYY-MM-DD' local day, or 'last24h'. */
  key: string;
  /**
   * Feeds as the family counts them: nursing by the 10-minute rule
   * (nursingRuns: Pause or Done alike, a 10+ minute break starts a new feed)
   * plus each bottle, counted on the day each began.
   */
  feeds: number;
  breastFeeds: number;
  bottleFeeds: number;
  /** Of breastFeeds, how many were in a cluster ("11 · 4 in a cluster"). */
  clusterFeeds: number;
  /** Clusters that began in the window ("11 feeds (one cluster)"). */
  clusters: number;
  /**
   * Nursing as whole minutes × 60: each feed's rows added up (the rows' rule, as feedMinutes), so every surface shows
   * the same minutes. Counted with the feeds, on the day each feed (run) began.
   */
  nursingSec: number;
  leftSec: number;
  rightSec: number;
  /** Back and forth (both sides, not tracked): part of nursingSec, never of leftSec or rightSec. */
  bothSec: number;
  bottleMl: number;
  pumpMl: number;
  diapers: number;
  wet: number;
  dirty: number;
  sleepSec: number;
  sleeps: number;
  longestSleepSec: number;
  tummySec: number;
  meds: string[];
  maxTempC: number | null;
};

/**
 * A milestone reached recently. The app shows each one once per person
 * (seen ids in localStorage), only by daytime, until it's 3 days old.
 * `entryId` is the entry that made it (her first bath, the 100th diaper), so
 * the card can quote the note the family wrote on it.
 */
export type Celebration = { id: string; emoji: string; title: string; reachedAt: string; milestone?: string; entryId?: number };

export type Summary = {
  now: string;
  tz: string;
  born: boolean;
  age: BabyAge | null;
  /** Running timers, oldest first. */
  active: Entry[];
  /** The newest feed entry (to open it). Her last feed as counted (a run of entries) is lastFed. */
  lastFeed: EntryOf<"feed"> | null;
  /** Last feed's totals in seconds, as whole minutes × 60 like its rows (breast), and ml (bottle). */
  lastFeedTotals: { left: number; right: number; total: number; ml: number | null } | null;
  /**
   * Her last feed by the 10-minute rule, and when "Last fed" counts from
   * (feed.ts lastFedAnchor): its start, or 40 minutes before a long
   * back-and-forth (or 3+ part) feed ended, or, when that feed's last side
   * alone ran past 40 minutes (left on), when she went on it.
   */
  lastFed: LastFed | null;
  /** Minutes since lastFed.at (what "Last fed … ago" and the feed-gap checks say), or null. */
  minutesSinceFeed: number | null;
  /** The cluster her last nursing feed belongs to (3+ feeds, each under 30 min after the last), or null. */
  cluster: FeedCluster | null;
  /** The side to offer next (nextSideFor): with the rule behind it and "or the fuller side" after back and forth. */
  next: NextSide | null;
  /** next?.side, for the places that only need the side. */
  nextSide: Side | null;
  lastDiaper: EntryOf<"diaper"> | null;
  lastPee: EntryOf<"diaper"> | null;
  lastPoop: EntryOf<"diaper"> | null;
  lastSleep: EntryOf<"sleep"> | null;
  /** The local calendar day so far. */
  today: DayStats;
  /** Rolling last 24 hours: what the clinical targets are measured against. */
  last24h: DayStats;
  /**
   * Minimums per 24 hours for her current day of life. Null before birth, and
   * while warnings are off: against patchy logging they only say "behind".
   */
  targets: { wet: number; dirty: number | null; feeds: readonly [number, number]; tummyMin: number } | null;
  vitaminD: { givenAt: string; by: string | null } | null;
  weight: {
    latestG: number;
    at: string;
    birthG: number | null;
    /** Percent change vs birth weight (negative = below). */
    changePct: number | null;
    backToBirthWeight: boolean | null;
  } | null;
  /**
   * Most urgent first. Already excludes alerts the family marked handled.
   * Empty unless warnings are switched on (see alertsOn).
   */
  alerts: Alert[];
  /**
   * The diaper brigade (last 7 days): a team total, not a leaderboard.
   * `night` counts changes between 10pm and 6am.
   */
  duty: { who: string; diapers: number; night: number }[];
  teamDiapers: number;
  celebrations: Celebration[];
  /** Lifetime counts, for fun. */
  totals: { diapers: number; feeds: number };
};

/** Vitamin D by name, including common US drop brands (Ddrops, D-Vi-Sol, Tri-/Poly-Vi-Sol, "D3 drops"). */
export const isVitaminD = (name: string) =>
  /vit(amin)?[\s.-]*d\b|vit(amin)?[\s.-]*d3|\bd3\b|\bd\s*drops?\b|ddrops|(d|tri|poly)[- ]?vi[- ]?sol|cholecalciferol|sunshine/i.test(name);

function emptyStats(key: string): DayStats {
  return {
    key,
    feeds: 0,
    breastFeeds: 0,
    bottleFeeds: 0,
    clusterFeeds: 0,
    clusters: 0,
    nursingSec: 0,
    leftSec: 0,
    rightSec: 0,
    bothSec: 0,
    bottleMl: 0,
    pumpMl: 0,
    diapers: 0,
    wet: 0,
    dirty: 0,
    sleepSec: 0,
    sleeps: 0,
    longestSleepSec: 0,
    tummySec: 0,
    meds: [],
    maxTempC: null,
  };
}

/** Seconds of [a, b) that fall inside [lo, hi). */
function overlapSec(a: number, b: number, lo: number, hi: number): number {
  return Math.max(0, (Math.min(b, hi) - Math.max(a, lo)) / 1000);
}

/**
 * Totals for one window [from, to). Point events count by start time; sleep
 * and tummy time count only the part inside the window, so a sleep across
 * midnight splits between the two days. Nursing feeds are counted as runs
 * (feed.ts nursingRuns) by when each began, and their minutes with them, so
 * a day never reads 0 feeds with nursing minutes (a feed just after midnight
 * that carries on one from 11:55 PM counts, minutes and all, on the day it
 * began); pass `runs` worked out from every loaded entry when `entries` is
 * only this window's, so a feed that began before the window isn't counted
 * again in it.
 */
export function statsFor(entries: Entry[], from: Date, to: Date, key: string, now: Date, runs?: readonly NursingRun[]): DayStats {
  const s = emptyStats(key);
  const lo = from.getTime();
  const hi = to.getTime();
  const all = runs ?? nursingRuns(entries, now);
  const clustersSeen = new Set<number>();
  for (const r of all) {
    if (r.cluster !== null && !clustersSeen.has(r.cluster)) {
      clustersSeen.add(r.cluster);
      // A cluster counts on the day its first feed began.
      if (r.start >= lo && r.start < hi) s.clusters++;
    }
    if (r.start < lo || r.start >= hi) continue;
    s.feeds++;
    s.breastFeeds++;
    if (r.cluster !== null) s.clusterFeeds++;
    // The rows' whole minutes (spanMinutes per part), so they add up with every list.
    s.leftSec += r.min.left * 60;
    s.rightSec += r.min.right * 60;
    s.bothSec += r.min.both * 60;
    s.nursingSec += r.min.total * 60;
  }
  for (const e of entries) {
    const start = Date.parse(e.started_at);
    const end = e.ended_at ? Date.parse(e.ended_at) : e.active ? now.getTime() : start;
    const inWindow = start >= lo && start < hi;
    switch (e.kind) {
      case "feed": {
        if (!inWindow) break;
        // Nursing is counted above, as runs.
        if (e.data.method === "bottle") {
          s.feeds++;
          s.bottleFeeds++;
          s.bottleMl += e.data.amount_ml ?? 0;
        }
        break;
      }
      case "pump":
        if (inWindow) s.pumpMl += e.data.total_ml ?? (e.data.left_ml ?? 0) + (e.data.right_ml ?? 0);
        break;
      case "diaper":
        if (!inWindow) break;
        s.diapers++;
        if (e.data.pee) s.wet++;
        if (e.data.poop) s.dirty++;
        break;
      case "sleep": {
        const sec = overlapSec(start, end, lo, hi);
        if (sec > 0) {
          s.sleepSec += sec;
          if (inWindow) s.sleeps++;
          s.longestSleepSec = Math.max(s.longestSleepSec, (end - start) / 1000);
        }
        break;
      }
      case "tummy":
        s.tummySec += overlapSec(start, end, lo, hi);
        break;
      case "med":
        if (inWindow) s.meds.push(e.data.name);
        break;
      case "temp":
        if (inWindow) s.maxTempC = s.maxTempC == null ? e.data.temp_c : Math.max(s.maxTempC, e.data.temp_c);
        break;
    }
  }
  s.sleepSec = Math.round(s.sleepSec);
  s.tummySec = Math.round(s.tummySec);
  s.longestSleepSec = Math.round(s.longestSleepSec);
  return s;
}

/** One DayStats per local day from `fromKey` to `toKey` inclusive, oldest first. */
export function dailyStats(entries: Entry[], fromKey: string, toKey: string, now: Date, tz: string = DEFAULT_TZ): DayStats[] {
  const out: DayStats[] = [];
  const runs = nursingRuns(entries, now);
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
    const [a, b] = dayBounds(k, tz);
    out.push(statsFor(entries, a, b, k, now, runs));
  }
  return out;
}

const ts = (e: { started_at: string }) => Date.parse(e.started_at);

function ofKind<K extends Entry["kind"]>(entries: Entry[], kind: K): EntryOf<K>[] {
  return entries.filter((e) => e.kind === kind) as EntryOf<K>[];
}

function newest<K extends Entry["kind"]>(
  entries: Entry[],
  kind: K,
  pred: (e: EntryOf<K>) => boolean = () => true
): EntryOf<K> | null {
  let best: EntryOf<K> | null = null;
  for (const x of ofKind(entries, kind)) {
    if (pred(x) && (!best || ts(x) > ts(best))) best = x;
  }
  return best;
}

/** The entry of the same kind just before `e` (for "recheck" logic). */
function previousOf<K extends Entry["kind"]>(entries: Entry[], e: EntryOf<K>, pred: (x: EntryOf<K>) => boolean = () => true): EntryOf<K> | null {
  let best: EntryOf<K> | null = null;
  for (const x of ofKind(entries, e.kind as K)) {
    if (x.id === e.id || ts(x) > ts(e) || !pred(x)) continue;
    if (!best || ts(x) > ts(best)) best = x;
  }
  return best;
}

export function memberName(id: string | null | undefined, members: Member[]): string {
  if (!id) return "Someone";
  const m = members.find((x) => x.email === id);
  if (m?.display_name) return m.display_name;
  if (id === "admin") return "Admin";
  return id.split("@")[0];
}

/**
 * Warnings and reminders (feed gaps, diaper counts, weight, vitamin D,
 * checkups) need consistent logging to mean anything, so they're off unless
 * the family switches them on in Family → On Today → Warnings & reminders. A reading
 * entered in a sheet or through an assistant is still checked as it's logged.
 */
export function alertsOn(baby: Baby): boolean {
  return (baby.settings as { show_alerts?: unknown }).show_alerts === true;
}

/**
 * Who the site admin login logs as through Claude or ChatGPT: the member an
 * owner picked under Family → Admin (settings.admin_as), while they can still
 * log. Null means it logs as "Admin".
 */
export function adminActsAs(baby: Baby, members: Member[]): Member | null {
  const as = (baby.settings as { admin_as?: unknown }).admin_as;
  if (typeof as !== "string") return null;
  const m = members.find((x) => x.email === as);
  return m && m.email !== "admin" && m.role !== "viewer" ? m : null;
}

/**
 * A name worth printing ("started by Brittany", "Brittany just changed this
 * feed"), or null when it would only mean the viewer, an unknown id, or
 * "Admin": the admin login reads as the member it acts as (adminActsAs), and
 * the word "Admin" is never shown on a timer.
 */
export function memberLabel(id: string | null | undefined, ctx: { members: Member[]; me: Member | null | undefined; baby: Baby }): string | null {
  if (!id || id === ctx.me?.email) return null;
  const m = id === "admin" ? adminActsAs(ctx.baby, ctx.members) : ctx.members.find((x) => x.email === id);
  if (!m || m.email === "admin" || m.email === ctx.me?.email) return null;
  return m.display_name || m.email.split("@")[0];
}

/** Alerts a family has marked handled ("We called"), keyed by alert id. */
export function acknowledged(baby: Baby): Record<string, string> {
  const acks = (baby.settings as { acks?: unknown }).acks;
  return acks && typeof acks === "object" && !Array.isArray(acks) ? (acks as Record<string, string>) : {};
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything the Today screen and `maple_status` show. `entries` should hold
 * at least the last ~48 hours plus running timers; `growth` every growth
 * entry; `lifetime` (optional) lifetime counts from the server.
 */
export function summarize(opts: {
  entries: Entry[];
  growth?: Entry[];
  baby: Baby;
  members?: Member[];
  now: Date;
  lifetime?: Lifetime;
}): Summary {
  const { baby, now } = opts;
  const members = opts.members ?? [];
  const tz = baby.timezone || DEFAULT_TZ;
  const entries = opts.entries;
  const settings = baby.settings as Record<string, unknown>;
  const born = !!baby.born_at;
  const age = baby.born_at ? babyAge(baby.born_at, now, tz) : null;
  const ageHours = age ? age.ms / 3600_000 : 0;
  const nowMs = now.getTime();
  const H = 3600_000;

  const todayKey = dayKey(now, tz);
  const [todayStart, todayEnd] = dayBounds(todayKey, tz);
  // Feeds by the 10-minute rule, worked out once from everything loaded.
  const runs = nursingRuns(entries, now);
  const today = statsFor(entries, todayStart, todayEnd, todayKey, now, runs);
  const last24h = statsFor(entries, new Date(nowMs - 24 * H), new Date(nowMs + 1), "last24h", now, runs);

  const active = entries.filter((e) => e.active).sort((a, b) => ts(a) - ts(b));
  const lastFeed = newest(entries, "feed");
  const lastMin = lastFeed ? feedMinutes(lastFeed, now) : null;
  const lastFeedTotals =
    lastFeed && lastMin
      ? { left: lastMin.left * 60, right: lastMin.right * 60, total: lastMin.total * 60, ml: lastFeed.data.method === "bottle" ? lastFeed.data.amount_ml ?? null : null }
      : null;
  // "Last fed" counts from her last feed's start, or 40 min before a long back-and-forth one ended (lastFedAnchor),
  // or from when she went on a last side left on past 40 min.
  const lastFed = lastFedAnchor(entries, now, runs);
  const minutesSinceFeed = lastFed ? Math.max(0, Math.round((nowMs - Date.parse(lastFed.at)) / 60000)) : null;
  const lastRun = runs[runs.length - 1] ?? null;
  const cluster = lastRun && lastRun.cluster !== null ? feedClusters(runs).find((c) => c.runs.includes(lastRun)) ?? null : null;
  // While nursing, this is the side to offer at the *next* feed.
  const next = nextSideFor(runs, now);
  const nextSide = next?.side ?? null;

  const lastDiaper = newest(entries, "diaper");
  const lastPee = newest(entries, "diaper", (e) => e.data.pee);
  const lastPoop = newest(entries, "diaper", (e) => e.data.poop);
  const lastSleep = newest(entries, "sleep");

  const targets = age
    ? { ...diaperTargets(age.dayOfLife), feeds: FEEDS_PER_DAY, tummyMin: tummyGoalMinutes(age.days) }
    : null;

  const vitD = newest(entries, "med", (e) => isVitaminD(e.data.name) && ts(e) >= todayStart.getTime());
  const vitaminD = vitD ? { givenAt: vitD.started_at, by: vitD.created_by } : null;

  // Weight vs birth weight, from the newest weights.
  const weights = ofKind(opts.growth ?? entries, "growth")
    .filter((e) => e.data.weight_g != null)
    .sort((a, b) => ts(a) - ts(b));
  const latestW = weights[weights.length - 1] ?? null;
  const birthG = baby.birth_weight_g;
  const weight = latestW
    ? {
        latestG: latestW.data.weight_g!,
        at: latestW.started_at,
        birthG,
        changePct: birthG ? Math.round(((latestW.data.weight_g! - birthG) / birthG) * 1000) / 10 : null,
        backToBirthWeight: birthG ? latestW.data.weight_g! >= birthG : null,
      }
    : null;

  // "Are they logging?" Several checks only make sense if the window has
  // other activity; otherwise a quiet log would look like a dry baby.
  const loggedSince = (fromMs: number) => entries.filter((e) => ts(e) >= fromMs && ts(e) <= nowMs).length;
  const loggingFor24h = born && entries.some((e) => ts(e) <= nowMs - 24 * H && ts(e) >= Date.parse(baby.born_at!) - H);

  const alerts: Alert[] = [];
  const push = (id: string, a: { tier: AlertTier; title: string; body: string }, entryId?: number) =>
    alerts.push({ id, ...a, entryId });

  if (age) {
    const months = age.months;

    // Temperature. A fever (any call tier) from the last 12 hours stays up
    // until the family marks it handled: a lower reading afterwards, maybe on
    // a less accurate thermometer, must not hide it. A "please recheck" nudge
    // only comes from the newest reading, so the recheck itself clears it.
    const assess = (t: EntryOf<"temp">) => {
      const prev = previousOf(entries, t);
      return assessTemperature(
        t.data.temp_c,
        t.data.method,
        months,
        prev ? { tempC: prev.data.temp_c, minutesBefore: (ts(t) - ts(prev)) / 60000 } : null
      );
    };
    let worstTemp: { e: EntryOf<"temp">; a: NonNullable<ReturnType<typeof assessTemperature>> } | null = null;
    for (const t of ofKind(entries, "temp")) {
      if (nowMs - ts(t) >= 12 * H || ts(t) > nowMs) continue;
      const a = assess(t);
      if (!a || a.tier === "nudge") continue;
      const worse = !worstTemp || ALERT_TIERS.indexOf(a.tier) < ALERT_TIERS.indexOf(worstTemp.a.tier);
      const sameButNewer = worstTemp && a.tier === worstTemp.a.tier && ts(t) > ts(worstTemp.e);
      if (worse || sameButNewer) worstTemp = { e: t, a };
    }
    if (worstTemp) push(`temp-${worstTemp.e.id}`, worstTemp.a, worstTemp.e.id);
    else {
      const latestTemp = newest(entries, "temp", (t) => ts(t) <= nowMs);
      const a = latestTemp && nowMs - ts(latestTemp) < 12 * H ? assess(latestTemp) : null;
      if (latestTemp && a) push(`temp-${latestTemp.id}`, a, latestTemp.id);
    }

    // Vitals: each measure on its own, so a heart-rate-only entry can't hide
    // an earlier oxygen reading. Its "recheck" baseline is the previous
    // reading of that same measure.
    // The newest reading of a measure is its current state: a calm recheck
    // clears an earlier scare, while a different measure can't mask it.
    for (const f of ["spo2", "resp_rate", "heart_bpm"] as const) {
      const has = (e: EntryOf<"vitals">) => e.data[f] != null && ts(e) <= nowMs;
      const e = newest(entries, "vitals", has);
      if (!e || nowMs - ts(e) >= 12 * H) continue;
      const prev = previousOf(entries, e, has);
      assessVitals(
        { [f]: e.data[f] },
        months,
        prev ? { [f]: prev.data[f], minutesBefore: (ts(e) - ts(prev)) / 60000 } : null
      ).forEach((a) => push(`vitals-${e.id}-${f}`, a, e.id));
    }
    // Skin checks: the most urgent in the last 48 hours (a later "looks fine"
    // shouldn't quietly clear a call-now; "We called" does).
    let worstSkin: { e: EntryOf<"vitals">; a: NonNullable<ReturnType<typeof assessJaundice>> } | null = null;
    for (const e of ofKind(entries, "vitals")) {
      if (e.data.jaundice == null || nowMs - ts(e) >= 48 * H || ts(e) > nowMs) continue;
      const prev = previousOf(entries, e, (x) => x.data.jaundice != null);
      const a = assessJaundice(
        e.data.jaundice,
        (ts(e) - Date.parse(baby.born_at!)) / H,
        prev ? { level: prev.data.jaundice!, minutesBefore: (ts(e) - ts(prev)) / 60000 } : null
      );
      if (!a) continue;
      const worse = !worstSkin || ALERT_TIERS.indexOf(a.tier) < ALERT_TIERS.indexOf(worstSkin.a.tier);
      if (worse || (a.tier === worstSkin!.a.tier && ts(e) > ts(worstSkin!.e))) worstSkin = { e, a };
    }
    if (worstSkin) push(`skin-${worstSkin.e.id}`, worstSkin.a, worstSkin.e.id);
  }

  // Stool color flags (last 48 hours).
  for (const e of ofKind(entries, "diaper")) {
    if (!e.data.poop || !e.data.color || nowMs - ts(e) > 48 * H) continue;
    const hoursOld = baby.born_at ? (ts(e) - Date.parse(baby.born_at)) / H : 0;
    if (e.data.color === "white" || e.data.color === "gray" || e.data.color === "pale_yellow") push(`pale-${e.id}`, PALE_STOOL, e.id);
    else if (e.data.color === "red") push(`red-${e.id}`, RED_STOOL, e.id);
    else if (e.data.color === "black" && hoursOld >= 96) push(`black-${e.id}`, LATE_BLACK_STOOL, e.id);
  }

  // Episode alerts get an id suffix (the entry or day they're about), so
  // "We called" quiets this episode only, never the next one.
  if (age && born && targets) {
    const bornMs = Date.parse(baby.born_at!);
    const diapersSinceBirth = ofKind(entries, "diaper").filter((e) => ts(e) >= bornMs && ts(e) <= nowMs);

    // Pee. The 24-hour rule only applies while the loaded window reaches
    // back to birth, and only when diapers are actually being logged.
    if (ageHours >= 24 && ageHours < 72 && diapersSinceBirth.length >= 2 && !diapersSinceBirth.some((e) => e.data.pee)) {
      push("no-pee-24h", {
        tier: "now",
        title: "No wet diaper logged yet",
        body: "Babies should pee by 24 hours of life. If she really hasn't, call your pediatrician (or tell your nurse) now.",
      });
    } else if (age.dayOfLife >= 3 && lastPee && nowMs - ts(lastPee) > 8 * H && loggedSince(nowMs - 8 * H) >= 2) {
      push(`no-pee-8h:${lastPee.id}`, {
        tier: "now",
        title: "No wet diaper in 8 hours",
        body: "No wet diaper in 8 hours can mean she needs more milk. Please call your pediatrician now, especially if her pee was dark or her mouth looks dry.",
      });
    } else if (ageHours >= 48 && loggingFor24h) {
      // The last 24 hours are mostly the previous day of life: judge them
      // against that day's minimum, not the higher one just starting.
      const covered = age.dayOfLife - 1;
      const wetTarget = diaperTargets(covered).wet;
      if (last24h.wet < wetTarget) {
        push(`low-wet:${age.dayOfLife}`, {
          tier: "today",
          title: `${last24h.wet} wet diaper${last24h.wet === 1 ? "" : "s"} in the last 24 hours`,
          body: `The last 24 hours were mostly Day ${covered}, when babies usually have at least ${wetTarget} wet diapers. Offer feeds often and give your pediatrician a call today.`,
        });
      }
    }

    // Poop.
    if (age.dayOfLife >= 2 && age.dayOfLife <= 4 && loggingFor24h && last24h.dirty === 0) {
      push(`no-stool-24h:${age.dayOfLife}`, {
        tier: "today",
        title: "No poop in the last 24 hours",
        body: "In the first days babies should poop at least a couple of times a day as the meconium clears. Call your pediatrician within the day.",
      });
    } else if (age.dayOfLife >= 6 && age.dayOfLife <= 42 && loggingFor24h && targets.dirty && last24h.dirty < targets.dirty) {
      push(`low-stool:${age.dayOfLife}`, {
        tier: "today",
        title: `${last24h.dirty} poop${last24h.dirty === 1 ? "" : "s"} in the last 24 hours`,
        body: "From about Day 5 to 6 weeks, breastfed babies usually have 3 or more yellow poops a day. Fewer can mean she needs more milk: call your pediatrician within the day.",
      });
    }

    // Feeding gaps (start to start), unless she's nursing right now.
    // An old weighing says little about today: only a recent one keeps the
    // stricter wake-to-feed rule going past two weeks.
    const recentWeight = weights.length > 0 && nowMs - ts(weights[weights.length - 1]) <= 7 * 24 * H;
    const rule = feedGapRule(age.days, recentWeight ? weight?.backToBirthWeight ?? null : null, num(settings.feed_interval_hours));
    const nursingNow = active.some((e) => e.kind === "feed");
    const hour = localParts(now, tz).hour;
    const isNight = hour >= 22 || hour < 7;
    // Measured from the moment "Last fed" counts from, so the warning and the big number agree.
    const gapFeed = lastFed?.entry ?? lastFeed;
    if (gapFeed && minutesSinceFeed != null && !nursingNow && !(rule.nightsOff && isNight)) {
      const gap = `${Math.floor(minutesSinceFeed / 60)}h ${String(minutesSinceFeed % 60).padStart(2, "0")}m`;
      if (rule.firmMin && minutesSinceFeed >= rule.firmMin) {
        push(`feed-gap:${gapFeed.id}:firm`, {
          tier: "nudge",
          title: `${gap} since her last feed`,
          body: "Please wake her to feed: undress her, change her diaper, or try skin-to-skin. If she's too sleepy to feed, call your pediatrician.",
        });
      } else if (minutesSinceFeed >= rule.nudgeMin) {
        push(`feed-gap:${gapFeed.id}`, {
          tier: "nudge",
          title: `${gap} since her last feed`,
          body: rule.firmMin
            ? "Time to gently wake Maple for a feed. Undressing her, a diaper change, or skin-to-skin can help."
            : "Might be time to offer a feed.",
        });
      }
    }
    if (age.days >= 1 && loggingFor24h && last24h.feeds < FEEDS_PER_DAY[0] && !alerts.some((a) => a.id.startsWith("feed-gap"))) {
      push(`few-feeds:${age.dayOfLife}`, {
        tier: "nudge",
        title: `${last24h.feeds} feed${last24h.feeds === 1 ? "" : "s"} in the last 24 hours`,
        body: "Aim for 8–12 feeds a day. If she's hard to wake, not interested in feeding, or you're worried she's not getting enough, call your pediatrician or lactation consultant.",
      });
    }

    // Weight, from a recent weighing only (an old discharge weight says
    // nothing about today).
    const latest = weights[weights.length - 1];
    const weightFresh = latest && nowMs - ts(latest) <= 5 * 24 * H;
    if (weightFresh && weight?.changePct != null && weight.changePct <= -WEIGHT_LOSS_CALL_PCT) {
      push(`weight-10:${latest.id}`, {
        tier: "today",
        title: `Down ${Math.abs(weight.changePct)}% from birth weight`,
        body: `Maple has lost ${Math.abs(weight.changePct)}% of her birth weight. That's more than expected, so please call your pediatrician today.`,
      });
    } else if (weightFresh && weight?.changePct != null && weight.changePct <= -WEIGHT_LOSS_CHECK_PCT) {
      push(`weight-7:${latest.id}`, {
        tier: "mention",
        title: `Down ${Math.abs(weight.changePct)}% from birth weight`,
        body: "Most babies lose 5–7% before gaining. A bit more is worth a feeding check: let your pediatrician or a lactation consultant know.",
      });
    }
    // Still losing after Day 5: the newest weighing (after 120 hours) is lower
    // than an earlier one from Day 4 on, at least a day before it, by more than
    // noise: about an ounce between doctor's scales, and more than a feed or a
    // diaper (3 oz) when a home scale is involved.
    const stillLosing =
      latest &&
      weightFresh &&
      ts(latest) - bornMs >= 120 * H &&
      weights.some((p) => {
        if (p === latest || ts(p) - bornMs < 72 * H || ts(latest) - ts(p) < 24 * H || ts(latest) - ts(p) > 7 * 24 * H) return false;
        const both = p.data.at === "doctor" && latest.data.at === "doctor";
        return p.data.weight_g! - latest.data.weight_g! >= (both ? 30 : 90);
      });
    if (latest && stillLosing) {
      push(`still-losing:${latest.id}`, {
        tier: "today",
        title: "Still losing weight after Day 5",
        body: "Babies usually start gaining around Day 5. A drop after that is worth a call to your pediatrician today.",
      });
    }
    if (
      latest &&
      weight &&
      weight.backToBirthWeight === false &&
      age.days >= BIRTH_WEIGHT_REGAIN_DAY &&
      ts(latest) - bornMs >= 10 * 24 * H &&
      nowMs - ts(latest) <= 7 * 24 * H
    ) {
      push(`regain-14:${latest.id}`, {
        tier: "today",
        title: "Not back to birth weight yet",
        body: "Most babies are back to birth weight by about 2 weeks. Let's have your pediatrician take a look.",
      });
    }

    // Sunshine drops reminder in the evening.
    if (!vitaminD && age.days >= 2 && hour >= 18 && settings.vitamin_d_reminder !== false) {
      push(`vitamin-d:${todayKey}`, {
        tier: "nudge",
        title: "Sunshine drops today?",
        body: "No vitamin D logged yet today. Pediatricians recommend 400 IU once a day for breastfed babies.",
      });
    }

    if (age.days < 5) push("first-checkup", { tier: "mention", title: "First checkup", body: FIRST_CHECKUP_NOTE });
    if (needsOwnPlan(num(settings.gestational_age_weeks), baby.birth_weight_g)) {
      push("own-plan", {
        tier: "mention",
        title: "Your pediatrician's plan comes first",
        body: "These reminders are tuned for healthy full-term babies. If Maple arrived early or small, follow the feeding and weight plan your pediatrician gives you.",
      });
    }
  }

  const acks = acknowledged(baby);
  const order = (t: AlertTier) => ALERT_TIERS.indexOf(t);
  const visible = alerts.filter((a) => !acks[a.id]).sort((a, b) => order(a.tier) - order(b.tier));

  // The diaper brigade (last 7 days). Diapers only: feeds are credited to
  // whoever logged them, not whoever fed, so they'd make a misleading score.
  // The loaded entries reach back only ~72h, so the server counts the older
  // part of the week (lifetime.week, up to its `before`) and the loaded ones
  // count from there on: a change just logged shows at once.
  const weekAgo = nowMs - 7 * 24 * H;
  const dutyMap = new Map<string, { diapers: number; night: number }>();
  let teamDiapers = 0;
  const credit = (by: string | null | undefined, diapers: number, night: number) => {
    teamDiapers += diapers;
    if (!by || !diapers) return;
    const who = memberName(by, members);
    const d = dutyMap.get(who) ?? { diapers: 0, night: 0 };
    d.diapers += diapers;
    d.night += night;
    dutyMap.set(who, d);
  };
  const older = opts.lifetime?.week;
  const olderUntil = older ? Date.parse(older.before) : -Infinity;
  for (const c of older?.counts ?? []) credit(c.by, c.diapers, c.night);
  for (const e of ofKind(entries, "diaper")) {
    if (ts(e) < weekAgo || ts(e) < olderUntil || ts(e) > nowMs) continue;
    const h = localParts(ts(e), tz).hour;
    credit(e.created_by, 1, h >= 22 || h < 6 ? 1 : 0);
  }
  const duty = [...dutyMap.entries()].map(([who, d]) => ({ who, ...d })).sort((a, b) => a.who.localeCompare(b.who));

  const totals = opts.lifetime ?? {
    diapers: ofKind(entries, "diaper").length,
    feeds: ofKind(entries, "feed").length,
  };

  const celebrations = milestonesReached({ entries, weights, baby, now, totals, firsts: opts.lifetime?.firsts, tz });
  return {
    now: now.toISOString(),
    tz,
    born,
    age,
    active,
    lastFeed,
    lastFeedTotals,
    lastFed,
    minutesSinceFeed,
    cluster,
    next,
    nextSide,
    lastDiaper,
    lastPee,
    lastPoop,
    lastSleep,
    today,
    last24h,
    targets: alertsOn(baby) ? targets : null,
    vitaminD,
    weight,
    alerts: alertsOn(baby) ? visible : [],
    duty,
    teamDiapers,
    celebrations,
    totals,
  };
}

const CELEBRATE_FOR_MS = 3 * 24 * 3600_000;
/** How far back the app's entries reach (the state route's window). */
const LOADED_HOURS = 72;
/** A first poop is the meconium only in her first few days. */
const FIRST_POOP_DAYS = 4;

/**
 * Milestones reached in the last 3 days, newest first. Counted milestones
 * ("100 diapers") are dated by finding that entry among the recent ones.
 */
function milestonesReached(o: {
  entries: Entry[];
  weights: EntryOf<"growth">[];
  baby: Baby;
  now: Date;
  totals: { diapers: number; feeds: number };
  firsts?: Lifetime["firsts"];
  tz: string;
}): Celebration[] {
  const { entries, baby, now, totals, tz } = o;
  if (!baby.born_at) return [];
  const out: Celebration[] = [];
  const nowMs = now.getTime();
  const bornMs = Date.parse(baby.born_at);
  const name = baby.nickname || baby.name;
  const add = (c: Omit<Celebration, "reachedAt">, at: number) => {
    if (at <= nowMs && nowMs - at <= CELEBRATE_FOR_MS) out.push({ ...c, reachedAt: new Date(at).toISOString() });
  };

  add({ id: "born", emoji: "🍁", title: `Welcome to the world, ${baby.name}!`, milestone: "Born" }, bornMs);
  for (let w = 1; w <= 4; w++) {
    const title = w === 1 ? `One whole week of ${name}` : `${["", "", "Two", "Three", "Four"][w]} weeks of ${name}`;
    add({ id: `week-${w}`, emoji: w === 1 ? "🌱" : "🌿", title, milestone: `${w} week${w === 1 ? "" : "s"} old` }, bornMs + w * 7 * 24 * 3600_000);
  }
  // Month-days: the same date (and time) each month, in her timezone.
  const b = localParts(bornMs, tz);
  for (let m = 1; m <= 24; m++) {
    const mm = b.month - 1 + m;
    const at = zonedTimeToUtc(b.year + Math.floor(mm / 12), (mm % 12) + 1, b.day, b.hour, b.minute, tz).getTime();
    if (at > nowMs) break;
    add({ id: `month-${m}`, emoji: "🌳", title: `${m} month${m === 1 ? "" : "s"} old today`, milestone: `monthly-${m}` }, at);
  }
  add({ id: "day-100", emoji: "💯", title: `100 days of ${name}`, milestone: "100 days" }, bornMs + 100 * 24 * 3600_000);

  /**
   * When she first did it: the server's lifetime first. The loaded entries
   * only reach back ~72h, so their earliest is her first only while that
   * covers her whole life (an older server answer with no firsts).
   */
  const coversBirth = nowMs - bornMs <= LOADED_HOURS * 3600_000;
  const firstAt = (key: keyof NonNullable<Lifetime["firsts"]>, pred: (e: Entry) => boolean): number | null => {
    if (o.firsts) return o.firsts[key] ? Date.parse(o.firsts[key]!) : null;
    if (!coversBirth) return null;
    const e = entries.filter((x) => pred(x) && Date.parse(x.started_at) >= bornMs - 3600_000).sort((x, y) => ts(x) - ts(y))[0];
    return e ? ts(e) : null;
  };
  /** The loaded entry behind a first (when it's still in the ~72h loaded), for its note. */
  const entryAt = (at: number, pred: (e: Entry) => boolean) => entries.find((x) => pred(x) && ts(x) === at)?.id;
  // Meconium comes in her first days: a "first" poop logged later is just when the logging started.
  const isPoop = (e: Entry) => e.kind === "diaper" && !!e.data.poop;
  const firstPoop = firstAt("poop", isPoop);
  if (firstPoop !== null && firstPoop - bornMs <= FIRST_POOP_DAYS * 24 * 3600_000) add({ id: "first-poop", emoji: "🌰", title: "Her first poop", entryId: entryAt(firstPoop, isPoop) }, firstPoop);
  const isBath = (e: Entry) => e.kind === "bath";
  const firstBath = firstAt("bath", isBath);
  if (firstBath !== null) add({ id: "first-bath", emoji: "🛁", title: "Her first bath", milestone: "First bath", entryId: entryAt(firstBath, isBath) }, firstBath);
  const isTummy = (e: Entry) => e.kind === "tummy" && !e.active;
  const firstTummy = firstAt("tummy", isTummy);
  if (firstTummy !== null) add({ id: "first-tummy", emoji: "🐢", title: "Her first tummy time", milestone: "First tummy time", entryId: entryAt(firstTummy, isTummy) }, firstTummy);

  if (baby.birth_weight_g) {
    const back = o.weights.find((w) => w.data.weight_g! >= baby.birth_weight_g! && ts(w) > bornMs + 24 * 3600_000);
    const dippedFirst = back && o.weights.some((w) => ts(w) < ts(back) && w.data.weight_g! < baby.birth_weight_g!);
    if (back && dippedFirst) add({ id: `regained-${back.id}`, emoji: "🎈", title: "Back to her birth weight", milestone: "Back to birth weight", entryId: back.id }, ts(back));
  }

  // "100 diapers" / "500 feeds": date it by the entry that was the Nth.
  const counted = (kind: "diaper" | "feed", total: number, marks: number[], label: (n: number) => string, emoji: string) => {
    const recent = ofKind(entries, kind).filter((e) => !e.active).sort((x, y) => ts(y) - ts(x));
    for (const n of marks) {
      const fromNewest = total - n;
      if (fromNewest < 0 || fromNewest >= recent.length) continue;
      add({ id: `${kind}-${n}`, emoji, title: label(n), entryId: recent[fromNewest].id }, ts(recent[fromNewest]));
    }
  };
  counted("diaper", totals.diapers, [100, 250, 500, 1000, 2000], (n) => `${n} diapers`, "🎉");
  counted("feed", totals.feeds, [100, 500, 1000], (n) => `${n} feeds`, "🍼");

  return out.sort((a, b) => Date.parse(b.reachedAt) - Date.parse(a.reachedAt));
}

/** "Given at 8:10 AM by Brittany" helper for UI and MCP. */
export function vitaminDLine(s: Summary, members: Member[]): string | null {
  if (!s.vitaminD) return null;
  return `Given at ${formatTime(s.vitaminD.givenAt, s.tz)} by ${memberName(s.vitaminD.by, members)}`;
}
