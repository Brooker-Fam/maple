"use client";

import { planTitle } from "@/lib/maple/care";
import { KindBadge } from "../icons";
import { CARE_COLOR } from "../palette";
import { useCareNav } from "./CareNav";
import { GlanceMark, PlanName, TookIt } from "./parts";
import { useCare } from "./useCare";

/**
 * Her strip, pinned on top of Today's dock (§11.1): at most 44px, so her
 * next medicine is always in thumb reach without taking anything of
 * Maple's. A pill badge, her name and the medicine (with its Also called
 * name), the glance ("OK now · last 2:24 AM", "Not yet · OK after 10:55
 * AM"), "+n" for the rest, and Took it. The medicine is her most pressing
 * one by the one rule (pressingPlan), or the one just logged on this phone
 * while it holds its slot ("Logged 6:56 AM"), so a second tap never lands on
 * another medicine. Tapping the line opens her picker.
 *
 * Nothing shows for view-only guests (no care at all), or when she has no
 * active medicines. Neutral ink in every state: it's a fact, never an alert.
 */
export function CareStrip() {
  const care = useCare();
  const nav = useCareNav();
  const line = care?.todayLine;
  if (!care || !line) return null;
  const { view, more } = line;
  const g = view.glance;
  const whose = care.self ? "Your" : `${care.name}'s`;

  return (
    <div
      role="group"
      aria-label={`${whose} medicines`}
      className="-mt-0.5 mb-1.5 flex h-11 items-center gap-1 rounded-2xl border border-(--mp-edge) bg-mp-surface pr-2 shadow-[0_1px_2px_rgb(28_38_25/0.06)]"
    >
      <button
        type="button"
        onClick={() => nav.openPicker()}
        aria-label={`${whose} medicines: ${planTitle(view.plan)}, ${g.text}${more ? `, and ${more} more` : ""}. Open the list.`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-2xl pl-2 text-left transition active:bg-mp-ink/[0.04]"
      >
        <KindBadge icon="pill" color={CARE_COLOR} size={28} />
        {/* Two cut lines: a long name never pushes the time out of the 44px, and the Also called name goes first. */}
        <span className="min-w-0 flex-1 text-[13px] leading-[17px] tabular-nums">
          <PlanName
            plan={view.plan}
            className="text-[14px] text-mp-ink"
            lead={
              <>
                <span className="shrink-0 font-semibold">{care.name}</span>
                <span aria-hidden className="shrink-0 px-1 text-mp-ink-3">
                  ·
                </span>
              </>
            }
          />
          {/* The mark says OK now or not yet; "Not yet" itself would cut "OK after 12:36 PM" at 375px (the picker says it). */}
          <span className="flex min-w-0 items-center gap-1 text-mp-ink-2">
            <GlanceMark ready={g.ready} size={13} />
            <GlanceParts text={g.ready === false ? g.detail : g.text} />
          </span>
        </span>
        {/* "+1" (the label says "and 1 more"): "+1 more" would take the time's room. */}
        {more > 0 && <span className="shrink-0 text-[13px] text-mp-ink-3 tabular-nums">+{more}</span>}
      </button>
      <TookIt view={view} care={care} onAsk={(ask) => nav.openDose(view.plan.id, ask)} />
    </div>
  );
}

/**
 * The glance on one line, part by part ("OK after 10:55 AM", "last 4:55 AM"):
 * a part that doesn't fit drops out whole onto a hidden second line, so a
 * time is never cut ("last 4:…"). Only the first part can be cut.
 */
function GlanceParts({ text }: { text: string }) {
  const [first, ...rest] = text.split(" · ");
  return (
    <span className="flex h-[1lh] min-w-0 flex-1 flex-wrap overflow-hidden">
      <span className="max-w-full min-w-0 truncate">{first}</span>
      {rest.map((part, i) => (
        <span key={i} className="shrink-0 whitespace-nowrap">
          {` · ${part}`}
        </span>
      ))}
    </span>
  );
}
