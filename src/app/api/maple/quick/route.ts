import { NextRequest } from "next/server";
import { careErrorResponse, errorResponse, json } from "@/lib/maple/api";
import { listMembers, memberFor } from "@/lib/maple/auth";
import { careTime, countedAs, matchPlan } from "@/lib/maple/care";
import { spokenLine } from "@/lib/maple/care-mcp";
import { carePersonName, carePlanViews, careSession, logCareDose } from "@/lib/maple/care-store";
import { describeEntry } from "@/lib/maple/describe";
import { staleFeed } from "@/lib/maple/feed";
import { LABEL_NOT_WHILE_NURSING, MOM_HELP, TIER_LABEL, VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { memberName, summarize } from "@/lib/maple/insights";
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
import { ozToMl } from "@/lib/maple/units";
import type { Entry, FeedData, Member } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

/**
 * Hands-free logging for iOS Shortcuts ("Hey Siri, Maple pee"), the Action
 * Button or Back Tap. Auth: `Authorization: Bearer maple_…` (a personal token
 * from Family → Hands-free). Body: { action, amount_oz?, client_id? }.
 * Answers { speak } — one sentence for the Shortcut's "Speak Text".
 *
 * Mom's medicines ride the same URL (one "Mom meds" Shortcut for every plan,
 * any phone): mom_status lists her plans as { id, label } for Choose from
 * List, and mom_dose { med, minutes_ago?, skipped?, units?, confirm?,
 * client_id? } logs one, like Maple's own actions: it saves (a name that
 * isn't on her list as a one-time medicine), and early or over her limit
 * is said after. Only a likely duplicate (the same medicine within 30
 * minutes) answers ok:false with needs_confirm and a question to speak.
 */

const ACTIONS = [
  "pee",
  "poop",
  "both",
  "nurse_left",
  "nurse_right",
  "switch",
  "stop",
  "sleep",
  "wake",
  "vitamin_d",
  "bottle",
  "status",
  "mom_status",
  "mom_dose",
] as const;
type Action = (typeof ACTIONS)[number];

const side = (s: "L" | "R") => (s === "L" ? "left" : "right");

function ago(min: number): string {
  if (min < 1) return "just now";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const parts = [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} minute${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `${parts.join(" ")} ago`;
}

export async function POST(request: NextRequest) {
  try {
    const auth = request.headers.get("authorization") ?? "";
    const memberId = auth.startsWith("Bearer ") ? await memberForPersonalToken(auth.slice(7).trim()) : null;
    const me = memberId ? await memberFor(memberId) : null;
    if (!me) return json({ error: "Unknown or revoked token", speak: "That shortcut isn't connected to Maple's log anymore." }, 401);

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; amount_oz?: unknown; client_id?: unknown } & MomBody;
    const action = body.action as Action;
    if (!ACTIONS.includes(action)) {
      return json({ error: `action must be one of ${ACTIONS.join(", ")}`, speak: "I didn't catch what to log." }, 400);
    }
    const mom = action === "mom_status" || action === "mom_dose";
    if (me.role === "viewer" && action !== "status") {
      return json({ error: "View-only", speak: "You have view-only access to Maple's log.", ...(mom ? { help_now: MOM_HELP.now } : {}) }, 403);
    }
    if (mom) return momAction(action, me, body);

    const baby = await getBaby();
    const tz = baby.timezone;
    const now = new Date();
    const base = { babyId: baby.id, createdBy: me.email, source: "shortcut" as const };
    const clientId = typeof body.client_id === "string" ? `shortcut:${body.client_id}` : null;
    const running = await activeTimers(baby.id);
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
        ({ entry } = await createEntryOnce({ ...base, kind: "diaper", startedAt: now, data, clientId }));
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
        if (runningSleep) await stopTimer(runningSleep.id, undefined, me.email);
        ({ entry } = await startTimer({ ...base, kind: "feed", side: s, at: now, clientId }));
        speak = `Nursing timer running on the ${side(s)}.`;
        break;
      }
      case "switch": {
        if (!runningFeed) {
          speak = "No nursing timer is running.";
          break;
        }
        const d = runningFeed.data as FeedData;
        const to = d.last_side === "L" ? "R" : "L";
        entry = (await switchSide(runningFeed.id, to, undefined, me.email)).entry;
        speak = `Switched to the ${side(to)}.`;
        break;
      }
      case "stop":
      case "wake": {
        const target = action === "wake" ? runningSleep : runningFeed ?? runningSleep ?? running[0];
        if (!target) {
          speak = action === "wake" ? "No sleep timer is running." : "No timer is running.";
          break;
        }
        // No time: "now" under the stop rule (a paused feed ends at its pause).
        entry = await stopTimer(target.id, undefined, me.email);
        speak = `Stopped. ${describeEntry(entry, { now }).text}.`;
        break;
      }
      case "sleep": {
        if (runningFeed) await stopTimer(runningFeed.id, undefined, me.email);
        ({ entry } = await startTimer({ ...base, kind: "sleep", at: now, clientId }));
        speak = runningFeed ? "Feed stopped and sleep timer started. Sweet dreams, Maple." : "Sleep timer started. Sweet dreams, Maple.";
        break;
      }
      case "vitamin_d": {
        ({ entry } = await createEntryOnce({ ...base, kind: "med", startedAt: now, data: VITAMIN_D_DEFAULT, clientId }));
        speak = `Vitamin D logged at ${at}.`;
        break;
      }
      case "bottle": {
        const oz = Number(body.amount_oz);
        const data = Number.isFinite(oz) && oz > 0 && oz <= 12 ? { method: "bottle", amount_ml: Math.round(ozToMl(oz)) } : { method: "bottle" };
        ({ entry } = await createEntryOnce({ ...base, kind: "feed", startedAt: now, data, clientId }));
        speak = `Logged a ${"amount_ml" in data ? `${oz} ounce ` : ""}bottle at ${at}.`;
        break;
      }
      case "status": {
        const [entries, growth, members, lifetime] = await Promise.all([
          listEntries({ babyId: baby.id, from: new Date(now.getTime() - 72 * 3600_000), includeActive: true }),
          listEntries({ babyId: baby.id, kinds: ["growth"], ascending: true }),
          listMembers(),
          lifetimeCounts(baby.id),
        ]);
        const s = summarize({ entries, growth, baby, members, now, lifetime });
        const bits: string[] = [];
        const nursing = s.active.find((e) => e.kind === "feed");
        if (nursing) {
          const d = nursing.data as FeedData;
          const mins = Math.round((now.getTime() - Date.parse(nursing.started_at)) / 60000);
          bits.push(`${baby.nickname || baby.name} is nursing now${d.last_side ? ` on the ${side(d.last_side)}` : ""}, ${mins} minute${mins === 1 ? "" : "s"} in.`);
        } else if (s.lastFeed && s.minutesSinceFeed != null) {
          const first = s.lastFeed.data.first_side;
          bits.push(
            `${baby.nickname || baby.name} last ate ${ago(s.minutesSinceFeed)}${first ? `, starting on the ${side(first)}` : ""}${s.nextSide ? `, so start on the ${side(s.nextSide)} next` : ""}.`
          );
        } else bits.push("No feeds logged yet.");
        bits.push(`${s.last24h.wet} wet and ${s.last24h.dirty} dirty diapers in the last 24 hours.`);
        const others = s.active.filter((e) => e.kind !== "feed");
        if (others.length) bits.push(`A ${others.map((e) => (e.kind === "tummy" ? "tummy time" : e.kind)).join(" and ")} timer is running.`);
        if (s.vitaminD) bits.push("Vitamin D is done today.");
        const urgent = s.alerts.find((a) => a.tier === "emergency" || a.tier === "now" || a.tier === "today");
        // Say who to call, not just what happened ("Call your pediatrician now: No wet diaper in 8 hours.").
        if (urgent) bits.push(`${TIER_LABEL[urgent.tier]}: ${urgent.title.replace(/[.:]?$/, "")}.`);
        speak = bits.join(" ");
        break;
      }
    }

    return json({ speak, entry: entry ? toClientEntry(entry) : null });
  } catch (error) {
    const res = await errorResponse("POST /api/maple/quick", error);
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    return json({ error: body.error ?? "Something went wrong", speak: "Sorry, Maple's log didn't save that. Try the app." }, res.status);
  }
}

// ── Mom's medicines (§10.5) ──────────────────────────────────────────────

type MomBody = { med?: unknown; minutes_ago?: unknown; skipped?: unknown; units?: unknown; confirm?: unknown; name_in_reminder?: unknown; client_id?: unknown };

/** "3:02", "9:02 tomorrow": a clock time to say, without AM/PM (the Shortcut's speech is short). */
const sayTime = (iso: string, now: Date, tz: string) => careTime(iso, now, tz).replace(/ (AM|PM)\b/, "");

const andList = (names: string[]) => (names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** mom_status / mom_dose: her token reads "your", anyone she shares with "Brittany's". Errors are scrubbed (careErrorResponse). */
async function momAction(action: "mom_status" | "mom_dose", me: Member, body: MomBody): Promise<Response> {
  try {
    const [baby, members] = await Promise.all([getBaby(), listMembers()]);
    // A personal token is its member's own phone: never the admin path.
    const s = await careSession({ id: me.email, role: me.role, viaAdmin: false, channel: "siri" }, { members, baby });
    const help = { help_now: MOM_HELP.now };
    const name = carePersonName(s.person!, members);
    if (!s.access.read || !s.access.write) return json({ error: "Not shared", speak: `You can't change ${name}'s medicines from this account.`, ...help }, 403);
    const self = s.access.self;
    const whose = self ? "your" : "her";
    const views = await carePlanViews(s);
    const plans = views.map((v) => ({ id: `p${v.plan.id}`, label: v.line }));
    const { now, tz } = s;

    if (action === "mom_status") {
      const speak = views.length ? `${views.slice(0, 3).map((v) => spokenLine(v, now, tz)).join(". ")}.` : `There are no medicines on ${whose} list yet.`;
      return json({ ok: true, speak, plans });
    }

    const med = typeof body.med === "string" ? body.med.trim() : "";
    if (!med) return json({ ok: false, not_found: true, speak: "Which medicine?", plans });
    const m = matchPlan(med, views.map((v) => v.plan), { includePrivate: true });
    if (m.kind === "ambiguous") {
      return json({ ok: false, not_found: true, speak: `Which one: ${andList(m.plans.map((p) => p.name)).replace(/ and ([^,]*)$/, " or $1")}?`, plans: m.plans.map((p) => ({ id: `p${p.id}`, label: views.find((v) => v.plan.id === p.id)!.line })) });
    }
    // On her list it counts toward that plan; any other name is saved as a one-time medicine, like Maple's log.
    const plan = m.kind === "match" ? m.plan : null;
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
    else bits.push(`Got it, ${said} at ${sayTime(entry.at, now, tz)}.`);
    // "Next one's OK after" only on a gap; As needed with none set, Each day and set times say nothing more.
    const next = plan && st && st.nextOkAt && plan.schedule.type !== "daily" && plan.schedule.type !== "times" && st.state !== "unknown" ? st.nextOkAt : null;
    if (next && !res.deduped) bits.push(`Next one's OK after ${sayTime(next, now, tz)}.`);
    if (!plan && !res.deduped) bits.push(`It isn't on ${whose} list, so it's saved as a one-time medicine.`);
    const counted = plan && res.created && entry.kind === "dose" && !entry.data.skipped ? countedAs(plan, entry.data.units) : null;
    if (counted) bits.push(`Counted as ${counted}.`);
    // An early or over-the-limit dose still saves: that note's own words.
    for (const n of res.notes) if (n.tier === "nudge" || n.label === "Call Poison Help now") bits.push(`${n.title}. ${n.body}`);
    // Hands-free at 3am is when she's least likely to open the card, so the nursing note is said too, with its label.
    for (const n of res.notes) if (n.label === LABEL_NOT_WHILE_NURSING.label) bits.push(`${n.label}: ${n.title}. ${n.body}`);
    return json({
      ok: true,
      speak: bits.join(" "),
      next_ok_at: next,
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
