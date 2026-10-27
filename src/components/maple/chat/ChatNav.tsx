"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatConsent } from "@/lib/maple/chat/types";
import { useMaple } from "../useMaple";

/**
 * This member's chat consents, held once in MapleApp so the Chat tab's terms
 * card and her switch in Family and on her page agree.
 */

export type ConsentChange = { terms?: true; care?: boolean };

export type ChatNav = {
  /** Null until read (or when the read failed: the server still turns a message away without terms). */
  consent: ChatConsent | null;
  loadConsent(): void;
  saveConsent(change: ConsentChange): Promise<boolean>;
  /** A message was turned away for terms (raised version, or another phone): the card shows again. */
  termsNeeded(): void;
};

const ChatNavContext = createContext<ChatNav>({
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

  const nav = useMemo(() => ({ consent: mine, loadConsent, saveConsent, termsNeeded }), [mine, loadConsent, saveConsent, termsNeeded]);
  return (
    <ChatNavContext.Provider value={nav}>
      {children}
    </ChatNavContext.Provider>
  );
}
