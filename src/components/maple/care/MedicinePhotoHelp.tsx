import { cx, tone } from "../ui";

export default function MedicinePhotoHelp({ className }: { className?: string }) {
  return <p className={cx(tone.muted, "text-[13px] leading-snug", className)}>
    To add medicines from a discharge photo, <a href="/maple/connect" className="inline-flex min-h-[44px] items-center font-medium text-mp-accent-fg underline underline-offset-2">Set up Claude for photos</a>. This uses Claude outside Maple Chat.
  </p>;
}
