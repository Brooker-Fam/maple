import { Icon, type IconName } from "@/components/maple/icons";
import { DETAIL_COLOR, KIND_COLOR, MAPLE, SIDE_COLOR, SIDE_INK } from "@/components/maple/palette";
import Ticker from "./Ticker";

/** A drawn phone holding a sample screen. The screen is decorative; `label` says what it shows. */
export function Phone({ label, night, children, className = "" }: { label: string; night?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <figure className={`site-phone ${night ? "site-night" : ""} ${className}`}>
      <figcaption className="sr-only">{label}</figcaption>
      <div className="site-phone-screen" aria-hidden>
        {children}
      </div>
    </figure>
  );
}

function StatusBar({ at }: { at: number }) {
  return (
    <div className="flex items-center justify-between px-6 pt-3.5 pb-1 text-[13px] font-semibold tabular-nums text-mp-ink">
      <Ticker from={at} format="clock" />
      <span className="flex items-center gap-1 opacity-80">
        <span className="h-2 w-3.5 rounded-[3px] border border-current" />
      </span>
    </div>
  );
}

function SideMark({ side, size = 26 }: { side: "L" | "R"; size?: number }) {
  return (
    <span
      className="mp-side-mark inline-flex shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
      style={{ width: size, height: size, backgroundColor: SIDE_COLOR[side], color: SIDE_INK[side] }}
    >
      {side}
    </span>
  );
}

type Mark = { icon: IconName; color?: string };

function DockTile({ marks, label, filled }: { marks: Mark[]; label: string; filled?: boolean }) {
  return (
    <span
      className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-[16px] py-2.5 text-[12px] font-semibold ${
        filled ? "bg-mp-accent text-mp-on-accent" : "bg-mp-surface text-mp-ink"
      }`}
    >
      <span className="flex items-center">
        {marks.map((m) => (
          <Icon key={m.icon} name={m.icon} size={22} className={m.color ? "mp-kind-ink" : undefined} style={m.color ? { color: m.color } : undefined} />
        ))}
      </span>
      {label}
    </span>
  );
}

function RecentRow({ icon, color, title, time }: { icon: IconName; color: string; title: string; time: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2.5">
      <span className="mp-kind inline-flex h-7 w-7 items-center justify-center rounded-full" style={{ color, backgroundColor: `${color}1f` }}>
        <Icon name={icon} size={15} />
      </span>
      <span className="flex-1 text-[14px] text-mp-ink">{title}</span>
      <span className="text-[12px] text-mp-ink-3 tabular-nums">{time}</span>
    </div>
  );
}

/** A simplified Patterns screen. Every mark and count is fictional sample data. */
export function PatternsMock() {
  const days = [
    { day: "Wed", feeds: [0.5, 3, 5.5, 8, 10.5, 13, 15.5, 18, 21], wet: [2, 6, 9, 13.5, 17, 22], dirty: [6, 13.5, 22] },
    { day: "Tue", feeds: [1, 3.5, 6, 8.5, 11, 14, 16.5, 19, 22], wet: [1.5, 5, 9, 12, 17, 21], dirty: [5, 12, 21] },
    { day: "Mon", feeds: [0.5, 6, 8, 10.5, 13.5, 16, 19, 22], wet: [1, 7, 10, 14, 19, 22.5], dirty: [7, 14] },
  ];
  const x = (hour: number) => 3 + (hour / 24) * 210;

  return (
    <div className="flex h-full flex-col gap-2 bg-mp-bg px-3.5 pt-5 pb-4">
      <div className="flex items-center justify-between px-1">
        <div>
          <p className="text-[23px] font-semibold tracking-[-0.03em] text-mp-ink">History</p>
          <p className="text-[11px] text-mp-ink-3">June&rsquo;s log</p>
        </div>
      </div>
      <div className="flex rounded-xl bg-mp-sunken p-1 text-center text-[12px] font-semibold">
        <span className="flex-1 px-3 py-1.5 text-mp-ink-3">Timeline</span>
        <span className="flex-1 rounded-lg bg-mp-surface px-3 py-1.5 text-mp-ink">Patterns</span>
      </div>

      <div className="rounded-[20px] border border-[var(--mp-edge)] bg-mp-surface p-3">
        <div className="flex items-center justify-between">
          <p className="text-[14px] font-semibold text-mp-ink">Day ribbons</p>
          <span className="text-[11px] font-semibold text-mp-accent-fg">Days</span>
        </div>
        <div className="mt-2 flex gap-3 text-[10px] text-mp-ink-2">
          <span className="flex items-center gap-1"><span className="h-2.5 w-1 rounded-sm bg-mp-maple" />Nursing</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: DETAIL_COLOR.pee }} />Wet</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: DETAIL_COLOR.poop }} />Dirty</span>
        </div>
        <div className="mt-3 flex justify-between text-[9px] font-medium text-mp-ink-3 tabular-nums">
          {["12a", "6a", "12p", "6p", "12a"].map((tick, i) => <span key={i}>{tick}</span>)}
        </div>
        <div className="mt-1 space-y-1.5">
          {days.map((day) => (
            <div key={day.day}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-semibold text-mp-ink">{day.day}</span>
                <span className="text-[10px] text-mp-ink-3 tabular-nums">{day.feeds.length} feeds · {day.wet.length} wet · {day.dirty.length} dirty</span>
              </div>
              <svg viewBox="0 0 216 27" className="mt-1 block h-[22px] w-full" role="presentation">
                <rect x="0" y="4" width="216" height="15" rx="3" fill="var(--mp-sunken)" />
                {[6, 12, 18].map((hour) => <line key={hour} x1={x(hour)} x2={x(hour)} y1="0" y2="27" stroke="var(--mp-line)" />)}
                {day.feeds.map((hour) => <rect key={hour} x={x(hour)} y="2" width="4" height="17" rx="1.5" fill="var(--mp-maple)" />)}
                {day.wet.map((hour) => <circle key={hour} cx={x(hour)} cy="23" r="2" fill={DETAIL_COLOR.pee} />)}
                {day.dirty.map((hour) => <circle key={hour} cx={x(hour) + 4} cy="23" r="2" fill={DETAIL_COLOR.poop} />)}
              </svg>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-snug text-mp-ink-3">Each row is one day, midnight to midnight.</p>
      </div>

      <div className="rounded-[20px] border border-[var(--mp-edge)] bg-mp-surface p-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-mp-ink">
          <Icon name="stethoscope" size={17} className="text-mp-accent-fg" />
          For the doctor
        </p>
        <p className="mt-1 text-[11px] leading-snug text-mp-ink-2">Visit summary · questions · growth</p>
      </div>
      <p className="mt-auto text-center text-[10px] leading-snug text-mp-ink-3">Counts include only what you log.</p>
    </div>
  );
}

/** Today in the daytime, mid-feed: the hero folds away, the card shows what happened, the dock holds every action. */
export function TodayMock() {
  return (
    <div className="flex h-full flex-col bg-mp-bg">
      <StatusBar at={2 * 3600 + 27 * 60 + 12} />

      <div className="mx-3.5 mt-4 rounded-[22px] border border-[var(--mp-edge)] bg-mp-surface p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-mp-ink">
            <span className="mp-kind-fill h-2.5 w-2.5 rounded-full" style={{ backgroundColor: MAPLE.ember }} />
            Nursing
          </p>
          <span className="flex items-center gap-3 text-mp-ink-3">
            <Icon name="lamp" size={19} />
            <Icon name="ellipsis" size={20} />
          </span>
        </div>
        <div className="mt-3 space-y-2 text-[14px] tabular-nums">
          <p className="flex items-center gap-2.5 text-mp-ink-2">
            <SideMark side="L" size={22} />
            Left 2:10–2:22 · 12 min
          </p>
          <p className="flex items-center gap-2.5 font-medium text-mp-ink">
            <SideMark side="R" size={22} />
            Right side · since 2:23
          </p>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <Ticker from={252} className="text-[52px] leading-none font-semibold tracking-[-0.03em] text-mp-ink tabular-nums" />
          <p className="pb-1 text-right text-[12px] leading-tight whitespace-nowrap text-mp-ink-3">
            Total nursing
            <Ticker from={12 * 60 + 252} format="minutes" className="block text-[15px] font-semibold text-mp-ink-2" />
          </p>
        </div>
      </div>

      <div className="mx-3.5 mt-3 grid grid-cols-2 gap-2.5">
        <div className="rounded-[18px] bg-mp-surface px-3.5 py-3">
          <p className="text-[12px] text-mp-ink-3">Since pee</p>
          <p className="text-[17px] font-semibold text-mp-ink tabular-nums">1h 05m</p>
        </div>
        <div className="rounded-[18px] bg-mp-surface px-3.5 py-3">
          <p className="text-[12px] text-mp-ink-3">Since poop</p>
          <p className="text-[17px] font-semibold text-mp-ink tabular-nums">3h 40m</p>
        </div>
      </div>

      <div className="mx-3.5 mt-4">
        <p className="px-1 text-[13px] font-semibold text-mp-ink-2">Recent</p>
        <div className="mt-1.5 divide-y divide-[var(--mp-line)] rounded-[18px] bg-mp-surface px-3.5">
          <RecentRow icon="moon" color={KIND_COLOR.sleep} title="Nap · 1h 25m" time="11:50 AM" />
        </div>
      </div>

      <div className="mt-auto space-y-2 bg-mp-sunken px-2.5 pt-2.5 pb-5">
        <div className="flex gap-2">
          <DockTile marks={[{ icon: "arrow-left-right" }]} label="Switch" />
          <DockTile marks={[{ icon: "pause" }]} label="Pause" />
          <DockTile marks={[{ icon: "check" }]} label="Done" filled />
          <DockTile marks={[{ icon: "plus" }]} label="More" />
        </div>
        <div className="flex gap-2">
          <DockTile marks={[{ icon: "droplet", color: DETAIL_COLOR.pee }]} label="Pee" />
          <DockTile marks={[{ icon: "poop", color: DETAIL_COLOR.poop }]} label="Poop" />
          <DockTile
            marks={[
              { icon: "droplet", color: DETAIL_COLOR.pee },
              { icon: "poop", color: DETAIL_COLOR.poop },
            ]}
            label="Both"
          />
          <DockTile marks={[{ icon: "moon", color: DETAIL_COLOR.sleep }]} label="Sleep" />
        </div>
      </div>
    </div>
  );
}

function LanternButton({ label, mark, icon, fill = 0 }: { label: string; mark?: "L" | "R"; icon?: IconName; fill?: number }) {
  const C = 2 * Math.PI * 26;
  return (
    <span className="site-lantern-button flex flex-1 flex-col items-center justify-center gap-2.5 rounded-[24px] border text-[16px] font-semibold">
      <span className="relative flex h-14 w-14 items-center justify-center">
        <svg width="56" height="56" viewBox="0 0 64 64" className="absolute inset-0">
          <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(224,169,59,0.15)" strokeWidth="4" />
          {fill > 0 && (
            <circle
              cx="32"
              cy="32"
              r="26"
              fill="none"
              stroke="rgba(224,169,59,0.75)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${C * fill} ${C}`}
              transform="rotate(-90 32 32)"
            />
          )}
        </svg>
        {mark ? <span className="text-[19px] font-bold">{mark}</span> : icon && <Icon name={icon} size={22} />}
      </span>
      {label}
    </span>
  );
}

/** The Lantern at 3am: dim amber on near-black, one big clock, three buttons that need a half-second hold. */
export function LanternMock() {
  return (
    <div className="site-lantern flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-4">
        <p className="text-[12px] opacity-50">Lantern · swipe down to close</p>
        <Icon name="x" size={18} className="opacity-50" />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
        <p className="mb-3 flex items-center gap-2.5 text-[20px] font-semibold opacity-75">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-bold" style={{ boxShadow: "inset 0 0 0 1.5px rgba(224,169,59,0.45)" }}>
            R
          </span>
          Right side
        </p>
        <Ticker from={408} className="text-[68px] leading-none font-semibold tracking-[-0.03em] tabular-nums" />
        <p className="mt-3 text-[15px] tabular-nums opacity-65">Since 3:05 AM</p>
        <p className="mt-1 text-[14px] tabular-nums opacity-60">
          Total nursing <Ticker from={12 * 60 + 408} format="minutes" />
        </p>
      </div>
      <p className="pb-3 text-center text-[12px] opacity-50">Hold a button to use it</p>
      <div className="flex h-[34%] gap-2.5 px-3.5 pb-5">
        <LanternButton label="Switch" mark="L" fill={0.62} />
        <LanternButton label="Pause" icon="pause" />
        <LanternButton label="Done" icon="check" />
      </div>
    </div>
  );
}
