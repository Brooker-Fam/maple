"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import { cx } from "../ui";
import { useMaple } from "../useMaple";

/**
 * Opens the chat (Ask) from Today's button and More's first row. Mounted once
 * in MapleApp inside CareNav and the log sheets, so Help and Maple's own
 * sheets open on top of it. The sheet and the AI SDK load on first open, so
 * Today and the dock don't carry them.
 */

const ChatSheet = dynamic(() => import("./ChatSheet"), { ssr: false });

export type ChatNav = { openChat(): void };

const ChatNavContext = createContext<ChatNav>({ openChat: () => {} });

export function useChatNav(): ChatNav {
  return useContext(ChatNavContext);
}

export function ChatNavProvider({ children }: { children: ReactNode }) {
  const { state } = useMaple();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const openChat = useCallback(() => {
    setLoaded(true);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const nav = useMemo(() => ({ openChat }), [openChat]);
  return (
    <ChatNavContext.Provider value={nav}>
      {children}
      {state && loaded && <ChatSheet open={open} onClose={close} />}
    </ChatNavContext.Provider>
  );
}

/** Today's round Ask button, beside her name. */
export function AskButton({ className }: { className?: string }) {
  const { online } = useMaple();
  const { openChat } = useChatNav();
  return (
    <button
      type="button"
      onClick={openChat}
      disabled={!online}
      aria-label={online ? "Ask about Maple" : "Ask about Maple: needs a connection"}
      title={online ? undefined : "Needs a connection"}
      className={cx(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2 transition active:scale-95 disabled:opacity-40",
        className
      )}
    >
      <Icon name="message-square" size={20} />
    </button>
  );
}
