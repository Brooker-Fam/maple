import { Icon, type IconName } from "@/components/maple/icons";
import { KIND_COLOR, MAPLE, SIDE_COLOR, SIDE_INK } from "@/components/maple/palette";
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

function DockTile({ icon, label, filled }: { icon: IconName; label: string; filled?: boolean }) {
  return (
    <span
      className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-[16px] py-2.5 text-[12px] font-semibold ${
        filled ? "bg-mp-accent text-mp-on-accent" : "bg-mp-surface text-mp-ink"
      }`}
    >
      <Icon name={icon} size={22} />
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

/** Today in the daytime, mid-feed: the card shows what happened, the dock holds every action. */
export function TodayMock() {
  return (
    <div className="flex h-full flex-col bg-mp-bg">
      <StatusBar at={2 * 3600 + 27 * 60 + 12} />
      <div className="flex items-end justify-between px-5 pt-3">
        <div>
          <p className="font-display text-[34px] leading-none font-semibold text-mp-ink">June</p>
          <p className="mt-1 text-[13px] text-mp-ink-3">Day 15 · two weeks old</p>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-mp-surface text-mp-accent-fg">
          <Icon name="message-square" size={19} />
        </span>
      </div>

      <div className="mx-3.5 mt-4 rounded-[22px] border border-[var(--mp-edge)] bg-mp-surface p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-mp-ink">
            <span className="mp-kind-fill h-2.5 w-2.5 rounded-full" style={{ backgroundColor: MAPLE.ember }} />
            Nursing
          </p>
          <Icon name="ellipsis" size={20} className="text-mp-ink-3" />
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

      <div className="mt-auto bg-mp-sunken px-2.5 pt-2.5 pb-5">
        <div className="flex gap-2">
          <DockTile icon="arrow-left-right" label="Switch" />
          <DockTile icon="pause" label="Pause" />
          <DockTile icon="check" label="Done" filled />
          <DockTile icon="ellipsis" label="More" />
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
