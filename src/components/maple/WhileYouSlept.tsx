"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { isVitaminD } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatDuration, formatTime, localParts } from "@/lib/maple/time";
import { photoUrl } from "./EntryRow";
import { Icon, type IconName } from "./icons";
import { SIDE_NAME } from "./TimerCard";
import { Avatar, Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The hand-off card for the parent who just woke up (or got back from work):
 * everything logged since their last visit, in one paragraph, so they don't
 * have to rebuild the night from the timeline. Shown after a 3h+ gap, until
 * "Got it".
 */

const GAP_MS = 3 * 3600_000;
const KEY = "maple-wys-dismissed";

function overlapsNight(from: number, to: number, tz: string): boolean {
  for (let t = from; t <= to; t += 30 * 60_000) {
    const h = localParts(t, tz).hour;
    if (h >= 22 || h < 6) return true;
  }
  return false;
}

export default function WhileYouSlept() {
  const { state, summary, seenAt, memberName, member, now } = useMaple();
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(KEY));
    } catch {
      // storage blocked
    }
  }, []);
  if (!state || !summary || !seenAt || dismissed === seenAt) return null;

  const tz = state.baby.timezone ?? DEFAULT_TZ;
  const since = Date.parse(seenAt);
  const nowMs = now().getTime();
  if (!Number.isFinite(since) || nowMs - since < GAP_MS) return null;

  // What the others logged while they were away (plus a nap that's still going); not what they just logged themselves.
  const fresh = state.entries.filter(
    (e) => e.id > 0 && e.created_by !== state.me.email && (Date.parse(e.started_at) >= since || (e.active && e.kind === "sleep"))
  );
  if (!fresh.length) return null;

  const feeds = fresh.filter((e) => e.kind === "feed").sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const diapers = fresh.filter((e) => e.kind === "diaper");
  const wet = diapers.filter((e) => e.kind === "diaper" && e.data.pee).length;
  const dirty = diapers.filter((e) => e.kind === "diaper" && e.data.poop).length;
  const sleeps = fresh.filter((e) => e.kind === "sleep").sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const done = sleeps
    .filter((e) => !e.active && e.ended_at)
    .map((e) => formatDuration(Math.max(60, (Date.parse(e.ended_at!) - Date.parse(e.started_at)) / 1000)));
  const vitD = fresh.some((e) => e.kind === "med" && isVitaminD(e.data.name));
  const moments = fresh.filter((e) => e.kind === "moment");
  const photo = moments.find((e) => e.kind === "moment" && e.data.photos?.length);
  const who = [...new Set(fresh.map((e) => e.created_by).filter((x): x is string => !!x))];

  // One short line per kind of thing, so the night reads at a glance.
  const bits: { icon: IconName; text: string }[] = [];
  if (feeds.length) {
    const next = summary.nextSide && !summary.active.some((e) => e.kind === "feed") ? `, ${SIDE_NAME[summary.nextSide]} next` : "";
    bits.push({ icon: "baby", text: `${feeds.length} feed${feeds.length === 1 ? "" : "s"} (last ${formatTime(feeds[0].started_at, tz)}${next})` });
  }
  if (diapers.length) {
    const parts = [wet && `${wet} wet`, dirty && `${dirty} dirty`].filter(Boolean).join(", ");
    bits.push({ icon: "diaper", text: `${diapers.length} diaper${diapers.length === 1 ? "" : "s"}${parts ? ` (${parts})` : ""}` });
  }
  const napping = sleeps.some((e) => e.active);
  if (done.length > 3) {
    // A long shift: total and longest, not a list of every stretch.
    const secs = sleeps.filter((e) => !e.active && e.ended_at).map((e) => (Date.parse(e.ended_at!) - Date.parse(e.started_at)) / 1000);
    const total = secs.reduce((a, b) => a + b, 0);
    bits.push({
      icon: "moon",
      text: `Slept ${formatDuration(total)} in ${secs.length} stretches (longest ${formatDuration(Math.max(...secs))})${napping ? " + asleep now" : ""}`,
    });
  } else if (done.length || napping) {
    bits.push({ icon: "moon", text: done.length ? `Slept ${done.join(" + ")}${napping ? " + asleep now" : ""}` : "Asleep now" });
  }
  if (vitD) bits.push({ icon: "sun", text: "Vitamin D given" });

  const extra: string[] = [];
  const urgent = summary.alerts.filter((a) => a.tier === "emergency" || a.tier === "now" || a.tier === "today");
  if (urgent.length) extra.push(`${urgent.length} alert${urgent.length === 1 ? "" : "s"} to look at below`);
  const reached = summary.celebrations.filter((c) => Date.parse(c.reachedAt) >= since);
  if (reached.length) extra.push(reached.map((c) => c.title).join(" · "));
  if (moments.length) extra.push(`${moments.length} new moment${moments.length === 1 ? "" : "s"}`);

  const overnight = overlapsNight(since, nowMs, tz);
  // Keep "9:12 AM" together when the title wraps.
  const title = overnight ? (
    "While you slept"
  ) : (
    <>
      Since you checked in at <span className="whitespace-nowrap">{formatTime(since, tz)}</span>
    </>
  );
  const gotIt = () => {
    setDismissed(seenAt);
    try {
      localStorage.setItem(KEY, seenAt);
    } catch {
      // storage blocked: hidden until reload
    }
  };

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} aria-labelledby="wys" className={cx(tone.card, "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <h2 id="wys" className={cx(tone.heading, "flex min-w-0 items-center gap-2 text-[17px] leading-snug")}>
          <Icon name={overnight ? "moon-star" : "history"} size={19} className="shrink-0 text-mp-ink-2" />
          <span className="min-w-0">{title}</span>
        </h2>
        <div role="img" className="flex shrink-0 -space-x-1.5" aria-label={`Logged by ${who.map((w) => memberName(w)).join(", ")}`}>
          {who.slice(0, 4).map((w) => (
            <span key={w} title={memberName(w)} className="rounded-full ring-2 ring-mp-surface">
              <Avatar member={member(w) ?? { email: w, display_name: memberName(w), role: "member", emoji: null, color: null }} size={26} />
            </span>
          ))}
        </div>
      </div>
      {bits.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {bits.map((b) => (
            <li key={b.icon} className="flex items-start gap-2.5 text-[15px] leading-snug text-mp-ink">
              <Icon name={b.icon} size={17} className="mt-0.5 shrink-0 text-mp-ink-3" />
              {b.text}
            </li>
          ))}
        </ul>
      )}
      {(extra.length > 0 || photo) && (
        <div className="mt-3 flex items-center gap-2.5">
          {photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(photo.id, 0)} alt="" className="h-10 w-10 shrink-0 rounded-[10px] object-cover [.maple-night_&]:brightness-[.55] [.maple-night_&]:saturate-[.8]" />
          )}
          <p className="text-sm text-mp-ink-2">{extra.join(" · ")}</p>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="soft" onClick={gotIt}>
          Got it
        </Button>
      </div>
    </motion.section>
  );
}
