"use client";

import { useState } from "react";
import { MAX_INVITES_AT_ONCE, type OnboardingView } from "@/lib/maple/onboarding/steps";
import { Icon } from "../icons";
import { Button, Chip, cx, tone } from "../ui";
import { StepShell, TextInput } from "./StepShell";
import type { InviteLink, Onboarding } from "./useOnboarding";

type Props = { ob: Onboarding; view: OnboardingView };
type Person = { name: string; role: "member" | "viewer" };

export function InvitesStep({ ob }: Props) {
  const [people, setPeople] = useState<Person[]>([{ name: "", role: "member" }]);
  const set = (i: number, p: Partial<Person>) => setPeople(people.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const filled = people.filter((p) => p.name.trim());
  return (
    <StepShell step="invites" ob={ob} canSave={filled.length > 0} saveLabel="Make links" onSave={() => void ob.answer("invites", { people: filled })}>
      {people.map((p, i) => (
        <div key={i} className={cx(tone.inset, "space-y-2.5 p-3")}>
          <TextInput label="Their first name" value={p.name} onChange={(name) => set(i, { name })} />
          <div className="flex flex-wrap gap-2">
            <Chip raised selected={p.role === "member"} onClick={() => set(i, { role: "member" })}>
              Can log
            </Chip>
            <Chip raised selected={p.role === "viewer"} onClick={() => set(i, { role: "viewer" })}>
              View only
            </Chip>
          </div>
        </div>
      ))}
      {people.length < MAX_INVITES_AT_ONCE && (
        <Button variant="soft" size="sm" onClick={() => setPeople([...people, { name: "", role: "member" }])}>
          <Icon name="plus" size={16} />
          Someone else
        </Button>
      )}
    </StepShell>
  );
}

/** The links the server just made: shown once, since only their hashes are kept. */
export function InviteLinks({ links }: { links: InviteLink[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!links.length) return null;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setCopied(null);
    }
  };
  const share = (l: InviteLink) => void navigator.share?.({ title: "Join our baby's log", text: `${l.name}, here's your link to join our log in Maple:`, url: l.url }).catch(() => {});
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label="Invite links">
      <p className={cx(tone.body, "text-[15px] leading-snug")}>Send each link to its person. It works once, for 7 days, and shows only here, so send it now.</p>
      {links.map((l) => (
        <div key={l.url} className={cx(tone.inset, "flex items-center gap-2 p-3")}>
          <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-medium")}>{l.name}</span>
          <Button size="sm" variant="soft" onClick={() => void copy(l.url)} aria-label={`Copy ${l.name}'s link`}>
            <Icon name={copied === l.url ? "check" : "copy"} size={16} />
            {copied === l.url ? "Copied" : "Copy"}
          </Button>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <Button size="sm" variant="soft" onClick={() => share(l)} aria-label={`Share ${l.name}'s link`}>
              <Icon name="share" size={16} />
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The birth parent's recovery page: offered once, made only when she says yes
 * for herself after reading what it holds and who sees it. For someone else,
 * it waits for them to join and turn it on.
 */
export function CareStep({ ob, consent: startAtConsent }: Props & { consent?: boolean }) {
  const [stage, setStage] = useState<"ask" | "consent">(startAtConsent ? "consent" : "ask");
  if (stage === "consent") {
    return (
      <StepShell step="care" ob={ob} saveLabel="I agree, turn it on" onSave={() => void ob.answer("care", { choice: "me", consent: true })}>
        <ul className={cx(tone.body, "list-disc space-y-2 pl-5 text-[15px] leading-relaxed")}>
          <li>Your page keeps your medicines and doses, your temperatures and your questions for your OB, apart from the baby&apos;s log.</li>
          <li>Everyone in this log who can log can see and add to it. View-only guests can&apos;t see it.</li>
          <li>It never tells you to take a medicine or how much. The chat sees it only if you turn that on yourself.</li>
          <li>You can delete everything on it any time, from its Settings.</li>
        </ul>
        <Button variant="ghost" size="sm" onClick={() => setStage("ask")}>
          Back
        </Button>
      </StepShell>
    );
  }
  return (
    <StepShell step="care" ob={ob} hideSave noSkip onSave={() => {}}>
      <div className="flex flex-col gap-2">
        <Button variant="soft" onClick={() => setStage("consent")}>
          Yes, it&apos;s for me
        </Button>
        <Button variant="soft" onClick={() => void ob.answer("care", { choice: "later" })}>
          It&apos;s for someone else
        </Button>
        <Button variant="ghost" onClick={() => void ob.answer("care", { choice: "no" })}>
          Not now
        </Button>
      </div>
      <p className={cx(tone.faint, "text-[13px] leading-snug")}>Someone else turns on their own page once they&apos;ve joined, signed in as themselves.</p>
    </StepShell>
  );
}

export function NotificationsStep({ ob }: Props) {
  return (
    <StepShell step="notifications" ob={ob} hideSave noSkip onSave={() => {}}>
      <div className="flex flex-col gap-2">
        <Button
          onClick={() => void ob.answer("notifications", { on: true })}
          disabled={ob.busy}
        >
          Set up after starting
        </Button>
        <p className={cx(tone.muted, "text-[14px] leading-snug")}>The phone&apos;s setup opens after you start logging. This choice does not turn notifications on.</p>
        <Button variant="ghost" onClick={() => void ob.answer("notifications", { on: false })} disabled={ob.busy}>
          Not now
        </Button>
      </div>
    </StepShell>
  );
}
