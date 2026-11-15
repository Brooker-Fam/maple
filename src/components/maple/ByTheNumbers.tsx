"use client";

import type { ReactNode } from "react";
import { DEFAULT_TZ, babyAge } from "@/lib/maple/time";
import { useExtrasOn } from "./extras";
import { useBabyWords } from "./familyWords";
import { useNightActive } from "./nightLook";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * By the numbers, at the end of History → Patterns: a few lifetime fun stats
 * from what the app already has, the server's lifetime counts (state.lifetime:
 * every diaper and finished feed logged) and the baby's age from the birth
 * time, in the family's timezone. A number worked out from a guess says so
 * ("At about 2 minutes a change, that's roughly 11 hours of diaper duty").
 * Counts only: never an average, a score or a comparison. It's whimsy, so it
 * follows this phone's "Fun facts and cheers" switch and stays away at night
 * (8 PM to 7 AM, or the night look on), like the diaper brigade; never before
 * birth, for a photos-only guest, or while the numbers are too small to be fun.
 */

/** Under this many diapers logged, the numbers are too small to be fun. */
export const NUMBERS_FROM_DIAPERS = 20;
/** The guess behind diaper duty, said on the card. */
export const MINUTES_A_CHANGE = 2;

export type LifetimeNumbers = { days: number; hours: number; diapers: number; feeds: number; dutyMinutes: number };

/** What the card counts, or null when it has nothing fun to say yet: no birth time, a birth still to come, or too few diapers. */
export function lifetimeNumbers(o: { bornAt: string | null | undefined; now: Date; tz: string; diapers: number; feeds: number }): LifetimeNumbers | null {
  const born = o.bornAt ? Date.parse(o.bornAt) : NaN;
  if (!Number.isFinite(born) || o.now.getTime() < born) return null;
  const diapers = Math.max(0, Math.floor(o.diapers || 0));
  if (diapers < NUMBERS_FROM_DIAPERS) return null;
  const age = babyAge(o.bornAt!, o.now, o.tz);
  return { days: age.days, hours: Math.floor(age.ms / 3_600_000), diapers, feeds: Math.max(0, Math.floor(o.feeds || 0)), dutyMinutes: diapers * MINUTES_A_CHANGE };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

/** Diaper duty in words: "40 minutes" under an hour, then "an hour", "11 hours". */
export function dutyWords(minutes: number): string {
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : plural(hours, "hour");
}

/** A number and its word, as the diaper brigade sets them. */
const Num = ({ children }: { children: ReactNode }) => <span className="font-semibold text-mp-ink tabular-nums">{children}</span>;

export default function ByTheNumbers() {
  const { state, isNight } = useMaple();
  const w = useBabyWords();
  const nightLook = useNightActive();
  const [extrasOn] = useExtrasOn();
  // A minute's clock, so the hours keep up and the card goes at 8 PM.
  const now = useNow(60_000);
  if (!state || state.me.role === "photos" || !extrasOn || nightLook || isNight()) return null;
  const n = lifetimeNumbers({
    bornAt: state.baby.born_at,
    now,
    tz: state.baby.timezone ?? DEFAULT_TZ,
    diapers: state.lifetime?.diapers ?? 0,
    feeds: state.lifetime?.feeds ?? 0,
  });
  if (!n) return null;
  // Without a birth time (only the day), the hours are near enough, not exact.
  const about = state.baby.settings.birth_time_approx === true ? "about " : "";

  return (
    <section aria-labelledby="maple-numbers" className={cx(tone.card, "mt-3 mb-4 px-4 py-3.5")}>
      <h2 id="maple-numbers" className={cx(tone.heading, "text-[15px]")}>
        By the numbers
      </h2>
      <div className="mt-1.5 space-y-1 text-[14px] leading-snug text-balance text-mp-ink-2">
        <p>
          <Num>{plural(n.days, "day")}</Num>
          {` old. That's ${about}`}
          <Num>{plural(n.hours, "hour")}</Num>
          {` of ${w.name}.`}
        </p>
        <p>
          {n.feeds > 0 && (
            <>
              <Num>{plural(n.feeds, "feed")}</Num>
              {" and "}
            </>
          )}
          <Num>{plural(n.diapers, "diaper")}</Num>
          {" logged."}
        </p>
        <p>
          {`At about ${MINUTES_A_CHANGE} minutes a change, that's roughly `}
          <Num>{dutyWords(n.dutyMinutes)}</Num>
          {" of diaper duty."}
        </p>
      </div>
    </section>
  );
}
