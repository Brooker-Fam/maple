"use client";

import { MEMORY_KIND_LABEL, type MemoryKind } from "@/lib/maple/memory/types";
import type { ChatMemoryChange } from "@/lib/maple/chat/types";
import { useAppNav } from "../AppNav";
import { Icon } from "../icons";
import { cx, tone } from "../ui";

/**
 * A family memory the reply saved or changed. Memories are shared with
 * everyone in the family, so the card says so and opens Settings → Memories,
 * where any of them can be edited or forgotten.
 */

const TITLE: Record<ChatMemoryChange["status"], string> = {
  saved: "Remembered for the family",
  supported: "Already remembered",
  corrected: "Memory updated",
  resolved: "Memory marked resolved",
  archived: "Memory archived",
};

export default function ChatMemory({ change }: { change: ChatMemoryChange }) {
  const app = useAppNav();
  const kind = MEMORY_KIND_LABEL[change.kind as MemoryKind];
  return (
    <section className={cx(tone.card, "space-y-1.5 p-3.5")} aria-label={TITLE[change.status]}>
      <p className={cx(tone.label, "flex items-center gap-1.5")}>
        <Icon name="sticky-note" size={15} />
        {TITLE[change.status]}
        {kind && <span className={tone.faint}>· {kind}</span>}
      </p>
      <p className={cx(tone.body, "text-[15px] leading-snug", (change.status === "resolved" || change.status === "archived") && "text-mp-ink-2")}>{change.fact}</p>
      {change.previous && change.previous !== change.fact && <p className={cx(tone.muted, "text-[13px] leading-snug")}>Was: {change.previous}</p>}
      <button type="button" onClick={() => app.go("family/memories")} className="-ml-1 flex min-h-[44px] items-center gap-1 rounded-[10px] px-1 text-[14px] font-medium text-mp-accent-fg">
        Everyone in the family can see it in Memories
        <Icon name="chevron-right" size={16} />
      </button>
    </section>
  );
}
