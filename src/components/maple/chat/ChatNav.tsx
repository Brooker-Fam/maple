"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatConsent } from "@/lib/maple/chat/types";
import { Icon } from "../icons";
import { cx } from "../ui";
import { useMaple } from "../useMaple";

/**
 * Opens the chat (Ask) from Today's button and More's first row. Mounted once
 * in MapleApp inside CareNav and the log sheets, so Help and Maple's own
 * sheets open on top of it. The sheet and the AI SDK load on first open, so
 * Today and the dock don't carry them. It also holds this member's chat
 * consents, so the sheet's terms card and her switch in Family and on her
 * page agree.
 */

const ChatSheet = dynamic(() => import("./ChatSheet"), { ssr: false });

export type ConsentChange = { terms?: true; care?: boolean };

export type ChatNav = {
  openChat(): void;
  /** Null until read (or when the read failed: the server still turns a message away without terms). */
  consent: ChatConsent | null;
  loadConsent(): void;
  saveConsent(change: ConsentChange): Promise<boolean>;
  /** A message was turned away for terms (raised version, or another phone): the card shows again. */
  termsNeeded(): void;
};

const ChatNavContext = createContext<ChatNav>({
  openChat: () => {},
  consent: null,
  loadConsent: () => {},
  saveConsent: async () => false,
  termsNeeded: () => {},
});

export function useChatNav(): ChatNav {
  return useContext(ChatNavContext);
}

export function ChatNavProvider({ children }: { children: ReactNode }) {
  const { state, api, toast } = useMaple();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const me = state?.me.email ?? null;
  const [consent, setConsent] = useState<{ me: string | null; value: ChatConsent } | null>(null);
  const reading = useRef(false);
  const mine = consent?.me === me ? consent.value : null;

  const loadConsent = useCallback(() => {
    if (reading.current || !me) return;
    reading.current = true;
    api<ChatConsent>("/api/maple/chat/consent")
      .then((value) => setConsent({ me, value }))
      .catch(() => {})
      .finally(() => {
        reading.current = false;
      });
  }, [api, me]);

  const saveConsent = useCallback(
    async (change: ConsentChange) => {
      try {
        const value = await api<ChatConsent>("/api/maple/chat/consent", { method: "POST", body: JSON.stringify(change) });
        setConsent({ me, value });
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
        return false;
      }
    },
    [api, me, toast]
  );

  const termsNeeded = useCallback(() => {
    setConsent((c) => ({ me, value: { care: false, self: false, ...(c?.me === me ? c.value : {}), terms: false } }));
    loadConsent();
  }, [loadConsent, me]);

  const openChat = useCallback(() => {
    setLoaded(true);
    setOpen(true);
    loadConsent();
  }, [loadConsent]);
  const close = useCallback(() => setOpen(false), []);
  const nav = useMemo(() => ({ openChat, consent: mine, loadConsent, saveConsent, termsNeeded }), [openChat, mine, loadConsent, saveConsent, termsNeeded]);
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
