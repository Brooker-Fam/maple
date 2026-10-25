"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { nursingRuns } from "@/lib/maple/feed";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import { isVitaminD } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatDuration, formatTime, localParts } from "@/lib/maple/time";
import { photoUrl } from "./EntryRow";
import { SIDE_NAME } from "./TimerCard";
import { Icon } from "./icons";
import { Avatar, Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The hand-off for the parent who just woke up (or got back from work):
 * everything logged since their last visit. On Today it's one line under
 * "Right now" that keeps the key facts in view ("While you slept · 1 feed ·
 * 2 wet · a nap · by Matt"), so it never pushes the 3am answers down; a tap
 * opens the few sentences the other parent would leave on the counter ("5
 * feeds, the last at 12:05 PM. Left is next."), signed by whoever logged it,
 * with "Got it". Shown after a 3h+ gap, until "Got it".
 */

const GAP_MS = 3 * 3600_000;
const KEY = "maple-wys-dismissed";

const plural = (n: number) => (n === 1 ? "" : "s");

/** "1h 30m", "1h 30m and 1h 45m", "1h 30m, 1h 45m and 1h 03m". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

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
  const [open, setOpen] = useState(false);
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

  // Finished feeds as the family counts them (nursingRuns: Done and a side again under 10 minutes apart is one feed,
  // as on Today's tally and in Claude's recap), plus each bottle; one still going is "Nursing now", not counted as done.
  const done = fresh.filter((e) => e.kind === "feed" && !e.active);
  const feedStarts = [
    ...nursingRuns(done, now())
      .filter((r) => r.start >= since)
      .map((r) => r.start),
    ...done.filter((e) => e.kind === "feed" && e.data.method === "bottle").map((e) => Date.parse(e.started_at)),
  ].sort((a, b) => b - a);
  const nursing = fresh.find((e) => e.kind === "feed" && e.active);
  const diapers = fresh.filter((e) => e.kind === "diaper").sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const wet = diapers.filter((e) => e.kind === "diaper" && e.data.pee).length;
  const dirty = diapers.filter((e) => e.kind === "diaper" && e.data.poop);
  const sleeps = fresh.filter((e) => e.kind === "sleep").sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  const slept = sleeps.filter((e) => !e.active && e.ended_at).map((e) => Math.max(60, (Date.parse(e.ended_at!) - Date.parse(e.started_at)) / 1000));
  const napping = sleeps.some((e) => e.active);
  const vitD = fresh.some((e) => e.kind === "med" && isVitaminD(e.data.name));
  const moments = fresh.filter((e) => e.kind === "moment");
  const photo = moments.find((e) => e.kind === "moment" && e.data.photos?.length);
  const who = [...new Set(fresh.map((e) => e.created_by).filter((x): x is string => !!x))];

  // The note she'd leave: one short sentence per kind of thing, so the night reads at a glance.
  const lines: string[] = [];
  if (feedStarts.length) {
    const next = summary.nextSide && !summary.active.some((e) => e.kind === "feed") ? ` ${SIDE_NAME[summary.nextSide]} is next.` : "";
    const last = formatTime(feedStarts[0], tz);
    lines.push(`${feedStarts.length === 1 ? `1 feed, at ${last}` : `${feedStarts.length} feeds, the last at ${last}`}.${next}`);
  }
  if (nursing) lines.push(`Nursing now, since ${formatTime(nursing.started_at, tz)}.`);
  if (diapers.length) {
    // Count diapers once (a wet + dirty one is one diaper), and say the color of the latest poop.
    const latest = dirty[0];
    const color = latest?.kind === "diaper" && latest.data.color ? STOOL_COLOR_INFO[latest.data.color].label.toLowerCase() : null;
    const n = diapers.length;
    if (!dirty.length) lines.push(wet === n ? `${n} wet diaper${plural(n)}.` : `${n} diaper${plural(n)}${wet ? `, ${wet} wet` : ""}.`);
    else if (dirty.length === 1) lines.push(`${n} diaper${plural(n)}, ${n === 1 ? "with" : "1 with"} poop${color ? ` (${color})` : ""}.`);
    else lines.push(`${n} diapers, ${dirty.length === n ? "all" : dirty.length} with poop${color ? `, the last ${color}` : ""}.`);
  }
  if (slept.length > 3) {
    // A long shift: total and longest, not a list of every stretch.
    const total = slept.reduce((a, b) => a + b, 0);
    lines.push(`Slept ${formatDuration(total)} in ${slept.length} stretches, longest ${formatDuration(Math.max(...slept))}.${napping ? " Asleep now." : ""}`);
  } else if (slept.length) {
    const naps = listed(slept.map(formatDuration));
    lines.push(`${slept.length === 1 ? `A nap of ${naps}` : `Naps of ${naps}`}.${napping ? " Asleep now." : ""}`);
  } else if (napping) {
    lines.push("Asleep now.");
  }
  if (vitD) lines.push("Vitamin D given.");

  const extra: string[] = [];
  const urgent = summary.alerts.filter((a) => a.tier === "emergency" || a.tier === "now" || a.tier === "today");
  if (urgent.length) extra.push(`${urgent.length} alert${urgent.length === 1 ? "" : "s"} to look at below`);
  const reached = summary.celebrations.filter((c) => Date.parse(c.reachedAt) >= since);
  if (reached.length) extra.push(reached.map((c) => c.title).join(" · "));
  if (moments.length) extra.push(`${moments.length} new moment${moments.length === 1 ? "" : "s"}`);

  // The line: a few counts, then who.
  const facts: string[] = [];
  if (feedStarts.length) facts.push(`${feedStarts.length} feed${plural(feedStarts.length)}`);
  if (nursing) facts.push("nursing now");
  if (wet) facts.push(`${wet} wet`);
  if (dirty.length) facts.push(`${dirty.length} dirty`);
  if (slept.length) facts.push(slept.length === 1 ? "a nap" : `${slept.length} naps`);
  if (napping) facts.push("asleep now");
  if (vitD) facts.push("vitamin D");
  if (!facts.length && moments.length) facts.push(`${moments.length} new moment${plural(moments.length)}`);
  const names = who.map((w) => memberName(w).split(" ")[0]);
  const by = names.length ? `by ${names.length < 3 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and more`}` : null;

  const overnight = overlapsNight(since, nowMs, tz);
  const lead = overnight ? "While you slept" : `Since ${formatTime(since, tz)}`;
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
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      aria-labelledby="wys"
      className={cx(tone.card, "overflow-hidden")}
    >
      <button
        type="button"
        onClick={(ev) => {
          // Opened on a short phone, the sentences land under the dock (or, read-only, the tab bar): bring them up into
          // view. Measured from the top of whichever sits lowest on the page's bottom edge, safe area and all.
          const sec = ev.currentTarget.closest("section");
          if (!open && sec)
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const cover = document.querySelector('[aria-label="Log something"]') ?? document.querySelector(`nav[aria-label="Maple's Log"]`);
                const bottom = cover ? cover.getBoundingClientRect().top : window.innerHeight;
                const over = sec.getBoundingClientRect().bottom - (bottom - 16);
                if (over > 0) window.scrollBy({ top: over, behavior: "smooth" });
              })
            );
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls="wys-more"
        className={cx(tone.row, "min-h-[52px] py-2")}
      >
        <Icon name={overnight ? "moon" : "history"} size={20} className="shrink-0 text-mp-ink-2" />
        <span id="wys" className="min-w-0 flex-1 truncate text-[15px] text-mp-ink">
          <span className="font-semibold">{lead}</span>
          {[...facts, ...(by ? [by] : [])].map((f) => (
            <span key={f} className="text-mp-ink-2">
              {" · "}
              {f}
            </span>
          ))}
        </span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div id="wys-more" className="border-t border-mp-line px-4 pt-3 pb-4">
          {/* The line above already says "While you slept"; the daytime one says when ("Since you checked in at 9:12 AM"). */}
          {!overnight && <h3 className={cx(tone.heading, "mb-2 text-[17px] leading-snug")}>{title}</h3>}
          {lines.length > 0 && (
            <div className="space-y-0.5">
              {lines.map((l) => (
                <p key={l} className="text-[15px] leading-snug text-mp-ink">
                  {l}
                </p>
              ))}
            </div>
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
          <div className="mt-3 flex items-center justify-between gap-3">
            {/* Signed, like a note: each person's initial disc and name ("Brittany", "Brittany and Grandma"). */}
            <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-mp-ink-2">
              {who.map((w, i) => (
                <span key={w} className="inline-flex items-center gap-1.5">
                  <Avatar member={member(w) ?? { email: w, display_name: memberName(w), role: "member", emoji: null, color: null }} size={18} />
                  <span>
                    {memberName(w)}
                    {i < who.length - 2 && ","}
                  </span>
                  {i === who.length - 2 && <span>and</span>}
                </span>
              ))}
            </p>
            <Button variant="soft" className="shrink-0" onClick={gotIt}>
              Got it
            </Button>
          </div>
        </div>
      )}
    </motion.section>
  );
}
