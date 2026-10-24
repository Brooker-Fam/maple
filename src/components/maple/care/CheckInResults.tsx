"use client";

import { useState } from "react";
import { screenResults, shortDate, type ScreenCard } from "@/lib/maple/care";
import {
  DIFFICULTY,
  FREQ,
  MOM_HELP,
  RESULTS_CAVEAT,
  RESULTS_FOOTER,
  RESULTS_HEADER,
  RESULTS_SUB,
  type Assessment,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ, dayKey, parseDayKey } from "@/lib/maple/time";
import type { MoodDataByKind, MoodEntry } from "@/lib/maple/types";
import { Icon, type IconName } from "../icons";
import { AssessmentCard } from "../sheets/parts";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { CrisisActions, HelpRow, OnTop, smsHref } from "./CrisisSheet";
import { ConfirmSheet } from "./parts";
import { useCare } from "./useCare";

/**
 * The fuller check-in's results (§6.3), hers only: CRISIS first whenever
 * question 9 was ever above "Not at all" (even if she changed it back), then
 * the PHQ-9 and GAD-7 cards as guidelines.ts words them, the difficulty card,
 * the caveat, "No one is notified" and HELP_ROW. Never a severity word, never
 * reassurance after a self-harm answer (screenResults decides which card).
 *
 * "Copy for my OB" puts plain text on the clipboard; nothing is sent anywhere.
 */

type Screen = MoodDataByKind["screen"];
type ScreenEntry = Extract<MoodEntry, { kind: "screen" }>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The maternal hotline, for the cards whose own words send her to it.
const HOTLINE = MOM_HELP.talk.find((l) => l.name === "National Maternal Mental Health Hotline");
const HOTLINE_SHOWN = HOTLINE?.action.replace(/^Call /, "") ?? "";
const HOTLINE_SMS = HOTLINE?.extra?.find((x) => x.sms)?.sms;

/** "Call the hotline" / "Text the hotline" on a card that names the hotline's number (INTRUSIVE, STRUGGLING, PHQ-9 positive). */
export function hotlineLinks(a: Assessment): { label: string; href: string; icon?: IconName }[] | undefined {
  if (!HOTLINE?.tel || !HOTLINE_SHOWN || !a.body.includes(HOTLINE_SHOWN)) return undefined;
  return [
    { label: "Call the hotline", href: `tel:${HOTLINE.tel}` },
    ...(HOTLINE_SMS ? [{ label: "Text the hotline", href: smsHref(HOTLINE_SMS), icon: "message-square" as const }] : []),
  ];
}

/** "Your check-in, Oct 24". */
export const resultsTitle = (at: string, tz: string) => RESULTS_HEADER(shortDate(dayKey(new Date(at), tz)));

/** The plain text for "Copy for my OB": the date, both scores, question 9's answer when it's above 0, and the difficulty answer. */
export function screenCopyText(d: Screen, at: string, tz: string): string {
  const { year, month, day } = parseDayKey(dayKey(new Date(at), tz));
  const lines = [`PHQ-9 and GAD-7 check-in, ${MONTHS[month - 1]} ${day}, ${year}`];
  lines.push(d.phq9.length === 9 ? `PHQ-9: ${d.phq9_score} of 27` : "PHQ-9: not finished");
  lines.push(d.gad7_score !== null && d.gad7.length === 7 ? `GAD-7: ${d.gad7_score} of 21` : "GAD-7: not finished");
  if (d.item9) lines.push(`PHQ-9 question 9: ${FREQ[d.phq9[8]]}`);
  if (d.difficulty != null) lines.push(`Difficulty: ${DIFFICULTY[d.difficulty]}`);
  return lines.join("\n");
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older iOS, or no clipboard permission: a hidden textarea and the old command.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** "Copy for my OB", with its toast. */
export function useCopyForOb() {
  const { toast } = useMaple();
  return async (text: string) => {
    if (await copy(text)) toast("Copied. Paste it into a message or your notes.");
    else toast("Couldn't copy that. Try again.", { tone: "error" });
  };
}

/** The cards, in §6.3's order, then the caveat, the footer and HELP_ROW. */
export function ScreenResults({ data }: { data: Screen }) {
  const cards = screenResults(data);
  const phqDone = data.phq9.length === 9;
  const gadDone = data.gad7.length === 7;
  return (
    <div className="space-y-4">
      {cards.map((c) => {
        if (c.key === "crisis") return <CrisisBlock key={c.key} c={c} />;
        // Only finished scales get a score: a partial total would read like a low one.
        if (c.key === "phq9" && !phqDone) return null;
        if (c.key === "gad7" && !gadDone) return null;
        return <ResultCard key={c.key} c={c} />;
      })}
      {!phqDone && <p className={cx(tone.muted, "px-1 text-[15px] leading-snug")}>You stopped before the end of the PHQ-9, so there&apos;s no score for it.</p>}
      {phqDone && !gadDone && <p className={cx(tone.muted, "px-1 text-[15px] leading-snug")}>You stopped after the PHQ-9, so there&apos;s no GAD-7 score.</p>}
      <p className={cx(tone.muted, "px-1 text-[14px] leading-snug")}>{RESULTS_CAVEAT}</p>
      <div className="space-y-1 px-1">
        <p className={cx(tone.muted, "text-[14px] leading-snug")}>{RESULTS_FOOTER}</p>
        <HelpRow />
      </div>
    </div>
  );
}

/** CRISIS at the top of results, with the same calls as the crisis sheet. */
function CrisisBlock({ c }: { c: ScreenCard }) {
  return (
    <div role="alert" className={cx(tone.card, "space-y-3 p-4")}>
      <div>
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-danger">
          <Icon name="siren" size={16} strokeWidth={2} className="shrink-0" />
          {c.label}
        </p>
        <p className={cx(tone.heading, "mt-1.5 text-[17px] leading-snug")}>{c.title}</p>
        <p className={cx(tone.body, "mt-1 text-[15px] leading-relaxed")}>{c.body}</p>
      </div>
      <CrisisActions her />
    </div>
  );
}

/** One scale's card: "PHQ-9: 12 of 27" over it; a tier card (with her OB's number) or, for the low bands, a plain one. */
function ResultCard({ c }: { c: ScreenCard }) {
  const heading = c.heading && <p className={cx(tone.label, "mb-1.5 px-1 tabular-nums")}>{c.heading}</p>;
  if (!c.tier) {
    return (
      <div>
        {heading}
        <div role="status" className="rounded-xl border-l-[3px] border-mp-line bg-mp-sunken px-4 py-3">
          <p className={cx(tone.heading, "text-[15px] leading-snug")}>{c.title}</p>
          <p className={cx(tone.body, "mt-1 text-sm leading-relaxed")}>{c.body}</p>
        </div>
      </div>
    );
  }
  const a: Assessment = { tier: c.tier, ...(c.label ? { label: c.label } : {}), title: c.title, body: c.body };
  return (
    <div>
      {heading}
      <AssessmentCard a={a} audience="mom" more={hotlineLinks(a)} />
    </div>
  );
}

/** A saved fuller check-in, from "Your check-ins": its results again, Copy for my OB, and a hard delete. */
export default function CheckInResultsSheet({ entry, open, onClose }: { entry: ScreenEntry | null; open: boolean; onClose: () => void }) {
  const care = useCare();
  const { state } = useMaple();
  const copyForOb = useCopyForOb();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Keep the last one while the sheet slides away.
  const [shown, setShown] = useState<ScreenEntry | null>(entry);
  if (entry && entry !== shown) setShown(entry);
  const e = entry ?? shown;
  if (!care?.mood || !e) return null;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;

  const remove = async () => {
    setBusy(true);
    try {
      await care.act.deleteMood(e.id);
      setConfirm(false);
      onClose();
    } catch {
      // useCare said why in a toast; the confirm stays open to try again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={resultsTitle(e.at, tz)}
        subtitle={RESULTS_SUB}
        footer={
          <div className="flex gap-3">
            {/* Wider than Done, so it stays on one line at 375 px. */}
            <Button variant="soft" size="lg" className="flex-[1.4]" onClick={() => void copyForOb(screenCopyText(e.data, e.at, tz))}>
              Copy for my OB
            </Button>
            <Button size="lg" className="flex-1" onClick={onClose}>
              Done
            </Button>
          </div>
        }
      >
        <ScreenResults data={e.data} />
        <div className="flex justify-center pb-1">
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
            <Icon name="trash-2" size={16} />
            Delete this check-in
          </Button>
        </div>
      </Sheet>
      <OnTop>
        <ConfirmSheet
          open={open && confirm}
          onClose={() => setConfirm(false)}
          title="Delete this check-in for good?"
          body="It's gone from Maple's Log for good, not hidden. This can't be undone."
          confirm="Delete for good"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </OnTop>
    </>
  );
}
