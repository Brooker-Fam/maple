"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { MapleLeaf } from "@/components/maple/art";
import { Icon, type IconName } from "@/components/maple/icons";
import { cx, tone } from "@/components/maple/ui";

/**
 * /maple/connect — how to hook Maple's Log up to Claude and ChatGPT (the MCP
 * server at /api/maple/mcp). Unlinked on purpose, like the rest of /maple;
 * the Family tab points here. Outside the app shell, so it reads like one of
 * the app's own pages: the mp-* tokens (MapleUiScope sets the font and page
 * background), plain cards, line icons.
 */

const MCP_URL = "https://brooker.family/api/maple/mcp";
const CLAUDE_CODE_CMD = `claude mcp add --transport http maple ${MCP_URL}`;

const PROMPTS: { when: string; icon: IconName; lines: string[] }[] = [
  {
    when: "In the night",
    icon: "moon",
    lines: [
      "Log a wet diaper.",
      "Wet and dirty diaper, mustard and seedy.",
      "Start a feed on the right.",
      "Switch sides. … She's done.",
      "She nursed 12 min left then 8 right, finished 10 minutes ago.",
      "She fell asleep 10 minutes ago in the bassinet.",
      "Which side should I start on?",
    ],
  },
  {
    when: "In the morning",
    icon: "sun",
    lines: [
      "How did last night go?",
      "Gave her the vitamin D drops.",
      "How many wet diapers today? Is that enough for her age?",
      "Oops, undo that.",
    ],
  },
  {
    when: "Before a checkup",
    icon: "stethoscope",
    lines: [
      "She weighed 7 lb 9 oz on the doctor's scale.",
      "Add a question for the doctor: is the rash on her cheek okay?",
      "Make a summary for her 2-week visit.",
    ],
  },
  {
    when: "Just for fun",
    icon: "leaf",
    lines: [
      "Write Maple's week as a short storybook page for the grandparents.",
      "Write a letter to Maple about her first month.",
    ],
  },
];

/** A URL or command that wraps after its slashes on a phone, instead of mid-word ("http / s://"). */
function Breakable({ text }: { text: string }) {
  const parts = text.replace(/\/(?!\/)/g, "/\u0000").split("\u0000");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // ignore
        }
      }}
      aria-live="polite"
      className="relative inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-[10px] border border-mp-line bg-mp-surface px-3 text-[13px] font-semibold text-mp-ink transition after:absolute after:-inset-1 after:content-[''] active:scale-[0.97]"
    >
      <Icon name={copied ? "check" : "copy"} size={15} strokeWidth={2} />
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeBlock({ children, copyText }: { children: string; copyText?: string }) {
  return (
    <div className="relative">
      <pre className="rounded-xl bg-mp-sunken p-4 pr-24 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-mp-ink [overflow-wrap:anywhere]">
        <code>
          <Breakable text={children} />
        </code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={copyText ?? children} />
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded-md bg-mp-sunken px-1.5 py-0.5 font-mono text-[13px] text-mp-ink [overflow-wrap:anywhere]">
      <Breakable text={children} />
    </code>
  );
}

/** The step between two menu items ("Settings › Connectors"). */
function Then() {
  return <Icon name="chevron-right" size={14} strokeWidth={2} label="then" className="mx-0.5 inline align-[-2px] text-mp-ink-3" />;
}

/** A tip or a check, set into the card. */
function Note({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className={cx(tone.inset, "flex gap-3 p-3.5 text-sm leading-relaxed")}>
      <Icon name={icon} size={18} className="mt-0.5 shrink-0 text-mp-accent-fg" />
      <p>{children}</p>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-mp-accent-fg underline decoration-mp-accent-fg/30 underline-offset-2">
      {children}
    </a>
  );
}

function Section({ mark, title, children }: { mark: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className={cx(tone.card, "p-5 sm:p-6")}>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-mp-sunken text-[15px] font-semibold text-mp-ink-2">
          {mark}
        </span>
        <h2 className={cx(tone.heading, "text-[20px] leading-tight")}>{title}</h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-mp-ink [&_strong]:font-semibold">{children}</div>
    </section>
  );
}

export default function MapleConnectPage() {
  return (
    <div className="min-h-[100dvh]">
      <div className="mx-auto max-w-2xl px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-16 sm:pt-8">
        <Link href="/maple" className="-ml-2 inline-flex min-h-[44px] items-center gap-0.5 px-2 text-[15px] font-medium text-mp-accent-fg">
          <Icon name="chevron-left" size={20} />
          Maple&apos;s Log
        </Link>

        <header className="mt-4 mb-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-[16px] border border-mp-line bg-mp-surface">
            <MapleLeaf size={38} className="[.maple-night_&]:opacity-70" />
          </div>
          <h1 className={cx(tone.display, "mt-5 text-[34px] leading-[1.05] sm:text-[40px]")}>Just say it out loud</h1>
          <p className={cx(tone.muted, "mt-3 text-[15px] leading-relaxed sm:text-base")}>
            Connect Claude or ChatGPT to Maple&apos;s Log, then tell it what
            happened (&ldquo;wet and dirty diaper, mustard&rdquo;) or ask
            what you need to know (&ldquo;which side next?&rdquo;). It lands in
            the same log as the app, with your name on it.
          </p>
        </header>

        <div className="space-y-5">
          <section className={cx(tone.card, "space-y-4 p-5 sm:p-6")} aria-labelledby="connector-url">
            <div>
              <h2 id="connector-url" className={tone.label}>
                Connector URL
              </h2>
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-mp-sunken py-1.5 pr-1.5 pl-3.5">
                <code className="min-w-0 flex-1 font-mono text-[13px] text-mp-ink [overflow-wrap:anywhere] sm:text-sm">
                  <Breakable text={MCP_URL} />
                </code>
                <CopyButton text={MCP_URL} />
              </div>
            </div>
            <p className="text-[15px] leading-relaxed text-mp-ink [&_strong]:font-semibold">
              When it asks you to sign in, choose <strong>Continue with Google</strong>{" "}
              and use the same Google account you use for Maple&apos;s Log, then
              tap <strong>Approve</strong>.
            </p>
            <Note icon="calendar-check">
              <strong>Already have the Brooker Family Calendar connector?</strong>{" "}
              Maple&apos;s tools are in it too, so you can skip this. Reconnect it
              if Claude asks, then in Maple&apos;s Log <Then /> <strong>Family</strong>,
              turn on <strong>Calendar connector logs as me</strong>.
            </Note>
          </section>

          <Section mark="A" title="Claude (web, desktop & phone)">
            <p>
              Set it up once and it follows you everywhere you use Claude,
              including the Claude phone app. That makes it the most dependable
              option for night feeds.
            </p>
            <ol className="ml-5 list-decimal space-y-2 marker:text-mp-ink-3">
              <li>
                On <ExtLink href="https://claude.ai">claude.ai</ExtLink> or the Claude desktop app, open <strong>Customize</strong> <Then />{" "}
                <strong>Connectors</strong> (in some versions it&apos;s{" "}
                <strong>Settings</strong> <Then /> <strong>Connectors</strong>).
              </li>
              <li>
                Click <strong>Add custom connector</strong>. Name it{" "}
                <strong>Maple&apos;s Log</strong> and paste the URL:{" "}
                <Code>{MCP_URL}</Code>
              </li>
              <li>
                Click <strong>Connect</strong> <Then /> <strong>Continue with Google</strong>{" "}
                <Then /> <strong>Approve</strong>.
              </li>
              <li>
                That&apos;s it. It works on the web, the desktop app and the
                Claude phone app (same account). In a chat, make sure Maple&apos;s
                Log is switched on in the tools menu, then try{" "}
                <em>&ldquo;which side should I start on?&rdquo;</em>
              </li>
            </ol>
            <Note icon="lightbulb">
              <strong>Tip:</strong> in the connector&apos;s tool permissions, set
              the logging tools to <strong>Always allow</strong> so a 3am diaper
              is one sentence. Keep <strong>update_entry</strong>,{" "}
              <strong>delete_entry</strong> and <strong>undo_last</strong> on{" "}
              <strong>Needs approval</strong>.
            </Note>
          </Section>

          <Section mark="B" title="ChatGPT">
            <p>
              ChatGPT can connect too, but custom connectors are set up on{" "}
              <strong>chatgpt.com in a web browser</strong>, and whether you
              have them depends on your plan (they sit behind developer mode).
              The phone app may not show them yet, so Claude is the safer bet
              for the middle of the night.
            </p>
            <ol className="ml-5 list-decimal space-y-2 marker:text-mp-ink-3">
              <li>
                On <ExtLink href="https://chatgpt.com">chatgpt.com</ExtLink>, open <strong>Settings</strong> <Then />{" "}
                <strong>Apps &amp; Connectors</strong> (it may be called Apps or
                Plugins) <Then /> <strong>Advanced</strong>, and turn on{" "}
                <strong>Developer mode</strong>.
              </li>
              <li>
                Choose <strong>Create</strong> (or add a custom MCP server).
                Name: <strong>Maple&apos;s Log</strong>. URL:{" "}
                <Code>{MCP_URL}</Code>. Authentication: <strong>OAuth</strong>.
              </li>
              <li>
                Connect <Then /> <strong>Continue with Google</strong> <Then />{" "}
                <strong>Approve</strong>.
              </li>
              <li>
                In a chat, pick Maple&apos;s Log from the <strong>+</strong> /
                tools menu (or type <strong>@</strong>). ChatGPT asks before
                each log: tap <strong>Approve</strong> and choose to remember it
                for that chat.
              </li>
            </ol>
          </Section>

          <Section mark="C" title="Claude Code (terminal)">
            <p>For the terminal-inclined. Run this once:</p>
            <CodeBlock>{CLAUDE_CODE_CMD}</CodeBlock>
            <p>
              Then type <Code>/mcp</Code> in Claude Code, pick{" "}
              <strong>maple</strong> and choose <strong>Authenticate</strong>. A
              browser window opens for the same Google sign-in.
            </p>
          </Section>

          <Section mark={<Icon name="message-square" size={18} />} title="Things to say">
            <div className="grid gap-5 sm:grid-cols-2">
              {PROMPTS.map((group) => (
                <div key={group.when}>
                  <p className="mb-1.5 flex items-center gap-2 font-semibold">
                    <Icon name={group.icon} size={17} className="text-mp-ink-3" />
                    {group.when}
                  </p>
                  <ul className="space-y-1 text-mp-ink-2">
                    {group.lines.map((line) => (
                      <li key={line}>&ldquo;{line}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <Note icon="circle-check">
              <strong>How to tell it saved:</strong> every confirmation includes
              an entry number, like &ldquo;Saved #1234: wet diaper at 3:10 AM
              today.&rdquo; If it doesn&apos;t say <strong>&ldquo;Saved
              #…&rdquo;</strong>, it didn&apos;t save. Say &ldquo;undo
              that&rdquo; to take back the last thing you logged.
            </Note>
            <p>
              Times are Maple&apos;s local time (Eastern). &ldquo;Just
              now&rdquo;, &ldquo;20 minutes ago&rdquo;, &ldquo;at 3:10&rdquo; and
              &ldquo;yesterday at 11pm&rdquo; all work. If someone else already
              logged the same diaper or feed, it&apos;ll ask before adding a
              second one.
            </p>
            <p>
              A fever, an oxygen reading or a pale poop is checked as you log
              it, and the alert comes through word for word, the same as in
              the app. Feeding, diaper-count and weight warnings only come
              through if they&apos;re switched on in Family <Then /> Warnings
              &amp; reminders. It&apos;s general guidance, not medical
              advice: when in doubt, call the pediatrician.
            </p>
          </Section>

          <Section mark={<Icon name="lock" size={18} />} title="Who can connect">
            <p>
              Only people invited to Maple&apos;s Log can connect. Claude or
              ChatGPT signs in <em>as you</em>, so everything it logs shows your
              name and &ldquo;via Claude&rdquo; or &ldquo;via ChatGPT&rdquo;.
              Viewers can ask questions but can&apos;t add anything.
            </p>
            <p>
              To disconnect, remove the connector in Claude or ChatGPT. An owner
              can also remove someone in Maple&apos;s Log <Then />{" "}
              <strong>Family</strong>, which cuts off their connector too.
            </p>
          </Section>
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/maple"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-mp-sunken px-4 text-[15px] font-semibold text-mp-ink transition active:scale-[0.98]"
          >
            <Icon name="chevron-left" size={18} />
            Back to Maple&apos;s Log
          </Link>
        </div>
      </div>
    </div>
  );
}
