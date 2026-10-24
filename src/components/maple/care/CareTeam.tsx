"use client";

import { POSTPARTUM_VISIT_NOTE } from "@/lib/maple/guidelines";
import { DEFAULT_TZ, dayKey, formatDayLabel, isDayKey } from "@/lib/maple/time";
import { Icon } from "../icons";
import { Button, SectionTitle, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP } from "./parts";
import type { UseCare } from "./useCare";

/**
 * Her care team (§11.2, step 1): one-tap call rows for her OB or midwife,
 * the after-hours line, the pharmacy, and her therapist (hers only: the
 * state never carries it to anyone else), her next OB visit, and ACOG's
 * visit timing. Numbers are the family's own; none is coded here.
 */
export const telHref = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;

export default function CareTeam({ care, onEdit }: { care: UseCare; onEdit: () => void }) {
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const team = care.state.settings.care_team ?? {};
  const rows = [
    { label: "OB or midwife", n: team.ob },
    { label: "After-hours or labor and delivery line", n: team.after_hours },
    { label: "Pharmacy", n: team.pharmacy },
    ...(care.access.therapist ? [{ label: "Therapist", n: team.therapist }] : []),
  ].filter((r): r is { label: string; n: string } => !!r.n?.trim());
  const visit = care.state.settings.next_visit;
  const write = care.access.write;

  return (
    <section>
      <SectionTitle
        action={
          write ? (
            <Button variant="ghost" size="sm" className="-mr-2" onClick={onEdit}>
              Edit
            </Button>
          ) : undefined
        }
      >
        Care team
      </SectionTitle>
      {rows.length ? (
        <div className={GROUP}>
          {rows.map((r) => (
            <a key={r.label} href={telHref(r.n)} className={cx(tone.row, "min-h-[52px] py-2.5")}>
              <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
              <span className="min-w-0 flex-1">
                <span className={cx(tone.body, "block text-[15px] leading-snug")}>{r.label}</span>
                <span className={cx(tone.muted, "block text-[13px] tabular-nums")}>{r.n}</span>
              </span>
              <span className="shrink-0 text-[15px] font-medium text-mp-accent-fg">Call</span>
            </a>
          ))}
        </div>
      ) : (
        <button type="button" onClick={write ? onEdit : undefined} disabled={!write} className={cx(tone.card, tone.row, "min-h-[52px] py-3 disabled:active:bg-transparent")}>
          <Icon name="phone" size={20} className="shrink-0 text-mp-ink-3" />
          <span className={cx(tone.muted, "min-w-0 flex-1 text-[15px] leading-snug")}>
            {care.self ? "Add your OB's number so it's one tap away." : "Add her OB's number so it's one tap away."}
          </span>
          {write && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
        </button>
      )}
      {visit && isDayKey(visit) && (
        <p className={cx(tone.body, "mt-3 flex items-center gap-2 px-1 text-[15px]")}>
          <Icon name="calendar-check" size={18} className="shrink-0 text-mp-ink-2" />
          Next OB visit: {formatDayLabel(visit, dayKey(now(), tz))}
        </p>
      )}
      <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug")}>{POSTPARTUM_VISIT_NOTE}</p>
    </section>
  );
}
