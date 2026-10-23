"use client";

import { DEFAULT_TZ, localParts } from "@/lib/maple/time";
import { useNightActive } from "./nightLook";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Today's hero: a maple sapling that grows a leaf for every week of Maple's
 * life and follows the real seasons (rust in October, bare with fairy lights
 * in winter, buds in spring, green in summer, red again on her birthday).
 * It stands still (no ambient motion); `sway` is there for a page that wants it.
 * Zoe naps at its roots at night and pricks up an ear while a timer runs.
 */

/** A small maple leaf, centered on 0,0, about 20 units tall (stem at the bottom). */
export const MAPLE_LEAF_PATH =
  "M0,-10 L1.9,-5.6 L5.6,-7.4 L4.7,-2.8 L9.6,-3.6 L6.8,0 L8.6,2 L3,1.8 L3.8,5.6 L0.9,3.8 L0.6,9 L-0.6,9 L-0.9,3.8 L-3.8,5.6 L-3,1.8 L-8.6,2 L-6.8,0 L-9.6,-3.6 L-4.7,-2.8 L-5.6,-7.4 L-1.9,-5.6 Z";

const AUTUMN = ["#B5452B", "#D9772B", "#E0A93B", "#C49A3C", "#C2552F"];
const SUMMER = ["#5C7A4A", "#6B8448", "#7FA05A", "#4E6E3E"];
const EARLY_FALL = ["#7FA05A", "#E0A93B", "#6B8448", "#D9772B"];
const BIRTHDAY = ["#B5452B", "#C2302A", "#D24A35", "#A83A28"];

type Season = "autumn" | "winter" | "spring" | "summer" | "early-fall" | "birthday";

function seasonFor(month: number, birthday: boolean): Season {
  if (birthday) return "birthday";
  if (month === 10 || month === 11) return "autumn";
  if (month === 12 || month <= 2) return "winter";
  if (month <= 4) return "spring";
  if (month <= 8) return "summer";
  return "early-fall";
}

// Branches sprout as the tree fills in (from = leaves needed).
const BRANCHES = [
  { d: "M51,60 C58,54 66,47 74,40", w: 2.2, from: 2 },
  { d: "M51,72 C44,66 36,60 28,50", w: 2.2, from: 3 },
  { d: "M50,44 C55,39 58,34 61,29", w: 1.6, from: 4 },
  { d: "M50,40 C46,38 41,35 37,33", w: 1.6, from: 5 },
  { d: "M51,64 C56,60 62,56 66,51", w: 1.4, from: 6 },
  { d: "M50,80 C45,74 39,68 33,61", w: 1.4, from: 7 },
];

// Where leaves sit, in growth order: branch tips first, then filling the crown.
const ANCHORS: [number, number, number][] = [
  [49, 19, -6],
  [74, 39, 42],
  [27, 49, -48],
  [61, 28, 22],
  [37, 33, -28],
  [66, 51, 60],
  [33, 61, -66],
  [55, 13, 8],
  [42, 22, -14],
  [79, 49, 70],
  [21, 41, -40],
  [70, 30, 34],
];

function leafSpots(n: number): [number, number, number][] {
  const out = ANCHORS.slice(0, n);
  // Beyond the anchors, fill the crown on a sunflower spiral so it stays even.
  for (let i = out.length; i < n; i++) {
    const k = i - ANCHORS.length + 4;
    const a = k * 2.39996;
    const r = 4.3 * Math.sqrt(k);
    out.push([50 + Math.cos(a) * r * 1.25, 36 + Math.sin(a) * r, (a * 180) / Math.PI]);
  }
  return out;
}

export function Sapling({
  leaves,
  season,
  gnome,
  sway,
  className,
}: {
  /** One per week of age (capped at 52); the tree also grows taller over her first two months. */
  leaves: number;
  season: Season;
  gnome?: boolean;
  sway?: boolean;
  className?: string;
}) {
  const spots = leafSpots(Math.max(0, Math.min(52, leaves)));
  const palette = season === "summer" ? SUMMER : season === "early-fall" ? EARLY_FALL : season === "birthday" ? BIRTHDAY : AUTUMN;
  const size = leaves <= 2 ? 1.55 : leaves <= 8 ? 1.05 : leaves <= 20 ? 0.8 : 0.62;
  const bare = season === "winter";
  const grow = 0.64 + 0.36 * Math.min(1, leaves / 9);
  return (
    <svg viewBox="0 0 100 110" className={className} aria-hidden>
      {/* ground */}
      <path d="M2,102 C22,94 78,94 98,102 L98,110 L2,110 Z" className="fill-[#5C7A4A]/25 dark:fill-[#A9C08F]/15" />
      {bare && <path d="M10,101 C28,95 72,95 90,101 C70,99 30,99 10,101 Z" fill="#F5F7F2" opacity="0.9" />}
      <g transform={`translate(50 100) scale(${grow}) translate(-50 -100)`}>
        <g
          className={cx(sway && "animate-gentle-sway motion-reduce:animate-none [.maple-night_&]:animate-none")}
          style={{ transformOrigin: "50% 100%", transformBox: "fill-box", animationDuration: "6s" }}
        >
          {/* trunk, then branches that appear as the leaves come in */}
          <g fill="none" stroke="#7A5230" strokeLinecap="round" className="dark:stroke-[#B08A62]">
            <path d="M50,100 C51,84 48,70 51,56 C53,46 50,34 49,20" strokeWidth="3.6" />
            {BRANCHES.filter((b) => bare || leaves >= b.from).map((b) => (
              <path key={b.d} d={b.d} strokeWidth={b.w} />
            ))}
          </g>
          {/* a newborn sapling gets two little seed leaves near the top */}
          {!bare && leaves < 3 && (
            <g fill="#86A85E" stroke="#5C7A4A" strokeWidth="0.8">
              <path d="M50,47 C43,38 33,39 29,45 C35,52 45,52 50,47 Z" />
              <path d="M51,58 C58,49 68,50 72,56 C66,63 56,63 51,58 Z" />
            </g>
          )}
          {bare &&
            ANCHORS.slice(0, 7).map(([x, y], i) => (
              <circle key={i} cx={x} cy={y + 3} r="1.6" fill="#F3D27A" />
            ))}
          {season === "spring" &&
            spots.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={2.4 * size} fill="#A9C98A" stroke="#6B8448" strokeWidth="0.6" />)}
          {!bare &&
            season !== "spring" &&
            spots.map(([x, y, rot], i) => (
              <path
                key={i}
                d={MAPLE_LEAF_PATH}
                transform={`translate(${x} ${y}) rotate(${rot}) scale(${size})`}
                fill={palette[i % palette.length]}
                stroke="rgba(0,0,0,0.12)"
                strokeWidth="0.5"
              />
            ))}
        </g>
      </g>
      {gnome && (
        <g transform="translate(70 86)">
          {/* a tiny acorn-capped gnome at the roots on her month-days */}
          <path d="M0,14 L3,6 L9,6 L12,14 Z" fill="#5C7A4A" />
          <circle cx="6" cy="6" r="3" fill="#E8C8B8" />
          <path d="M3.2,7 Q6,13 8.8,7 Z" fill="#F5F0E6" />
          <path d="M1.5,5 Q6,-2.5 10.5,5 Z" fill="#8A5A2B" />
          <path d="M6,-0.8 L6,-2.8" stroke="#5A3A1A" strokeWidth="1" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

/** Zoe, the small black couch commander with the grey muzzle, curled up asleep. */
export function Zoe({ alert, className }: { alert?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 48 30" className={className} aria-hidden>
      {!alert && (
        <text x="17" y="7" fontSize="6.5" fill="#E0A93B" opacity="0.6" fontFamily="serif" fontStyle="italic">
          z z
        </text>
      )}
      <g fill="#24211D" stroke="rgba(224,169,59,0.5)" strokeWidth="0.7" strokeLinejoin="round">
        {/* curled-up body and tail */}
        <path d="M14,28 C7,28 5,22 8,18 C12,12 24,10 33,11 C43,12 47,18 46,23 C45,27 40,29 34,29 Z" />
        <path d="M43,22 C48,18 46,12 41,13" fill="none" strokeWidth="2.6" stroke="#24211D" strokeLinecap="round" />
        {/* head resting on her paws */}
        <ellipse cx="13" cy="21" rx="7.5" ry="6.5" />
        <ellipse cx="9" cy="28.2" rx="5" ry="1.8" />
        {alert ? (
          <path d="M11,15.5 L13.5,6.5 L18,14.5 Z" />
        ) : (
          <path d="M11,15.5 C13,12 18,12 20,15.5 C18.5,19 14,19.5 11,15.5 Z" />
        )}
      </g>
      {/* the grey muzzle */}
      <ellipse cx="6.6" cy="23" rx="4.6" ry="3.3" fill="#9A9690" />
      <circle cx="2.6" cy="22.2" r="1.1" fill="#111" />
      {alert ? (
        <circle cx="11.5" cy="19.6" r="1" fill="#E0A93B" />
      ) : (
        <path d="M9.6,19.8 Q11.2,20.9 12.8,19.8" stroke="#BDB8B0" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

export default function Hero() {
  const { state, summary, isNight, toast } = useMaple();
  const now = useNow(60_000);
  const nightLook = useNightActive();
  if (!state || !summary) return null;
  const tz = state.baby.timezone ?? DEFAULT_TZ;
  const age = summary.age;
  const night = isNight() || nightLook;
  const p = localParts(now, tz);
  const born = state.baby.born_at ? localParts(Date.parse(state.baby.born_at), tz) : null;
  const monthDay = !!(born && age && age.months >= 1 && p.day === born.day);
  const birthday = !!(born && age && age.months >= 12 && p.month === born.month && p.day === born.day);
  const season = seasonFor(p.month, birthday);
  const leaves = age ? Math.min(52, age.weeks + 1) : 0;
  const first = (state.baby.name || "Maple").split(" ")[0];
  const timerRunning = summary.active.length > 0;

  const aboutTree = () =>
    toast(
      leaves === 1
        ? `${first}'s tree has its first leaf. One more grows each week.`
        : `${first}'s tree has ${leaves} leaves, one for each week.${season === "winter" ? " They're resting for winter." : ""}`,
      { tone: "info" }
    );

  return (
    <header className="flex items-end gap-3 px-1 pt-4">
      <div className="min-w-0 flex-1 pb-1">
        <h1 className={cx(tone.display, "truncate text-[34px] leading-[1.05]")}>{state.baby.name}</h1>
        {age && (
          <p className={cx(tone.muted, "mt-1 text-[15px]")}>
            <span className="font-semibold text-mp-maple">Day {age.dayOfLife}</span>
            <span aria-hidden> · </span>
            {age.label}
          </p>
        )}
      </div>
      <button type="button" onClick={aboutTree} aria-label={`${first}'s tree: ${leaves} leaves, one for each week`} className="relative shrink-0 rounded-2xl active:scale-[0.98]">
        {/* Still, not swaying: nothing on Today moves unless something happened. */}
        <Sapling leaves={leaves} season={season} gnome={monthDay} className="h-[72px] w-[66px]" />
        {night && <Zoe alert={timerRunning} className="absolute bottom-[1px] left-0 h-[20px] w-[33px]" />}
      </button>
    </header>
  );
}
