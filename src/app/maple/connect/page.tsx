"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

/**
 * /maple/connect — how to hook Maple's Log up to Claude and ChatGPT (the MCP
 * server at /api/maple/mcp). Unlinked on purpose, like the rest of /maple;
 * the Family tab points here.
 */

const MCP_URL = "https://brooker.family/api/maple/mcp";
const CLAUDE_CODE_CMD = `claude mcp add --transport http maple ${MCP_URL}`;

const PROMPTS: { when: string; emoji: string; lines: string[] }[] = [
  {
    when: "In the night",
    emoji: "🌙",
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
    emoji: "☀️",
    lines: [
      "How did last night go?",
      "Gave her the vitamin D drops.",
      "How many wet diapers today? Is that enough for her age?",
      "Oops, undo that.",
    ],
  },
  {
    when: "Before a checkup",
    emoji: "🩺",
    lines: [
      "She weighed 7 lb 9 oz on the doctor's scale.",
      "Add a question for the doctor: is the rash on her cheek okay?",
      "Make a summary for her 2-week visit.",
    ],
  },
  {
    when: "Just for fun",
    emoji: "🍂",
    lines: [
      "Write Maple's week as a short storybook page for the grandparents.",
      "Write a letter to Maple about her first month.",
    ],
  },
];

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
      className="rounded-full border border-[#5C7A4A]/40 bg-[#5C7A4A]/10 px-3 py-1 text-xs font-medium text-[#1D4420] transition hover:bg-[#5C7A4A]/20 dark:border-[#C49A3C]/35 dark:bg-[#C49A3C]/10 dark:text-[#F0DDB0] dark:hover:bg-[#C49A3C]/20"
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function CodeBlock({ children, copyText }: { children: string; copyText?: string }) {
  return (
    <div className="relative">
      <pre className="rounded-xl border border-[#1D4420]/15 bg-[#FDF8F0]/80 p-4 pr-20 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-[#1D4420] dark:border-[#FDF8F0]/15 dark:bg-[#0F1B11]/80 dark:text-[#E8DCC0] sm:text-sm">
        <code>{children}</code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={copyText ?? children} />
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[#1D4420]/5 px-1.5 py-0.5 font-mono text-xs break-all dark:bg-[#FDF8F0]/8">
      {children}
    </code>
  );
}

function Section({
  badge,
  title,
  children,
  accent = "sage",
}: {
  badge: string;
  title: string;
  children: React.ReactNode;
  accent?: "sage" | "lavender" | "blush" | "gold";
}) {
  const accentColors = {
    sage: "border-[#5C7A4A]/25 bg-[#5C7A4A]/5 dark:border-[#5C7A4A]/25 dark:bg-[#5C7A4A]/8",
    lavender: "border-[#B8A9C9]/30 bg-[#B8A9C9]/8 dark:border-[#B8A9C9]/20 dark:bg-[#B8A9C9]/8",
    blush: "border-[#E8C8B8]/60 bg-[#E8C8B8]/15 dark:border-[#E8C8B8]/20 dark:bg-[#E8C8B8]/8",
    gold: "border-[#C49A3C]/30 bg-[#C49A3C]/6 dark:border-[#C49A3C]/20 dark:bg-[#C49A3C]/8",
  };
  const badgeColors = {
    sage: "bg-[#5C7A4A]/20 text-[#1D4420] dark:bg-[#5C7A4A]/30 dark:text-[#D4E2C4]",
    lavender: "bg-[#B8A9C9]/30 text-[#4A1A2A] dark:bg-[#B8A9C9]/25 dark:text-[#E2D8EC]",
    blush: "bg-[#E8C8B8]/50 text-[#4A1A2A] dark:bg-[#E8C8B8]/20 dark:text-[#F4E2D8]",
    gold: "bg-[#C49A3C]/25 text-[#5A3E12] dark:bg-[#C49A3C]/25 dark:text-[#F0DDB0]",
  };
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.5 }}
      className={`rounded-2xl border ${accentColors[accent]} p-5 sm:p-7`}
    >
      <div className="mb-4 flex items-center gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${badgeColors[accent]}`}
        >
          {badge}
        </span>
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold text-[#1D4420] dark:text-[#FDF8F0] sm:text-3xl">
          {title}
        </h2>
      </div>
      <div className="space-y-4 font-[family-name:var(--font-body)] text-sm leading-relaxed text-[#1D4420]/85 dark:text-[#FDF8F0]/80 sm:text-base">
        {children}
      </div>
    </motion.section>
  );
}

export default function MapleConnectPage() {
  return (
    <div className="enchanted-bg relative min-h-screen overflow-hidden">
      <div className="mx-auto max-w-3xl px-4 pt-12 pb-16 sm:pt-16">
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-10 text-center"
        >
          <div className="mb-3 text-4xl" aria-hidden="true">
            🍁
          </div>
          <div className="mb-2 font-[family-name:var(--font-body)] text-xs font-medium tracking-widest text-[#5C7A4A] uppercase dark:text-[#C0D4A8] sm:text-sm">
            Maple&apos;s Log · for the grown-ups
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold text-[#1D4420] dark:text-[#FDF8F0] sm:text-5xl">
            Just say it out loud
          </h1>
          <p className="mx-auto mt-4 max-w-xl font-[family-name:var(--font-body)] text-sm text-[#4A1A2A] dark:text-[#FDF8F0]/80 sm:text-base">
            Connect Claude or ChatGPT to Maple&apos;s Log, then tell it what
            happened (&ldquo;wet and dirty diaper, mustard&rdquo;) or ask
            what you need to know (&ldquo;which side next?&rdquo;). It lands in
            the same log as the app, with your name on it. Handy at 3am with one
            hand free.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mb-8 rounded-2xl border border-[#C49A3C]/35 bg-[#FDF8F0]/70 p-5 backdrop-blur-sm dark:border-[#C49A3C]/25 dark:bg-[#162618]/75 sm:p-6"
        >
          <p className="mb-3 font-[family-name:var(--font-body)] text-xs font-semibold tracking-widest text-[#5A3E12]/80 uppercase dark:text-[#F0DDB0]/80">
            Connector URL
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg bg-[#1D4420]/5 px-3 py-2 font-mono text-[13px] break-all text-[#1D4420] dark:bg-[#FDF8F0]/8 dark:text-[#E8DCC0] sm:text-sm">
              {MCP_URL}
            </code>
            <CopyButton text={MCP_URL} />
          </div>
          <p className="mt-4 font-[family-name:var(--font-body)] text-sm text-[#1D4420]/80 dark:text-[#FDF8F0]/75">
            When it asks you to sign in, choose <strong>Continue with Google</strong>{" "}
            and use the same Google account you use for Maple&apos;s Log, then
            tap <strong>Approve</strong>.
          </p>
          <p className="mt-3 font-[family-name:var(--font-body)] text-sm text-[#1D4420]/80 dark:text-[#FDF8F0]/75">
            <strong>Already have the Brooker Family Calendar connector?</strong>{" "}
            Maple&apos;s tools are in it too, so you can skip this. Reconnect it
            if Claude asks, then in Maple&apos;s Log &rarr; <strong>Family</strong>,
            turn on <strong>Calendar connector logs as me</strong>.
          </p>
        </motion.div>

        <div className="space-y-5">
          <Section badge="A" title="Claude (web, desktop & phone)" accent="lavender">
            <p>
              Set it up once and it follows you everywhere you use Claude,
              including the Claude phone app. That makes it the most dependable
              option for night feeds.
            </p>
            <ol className="ml-5 list-decimal space-y-2">
              <li>
                On{" "}
                <a
                  href="https://claude.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-[#B8A9C9] decoration-2 underline-offset-2"
                >
                  claude.ai
                </a>{" "}
                or the Claude desktop app, open <strong>Customize</strong> &rarr;{" "}
                <strong>Connectors</strong> (in some versions it&apos;s{" "}
                <strong>Settings</strong> &rarr; <strong>Connectors</strong>).
              </li>
              <li>
                Click <strong>Add custom connector</strong>. Name it{" "}
                <strong>Maple&apos;s Log</strong> and paste the URL:{" "}
                <Code>{MCP_URL}</Code>
              </li>
              <li>
                Click <strong>Connect</strong> &rarr; <strong>Continue with Google</strong>{" "}
                &rarr; <strong>Approve</strong>.
              </li>
              <li>
                That&apos;s it. It works on the web, the desktop app and the
                Claude phone app (same account). In a chat, make sure Maple&apos;s
                Log is switched on in the tools menu, then try{" "}
                <em>&ldquo;which side should I start on?&rdquo;</em>
              </li>
            </ol>
            <p className="rounded-xl bg-[#B8A9C9]/12 p-3 text-sm dark:bg-[#B8A9C9]/10">
              <strong>Tip:</strong> in the connector&apos;s tool permissions, set
              the logging tools to <strong>Always allow</strong> so a 3am diaper
              is one sentence. Keep <strong>update_entry</strong>,{" "}
              <strong>delete_entry</strong> and <strong>undo_last</strong> on{" "}
              <strong>Needs approval</strong>.
            </p>
          </Section>

          <Section badge="B" title="ChatGPT" accent="gold">
            <p>
              ChatGPT can connect too, but custom connectors are set up on{" "}
              <strong>chatgpt.com in a web browser</strong>, and whether you
              have them depends on your plan (they sit behind developer mode).
              The phone app may not show them yet, so Claude is the safer bet
              for the middle of the night.
            </p>
            <ol className="ml-5 list-decimal space-y-2">
              <li>
                On{" "}
                <a
                  href="https://chatgpt.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-[#C49A3C] decoration-2 underline-offset-2"
                >
                  chatgpt.com
                </a>
                , open <strong>Settings</strong> &rarr;{" "}
                <strong>Apps &amp; Connectors</strong> (it may be called Apps or
                Plugins) &rarr; <strong>Advanced</strong>, and turn on{" "}
                <strong>Developer mode</strong>.
              </li>
              <li>
                Choose <strong>Create</strong> (or add a custom MCP server).
                Name: <strong>Maple&apos;s Log</strong>. URL:{" "}
                <Code>{MCP_URL}</Code>. Authentication: <strong>OAuth</strong>.
              </li>
              <li>
                Connect &rarr; <strong>Continue with Google</strong> &rarr;{" "}
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

          <Section badge="C" title="Claude Code (terminal)" accent="sage">
            <p>For the terminal-inclined. Run this once:</p>
            <CodeBlock>{CLAUDE_CODE_CMD}</CodeBlock>
            <p>
              Then type <Code>/mcp</Code> in Claude Code, pick{" "}
              <strong>maple</strong> and choose <strong>Authenticate</strong>. A
              browser window opens for the same Google sign-in.
            </p>
          </Section>

          <Section badge="✦" title="Things to say" accent="blush">
            <div className="grid gap-4 sm:grid-cols-2">
              {PROMPTS.map((group) => (
                <div key={group.when}>
                  <p className="mb-1.5 font-semibold text-[#4A1A2A] dark:text-[#F4E2D8]">
                    <span aria-hidden="true">{group.emoji}</span> {group.when}
                  </p>
                  <ul className="ml-5 list-disc space-y-1">
                    {group.lines.map((line) => (
                      <li key={line}>
                        <em>&ldquo;{line}&rdquo;</em>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="rounded-xl bg-[#E8C8B8]/25 p-3 text-sm dark:bg-[#E8C8B8]/10">
              <strong>How to tell it saved:</strong> every confirmation includes
              an entry number, like &ldquo;Saved #1234: wet diaper at 3:10 AM
              today.&rdquo; If it doesn&apos;t say <strong>&ldquo;Saved
              #…&rdquo;</strong>, it didn&apos;t save. Say &ldquo;undo
              that&rdquo; to take back the last thing you logged.
            </p>
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
              through if they&apos;re switched on in Family &rarr; Warnings
              &amp; reminders. It&apos;s general guidance, not medical
              advice: when in doubt, call the pediatrician.
            </p>
          </Section>

          <Section badge="🔒" title="Who can connect" accent="sage">
            <p>
              Only people invited to Maple&apos;s Log can connect. Claude or
              ChatGPT signs in <em>as you</em>, so everything it logs shows your
              name and &ldquo;via Claude&rdquo; or &ldquo;via ChatGPT&rdquo;.
              Viewers can ask questions but can&apos;t add anything.
            </p>
            <p>
              To disconnect, remove the connector in Claude or ChatGPT. An owner
              can also remove someone in Maple&apos;s Log &rarr;{" "}
              <strong>Family</strong>, which cuts off their connector too.
            </p>
          </Section>
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/maple"
            className="inline-flex items-center gap-2 rounded-full border border-[#5C7A4A]/40 bg-[#5C7A4A]/10 px-5 py-2 font-[family-name:var(--font-body)] text-sm font-medium text-[#1D4420] transition hover:bg-[#5C7A4A]/20 dark:border-[#C49A3C]/35 dark:bg-[#C49A3C]/10 dark:text-[#F0DDB0]"
          >
            &larr; Back to Maple&apos;s Log
          </Link>
        </div>
      </div>
    </div>
  );
}
