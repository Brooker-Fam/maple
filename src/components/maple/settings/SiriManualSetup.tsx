"use client";

import { useState } from "react";
import { SIRI_SHORTCUTS } from "@/lib/maple/siri-shortcuts";
import { useCare } from "../care/useCare";
import { cx, tone } from "../ui";
import { Code, CopyButton, Disclosure } from "./parts";

export default function SiriManualSetup({ url, fresh }: { url: string; fresh: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure label="Advanced setup" open={open} onToggle={() => setOpen((value) => !value)}>
      <p className="mb-3 text-sm text-mp-ink-2">Build your own shortcut, or add bottle amounts and medicine actions.</p>
      <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-mp-ink-2">
        <li>In Shortcuts, tap + and name it <strong className="text-mp-ink">Maple status</strong>.</li>
        <li>Add <strong className="text-mp-ink">Get Contents of URL</strong>, set Method to POST, and use this URL:
          <span className="mt-2 flex items-center gap-2"><Code>{url}</Code><CopyButton text={url} /></span>
        </li>
        <li>Add the header <Code>Authorization</Code> with the value <Code>{`Bearer ${fresh ?? "YOUR_KEY"}`}</Code>.</li>
        <li>Choose a JSON body. Add a Text field with key <Code>action</Code> and value <Code>status</Code>.</li>
        <li>Add <strong className="text-mp-ink">Get Dictionary Value</strong> for <Code>speak</Code> in Contents of URL, then <strong className="text-mp-ink">Speak Text</strong> with that value.</li>
      </ol>
      <table className="mt-4 w-full text-left text-sm">
        <caption className="pb-2 text-left font-medium text-mp-ink">Other commands</caption>
        <tbody className={tone.divide}>{SIRI_SHORTCUTS.slice(1).map((shortcut) => (
          <tr key={shortcut.action}><td className="py-2 pr-2 text-mp-ink-2">{shortcut.name}</td><td><Code>{shortcut.action}</Code></td></tr>
        ))}</tbody>
      </table>
      <p className="mt-3 text-sm text-mp-ink-2">For a bottle, use <Code>bottle</Code> and add the Number field <Code>amount_oz</Code>. Vitamin D uses <Code>vitamin_d</Code>.</p>
      <MomShortcut url={url} />
    </Disclosure>
  );
}

function MomShortcut({ url }: { url: string }) {
  const care = useCare();
  const [open, setOpen] = useState(false);
  if (!care?.access?.write) return null;
  const strong = "font-semibold text-mp-ink";
  return (
    <Disclosure
      label={care.self ? "Your medicines" : `${care.name}'s medicines`}
      summary="One shortcut for all"
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <p className={cx(tone.body, "text-sm leading-relaxed")}>
        One shortcut, <strong className={strong}>Mom meds</strong>, covers every medicine on {care.self ? "your" : "her"} list. Its Get Contents of URL
        actions are set up like the ones above: the same URL <Code>{url}</Code>, <strong className={strong}>POST</strong>, and the same Authorization
        header.
      </p>
      <ol className={cx(tone.body, "mt-3 list-decimal space-y-3 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-mp-ink-3")}>
        <li>
          <strong className={strong}>Get Contents of URL</strong> with a JSON body: <Code>action</Code> = <Code>mom_status</Code>. Then{" "}
          <strong className={strong}>Choose from List</strong> over its <Code>plans</Code>, showing each one&apos;s <Code>label</Code>.
        </li>
        <li>
          <strong className={strong}>Get Contents of URL</strong> again: <Code>action</Code> = <Code>mom_dose</Code>, and a Text field <Code>med</Code>{" "}
          set to the chosen item&apos;s <Code>id</Code>.
        </li>
        <li>
          If <Code>needs_confirm</Code> is true (someone logged it in the last half hour): <strong className={strong}>Choose from Menu</strong> with{" "}
          <Code>speak</Code> as the prompt, Yes and No. On Yes, call again with a Boolean field <Code>confirm</Code> set to true.
        </li>
        <li>
          <strong className={strong}>Speak Text</strong> with <Code>speak</Code>.
        </li>
        <li>
          Optional, for an alarm that rings through Silent: if <Code>next_ok_in_minutes</Code> is a number, <strong className={strong}>Start Timer</strong>{" "}
          for that many minutes.
        </li>
      </ol>
      <p className={cx(tone.muted, "mt-3 text-[13px] leading-snug")}>
        A timer, or Apple Reminders at <Code>next_ok_at</Code>, not a calendar: family calendars show on the kitchen display.
      </p>
    </Disclosure>
  );
}


