"use client";

import { useState } from "react";
import type { Voice } from "@/lib/maple/voice";
import { useVoice } from "../familyWords";
import { cx, tone } from "../ui";
import { Code, Disclosure } from "./parts";

/**
 * Siri & assistants → Sleep plan shortcuts: the sleep plan's phrases for
 * POST /api/maple/quick, and three ways to run one without opening the app
 * (Back Tap, the Action Button, an NFC sticker on the bassinet). Shortcuts
 * are built by duplicating Maple status and changing its action, so the
 * key stays the one already pasted there. The words use the family's own
 * pronouns for the baby.
 */

/** What to say, the action, the second Text field (key: value) where there is one, and what it does when that isn't plain. */
const phrases = (v: Voice): { say: string; action: string; field?: string; or?: string; does?: string }[] => [
  { say: "Maple put down", action: "put_down", does: "Right after a retry that ended awake, it says the plan pauses until the next try; say it again to try anyway." },
  { say: "Maple stayed asleep", action: "outcome", field: "outcome: stayed_asleep" },
  { say: "Maple woke calm", action: "outcome", field: "outcome: woke_calm" },
  { say: "Maple woke crying", action: "outcome", field: "outcome: woke_crying" },
  { say: "Maple picked up", action: "outcome", field: "outcome: picked_up" },
  { say: "Maple asleep in arms", action: "asleep_in_arms" },
  {
    say: "Maple handoff",
    action: "handoff",
    does: `Holding ${v.them}, or with nobody on a turn: asks the other adult to take over, and their phone only sounds if handoff reminders are on, so go wake them. Anyone else: you have ${v.them} now, with a catch-up.`,
  },
  { say: "Maple, what did I miss?", action: "recap", does: "What was logged since your protected sleep began (or since you last opened the app), what's going on now, and the next side. It changes nothing." },
  { say: "Maple check in", action: "checkin", field: "answer: yes", or: "or partly, no" },
  { say: "Maple undo", action: "undo" },
];

const WAYS: { label: string; how: string }[] = [
  { label: "Back Tap", how: "Settings → Accessibility → Touch → Back Tap → Double Tap or Triple Tap, then pick a shortcut, such as Maple put down." },
  { label: "Action Button", how: "On an iPhone that has one: Settings → Action Button → Shortcut, then pick one." },
  { label: "A sticker on the bassinet", how: "With an NFC sticker: in Shortcuts, Automation → New Automation → NFC, scan the sticker, choose Run Immediately, and pick Maple put down. Holding your iPhone to the sticker starts a bassinet try." },
];

export default function SiriSleepGuide() {
  const [open, setOpen] = useState(false);
  const v = useVoice();
  return (
    <Disclosure label="Sleep plan shortcuts" summary="Back Tap, Action Button, NFC" open={open} onToggle={() => setOpen((x) => !x)}>
      <p className={cx(tone.body, "text-sm leading-relaxed")}>
        Make one shortcut per phrase: in Shortcuts, duplicate Maple status, rename it to what you&apos;ll say, and change <Code>action</Code>. Outcomes and check-ins add a second Text field.
      </p>
      <ul className={cx(tone.divide, "mt-2")} aria-label="Sleep plan phrases">
        {phrases(v).map((p) => (
          <li key={p.say} className="py-2 text-sm">
            <span className={cx(tone.body, "block")}>{p.say}</span>
            {p.does && <span className={cx(tone.muted, "mt-0.5 block text-[13px] leading-snug")}>{p.does}</span>}
            <span className="mt-1 flex flex-wrap items-baseline gap-1">
              <Code>{p.action}</Code>
              {p.field && <Code>{p.field}</Code>}
              {p.or && <span className={cx(tone.muted, "text-[13px]")}>{p.or}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className={cx(tone.muted, "mt-3 text-[13px] leading-relaxed")}>
        For something a few minutes ago, add a Number field <Code>minutes_ago</Code> (up to 240) to Maple sleep, Maple awake or Maple put down. Maple undo takes back the last thing you did with Siri in the past 30 minutes, if nobody has changed it since.
      </p>
      <dl className="mt-4 space-y-3 text-sm">
        {WAYS.map((w) => (
          <div key={w.label}>
            <dt className={cx(tone.body, "font-semibold")}>{w.label}</dt>
            <dd className={cx(tone.muted, "leading-relaxed")}>{w.how}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}
