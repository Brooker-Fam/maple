import { Icon, type IconName } from "@/components/maple/icons";
import { DETAIL_COLOR, KIND_COLOR, MAPLE } from "@/components/maple/palette";
import { curves, percentileFor } from "@/lib/maple/growth";
import { STOOL_COLOR_INFO } from "@/lib/maple/guidelines";
import type { StoolColor } from "@/lib/maple/types";

/** A cut-out piece of a sample screen. Decorative: `label` says what it shows. */
function Fragment({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <figure className={`site-fragment ${className}`}>
      <figcaption className="sr-only">{label}</figcaption>
      <div aria-hidden>{children}</div>
    </figure>
  );
}

function Badge({ icon, color, size = 36 }: { icon: IconName; color: string; size?: number }) {
  return (
    <span
      className="mp-kind inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, color, backgroundColor: `${color}1f` }}
    >
      <Icon name={icon} size={Math.round(size * 0.52)} />
    </span>
  );
}

function Row({ icon, color, title, meta, time }: { icon: IconName; color: string; title: string; meta?: string; time: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Badge icon={icon} color={color} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium text-mp-ink">{title}</p>
        {meta && <p className="truncate text-[13px] text-mp-ink-3">{meta}</p>}
      </div>
      <span className="text-[13px] text-mp-ink-3 tabular-nums">{time}</span>
    </div>
  );
}

export function PatternQuestionFragment() {
  return (
    <Fragment label="Illustrative sample: asking Maple’s chat how the timing of logged feeds changed this week, alongside the day ribbons in History.">
      <p className="text-[13px] font-medium text-mp-ink-3">Explore your log with Maple’s chat</p>
      <div className="mt-4 ml-auto max-w-[90%] rounded-[18px] rounded-br-[6px] bg-mp-accent px-4 py-3 text-[16px] leading-snug text-mp-on-accent">
        How has the timing of her feeds changed this week?
      </div>
      <p className="mt-5 text-[15px] leading-relaxed text-mp-ink-2">Start with the days you want to understand. Ask about feeding times, longer gaps, or changes in the routine you’ve recorded.</p>
      <p className="mt-4 border-t border-mp-line pt-3 text-[13px] text-mp-ink-3">History → Patterns · Questions about these patterns?</p>
    </Fragment>
  );
}

export function HandoffFragment() {
  return (
    <Fragment label="Sample screen: a 'While you slept' line saying Dad gave a bottle, changed two wet diapers and put June down for a nap, with each entry below it.">
      <div className="rounded-[16px] bg-mp-sunken px-4 py-3 text-[14px] text-mp-ink">
        <span className="font-semibold">While you slept</span>
        <span className="text-mp-ink-2"> · 1 feed · 2 wet · a nap · by Dad</span>
      </div>
      <div className="mt-2 divide-y divide-[var(--mp-line)]">
        <Row icon="moon" color={KIND_COLOR.sleep} title="Slept 2h 25m" meta="by Dad" time="2:15 AM" />
        <Row icon="droplet" color={DETAIL_COLOR.pee} title="Wet diaper" meta="by Dad" time="2:10 AM" />
        <Row icon="bottle" color={DETAIL_COLOR.bottle} title="Bottle · 2 fl oz pumped milk" meta="by Dad" time="1:50 AM" />
        <Row icon="droplet" color={DETAIL_COLOR.pee} title="Wet diaper" meta="by Dad" time="12:40 AM" />
      </div>
    </Fragment>
  );
}

const SWATCHES: StoolColor[] = ["yellow", "mustard", "green", "brown", "orange", "black", "pale_yellow", "gray", "white", "red"];

export function StoolFragment() {
  const picked = STOOL_COLOR_INFO.mustard;
  return (
    <Fragment label="Sample screen: logging a dirty diaper by picking its color from ten swatches. Mustard and seedy is picked, with the note that it's textbook breastfed poop by days 4 to 5.">
      <p className="text-[13px] font-medium text-mp-ink-2">Color</p>
      <div className="mt-2.5 grid max-w-[18rem] grid-cols-5 gap-2">
        {SWATCHES.map((c) => (
          <span
            key={c}
            className={`mp-swatch aspect-square rounded-full ${c === "mustard" ? "site-swatch-picked" : ""}`}
            style={{ backgroundColor: STOOL_COLOR_INFO[c].hex, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--mp-ink) 18%, transparent)" }}
          />
        ))}
      </div>
      <div className="mt-4 rounded-[16px] bg-mp-sunken px-4 py-3">
        <p className="text-[15px] font-semibold text-mp-ink">{picked.label}</p>
        <p className="mt-0.5 text-[14px] leading-snug text-mp-ink-2">{picked.note}</p>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-mp-ink-3">Pale, gray, white and red each show a card that says to call your pediatrician today.</p>
    </Fragment>
  );
}

const JUNE_WEIGHTS: [day: number, grams: number][] = [
  [0, 3350],
  [3, 3120],
  [5, 3210],
  [10, 3540],
  [15, 3760],
];

export function GrowthFragment() {
  const W = 300;
  const H = 190;
  const days = 21;
  const lines = curves("weight", 0, days, 1, "girls");
  const all = lines.flatMap((l) => l.points.map(([, g]) => g));
  const lo = Math.min(...all) - 150;
  const hi = Math.max(...all) + 250;
  const x = (d: number) => 8 + (d / days) * (W - 16);
  const y = (g: number) => H - 14 - ((g - lo) / (hi - lo)) * (H - 28);
  const path = (pts: [number, number][]) => pts.map(([d, g], i) => `${i ? "L" : "M"}${x(d).toFixed(1)} ${y(g).toFixed(1)}`).join(" ");
  const [lastDay, lastG] = JUNE_WEIGHTS[JUNE_WEIGHTS.length - 1];
  const p = percentileFor("weight", lastG, lastDay, "girls");
  const pct = p?.label ?? null;
  return (
    <Fragment label={`Sample chart: June's weight over her first two weeks on the WHO girls' percentile curves${pct ? `, now near the ${pct} percentile` : ""}.`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-[15px] font-semibold text-mp-ink">Weight</p>
        <p className="text-[13px] text-mp-ink-3 tabular-nums">8 lb 4.6 oz{pct ? ` · ${pct} percentile` : ""}</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="presentation">
        {lines.map((l) => (
          <path
            key={l.p}
            d={path(l.points)}
            fill="none"
            stroke="currentColor"
            className={l.p === 50 ? "text-mp-ink-3" : "text-mp-line"}
            strokeWidth={l.p === 50 ? 1.25 : 1}
            strokeDasharray={l.p === 50 ? undefined : "3 4"}
          />
        ))}
        {lines.map((l) => (
          <text key={`t${l.p}`} x={W - 4} y={y(l.points[l.points.length - 1][1]) - 3} textAnchor="end" className="fill-mp-ink-3" fontSize="9">
            {l.p}
          </text>
        ))}
        <path d={path(JUNE_WEIGHTS)} fill="none" stroke={MAPLE.sage} strokeWidth="2" className="mp-kind-ink" />
        {JUNE_WEIGHTS.map(([d, g]) => (
          <circle key={d} cx={x(d)} cy={y(g)} r="3.5" fill={MAPLE.sage} className="mp-kind-fill" />
        ))}
      </svg>
      <p className="mt-1 text-[12px] text-mp-ink-3">WHO girls, birth to 3 weeks</p>
    </Fragment>
  );
}

export function QuestionsFragment() {
  const qs: { q: string; a?: string }[] = [
    { q: "Is all the sneezing normal?", a: "Yes, she’s clearing her nose." },
    { q: "When should her cord stump fall off?" },
    { q: "Which vitamin D drops do you recommend?" },
  ];
  return (
    <Fragment label="Sample list: three questions for the pediatrician, one ticked off with its answer.">
      <p className="text-[15px] font-semibold text-mp-ink">For the doctor</p>
      <ul className="mt-2 space-y-2.5">
        {qs.map(({ q, a }) => (
          <li key={q} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${a ? "border-transparent bg-mp-accent text-mp-on-accent" : "border-mp-ink-3"}`}
            >
              {a && <Icon name="check" size={13} strokeWidth={2.5} />}
            </span>
            <span className="text-[14px] leading-snug">
              <span className={a ? "text-mp-ink-3 line-through decoration-1" : "text-mp-ink"}>{q}</span>
              {a && <span className="block text-mp-ink-2">{a}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Fragment>
  );
}

export function MomentFragment() {
  return (
    <Fragment label="Sample moment: a drawing standing in for a photo, captioned 'First bath', with a short note.">
      <div className="site-photo aspect-[4/3] w-full overflow-hidden rounded-[16px]" />
      <div className="mt-3 flex items-start gap-3">
        <Badge icon="bath" color={KIND_COLOR.bath} size={32} />
        <div>
          <p className="text-[15px] font-semibold text-mp-ink">First bath</p>
          <p className="text-[13px] text-mp-ink-3">Day 15 · 4:30 PM</p>
          <p className="mt-1.5 text-[14px] leading-snug text-mp-ink-2">Cried at first, then settled.</p>
        </div>
      </div>
    </Fragment>
  );
}

export function SiriFragment() {
  return (
    <Fragment label="Sample Siri exchange: asking 'Maple status' and hearing when June last ate and which side to start on next.">
      <p className="text-[14px] text-mp-ink-3">You say</p>
      <p className="mt-1 font-display text-[24px] leading-tight font-semibold text-mp-ink">&ldquo;Hey Siri, Maple status.&rdquo;</p>
      <p className="mt-4 text-[14px] text-mp-ink-3">Siri says</p>
      <p className="mt-1 text-[16px] leading-snug text-mp-ink">June last ate 45 minutes ago, starting on the left, so start on the right next.</p>
    </Fragment>
  );
}

export function AskFragment() {
  return (
    <Fragment label="Sample in-app chat: a parent types that June had a wet diaper at 8 and took 2 ounces from a bottle; the reply logs both, each with an Undo.">
      <div className="ml-auto max-w-[85%] rounded-[18px] rounded-br-[6px] bg-mp-accent px-4 py-2.5 text-[15px] leading-snug text-mp-on-accent">
        wet one at 8 and she took 2 oz from a bottle after
      </div>
      <p className="mt-3 text-[15px] leading-snug text-mp-ink">Logged both. That&rsquo;s her fourth wet diaper today.</p>
      <div className="mt-2.5 space-y-2">
        {[
          { icon: "droplet" as const, color: DETAIL_COLOR.pee, text: "Wet diaper · 8:00 PM" },
          { icon: "bottle" as const, color: DETAIL_COLOR.bottle, text: "Bottle · 2 fl oz · 8:05 PM" },
        ].map((r) => (
          <div key={r.text} className="flex items-center gap-2.5 rounded-[14px] bg-mp-sunken px-3 py-2">
            <Badge icon={r.icon} color={r.color} size={26} />
            <span className="flex-1 text-[13px] text-mp-ink tabular-nums">{r.text}</span>
            <span className="text-[13px] font-semibold text-mp-accent-fg">Undo</span>
          </div>
        ))}
      </div>
    </Fragment>
  );
}
