"use client";

import type { ChatWebSearch } from "@/lib/maple/chat/types";
import { Icon } from "../icons";
import { cx, tone } from "../ui";

/**
 * A web search under the reply (web-search.ts): the exact phrase that left
 * Maple, so nobody has to wonder what was sent, and each page it found, to
 * open in the browser.
 */
export default function ChatWeb({ web }: { web: ChatWebSearch }) {
  const title = web.health ? "Searched trusted health sites" : "Searched the web";
  return (
    <section className={cx(tone.card, "space-y-1.5 p-4")} aria-label={title}>
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-ink-2">
        <Icon name="globe" size={14} className="shrink-0" />
        {title}
      </p>
      <p className={cx(tone.muted, "text-[13px] leading-snug wrap-anywhere")}>&ldquo;{web.query}&rdquo;</p>
      {web.sources.length ? (
        <ul>
          {web.sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="flex min-h-[44px] flex-col justify-center py-1 leading-snug">
                <span className="text-[15px] font-medium text-mp-accent-fg underline underline-offset-2 wrap-anywhere">{s.title}</span>
                <span className={cx(tone.muted, "text-[13px]")}>{s.site}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className={cx(tone.muted, "text-[13px] leading-snug")}>No pages found.</p>
      )}
    </section>
  );
}
