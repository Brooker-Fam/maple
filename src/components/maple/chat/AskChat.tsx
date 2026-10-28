"use client";

import type { ReactNode } from "react";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useChatNav, type ChatPrompt } from "./ChatNav";

export function AskChatButton({ prompt, label = "Ask about this", children, onOpened, className }: {
  prompt: string;
  label?: string;
  children?: ReactNode;
  onOpened?: () => void;
  className?: string;
}) {
  const { ask } = useChatNav();
  return (
    <Button variant="ghost" size="sm" className={cx("text-left", className)} onClick={() => {
      if (ask({ prompt, label })) onOpened?.();
    }}>
      <Icon name="message-square" size={17} className="shrink-0" />
      {children ?? label}
    </Button>
  );
}

export function AskChatCard({ title, description, suggestions }: {
  title: string;
  description?: string;
  suggestions: ChatPrompt[];
}) {
  return (
    <section aria-label={title} className={cx(tone.inset, "px-4 py-3")}>
      <h3 className={cx(tone.heading, "text-[14px]")}>{title}</h3>
      {description && <p className={cx(tone.muted, "mt-1 text-[13px] leading-relaxed")}>{description}</p>}
      <div className="-ml-3 mt-1 flex flex-wrap gap-x-1">
        {suggestions.map((suggestion) => <AskChatButton key={suggestion.label} {...suggestion} />)}
      </div>
    </section>
  );
}
