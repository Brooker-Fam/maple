import { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/maple/api";
import { listMembers, memberFor } from "@/lib/maple/auth";
import { describeEntry } from "@/lib/maple/describe";
import { TIER_LABEL, VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { summarize } from "@/lib/maple/insights";
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
import type { Entry, FeedData } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

/**
 * Hands-free logging for iOS Shortcuts ("Hey Siri, Maple pee"), the Action
 * Button or Back Tap. Auth: `Authorization: Bearer maple_…` (a personal token
 * from Family → Hands-free). Body: { action, amount_oz?, client_id? }.
 * Answers { speak } — one sentence for the Shortcut's "Speak Text".
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

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; amount_oz?: unknown; client_id?: unknown };
    const action = body.action as Action;
    if (!ACTIONS.includes(action)) {
      return json({ error: `action must be one of ${ACTIONS.join(", ")}`, speak: "I didn't catch what to log." }, 400);
    }
    if (me.role === "viewer" && action !== "status") {
      return json({ error: "View-only", speak: "You have view-only access to Maple's log." }, 403);
    }

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
        if (runningSleep) await stopTimer(runningSleep.id, now, me.email);
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
        entry = await switchSide(runningFeed.id, to, now, me.email);
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
        entry = await stopTimer(target.id, now, me.email);
        speak = `Stopped. ${describeEntry(entry, { now }).text}.`;
        break;
      }
      case "sleep": {
        if (runningFeed) await stopTimer(runningFeed.id, now, me.email);
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
