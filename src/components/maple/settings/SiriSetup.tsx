"use client";

import { useCallback, useEffect, useState } from "react";
import catalog from "../../../../public/shortcuts/catalog.json";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";
import { SIRI_SHORTCUTS } from "@/lib/maple/siri-shortcuts";
import { formatRelative } from "@/lib/maple/time";
import { Icon } from "../icons";
import { Button, cx } from "../ui";
import { useMaple } from "../useMaple";
import { CopyButton, DANGER_TEXT, Disclosure, GROUP, Section } from "./parts";
import SiriManualSetup from "./SiriManualSetup";

type PersonalToken = { id: number; label: string | null; created_at: string; last_used_at: string | null };
type FreshKey = { token: string; record: PersonalToken };

function useSiriSetup() {
  const { api, toast, now, readOnly } = useMaple();
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null);
  const [fresh, setFresh] = useState<FreshKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [origin, setOrigin] = useState(MAPLE_ORIGIN);

  const load = useCallback(async () => {
    setProblem(null);
    try {
      const result = await api<{ tokens: PersonalToken[] }>("/api/maple/tokens");
      setTokens(result.tokens);
    } catch {
      setProblem("Your Siri keys couldn't load. Try again.");
    }
  }, [api]);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load();
  }, [load]);

  const create = async (label = "My iPhone") => {
    if (busy || fresh) return;
    setBusy(true);
    try {
      const result = await api<FreshKey>("/api/maple/tokens", {
        method: "POST", body: JSON.stringify({ label: label.trim() || "My iPhone" }),
      });
      setFresh(result);
      setTokens((previous) => [result.record, ...(previous ?? [])]);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't make a Siri key. Try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: PersonalToken) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<{ tokens: PersonalToken[] }>(`/api/maple/tokens?id=${token.id}`, { method: "DELETE" });
      setTokens(result.tokens);
      if (fresh?.record.id === token.id) setFresh(null);
      toast("Key removed. Shortcuts using it can no longer access your family.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't remove that key. Try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return { tokens, fresh, busy, problem, origin, load, create, revoke, readOnly, now };
}

export default function SiriSetup() {
  const { tokens, fresh, busy, problem, origin, load, create, revoke, readOnly, now } = useSiriSetup();
  const [keysOpen, setKeysOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const prepared = origin === catalog.origin;
  return (
    <Section title="Siri">
      <div className={GROUP}>
        <div className="space-y-3 px-4 py-4">
          <p className="text-[19px] font-semibold tracking-[-0.025em] text-mp-ink">“Hey Siri, Maple status.”</p>
          <p className="text-[15px] leading-relaxed text-mp-ink-2">
            Use a ready-made shortcut to check in with your hands full.
          </p>
          {readOnly ? (
            <p className="text-sm text-mp-ink-2">Siri setup needs permission to log. Ask a family owner to update your access.</p>
          ) : !fresh ? (
            <SiriStart tokens={tokens} busy={busy} prepared={prepared} create={create} />
          ) : (
            <SiriSetupSteps fresh={fresh} prepared={prepared} />
          )}
          {problem && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-mp-danger"><span>{problem}</span><Button variant="ghost" size="sm" onClick={() => void load()}>Try again</Button></div>}
        </div>
        {!readOnly && prepared && <Disclosure label="More Siri commands" summary="Diapers, nursing, sleep" open={moreOpen} onToggle={() => setMoreOpen((value) => !value)}>
          <p className="mb-2 text-sm leading-relaxed text-mp-ink-2">Add only the ones you need. Paste the same key into each shortcut. Say its name to Siri to use it.</p>
          {!fresh && <p className="mb-2 text-[13px] text-mp-ink-3">Copy the key from the Text action in an existing shortcut, or make a new key below.</p>}
          <div className="divide-y divide-mp-line">{SIRI_SHORTCUTS.slice(1).map((shortcut) => <ShortcutLink key={shortcut.action} shortcut={shortcut} />)}</div>
        </Disclosure>}
        <Disclosure label="Your Siri keys" summary={tokens ? `${tokens.length}` : undefined} open={keysOpen} onToggle={() => setKeysOpen((value) => !value)}>
          <p className="mb-2 text-[13px] leading-relaxed text-mp-ink-2">A key lets shortcuts access your family as you. Remove one to disconnect every shortcut that uses it.</p>
          {tokens?.length === 0 && <p className="py-2 text-sm text-mp-ink-3">No Siri keys yet.</p>}
          {tokens?.map((token) => <div key={token.id} className="flex min-h-[60px] items-center gap-3 border-t border-mp-line py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium text-mp-ink">{token.label || "iPhone Shortcuts"}</p>
              <p className="text-[13px] text-mp-ink-3">{token.last_used_at ? `Used ${formatRelative(token.last_used_at, now())}` : `Created ${formatRelative(token.created_at, now())}; not used yet`}</p>
            </div>
            <button type="button" disabled={busy} onClick={() => void revoke(token)} aria-label={`Remove ${token.label || "iPhone Shortcuts"} key`} className={DANGER_TEXT}>Remove</button>
          </div>)}
        </Disclosure>
        <SiriManualSetup url={`${origin}/api/maple/quick`} fresh={fresh?.token ?? null} />
      </div>
      <p className="mt-2 px-1 text-[13px] leading-snug text-mp-ink-3">Siri may ask you to unlock. You can also run a shortcut from the Action Button or Home Screen.</p>
    </Section>
  );
}

function StepNumber({ children }: { children: string }) {
  return <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-xs font-semibold text-mp-ink-2">{children}</span>;
}

function ShortcutLink({ shortcut, primary = false }: { shortcut: (typeof SIRI_SHORTCUTS)[number]; primary?: boolean }) {
  return <a href={`/shortcuts/${shortcut.file}`} download={shortcut.file} className={cx(
    "flex min-h-11 items-center gap-3 rounded-lg text-[15px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mp-focus",
    primary ? "w-fit bg-mp-accent px-4 py-2 font-medium text-mp-on-accent" : "py-3 text-mp-accent-fg",
  )}>
    <span className="min-w-0 flex-1"><span className="block font-medium">{primary ? "Download Maple status" : shortcut.name}</span>{!primary && <span className="block text-[13px] text-mp-ink-3">{shortcut.description}</span>}</span>
    <Icon name="download" size={18} className="shrink-0" />
  </a>;
}

function SiriSetupSteps({ fresh, prepared }: { fresh: FreshKey; prepared: boolean }) {
  return (
            <ol className="space-y-5 pt-2" aria-label="Siri setup">
              <li className="flex gap-3">
                <StepNumber>1</StepNumber>
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="font-medium text-mp-ink">Copy your key</p>
                  <CopyButton text={fresh.token} label="Copy key" />
                  <details className="text-[13px] text-mp-ink-3">
                    <summary className="cursor-pointer py-1">Show key</summary>
                    <p className="mt-1 rounded-lg bg-mp-sunken p-2 font-mono break-all text-mp-ink select-all">{fresh.token}</p>
                  </details>
                  <p className="text-[13px] leading-snug text-mp-ink-3">Shown only here. Keep it private; each person should use their own.</p>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber>2</StepNumber>
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="font-medium text-mp-ink">Add the status shortcut</p>
                  {prepared ? <ShortcutLink shortcut={SIRI_SHORTCUTS[0]} primary /> : (
                    <p className="text-sm text-mp-ink-2">Ready-made shortcuts connect to {new URL(catalog.origin).host}. Use Advanced setup for this version of Maple.</p>
                  )}
                  {prepared && <p className="text-[13px] leading-relaxed text-mp-ink-2">Open the downloaded file in Apple Shortcuts. Paste your key when asked, then tap Add Shortcut.</p>}
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber>3</StepNumber>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium text-mp-ink">Try it once</p>
                  <p className="text-[13px] leading-relaxed text-mp-ink-2">Run Maple status in Shortcuts while unlocked and allow access to Maple. Then say “Hey Siri, Maple status.” This checks the connection without logging anything.</p>
                </div>
              </li>
            </ol>
  );
}

function SiriStart({ tokens, busy, prepared, create }: { tokens: PersonalToken[] | null; busy: boolean; prepared: boolean; create: (label?: string) => Promise<void> }) {
  const [label, setLabel] = useState<string | null>(null);
  const hasKeys = Boolean(tokens?.length);
  let defaultLabel = "My iPhone";
  for (let suffix = 2; tokens?.some((token) => token.label === defaultLabel); suffix += 1) defaultLabel = `My iPhone ${suffix}`;
  return <>
    {hasKeys && <div className="space-y-3">
      <p className="text-sm leading-relaxed text-mp-ink-2">To add a shortcut, reuse the key from the Text action in an existing shortcut. Haven&apos;t installed one yet, or lost the key? Make a new key below.</p>
      {prepared && <ShortcutLink shortcut={SIRI_SHORTCUTS[0]} primary />}
      <label className="block text-[13px] text-mp-ink-2">Name this key
        <input value={label ?? defaultLabel} onChange={(event) => setLabel(event.target.value)} maxLength={40} className="mt-1 block min-h-11 w-full rounded-xl border border-mp-line bg-mp-surface px-3 text-base text-mp-ink focus-visible:outline-2 focus-visible:outline-mp-focus" />
      </label>
    </div>}
    <Button onClick={() => void create(label?.trim() || defaultLabel)} disabled={busy || tokens === null} variant={hasKeys ? "soft" : "primary"} className={hasKeys ? "" : "w-full"}>
      <Icon name="plus" size={18} />
      {busy ? "Making your key…" : hasKeys ? "Make a new key" : "Set up Siri"}
    </Button>
    <p className="text-[13px] leading-snug text-mp-ink-3">{hasKeys ? "Your other shortcuts keep working. Remove unused keys below." : "You’ll copy a private key and add a shortcut to your iPhone."}</p>
  </>;
}
