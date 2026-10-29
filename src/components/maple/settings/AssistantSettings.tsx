"use client";

import Link from "next/link";
import { useState } from "react";
import { adminActsAs } from "@/lib/maple/insights";
import { MCP_URL } from "@/lib/maple/origin";
import { useCare } from "../care/useCare";
import { useBabyWords, useFamilyOne } from "../familyWords";
import { Icon } from "../icons";
import { cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { Code, CopyButton, Disclosure, GROUP, Section, Toggle } from "./parts";

import SiriSetup from "./SiriSetup";

const EXAMPLES = ["“Log a wet diaper.”", "“Which side next?”", "“How did last night go?”"];
const momExamples = (name: string) => [`“When is ${name}'s medicine OK again?”`, `“${name} took her pill.”`, `“Here's a photo of her discharge sheet.”`];

export default function AssistantSettings() {
  return (
    <><SiriSetup /><ConnectAI /></>
  );
}

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
    <Section title="Claude & ChatGPT">
      <div className={GROUP}>
        <p className="px-4 py-3.5 text-[15px] leading-relaxed text-mp-ink-2">
          Connect an assistant to log by conversation and ask about your baby&apos;s day.
        </p>
        <Link href="/maple/connect" className={cx(tone.row, "min-h-[52px]")}>
          <Icon name="list-checks" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="flex-1 text-[15px] font-medium text-mp-accent-fg">Connect an assistant</span>
          <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
        </Link>
        <Disclosure label="More about assistants" open={manual} onToggle={() => setManual((v) => !v)}>
          {examples("Things you can say", EXAMPLES)}
          {care && <div className="mt-3">{examples(`Things you can say for ${care.name}`, momExamples(care.name))}</div>}
          <dl className="mt-4 space-y-3 text-sm">
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
      hint={`The family calendar connector (the site's admin login) can log ${w.name} too. ${
        someoneElse ? `Right now it logs as ${memberName(someoneElse)}.` : "Turn this on so what it logs counts as you, not “Admin”."
      }`}
      checked={stored === me.email}
      disabled={busy}
      onChange={(v) => void set(v)}
    />
  );
}
