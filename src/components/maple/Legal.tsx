import { TRACKER_NOTE } from "@/lib/maple/guidelines";
import { cx, tone } from "./ui";

const LINK = "inline-flex min-h-[44px] items-center px-2 font-medium text-mp-accent-fg";

export function LegalLinks({ className }: { className?: string }) {
  return (
    <span className={cx("flex items-center justify-center text-[13px]", className)}>
      <a href="/terms" className={LINK}>
        Terms
      </a>
      <span aria-hidden className={tone.faint}>
        ·
      </span>
      <a href="/privacy" className={LINK}>
        Privacy
      </a>
    </span>
  );
}

export function TrackerNote({ className }: { className?: string }) {
  return (
    <div className={cx("text-center", className)}>
      <p className={cx(tone.faint, "text-[13px] leading-snug")}>{TRACKER_NOTE}</p>
      <LegalLinks />
    </div>
  );
}
