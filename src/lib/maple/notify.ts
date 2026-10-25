import { query } from "@/lib/db";
import { listMembers } from "./auth";
import { planStatus } from "./care";
import { careSession, getCarePerson, rowToCareEntry, rowToPlan, viewerFor } from "./care-store";
import { cleanDevice } from "./device";
import { feedMinutes, minutesText, openSegment, sideMinutesText } from "./feed";
import {
  forHer,
  liveSubs,
  runPushTick,
  sendOnce,
  vapidKeys,
  voiceOf,
  when,
  whose,
  type Notice,
  type PushSub,
  type Voice,
} from "./push";
import { DOSE_LOOKBACK_MS, dueMoments, ensureSafetyNet } from "./push-wake";
import { getBaby, rowToEntry } from "./store";
import { formatTime, parseDayKey, dayKey, zonedTimeToUtc } from "./time";
import type { CarePlan, DoseEntry, Entry, FeedData, Source } from "./types";

/**
 * The notices a write sends (push-hooks.ts runs these after the response):
 *
 * "Logged" closes the loop on a medicine reminder. A dose or skip of hers,
 * saved from the app, Siri or Claude, goes to every phone that was sent
 * that medicine's OK-again or set-time reminder since its previous dose
 * (up to 12 hours), plus phones that asked for every dose, never to the
 * phone that logged it (its X-Maple-Device id). It shares the medicine's tag,
 * so it replaces the reminder on the lock screen. No one is named: it says
 * "On another phone", "From Siri" or "From Claude".
 *
 * The nursing timer on the lock screen (per phone, off by default): every
 * phone that turned it on, the one that started the feed included, gets the
 * running feed as it changes (start, switch, break, back on, done, removed),
 * one silent notice per feed (tag nurse:<id>) that replaces the last.
 */

type Row = Record<string, unknown>;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** "Logged" looks back this far for the reminders it closes. */
const LOGGED_WINDOW_MS = 12 * HOUR;

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const rows = await query(sql, params);
  if (rows === null) throw new Error("No database");
  return rows as Row[];
}

/** After a care write: "Logged" for a new dose or skip, then a tick that re-arms the wake-ups. */
export async function afterCareWrite(opts: { doseId?: number; device?: string | null } = {}): Promise<void> {
  if (!vapidKeys()) return;
  const now = new Date();
  const any = await q(`SELECT 1 FROM maple_push_subs WHERE NOT needs_resubscribe LIMIT 1`);
  if (!any.length) {
    // No phone to tell: only make sure the safety net isn't running for nobody (one small read most days).
    await ensureSafetyNet(false, now);
    return;
  }
  if (opts.doseId) await notifyDoseLogged(opts.doseId, opts.device ?? null, now);
  await runPushTick(now, { via: "write", trusted: true, schedule: true });
}

// ── Logged ────────────────────────────────────────────────────────────

/** "On another phone." / "From Siri." / "From Claude." */
function origin(source: Source): { sentence: string; phrase: string } {
  if (source === "shortcut") return { sentence: "From Siri.", phrase: "with Siri" };
  if (source === "chatgpt") return { sentence: "From ChatGPT.", phrase: "from ChatGPT" };
  if (source === "claude" || source === "mcp") return { sentence: "From Claude.", phrase: "from Claude" };
  return { sentence: "On another phone.", phrase: "on another phone" };
}

/** What comes next for a plan after this dose: when it's OK again (in the future), or the next set time. */
export type AfterDose = { okAt?: string; slotAt?: string; skippedSlot?: string };

/** The "Logged" notice as this phone reads it. */
export function loggedNotice(dose: DoseEntry, plan: CarePlan | null, v: Voice, hideNames: boolean, next: AfterDose): Notice {
  const tag = plan ? `med:${plan.id}` : `med:once:${dose.id}`;
  const url = "/maple?care=1";
  const data = { kind: "logged" as const, ...(plan ? { plan: plan.id } : {}) };
  const o = origin(dose.source);
  if (hideNames) {
    return { title: "Maple's Log", body: dose.data.skipped ? `A set time was marked skipped ${o.phrase}.` : `A medicine was logged ${o.phrase}.`, tag, url, data };
  }
  const name = plan?.name ?? dose.data.name;
  const then = next.okAt ? ` OK after ${when(v, next.okAt)}, by ${whose(v)} schedule.` : next.slotAt ? ` Next set time ${when(v, next.slotAt)}.` : "";
  if (dose.data.skipped) {
    const title = next.skippedSlot ? `${name}: ${when(v, next.skippedSlot)} set time skipped` : `${name} skipped${forHer(v)} · ${when(v, dose.at)}`;
    return { title, body: `${o.sentence}${next.slotAt ? ` Next set time ${when(v, next.slotAt)}.` : ""}`, tag, url, data };
  }
  return { title: `${name} logged${forHer(v)} · ${when(v, dose.at)}`, body: `${o.sentence}${then}`, tag, url, data };
}

/** The set time a skip filled (the slot planStatus gave it that day). */
function slotFilledBy(plan: CarePlan, doses: DoseEntry[], dose: DoseEntry, tz: string): string | undefined {
  if (plan.schedule.type !== "times") return undefined;
  const { year, month, day } = parseDayKey(dayKey(new Date(dose.at), tz));
  return planStatus(plan, doses, zonedTimeToUtc(year, month, day, 12, 0, tz), tz).slots?.find((s) => s.filled_by === dose.id)?.at;
}

/**
 * Send "Logged" for dose `doseId` (taken or skipped), logged on the phone
 * `device` (null: Siri, Claude, or a phone that sent no id).
 */
export async function notifyDoseLogged(doseId: number, device: string | null, now = new Date()): Promise<number> {
  const rows = await q(`SELECT * FROM maple_care_entries WHERE id = $1 AND kind = 'dose' AND deleted_at IS NULL`, [doseId]);
  if (!rows.length) return 0;
  const dose = rowToCareEntry(rows[0]) as DoseEntry;
  const from = device ?? cleanDevice(rows[0].device);
  const subs = await liveSubs();
  if (!subs.length) return 0;

  let plan: CarePlan | null = null;
  let next: AfterDose = {};
  const reminded = new Set<number>();
  const [baby, members, person] = await Promise.all([getBaby(), listMembers(), getCarePerson()]);
  const tz = baby.timezone;
  if (dose.med_id != null) {
    const p = await q(`SELECT m.*, to_char(m.course_start, 'YYYY-MM-DD') AS course_start_text, to_char(m.course_end, 'YYYY-MM-DD') AS course_end_text FROM maple_care_meds m WHERE m.id = $1`, [dose.med_id]);
    if (p.length) plan = rowToPlan(p[0]);
  }
  if (plan) {
    const doseRows = await q(`SELECT * FROM maple_care_entries WHERE med_id = $1 AND kind = 'dose' AND deleted_at IS NULL AND at >= $2::timestamptz ORDER BY at`, [
      plan.id,
      new Date(Math.min(now.getTime(), Date.parse(dose.at)) - DOSE_LOOKBACK_MS).toISOString(),
    ]);
    const doses = doseRows.map(rowToCareEntry) as DoseEntry[];
    // The reminders this dose answers: sent since the dose before it was logged.
    const before = doses.filter((d) => d.id !== dose.id && Date.parse(d.at) <= Date.parse(dose.at)).at(-1);
    const since = Math.max(now.getTime() - LOGGED_WINDOW_MS, before ? Date.parse(before.created_at) : 0);
    const got = await q(
      `SELECT DISTINCT sub_id FROM maple_push_sent WHERE ref = $1 AND state = 'sent' AND sent_at >= $2::timestamptz AND sub_id IS NOT NULL
         AND (key LIKE '%|ok:%' OR key LIKE '%|at:%')`,
      [`med:${plan.id}`, new Date(since).toISOString()]
    );
    for (const r of got) reminded.add(Number(r.sub_id));
    const st = planStatus(plan, doses, now, tz);
    const s = plan.schedule;
    if ((s.type === "every" || s.type === "as_needed") && st.nextOkAt && Date.parse(st.nextOkAt) > now.getTime() && !dose.data.skipped) next.okAt = st.nextOkAt;
    if (s.type === "times") {
      const upcoming = dueMoments(plan, doses, now, tz)
        .filter((m) => m.kind === "at" && m.at > now.getTime())
        .sort((a, b) => a.at - b.at)[0];
      if (upcoming) next.slotAt = new Date(upcoming.at).toISOString();
      if (dose.data.skipped) next = { ...next, skippedSlot: slotFilledBy(plan, doses, dose, tz) };
    }
  }

  const wanted = subs.filter(
    (sub) =>
      ((reminded.has(sub.id) && sub.prefs.closing !== false) || sub.prefs.logged === true) &&
      !(from && sub.device_id === from) &&
      !(plan && sub.prefs.muted?.includes(plan.id))
  );
  let sent = 0;
  const byMember = new Map<string, PushSub[]>();
  for (const sub of wanted) byMember.set(sub.member, [...(byMember.get(sub.member) ?? []), sub]);
  for (const [email, phones] of byMember) {
    const member = members.find((m) => m.email === email);
    if (!member) continue;
    const s = await careSession(viewerFor(member, baby, members), { members, baby, person });
    // Viewers never hear about her medicines.
    if (!s.access.read) continue;
    const v = voiceOf(s, now);
    for (const phone of phones) {
      const o = await sendOnce(phone, `log:${dose.id}`, plan ? `med:${plan.id}` : null, loggedNotice(dose, plan, v, phone.prefs.hide_names === true, next), { ttlS: HOUR / 1000 });
      if (o === "sent") sent++;
    }
  }
  return sent;
}

// ── the nursing timer on the lock screen ──────────────────────────────

/** "B" is back and forth (both sides, not tracked): the notice reads "Nursing · both sides". */
const SIDE: Record<"L" | "R" | "B", string> = { L: "Left", R: "Right", B: "both sides" };
/** Two instants a part start and a feed start share (stored with ms vs µs). */
const same = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) < 1500;

export type NurseState = "running" | "break" | "done" | "removed";

/** The feed's lock-screen notice: what's happening now, in a few words, no emoji. */
export function nurseNotice(e: Entry, state: NurseState, tz: string, now: Date): Notice {
  const d = e.data as FeedData;
  const segs = d.segments ?? [];
  const t = (x: string) => formatTime(x, tz);
  const base = { tag: `nurse:${e.id}`, url: "/maple", silent: true, data: { kind: "nurse" as const, entry: e.id, ts: Date.parse(e.updated_at) } };
  if (state === "removed") return { ...base, title: "Feed removed", body: `The ${t(e.started_at)} feed was removed from the log.` };
  if (state === "done") {
    const m = feedMinutes({ active: false, ended_at: e.ended_at, data: d }, now);
    const sides = sideMinutesText(m);
    return { ...base, title: `Fed ${minutesText(m.total)}${sides ? ` · ${sides}` : ""}`, body: `Done at ${t(e.ended_at ?? now.toISOString())}` };
  }
  if (state === "break") {
    const last = segs[segs.length - 1];
    return { ...base, title: "Nursing · on a break", body: `Since ${t(last?.end ?? e.updated_at)}` };
  }
  const open = openSegment(segs) ?? segs[segs.length - 1];
  const title = `Nursing · ${SIDE[open?.side ?? "L"]}`;
  if (!open || same(open.start, e.started_at)) return { ...base, title, body: `Since ${t(e.started_at)}. Tap to open.` };
  return { ...base, title, body: `Since ${t(open.start)} · feed started ${t(e.started_at)}` };
}

/**
 * Update feed `entryId`'s notice on every phone that turned the nursing
 * timer on. Worked out from the feed as it is now, so two quick taps send
 * the newest state (once per version of the row). "Done" and "Feed
 * removed" only go to phones that were showing this feed.
 */
export async function notifyNursing(entryId: number, now = new Date()): Promise<number> {
  if (!vapidKeys()) return 0;
  const subs = (await liveSubs()).filter((s) => s.prefs.nursing === true);
  if (!subs.length) return 0;
  const rows = await q(`SELECT * FROM maple_entries WHERE id = $1`, [entryId]);
  if (!rows.length) return 0;
  const e = rowToEntry(rows[0]);
  const d = e.data as FeedData & { joined_into?: number };
  if (e.kind !== "feed" || d.method !== "breast" || !d.segments?.length) return 0;
  const deleted = rows[0].deleted_at != null;
  // Joined into the feed before it: that feed's own notice replaces this one.
  if (deleted && d.joined_into != null) return 0;
  const state: NurseState = deleted ? "removed" : e.active ? (openSegment(d.segments) ? "running" : "break") : "done";
  const [baby, members] = await Promise.all([getBaby(), listMembers()]);
  const n = nurseNotice(e, state, baby.timezone, now);
  const key = `nurse:${e.id}:${Date.parse(e.updated_at)}${deleted ? ":x" : ""}`;
  const shown = state === "done" || state === "removed" ? await phonesShowing(e.id) : null;
  let sent = 0;
  for (const phone of subs) {
    if (!members.some((m) => m.email === phone.member)) continue;
    if (shown && !shown.has(phone.id)) continue;
    const o = await sendOnce(phone, key, `nurse:${e.id}`, n, { ttlS: state === "done" ? HOUR / 1000 : (15 * MIN) / 1000 });
    if (o === "sent") sent++;
  }
  return sent;
}

async function phonesShowing(entryId: number): Promise<Set<number>> {
  const rows = await q(`SELECT DISTINCT sub_id FROM maple_push_sent WHERE ref = $1 AND state = 'sent' AND sub_id IS NOT NULL`, [`nurse:${entryId}`]);
  return new Set(rows.map((r) => Number(r.sub_id)));
}
