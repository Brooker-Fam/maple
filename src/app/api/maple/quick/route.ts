import { NextRequest } from "next/server";
import { careErrorResponse, errorResponse, json } from "@/lib/maple/api";
import { listMembers, memberFor } from "@/lib/maple/auth";
import { careLevelOf } from "@/lib/maple/access";
import { familyForRow, type FamilyCtx } from "@/lib/maple/family";
import { aheadOfSlot, careTime, countedAs, matchPlan, pressingFirst, type PlanMatch, type PlanView } from "@/lib/maple/care";
import { momSpeak, samePlans, spokenLine } from "@/lib/maple/care-mcp";
import { carePersonName, carePlanViews, careSession, logCareDose, planDoses } from "@/lib/maple/care-store";
import { describeEntry } from "@/lib/maple/describe";
import { openSegment, staleFeed } from "@/lib/maple/feed";
import { LABEL_NOT_WHILE_NURSING, MOM_HELP, MOM_TIER_LABEL, TIER_LABEL, VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { memberName, summarize } from "@/lib/maple/insights";
import { lastFedSpeak } from "@/lib/maple/mcp-tools";
import {
  activeTimers,
  createEntryOnce,
  getBaby,
  lifetimeCounts,
  listEntries,
  memberForPersonalToken,
  startTimer,
  stopTimer,
  switchSide,
  toClientEntry,
} from "@/lib/maple/store";
import { formatTime } from "@/lib/maple/time";
import { voiceFor } from "@/lib/maple/voice";
import { ozToMl } from "@/lib/maple/units";
import type { Baby, Entry, FeedData, Member } from "@/lib/maple/types";
import { runningTry } from "@/lib/maple/sleep/store";
import { captureServerException } from "@/lib/posthog-server";
import { recap } from "./recap";
import { asleepInArms, badMinutes, checkin, clock, entryByClient, handoff, minutesAgo, outcome, putDown, sleepStatusLine, sleptWords, stopFeedForSleep, undo, type QuickCtx } from "./sleep";

export const dynamic = "force-dynamic";

/**
 * Hands-free logging for iOS Shortcuts ("Hey Siri, Maple pee"), the Action
 * Button or Back Tap. Auth: `Authorization: Bearer maple_…` (a personal token
 * from Family → Hands-free). Body: { action, amount_oz?, client_id? }.
 * Answers { speak } — one sentence for the Shortcut's "Speak Text".
 *
 * Going back and forth: `back_and_forth` with a feed running stops tracking
 * sides from now (both sides; paused, it goes back on going both); with none
 * it asks for a side first, since the next side alternates from where she
 * started. While she's going both, `switch` says there's nothing to switch
 * and `nurse_left` / `nurse_right` track sides again. `status` speaks a
 * cluster (3+ feeds close together) as one line, as Today shows it.
 *
 * Mom's medicines ride the same URL (one "Mom meds" Shortcut for every plan,
 * any phone): mom_status lists her plans as { id, label, ok_now } for Choose
 * from List, OK-now ones first, and mom_dose { med, minutes_ago?, skipped?,
 * units?, confirm?, client_id? } logs one, like Maple's own actions: it saves
 * (its brand or generic name counts toward the one on her list; any other
 * name is a one-time medicine), and early or over her limit is said after.
 * Only a likely duplicate (the same medicine within 30 minutes) answers
 * ok:false with needs_confirm and a question to speak. A save returns
 * next_ok_at and next_ok_in_minutes, so a Shortcut can Start Timer (which
 * rings through Silent) in one action. "Maple status" adds her medicines,
 * capped at two, for anyone who can read them.
 *
 * The sleep plan (./sleep.ts) rides it too: put_down { minutes_ago? } lays
 * a bassinet try ("Try 2 tonight, down at 9:42."), outcome { outcome:
 * stayed_asleep | woke_calm | woke_crying | picked_up } finishes the running
 * one, asleep_in_arms starts a sleep in arms, handoff from the person
 * holding her only asks the partner to take over (anyone else saying it has
 * her now, with the catch-up; with nobody on a turn, the speaker's own
 * starts with the ask on it), checkin { answer: yes | partly | no } is the speaker's own
 * check-in for last night, and undo takes back their newest Siri action
 * with the app's own Undo. sleep and wake take minutes_ago too (up to 4
 * hours). "Maple status" adds one sleep line while a try or a turn runs
 * (telling the person asked to take over that it's them), or while the
 * speaker's check-in is due. Retries carry client_id; a second tap on a
 * try, an outcome or a handoff answers with what's there.
 *
 * recap ("Maple, what did I miss?", ./recap.ts) is a read, for viewers too:
 * what was logged since the speaker's protected window began (in it, or
 * just out of it), else since their last visit, never moving that visit.
 */

const ACTIONS = [
  "pee",
  "poop",
  "both",
  "nurse_left",
  "nurse_right",
  "switch",
  "back_and_forth",
  "stop",
  "sleep",
  "wake",
  "vitamin_d",
  "bottle",
  "status",
  "mom_status",
  "mom_dose",
  "put_down",
  "outcome",
  "asleep_in_arms",
  "handoff",
  "checkin",
  "undo",
  "recap",
] as const;
type Action = (typeof ACTIONS)[number];

const side = (s: "L" | "R") => (s === "L" ? "left" : "right");

export async function POST(request: NextRequest) {
  let scope: FamilyCtx | undefined;
  try {
    const auth = request.headers.get("authorization") ?? "";
    const row = auth.startsWith("Bearer ") ? await memberForPersonalToken(auth.slice(7).trim()) : null;
    const fam = await familyForRow(row);
    scope = fam ?? undefined;
    const me = fam ? await memberFor(fam, fam.member) : null;
    if (!fam || !me) return json({ error: "Unknown or revoked token", speak: "That shortcut isn't connected to Maple's log anymore." }, 401);

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; amount_oz?: unknown; client_id?: unknown; outcome?: unknown; answer?: unknown; protected?: unknown } & MomBody;
    const action = body.action as Action;
    if (!ACTIONS.includes(action)) {
      return json({ error: `action must be one of ${ACTIONS.join(", ")}`, speak: "I didn't catch what to log." }, 400);
    }
    const mom = action === "mom_status" || action === "mom_dose";
    // Status and the recap are reads; her status too, for a viewer an owner let see her page (momAction checks it again).
    if (me.role === "viewer" && action !== "status" && action !== "recap" && !(action === "mom_status" && careLevelOf(me) !== "none")) {
      return json({ error: "View-only", speak: "You have view-only access to Maple's log.", ...(mom ? { help_now: MOM_HELP.now } : {}) }, 403);
    }
    if (mom) return momAction(action, me, fam, body);

    const baby = await getBaby(fam);
    const vo = voiceFor(fam.familyId, baby);
    const tz = baby.timezone;
    const now = new Date();
    const base = { babyId: baby.id, createdBy: me.email, source: "shortcut" as const };
    const clientId = typeof body.client_id === "string" ? `shortcut:${body.client_id}` : null;
    // The sleep plan's actions (./sleep.ts): each reads what it needs and answers itself. Awaited, so a failure is spoken below.
    const qc: QuickCtx = { fam, me, baby, vo, tz, now, clientId, body };
    switch (action) {
      case "put_down":
        return await putDown(qc);
      case "outcome":
        return await outcome(qc);
      case "asleep_in_arms":
        return await asleepInArms(qc);
      case "checkin":
        return await checkin(qc);
      case "handoff":
        return await handoff(qc, await listMembers(fam));
      case "undo":
        return await undo(qc, await listMembers(fam));
      case "recap":
        return await recap(qc, await listMembers(fam));
    }
    const running = await activeTimers(fam, baby.id);
    const runningFeed = running.find((e) => e.kind === "feed");
    const runningSleep = running.find((e) => e.kind === "sleep");
    const at = formatTime(now, tz);
    let entry: Entry | null = null;
    let speak = "";

    switch (action) {
      case "pee":
      case "poop":
      case "both": {
        const data = { pee: action !== "poop", poop: action !== "pee" };
        ({ entry } = await createEntryOnce(fam, { ...base, kind: "diaper", startedAt: now, data, clientId }));
        speak = `Logged a ${action === "both" ? "wet and dirty" : action === "pee" ? "wet" : "dirty"} diaper at ${at}.`;
        break;
      }
      case "nurse_left":
      case "nurse_right": {
        const s = action === "nurse_left" ? "L" : "R";
        // A feed nobody tapped Done on (MCP start_timer's rule, by its newest tap, so a long feed tapped a minute ago still resumes):
        // switching sides on it would glue this feed onto that one.
        const d = runningFeed?.data as FeedData | undefined;
        if (runningFeed && d && staleFeed({ started_at: runningFeed.started_at, data: d }, now)) {
          const last = d.segments?.at(-1);
          // Paused: "stop" ends it at the pause, so say that's where it stands.
          speak =
            last && last.end !== null
              ? `A feed from ${formatTime(runningFeed.started_at, tz)} is still open, on a break since ${formatTime(last.end, tz)}. Stop that one first, then start the new feed.`
              : `A feed from ${formatTime(runningFeed.started_at, tz)} is still running. Stop that one first, then start the new feed.`;
          break;
        }
        if (runningSleep) await stopTimer(fam, runningSleep.id, undefined, me.email);
        // Going back and forth until now: this side is tracking sides again.
        const wasBoth = !!d && openSegment(d.segments)?.side === "B";
        ({ entry } = await startTimer(fam, { ...base, kind: "feed", side: s, at: now, clientId }));
        speak = wasBoth ? `Tracking sides again: ${vo.they}${vo.verb("'s")} on the ${side(s)}.` : `Nursing timer running on the ${side(s)}.`;
        break;
      }
      case "switch": {
        if (!runningFeed) {
          speak = "No nursing timer is running.";
          break;
        }
        const d = runningFeed.data as FeedData;
        // Going back and forth (or on a break from it): no side to flip to, and never a guess from the last side tracked.
        if (d.segments?.at(-1)?.side === "B") {
          speak = `${vo.They}${vo.verb("'s")} going back and forth, so there's nothing to switch.`;
          break;
        }
        const to = d.last_side === "L" ? "R" : "L";
        entry = (await switchSide(fam, runningFeed.id, to, undefined, me.email)).entry;
        speak = `Switched to the ${side(to)}.`;
        break;
      }
      case "back_and_forth": {
        if (!runningFeed) {
          // The side she starts on is what the next side alternates from.
          speak = "Start the feed on a side first.";
          break;
        }
        const d = runningFeed.data as FeedData;
        // A feed nobody tapped Done on isn't this one (the nurse_* rule): going both on it would glue two feeds together.
        if (staleFeed({ started_at: runningFeed.started_at, data: d }, now)) {
          const last = d.segments?.at(-1);
          speak =
            last && last.end !== null
              ? `A feed from ${formatTime(runningFeed.started_at, tz)} is still open, on a break since ${formatTime(last.end, tz)}. Stop that one first, then start the new feed.`
              : `A feed from ${formatTime(runningFeed.started_at, tz)} is still running. Stop that one first, then start the new feed.`;
          break;
        }
        const paused = !openSegment(d.segments);
        const r = await switchSide(fam, runningFeed.id, "B", undefined, me.email);
        entry = r.entry;
        const open = openSegment((r.entry.data as FeedData).segments);
        if (r.noop) speak = `${vo.They}${vo.verb("'s")} already going back and forth.`;
        else if (paused) speak = r.merged ? "Back on, still going back and forth." : "Back on, going back and forth.";
        else speak = `Going back and forth from ${formatTime(open?.start ?? now, tz)}, so there's nothing to switch.`;
        break;
      }
      case "stop":
      case "wake": {
        const target = action === "wake" ? runningSleep : runningFeed ?? runningSleep ?? running[0];
        if (!target) {
          speak = action === "wake" ? "No sleep timer is running." : "No timer is running.";
          break;
        }
        // wake takes minutes_ago ("she woke 5 minutes ago"); otherwise "now" under the stop rule (a paused feed ends at its pause).
        const when = action === "wake" ? minutesAgo(body.minutes_ago, now) : { at: now, given: false };
        if (!when) return badMinutes(body.minutes_ago);
        if (when.given && when.at.getTime() < Date.parse(target.started_at)) {
          return json({ ok: false, speak: `That's before the sleep timer started at ${clock(target.started_at, tz)}, so nothing was changed.` }, 400);
        }
        entry = await stopTimer(fam, target.id, when.given ? when.at : undefined, me.email);
        // A sleep is said as a sentence ("She slept 25 minutes, in arms."), never the card's "Slept · 0s · in arms".
        speak = entry.kind === "sleep" ? `Stopped. ${sleptWords(entry, vo)}` : `Stopped. ${describeEntry(entry, { now }).text}.`;
        // A bassinet try on that sleep stays open until someone says how it went (the app opens How did it go? here).
        if (entry.kind === "sleep" && (await runningTry(fam, baby.id))?.sleep_entry_id === entry.id) speak += " The bassinet try is still open: say how it went.";
        break;
      }
      case "sleep": {
        const when = minutesAgo(body.minutes_ago, now);
        if (!when) return badMinutes(body.minutes_ago);
        const dreams = vo.named ? `Sweet dreams, ${vo.name}.` : "Sweet dreams.";
        const at = (e: Entry) => (when.given ? ` at ${clock(e.started_at, tz)}` : "");
        // A retry of this request gets its first answer, not "already running".
        const prior = await entryByClient(fam, clientId);
        if (prior?.kind === "sleep") {
          entry = prior;
          speak = `Sleep timer started${at(prior)}. ${dreams}`;
          break;
        }
        // Fell asleep feeding: the feed ends when she fell asleep (a time given), else now.
        if (runningFeed) await stopFeedForSleep(fam, runningFeed, when, me.email);
        const r = await startTimer(fam, { ...base, kind: "sleep", at: when.at, clientId: prior ? null : clientId });
        entry = r.entry;
        if (r.alreadyRunning) speak = `${runningFeed ? "Feed stopped. " : ""}A sleep timer is already running, since ${clock(r.entry.started_at, tz)}.`;
        else speak = runningFeed ? `Feed stopped and sleep timer started${at(r.entry)}. ${dreams}` : `Sleep timer started${at(r.entry)}. ${dreams}`;
        break;
      }
      case "vitamin_d": {
        ({ entry } = await createEntryOnce(fam, { ...base, kind: "med", startedAt: now, data: VITAMIN_D_DEFAULT, clientId }));
        speak = `Vitamin D logged at ${at}.`;
        break;
      }
      case "bottle": {
        const oz = Number(body.amount_oz);
        const data = Number.isFinite(oz) && oz > 0 && oz <= 12 ? { method: "bottle", amount_ml: Math.round(ozToMl(oz)) } : { method: "bottle" };
        ({ entry } = await createEntryOnce(fam, { ...base, kind: "feed", startedAt: now, data, clientId }));
        speak = `Logged a ${"amount_ml" in data ? `${oz} ounce ` : ""}bottle at ${at}.`;
        break;
      }
      case "status": {
        const [entries, growth, members, lifetime] = await Promise.all([
          listEntries(fam, { babyId: baby.id, from: new Date(now.getTime() - 72 * 3600_000), includeActive: true }),
          listEntries(fam, { babyId: baby.id, kinds: ["growth"], ascending: true }),
          listMembers(fam),
          lifetimeCounts(fam, baby.id),
        ]);
        const s = summarize({ entries, growth, baby, members, now, lifetime, vo: voiceFor(fam.familyId, baby) });
        const bits: string[] = [];
        const name = baby.nickname || baby.name;
        const nursing = s.active.find((e) => e.kind === "feed");
        if (nursing) {
          const d = nursing.data as FeedData;
          const mins = Math.round((now.getTime() - Date.parse(nursing.started_at)) / 60000);
          const open = openSegment(d.segments);
          // On a break (nothing open), never the last side tracked: after going back and forth that's from before it.
          const breakAt = open ? null : d.segments?.at(-1)?.end;
          const where = open ? (open.side === "B" ? ", going back and forth" : ` on the ${side(open.side)}`) : breakAt ? `, on a break since ${formatTime(breakAt, tz)}` : "";
          bits.push(`${name} is nursing now${where}, ${mins} minute${mins === 1 ? "" : "s"} in.`);
          // A cluster still going: how many feeds so far (Today's rule: 3+ feeds, each under 30 minutes after the last ended).
          const c = s.lastFed?.kind === "breast" && s.lastFed.run?.cluster != null ? s.cluster : null;
          if (c) bits.push(`It's feed ${c.feeds} of a cluster since ${formatTime(c.start, tz)}.`);
        } else {
          // The cluster line after a cluster, else when she last ate and the side to start on (insights' lastFed and next).
          bits.push(lastFedSpeak(s, name, tz, vo));
        }
        // The sleep plan's one line: a try running, else who's holding her, else this adult's check-in when it's due.
        const sleep = await sleepStatusLine({ fam, baby, me, members, vo, name, now });
        if (sleep.line) bits.push(sleep.line);
        // Only what was logged: none is "no diapers logged", never "0 wet and 0 dirty".
        bits.push(s.last24h.diapers ? `${s.last24h.wet} wet and ${s.last24h.dirty} dirty diapers in the last 24 hours.` : "No diapers logged in the last 24 hours.");
        // The try's line already says she's asleep.
        const others = s.active.filter((e) => e.kind !== "feed" && e.id !== sleep.trySleepId);
        if (others.length) bits.push(`A ${others.map((e) => (e.kind === "tummy" ? "tummy time" : e.kind)).join(" and ")} timer is running.`);
        if (s.vitaminD) bits.push("Vitamin D is done today.");
        const urgent = s.alerts.find((a) => a.tier === "emergency" || a.tier === "now" || a.tier === "today");
        // Say who to call, not just what happened ("Call your pediatrician now: No wet diaper in 8 hours.").
        if (urgent) bits.push(`${TIER_LABEL[urgent.tier]}: ${urgent.title.replace(/[.:]?$/, "")}.`);
        // Her medicines after Maple's, capped at two; only for someone whose level lets them read her page.
        const mom = await momForStatus(me, fam, members, baby);
        if (mom) bits.push(mom);
        speak = bits.join(" ");
        break;
      }
    }

    return json({ speak, entry: entry ? toClientEntry(entry) : null });
  } catch (error) {
    const res = await errorResponse("POST /api/maple/quick", error, scope);
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    return json({ error: body.error ?? "Something went wrong", speak: "Sorry, Maple's log didn't save that. Try the app." }, res.status);
  }
}

// ── Mom's medicines (§10.5) ──────────────────────────────────────────────

type MomBody = { med?: unknown; minutes_ago?: unknown; skipped?: unknown; units?: unknown; confirm?: unknown; name_in_reminder?: unknown; client_id?: unknown };

/** "3:02", "9:02 tomorrow": a clock time to say, without AM/PM (the Shortcut's speech is short). */
const sayTime = (iso: string, now: Date, tz: string) => careTime(iso, now, tz).replace(/ (AM|PM)\b/, "");

const andList = (names: string[]) => (names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Her plans for Choose from List: OK now first (so the top row is usually the one), then the rest in sortPlans order. */
const okFirst = (views: PlanView[]) => [...views.filter((v) => v.status.state === "ok"), ...views.filter((v) => v.status.state !== "ok")];

/**
 * Her medicines for "Maple status" ("Brittany's medicines: Ibuprofen OK
 * since 2:10 AM; Tylenol OK after 10:55 AM."), most pressing first by the
 * rule Today's strip and maple_status use (pressingFirst: a set time not
 * logged leads), capped at two: only for someone who can read her page, and
 * never an error (Maple's status never waits on hers; a failure is reported
 * as a code only).
 */
async function momForStatus(me: Member, fam: FamilyCtx, members: Member[], baby: Baby): Promise<string | null> {
  try {
    const s = await careSession({ id: me.email, role: me.role, viaAdmin: false, channel: "siri" }, { familyId: fam.familyId, members, baby });
    if (!s.person || !s.access.read) return null;
    return momSpeak(pressingFirst(await carePlanViews(s)), { name: carePersonName(s.person, members), self: s.access.self, now: s.now, tz: s.tz });
  } catch {
    await captureServerException(new Error("care_status"), { route: "POST /api/maple/quick" });
    return null;
  }
}

/** mom_status / mom_dose: her token reads "your", anyone she shares with "Brittany's". Errors are scrubbed (careErrorResponse). */
async function momAction(action: "mom_status" | "mom_dose", me: Member, fam: FamilyCtx, body: MomBody): Promise<Response> {
  try {
    const [baby, members] = await Promise.all([getBaby(fam), listMembers(fam)]);
    // A personal token is its member's own phone: never the admin path.
    const s = await careSession({ id: me.email, role: me.role, viaAdmin: false, channel: "siri" }, { familyId: fam.familyId, members, baby });
    const help = { help_now: MOM_HELP.now };
    if (!s.person) return json({ error: "Not found", speak: "There's no page for mom's medicines in this log.", ...help }, 404);
    const name = carePersonName(s.person, members);
    // Never her name to someone her page is hidden from.
    if (!s.access.read) return json({ error: "Not shared", speak: "Mom's medicines aren't shared with this account.", ...help }, 403);
    if (action === "mom_dose" && !s.access.write) return json({ error: "Not shared", speak: `You can't change ${name}'s medicines from this account.`, ...help }, 403);
    const self = s.access.self;
    const whose = self ? "your" : "her";
    const views = okFirst(await carePlanViews(s));
    const plans = views.map((v) => ({ id: `p${v.plan.id}`, label: v.line, ok_now: v.status.state === "ok" }));
    const { now, tz } = s;

    if (action === "mom_status") {
      // Leads with what's OK now, like the list.
      const speak = views.length ? `${views.slice(0, 3).map((v) => spokenLine(v, now, tz)).join(". ")}.` : `There are no medicines on ${whose} list yet.`;
      return json({ ok: true, speak, plans });
    }

    const med = typeof body.med === "string" ? body.med.trim() : "";
    if (!med) return json({ ok: false, not_found: true, speak: "Which medicine?", plans });
    let m: PlanMatch = matchPlan(med, views.map((v) => v.plan), { includePrivate: true });
    // Not by her own names: its brand or generic name ("acetaminophen" for a Tylenol plan) counts toward that one; two ask which.
    let sameAs: string | null = null;
    if (m.kind === "none" && !/^p?\d{8}$/i.test(med)) {
      const same = samePlans(med, views.map((v) => v.plan));
      if (same.length === 1) {
        m = { kind: "match", plan: same[0] };
        sameAs = med;
      } else if (same.length > 1) m = { kind: "ambiguous", plans: same };
    }
    if (m.kind === "ambiguous") {
      // One loose match ("Tylenol" with only Tylenol PM on her list) is a yes or no, never a one-item choice.
      const speak =
        m.plans.length === 1
          ? `Did you mean ${m.plans[0].name}? Nothing was saved.`
          : `Which one: ${andList(m.plans.map((p) => p.name)).replace(/ and ([^,]*)$/, " or $1")}?`;
      return json({ ok: false, not_found: true, speak, plans: m.plans.map((p) => ({ id: `p${p.id}`, label: views.find((v) => v.plan.id === p.id)!.line })) });
    }
    // A p id is never a name: one that's no longer on her list answers like an unknown pick.
    if (m.kind === "none" && /^p?\d{8}$/i.test(med)) {
      return json({ ok: false, not_found: true, speak: `That medicine isn't on ${whose} list anymore. Pick it again.`, plans });
    }
    // On her list it counts toward that plan; any other name is saved as a one-time medicine, like Maple's log.
    const plan = m.kind === "match" ? m.plan : null;
    const before = plan ? await planDoses(s, plan.id, new Date(now.getTime() - 3 * 86400_000)) : [];
    const mins = Number(body.minutes_ago);
    const at = Number.isFinite(mins) && mins > 0 && mins <= 4320 ? new Date(now.getTime() - mins * 60_000) : now;
    const units = body.units == null || body.units === "" ? null : Number(body.units);
    const clientId = typeof body.client_id === "string" ? `shortcut-care:${body.client_id}` : null;
    const res = await logCareDose(s, {
      planId: plan?.id ?? null,
      name: plan ? undefined : med.slice(0, 80),
      at: at.toISOString(),
      units: units != null && Number.isFinite(units) ? units : null,
      skipped: body.skipped === true,
      allowDuplicate: body.confirm === true,
      clientId,
      source: "shortcut",
    });
    const label = plan?.name ?? med;

    if (!res.created && !res.deduped) {
      const dup = res.possible_duplicate;
      const who = dup ? (dup.created_by === me.email ? "You" : memberName(dup.created_by, members)) : null;
      const speak = dup ? `${who} logged ${label} at ${sayTime(dup.at, now, tz)}. Is this another dose?` : "That didn't save. Try again.";
      return json({ ok: false, needs_confirm: true, reason: res.reason ?? "recent", speak });
    }

    const entry = res.entry!;
    const st = res.status;
    const said = self ? label : `${name}'s ${label}`;
    const bits: string[] = [];
    if (res.deduped) bits.push(`Already logged, ${said} at ${sayTime(entry.at, now, tz)}.`);
    else if (entry.kind === "dose" && entry.data.skipped) bits.push(`Got it, ${said} skipped.`);
    else if (sameAs) bits.push(`Got it, ${sameAs} at ${sayTime(entry.at, now, tz)}, counted toward ${said}.`);
    else bits.push(`Got it, ${said} at ${sayTime(entry.at, now, tz)}.`);
    // "Next one's OK after" only on a gap; As needed with none set, Each day and set times say nothing more.
    const next = plan && st && st.nextOkAt && plan.schedule.type !== "daily" && plan.schedule.type !== "times" && st.state !== "unknown" ? st.nextOkAt : null;
    if (next && !res.deduped) bits.push(`Next one's OK after ${sayTime(next, now, tz)}.`);
    if (!plan && !res.deduped) bits.push(`It isn't on ${whose} list, so it's saved as a one-time medicine.`);
    const counted = plan && res.created && entry.kind === "dose" && !entry.data.skipped ? countedAs(plan, entry.data.units) : null;
    if (counted) bits.push(`Counted as ${counted}.`);
    const slot = plan && res.created && entry.kind === "dose" && !entry.data.skipped ? aheadOfSlot(plan, before, new Date(entry.at), tz) : null;
    if (slot) bits.push(`That counts for the ${sayTime(slot, now, tz)} time.`);
    // An early or over-the-limit dose still saves: that note's own words. A one-time medicine says all of its notes
    // (the acetaminophen overlap is a mention), since nobody saw them before it saved.
    for (const n of res.notes) {
      if (n.label === LABEL_NOT_WHILE_NURSING.label) continue;
      if (n.tier === "nudge" || n.label === "Call Poison Help now") bits.push(`${n.title}. ${n.body}`);
      else if (!plan) bits.push(`${n.label ?? MOM_TIER_LABEL[n.tier]}: ${n.title}. ${n.body}`);
    }
    // Hands-free at 3am is when she's least likely to open the card, so the nursing note is said too, with its label.
    for (const n of res.notes) if (n.label === LABEL_NOT_WHILE_NURSING.label) bits.push(`${n.label}: ${n.title}. ${n.body}`);
    // Whole minutes until her schedule's next OK time, for one Start Timer action (a Clock timer rings through
    // Silent); null when there's nothing to wait for.
    const inMin = next ? Math.ceil((Date.parse(next) - now.getTime()) / 60_000) : null;
    return json({
      ok: true,
      speak: bits.join(" "),
      next_ok_at: next,
      next_ok_in_minutes: inMin != null && inMin > 0 ? inMin : null,
      ...(sameAs && plan ? { counted_toward: plan.name } : {}),
      reminder_title: body.name_in_reminder === true ? `${label}: OK by ${whose} schedule` : "Medicine",
      entry: { id: `c${entry.id}` },
    });
  } catch (error) {
    const res = await careErrorResponse("POST /api/maple/quick", error);
    const b = (await res.clone().json().catch(() => ({}))) as { error?: string };
    const speak = res.status >= 500 ? "Sorry, Maple's log didn't save that. Try the app." : b.error ?? "Sorry, that didn't work.";
    return json({ error: b.error ?? "Something went wrong", speak, ...(res.status === 403 || res.status === 404 ? { help_now: MOM_HELP.now } : {}) }, res.status);
  }
}
