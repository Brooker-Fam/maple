"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminActsAs } from "@/lib/maple/insights";
import { MAPLE_ORIGIN, MCP_URL } from "@/lib/maple/origin";
import { formatRelative } from "@/lib/maple/time";
import { useCare } from "../care/useCare";
import { useBabyWords, useFamilyOne } from "../familyWords";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { Code, CopyButton, DANGER_TEXT, Disclosure, GROUP, Section, Toggle } from "./parts";

type PersonalToken = { id: number; label: string | null; created_at: string; last_used_at: string | null };

const EXAMPLES = ["“Log a wet diaper.”", "“Start a feed on the right.”", "“Which side next?”", "“How did last night go?”", "“Add a question for the doctor.”"];
/** Her side of the connector, with her name (no real medicine names: the repo is public). */
const momExamples = (name: string) => [`“When is ${name}'s medicine OK again?”`, `“${name} took her pill.”`, `“Here's a photo of her discharge sheet.”`];

export default function AssistantSettings() {
  return (
    <><ConnectAI /><HandsFree /></>
  );
}

// ── Claude / ChatGPT ─────────────────────────────────────────────────────

function ConnectAI() {
  const [manual, setManual] = useState(false);
  const care = useCare();
  const examples = (label: string, list: string[]) => (
    <ul className="space-y-1 border-l-2 border-mp-line pl-3" aria-label={label}>
      {list.map((s) => (
        <li key={s} className={cx(tone.muted, "text-[15px] leading-snug")}>
          {s}
        </li>
      ))}
    </ul>
  );
  return (
    <Section title="Talk to Maple's Log">
      <div className={GROUP}>
        <div className="space-y-3 px-4 py-3.5">
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Connect Claude or ChatGPT and just say what happened. It lands here with your name on it, and you can ask questions too.
          </p>
          {examples("Things you can say", EXAMPLES)}
          {care && (
            <>
              <p className={cx(tone.label, "pt-1")}>For {care.name}</p>
              {examples(`Things you can say for ${care.name}`, momExamples(care.name))}
              <p className={cx(tone.muted, "text-[13px] leading-snug")}>
                From a photo of a label or discharge sheet, Claude reads every medicine and number back to you and adds them only after you say yes. It
                never fills in a number that isn&apos;t on the paper.
              </p>
            </>
          )}
        </div>
        <Link href="/maple/connect" className={cx(tone.row, "min-h-[52px]")}>
          <Icon name="list-checks" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="flex-1 text-[15px] font-medium text-mp-accent-fg">Step-by-step setup</span>
          <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
        </Link>
        <Disclosure label="Where to add it" summary="Claude, ChatGPT" open={manual} onToggle={() => setManual((v) => !v)}>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className={cx(tone.body, "font-semibold")}>Claude (web, desktop, phone)</dt>
              <dd className={tone.muted}>Settings → Connectors → Add custom connector, then sign in to Maple.</dd>
            </div>
            <div>
              <dt className={cx(tone.body, "font-semibold")}>ChatGPT</dt>
              <dd className={tone.muted}>Settings → Connectors, with developer mode on.</dd>
            </div>
            <div>
              <dt className={cx(tone.body, "font-semibold")}>Claude Code</dt>
              <dd className={cx(tone.muted, "mt-1 flex items-start gap-2")}>
                <Code>claude mcp add --transport http maple {MCP_URL}</Code>
                <CopyButton text={`claude mcp add --transport http maple ${MCP_URL}`} />
              </dd>
            </div>
          </dl>
        </Disclosure>
        <CalendarConnectorAsMe />
      </div>
    </Section>
  );
}

/**
 * The "Brooker Family Calendar" connector (the site admin login) carries
 * Maple's tools too. An owner can have what it logs count as them, so it
 * isn't split off under "Admin".
 */
function CalendarConnectorAsMe() {
  const { state, api, refresh, toast, memberName } = useMaple();
  const w = useBabyWords();
  const one = useFamilyOne();
  const [busy, setBusy] = useState(false);
  const me = state?.me;
  if (!one || !state || !me || me.role !== "owner" || me.email === "admin") return null;
  const raw = (state.baby.settings as { admin_as?: unknown }).admin_as;
  const stored = typeof raw === "string" ? raw : null;
  const someoneElse = stored && stored !== me.email && adminActsAs(state.baby, state.members) ? stored : null;

  const set = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ settings: { admin_as: on ? me.email : null } }) });
      await refresh();
      toast(on ? "The calendar connector logs as you now" : "The calendar connector logs as Admin");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Toggle
      label="Calendar connector logs as me"
      hint={`The Brooker Family Calendar connector (the site's admin login) can log ${w.name} too. ${
        someoneElse ? `Right now it logs as ${memberName(someoneElse)}.` : "Turn this on so what it logs counts as you, not “Admin”."
      }`}
      checked={stored === me.email}
      disabled={busy}
      onChange={(v) => void set(v)}
    />
  );
}

// ── Siri / iOS Shortcuts ─────────────────────────────────────────────────

const SHORTCUTS: [string, string][] = [
  ["Maple pee", "pee"],
  ["Maple poop", "poop"],
  ["Maple both", "both"],
  ["Maple left", "nurse_left"],
  ["Maple right", "nurse_right"],
  ["Maple switch", "switch"],
  // With a feed running: both sides from now, so no Switch per side (Left / Right track sides again).
  ["Maple back and forth", "back_and_forth"],
  ["Maple stop", "stop"],
  ["Maple sleep", "sleep"],
  ["Maple awake", "wake"],
  ["Maple status", "status"],
];

const KEY_MARK = "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2";

function HandsFree() {
  const { api, toast, now } = useMaple();
  const w = useBabyWords();
  const one = useFamilyOne();
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [origin, setOrigin] = useState(MAPLE_ORIGIN);

  useEffect(() => {
    setOrigin(window.location.origin);
    api<{ tokens: PersonalToken[] }>("/api/maple/tokens")
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]));
  }, [api]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ token: string; record: PersonalToken }>("/api/maple/tokens", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || "iPhone Shortcuts" }),
      });
      setFresh(r.token);
      setTokens((t) => [r.record, ...(t ?? [])]);
      setLabel("");
      setHowTo(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't make a key", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: PersonalToken) => {
    try {
      const r = await api<{ tokens: PersonalToken[] }>(`/api/maple/tokens?id=${t.id}`, { method: "DELETE" });
      setTokens(r.tokens);
      toast("Key revoked. Shortcuts using it stop working.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke", { tone: "error" });
    }
  };

  const url = `${origin}/api/maple/quick`;
  const header = `Bearer ${fresh ?? "<your key>"}`;
  const strong = "font-semibold text-mp-ink";

  return (
    <Section title="Hands-free with Siri">
      <div className={GROUP}>
        <p className={cx(tone.body, "px-4 pt-3.5 text-[15px] leading-relaxed")}>
          Say <strong className="font-semibold">“Hey Siri, Maple pee”</strong> and it&apos;s logged, no unlocking or tapping. Each grown-up makes their
          own key, so entries carry their name.
        </p>
        <div className="flex gap-3 px-4 pt-2.5 pb-3.5">
          <Icon name="lightbulb" size={18} className="mt-0.5 shrink-0 text-mp-ink-3" />
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>
            One press, phone locked: put a shortcut on the Action Button (Settings → Action Button → Shortcut) or on the Lock Screen (press and hold
            it, Customize, then add a control), or use Back Tap (Settings → Accessibility → Touch → Back Tap).
          </p>
        </div>

        {tokens &&
          tokens.map((t) => (
            <div key={t.id} className="flex min-h-[56px] items-center gap-3 px-4 py-2">
              <span className={KEY_MARK} aria-hidden>
                <Icon name="key-round" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cx(tone.body, "truncate text-[15px] font-medium")}>{t.label || "iPhone Shortcuts"}</p>
                <p className={cx(tone.muted, "text-[13px]")}>{t.last_used_at ? `Last used ${formatRelative(t.last_used_at, now())}` : "Not used yet"}</p>
              </div>
              <button type="button" onClick={() => void revoke(t)} className={DANGER_TEXT}>
                Revoke
              </button>
            </div>
          ))}

        {fresh ? (
          <div className="space-y-2.5 px-4 py-3.5">
            <p className={tone.label}>Your new key · shown once</p>
            <div className={cx(tone.inset, "px-3 py-2.5")}>
              <p className="font-mono text-[13px] break-all text-mp-ink select-all">{fresh}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={fresh} label="Copy key" />
              {/* Dismisses this key (it was shown once) and brings back the form for another. */}
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                <Icon name="plus" size={16} strokeWidth={2} />
                Make another key
              </Button>
            </div>
            <p className={cx(tone.muted, "text-[13px] leading-snug")}>Keep it private: anyone with it can log as you.</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            className="flex items-center gap-1 py-1.5 pr-2 pl-1.5"
          >
            {/* The same "add" mark as a new doctor question, so it doesn't read as one of the keys. */}
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-mp-accent-fg" aria-hidden>
              <Icon name="plus" size={20} strokeWidth={2} />
            </span>
            <input
              className="min-h-[44px] min-w-0 flex-1 bg-transparent text-base text-mp-ink outline-none placeholder:text-mp-ink-3"
              value={label}
              maxLength={40}
              placeholder={one ? "Matt's iPhone" : "My iPhone"}
              aria-label="Key name"
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy} className="shrink-0">
              Make a key
            </Button>
          </form>
        )}

        <Disclosure label="Set up the shortcut" open={howTo} onToggle={() => setHowTo((v) => !v)}>
          <ol className={cx(tone.body, "list-decimal space-y-3 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-mp-ink-3")}>
            <li>
              Open the <strong className={strong}>Shortcuts</strong> app, tap <strong className={strong}>+</strong>, and name the shortcut{" "}
              <strong className={strong}>Maple pee</strong>.
            </li>
            <li>
              Add the action <strong className={strong}>Get Contents of URL</strong> and set the URL to
              <span className="mt-1.5 flex items-center gap-2">
                <Code>{url}</Code>
                <CopyButton text={url} />
              </span>
            </li>
            <li>
              Tap <strong className={strong}>›</strong> to show more. Set <strong className={strong}>Method</strong> to{" "}
              <strong className={strong}>POST</strong>.
            </li>
            <li>
              Under <strong className={strong}>Headers</strong>, add <Code>Authorization</Code> with the value
              <span className="mt-1.5 flex items-center gap-2">
                <Code>{header}</Code>
                {fresh && <CopyButton text={header} />}
              </span>
              {!fresh && <span className={cx(tone.muted, "mt-1 block text-xs")}>Make a key above to fill this in.</span>}
            </li>
            <li>
              Set <strong className={strong}>Request Body</strong> to <strong className={strong}>JSON</strong> and add a Text field: key{" "}
              <Code>action</Code>, value <Code>pee</Code>.
            </li>
            <li>
              Add <strong className={strong}>Get Dictionary Value</strong>: get the value for <Code>speak</Code> in{" "}
              <strong className={strong}>Contents of URL</strong>.
            </li>
            <li>
              Add <strong className={strong}>Speak Text</strong> with that <strong className={strong}>Dictionary Value</strong>, so Siri tells you
              what was logged.
            </li>
            <li>
              Try it: <strong className={strong}>“Hey Siri, Maple pee.”</strong> For one-press logging, choose the shortcut under Settings → Action
              Button, or Settings → Accessibility → Touch → Back Tap.
            </li>
            <li>
              Duplicate it for the rest, changing the name and the <Code>action</Code>:
              <table className="mt-2 w-full text-left text-[13px]">
                <tbody className={tone.divide}>
                  {SHORTCUTS.map(([name, action]) => (
                    <tr key={action}>
                      <td className="py-1.5 pr-2 font-medium">{name}</td>
                      <td className="py-1.5">
                        <Code>{action}</Code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <span className={cx(tone.muted, "mt-2 block text-xs leading-snug")}>
                Also: <Code>vitamin_d</Code>, and <Code>bottle</Code> (add a Number field <Code>amount_oz</Code>). “Maple status” reads back when {w.he} last
                ate and which side is next.
              </span>
            </li>
          </ol>
        </Disclosure>
        <MomShortcut url={url} />
      </div>
    </Section>
  );
}

/**
 * The one "Mom meds" shortcut (§10.5) for every medicine on her list, from
 * any phone. A dose saves like Maple's actions; only a likely duplicate
 * comes back as needs_confirm. Reminders go to Apple Reminders, never a
 * family calendar.
 */
function MomShortcut({ url }: { url: string }) {
  const care = useCare();
  const [open, setOpen] = useState(false);
  if (!care?.access.write) return null;
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

// ── About ────────────────────────────────────────────────────────────────
