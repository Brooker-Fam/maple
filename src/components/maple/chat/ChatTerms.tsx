"use client";

import { useEffect, useState } from "react";
import type { ChatConsent } from "@/lib/maple/chat/types";
import { CHAT_TERMS_HELP, TRACKER_NOTE } from "@/lib/maple/guidelines";
import { SwitchRow } from "../care/parts";
import { useCare } from "../care/useCare";
import { LegalLinks } from "../Legal";
import { Button, cx, tone } from "../ui";
import { useChatNav } from "./ChatNav";

/**
 * The chat's consents on the phone (the server keeps them and enforces
 * them): the terms card before a member's first message, her switch for
 * letting the chat see her page, and the line everyone else reads while it's off.
 */

const CARE_SWITCH = "Let the chat see my medicines, temperatures and questions for my OB";

export function TermsCard({ consent, onAccepted }: { consent: ChatConsent; onAccepted: () => void }) {
  const { saveConsent } = useChatNav();
  const [care, setCare] = useState(consent.care);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    const saved = await saveConsent(consent.self ? { terms: true, care } : { terms: true });
    setBusy(false);
    if (saved) onAccepted();
  };
  return (
    <section aria-labelledby="chat-terms" className={cx(tone.card, "space-y-3 p-4")}>
      <h3 id="chat-terms" className={cx(tone.heading, "text-[17px]")}>
        Before you start
      </h3>
      <ul className={cx(tone.body, "list-disc space-y-2 pl-5 text-[15px] leading-relaxed")}>
        <li>{TRACKER_NOTE} The chat&apos;s answers come from an AI and can be wrong.</li>
        <li>{CHAT_TERMS_HELP}</li>
        <li>
          What you type or choose in the chat, and the parts of the log the chat reads to answer, are sent to an AI model through Vercel AI Gateway, with zero data retention
          and no training on it requested.
        </li>
      </ul>
      {consent.self ? (
        <div className={cx(tone.inset, "overflow-hidden")}>
          <SwitchRow label={CARE_SWITCH} note="Off, the chat leaves your page out. You can change this later in Family." checked={care} onChange={setCare} />
        </div>
      ) : (
        <CareNote consent={consent} />
      )}
      <LegalLinks className="-ml-2 justify-start" />
      <Button className="w-full" disabled={busy} onClick={() => void accept()}>
        {busy ? "Saving…" : "Accept"}
      </Button>
    </section>
  );
}

export function CareNote({ consent }: { consent: ChatConsent | null }) {
  const care = useCare();
  if (!care || !consent || consent.care) return null;
  return (
    <p className={cx(tone.muted, "text-[13px] leading-snug")}>
      {consent.self ? "The chat can't see your medicines, temperatures or questions for your OB. You can turn that on in Family." : `${care.name}'s medicines, temperatures and OB questions aren't available to the chat.`}
    </p>
  );
}

/** Hers alone, in Family and in her page's settings; nobody else sees it. */
export function ChatCareRow() {
  const care = useCare();
  const { consent, loadConsent, saveConsent } = useChatNav();
  const [busy, setBusy] = useState(false);
  const self = !!care?.self;
  useEffect(() => {
    if (self) loadConsent();
  }, [self, loadConsent]);
  if (!self) return null;
  const set = async (on: boolean) => {
    setBusy(true);
    await saveConsent({ care: on });
    setBusy(false);
  };
  return (
    <SwitchRow
      label={CARE_SWITCH}
      note="The Chat tab in this app. Off, it leaves your page out."
      checked={!!consent?.care}
      disabled={!consent?.self || busy}
      onChange={(on) => void set(on)}
    />
  );
}
