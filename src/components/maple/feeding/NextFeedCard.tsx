"use client";

import { useMemo, useReducer, useRef, useState } from "react";
import { minutesShort, other } from "@/lib/maple/feed";
import { amountText, checkInText, dueStatus, feedingPlanOf, feedPlanNow, type PlanDue } from "@/lib/maple/feeding-plan";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { Side } from "@/lib/maple/types";
import { feedTargetOf } from "@/lib/maple/units";
import { useBabyWords } from "../familyWords";
import { SIDE_NAME } from "../FeedParts";
import { Icon, type IconName } from "../icons";
import { useNightActive } from "../nightLook";
import { KIND_COLOR, SIDE_COLOR, SIDE_INK } from "../palette";
import { useSheets } from "../sheets";
import { focusNext, useTapGuard } from "../tapCooldown";
import { holdTodayTaps } from "../tapShield";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useTimerActions } from "../useTimerActions";
import { useFeedingPlanNav } from "./FeedingPlanNav";
import { cardDueWords, listWords, missedItems, stepRows, type OneTapLog, type StepAction, type StepRow } from "./nextFeed";

/**
 * Today's Next feed card: the family's feeding plan (settings.feeding_plan,
 * from their care team) read against the log (feedPlanNow), so nobody has to
 * ask what to do next. Before a feed: which feed is next ("Next feed", or
 * "Night feed" in the plan's night), when it's due (dueText, calm in every
 * state: "Due since 4:10 PM" is a fact, never an alarm), its steps in the
 * plan's words, and on the first step the one big action: Start Left (the
 * side the dock suggests) with the other side beside it, Start pumping, or
 * Log bottle (the bottle form, prefilled from the plan). The plan's other
 * feeds are quiet "Do … instead" picks, kept on this phone until a feed
 * starts or the plan's turn changes. While a feed is going ("Now"), each step
 * says whether it's logged, going or still to do, and the first one left
 * carries the action: milk at the breast in one tap ("Log 20 ml in the
 * SNS"), a top-up in the bottle form naming its feed (top_up_of), Start
 * pumping. A finished feed's step nobody logged (a top-up, the milk at the
 * breast, the pump) gets one quiet line with its fix, or Got it to set it
 * aside on this phone.
 *
 * Every amount, minute and time is the plan's or the log's, in the plan's
 * unit. Viewers see the same card with no buttons but Plan; photos-only
 * guests see none of it. A tap that changes the page under the thumb holds
 * Today's taps for the cooldown (tapShield), and a change from elsewhere (the
 * other phone starting the feed) arms the card's buttons again (useTapGuard),
 * so a double tap never logs twice.
 */

/** This phone's own memory for the card (a pick, a missed step set aside): sessionStorage, or this page's memory when it's blocked. */
const memory = new Map<string, string>();
function sessionRead(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}
function sessionWrite(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked (a private window): this page's memory carries it.
  }
}

/** "Do … instead", for the plan's turn it was picked in (`turn`): a new turn (a feed logged, the night) drops it. */
type Pick = { turn: string; id: string };
const pickKey = (family: number) => `maple-plan-pick:${family}`;
function readPick(family: number): Pick | null {
  const raw = sessionRead(pickKey(family));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pick> | null;
    return typeof p?.turn === "string" && typeof p.id === "string" ? { turn: p.turn, id: p.id } : null;
  } catch {
    return null;
  }
}
/** A finished feed's unlogged steps, set aside on this phone (Got it), by the feed's start. */
const missedKey = (family: number, start: number) => `maple-plan-missed:${family}:${start}`;

const DUE_ICON: IconName = "clock-3";

export default function NextFeedCard() {
  const { state, summary, readOnly, log, now: clock } = useMaple();
  const w = useBabyWords();
  const now = useNow(20_000);
  const night = useNightActive();
  const nav = useFeedingPlanNav();
  const sheets = useSheets();
  const actions = useTimerActions();
  const settings = state?.baby.settings;
  const plan = useMemo(() => feedingPlanOf(settings), [settings]);
  const target = useMemo(() => feedTargetOf(settings), [settings]);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const family = state?.family?.id ?? 0;
  const entries = state?.entries;
  // Re-read this phone's pick and set-aside steps after a tap changes them.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // One action at a time: its buttons wait while it's out (a start, a one-tap log).
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  // The plan's own turn, then this phone's pick for that turn (cleared by a new turn: a feed logged, the night, a feed going).
  const base = useMemo(() => (plan && entries ? feedPlanNow(plan, entries, now, { tz, target }) : null), [plan, entries, now, tz, target]);
  const turn = base ? `${base.focus.state}|${base.focus.feed.id}|${summary?.lastFed?.at ?? ""}` : "";
  const saved = base ? readPick(family) : null;
  const choose =
    base && base.focus.state === "upcoming" && saved && saved.turn === turn && saved.id !== base.focus.feed.id && plan?.feeds.some((f) => f.id === saved.id) ? saved.id : null;
  const fp = useMemo(
    () => (choose && plan && entries ? feedPlanNow(plan, entries, now, { tz, target, choose }) : base),
    [choose, plan, entries, now, tz, target, base]
  );

  const missedStart = fp?.missed?.view.start ?? null;
  const missedAside = missedStart !== null && sessionRead(missedKey(family, missedStart)) === "1";
  const missed = fp && !missedAside ? missedItems(fp) : [];
  const rows = fp ? stepRows(fp) : [];
  const primary = rows.find((r) => r.action)?.action ?? null;
  // What's under the thumb: the feed, its state, the step with the action, the missed line. A change from elsewhere arms it again.
  const guard = useTapGuard(fp ? [fp.focus.state, fp.focus.feed.id, rows.find((r) => r.action)?.key ?? "", primary?.kind ?? "", missed.length ? missedStart : ""].join("|") : null);

  if (!state || !summary || !plan || !fp || !base || !state.baby.born_at || state.me.role === "photos") return null;

  const focus = fp.focus;
  const underway = focus.state === "underway";
  const chosen = focus.why === "chosen";
  const eyebrow = underway ? "Now" : focus.night ? "Night feed" : "Next feed";
  const due = fp.due;
  const dueHere = due && due.for === "focus" ? due : null;
  const dueAfter = due && due.for === "after" ? due : null;
  // The side the dock and Last fed suggest (nextSideFor), else Left for a first feed.
  const first: Side = summary.next?.side ?? "L";
  const run = focus.group?.run ?? null;

  /** A tap that changes the card, and the page under the thumb: Today's taps wait out the cooldown; one at a time. */
  const act = (fn: () => Promise<unknown> | void) => {
    if (inFlight.current) return;
    holdTodayTaps();
    const out = fn();
    if (out instanceof Promise) {
      inFlight.current = true;
      setBusy(true);
      void out.finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
    }
    // The button tapped is gone (the card moved on): a screen reader's place stays on the card.
    focusNext("#next-feed-title");
  };
  /** A start brings its timer card in above, as the dock's does: Right now comes to the top (no glide at night or with reduced motion). */
  const toTop = () => {
    const still = night || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
  };
  const startNursing = (side: Side, shield: boolean) =>
    act(async () => {
      toTop();
      await actions.startFeed(side, { ...(shield ? { shield: true } : {}), plan: focus.feed.id });
    });
  const startPump = () =>
    act(async () => {
      toTop();
      await actions.startTimer("pump");
    });
  const logOne = (l: OneTapLog) =>
    act(async () => {
      await log({ kind: "feed", ...(l.started_at ? { started_at: l.started_at } : {}), data: l.data }, { toast: `${l.toast} · ${formatTime(l.started_at ?? clock(), tz)}` });
    });
  const openForm = (a: Extract<StepAction, { kind: "form" }>) => {
    if (inFlight.current) return;
    sheets.open({ kind: a.sheet, preset: a.preset });
  };
  const pickFeed = (id: string | null) =>
    act(() => {
      sessionWrite(pickKey(family), id ? JSON.stringify({ turn, id } satisfies Pick) : null);
      bump();
    });
  const setAside = () =>
    act(() => {
      if (missedStart !== null) sessionWrite(missedKey(family, missedStart), "1");
      bump();
    });

  const actionView = (a: StepAction) => {
    if (a.kind === "nurse") {
      const second = other(first);
      const shield = a.shield ? ", with the nipple shield" : "";
      return (
        <div data-plan-primary className="flex gap-2">
          <Button
            size="lg"
            className="min-w-0 flex-1 whitespace-nowrap [@media(max-width:340px)]:px-3"
            disabled={busy}
            onClick={() => startNursing(first, a.shield)}
            aria-label={`Start ${SIDE_NAME[first]}${shield}: ${focus.feed.name}`}
          >
            <SideDot side={first} />
            Start {SIDE_NAME[first]}
          </Button>
          <Button
            size="lg"
            variant="soft"
            className="shrink-0 px-4 whitespace-nowrap [@media(max-width:340px)]:px-3"
            disabled={busy}
            onClick={() => startNursing(second, a.shield)}
            aria-label={`${SIDE_NAME[second]}: start on the ${SIDE_NAME[second]}${shield}`}
          >
            <SideDot side={second} />
            {SIDE_NAME[second]}
          </Button>
        </div>
      );
    }
    if (a.kind === "pump") {
      return (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={startPump}>
            <Icon name="milk" size={19} />
            Start pumping
          </Button>
        </div>
      );
    }
    if (a.kind === "form") {
      return (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => openForm(a)} aria-label={a.aria}>
            <Icon name={a.sheet === "pump" ? "milk" : "bottle"} size={19} />
            {a.label}
          </Button>
        </div>
      );
    }
    if (a.kind === "log") {
      return (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => logOne(a.log)} aria-label={a.log.aria}>
            <Icon name="bottle" size={19} />
            {a.log.label}
          </Button>
        </div>
      );
    }
    // Formula or breast milk, as the plan says: one tap each, neither the default.
    return (
      <div data-plan-primary role="group" aria-label={a.prompt.replace(/:$/, "")}>
        <p className="mb-1.5 text-[13px] font-medium text-mp-ink-2">{a.prompt}</p>
        <div className="grid grid-cols-2 gap-2">
          {a.options.map((o) => (
            <Button key={o.label} size="lg" variant="soft" disabled={busy} onClick={() => logOne(o)} aria-label={o.aria}>
              {o.label}
            </Button>
          ))}
        </div>
      </div>
    );
  };

  // The faint footer: the target in the plan's unit, who the plan is from (the care team, when it doesn't say), the next check-in.
  const footer = [
    target ? `Aim for ${amountText(target, plan.unit)} a feed` : null,
    plan.from ? `Plan from ${plan.from}` : "From your care team's plan",
    plan.check_in ? `Check-in ${checkInText(plan.check_in)}` : null,
  ].filter((x): x is string => !!x);
  const fixes = missed.filter((m) => m.fix);
  // The plan's own turn is "Back to …" while another one is picked here.
  const others = fp.others.filter((f) => !chosen || f.id !== base.focus.feed.id);

  return (
    <section data-next-feed aria-label={`${eyebrow}: ${focus.feed.name}`} {...guard.props} className={cx(tone.card, "px-4 pt-2.5 pb-3.5")}>
      <div className="flex min-h-[32px] items-center justify-between gap-2">
        <p className="text-[13px] font-semibold tracking-[0.01em] text-mp-ink-2">{eyebrow}</p>
        <button
          type="button"
          onClick={() => nav.openPlan()}
          aria-label="Plan: open the feeding plan"
          className="-mr-2 inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-xl px-2 text-[14px] font-medium text-mp-accent-fg transition active:bg-mp-ink/5 [@media(max-height:719px)]:-my-1.5"
        >
          Plan
          <Icon name="chevron-right" size={15} />
        </button>
      </div>
      <h3 id="next-feed-title" className="text-[21px] leading-[1.2] font-semibold tracking-[-0.01em] text-mp-ink [overflow-wrap:anywhere]">
        {focus.feed.name}
      </h3>
      {dueHere && <DueLine due={dueHere} now={now} tz={tz} her={w.him} />}
      {focus.extraNursing && run && (
        <p className="mt-1 text-[13px] leading-snug text-mp-ink-2">
          {w.He} nursed too · {minutesShort(run.min.total)}
        </p>
      )}

      {missed.length > 0 && missedStart !== null && (
        <div role="group" aria-label="Not logged" className={cx(tone.inset, "mt-3 px-3.5 pt-2.5", readOnly || !fixes.length ? "pb-2.5" : "pb-1")}>
          <p className="text-[14px] leading-snug text-mp-ink">
            <span className="font-semibold">{formatTime(missedStart, tz)} feed:</span> {listWords(missed.map((m) => m.what))} not logged
          </p>
          {!readOnly && (
            <div className="-mx-2 flex flex-wrap">
              {fixes.map((m) =>
                m.fix!.kind === "form" ? (
                  <Button key={m.key} variant="ghost" size="sm" disabled={busy} onClick={() => openForm(m.fix as Extract<StepAction, { kind: "form" }>)} aria-label={m.fix!.aria}>
                    {m.fix!.label}
                  </Button>
                ) : m.fix!.kind === "log" ? (
                  <Button key={m.key} variant="ghost" size="sm" disabled={busy} onClick={() => logOne((m.fix as Extract<StepAction, { kind: "log" }>).log)} aria-label={(m.fix as Extract<StepAction, { kind: "log" }>).log.aria}>
                    {(m.fix as Extract<StepAction, { kind: "log" }>).log.label}
                  </Button>
                ) : null
              )}
              <Button variant="ghost" size="sm" onClick={setAside} aria-label="Got it: set this aside on this phone">
                Got it
              </Button>
            </div>
          )}
        </div>
      )}

      <ol className="mt-3 space-y-3" aria-label={`${focus.feed.name}: steps`}>
        {rows.map((r) => (
          <Step key={r.key} row={r} action={r.action && !readOnly ? actionView(r.action) : null} />
        ))}
      </ol>

      {underway && fp.after && (
        <div className="mt-3 border-t border-mp-line pt-2.5 text-[13px] leading-snug text-mp-ink-2">
          <p className="font-semibold text-mp-ink [overflow-wrap:anywhere]">
            Then{fp.after.night ? " the night feed" : ""}: {fp.after.feed.name}
          </p>
          {dueAfter && <p>{cardDueWords(dueAfter, now, tz, w.him)}</p>}
        </div>
      )}

      {!readOnly && !underway && (chosen || others.length > 0) && (
        <div className="mt-3 border-t border-mp-line pt-1">
          {chosen && <p className="pt-1.5 text-[13px] leading-snug text-mp-ink-2">Picked on this phone, not the plan&apos;s turn.</p>}
          {/* The plan's other feeds, one quiet tap each: the card shows that one instead, on this phone. */}
          <div className="-mx-3 flex flex-wrap" role="group" aria-label="The plan's other feeds">
            {chosen && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => pickFeed(null)} className="text-left">
                Back to {base.focus.feed.name}
              </Button>
            )}
            {others.map((f) => (
              <Button key={f.id} variant="ghost" size="sm" disabled={busy} onClick={() => pickFeed(f.id)} className="text-left">
                Do {f.name} instead
              </Button>
            ))}
          </div>
        </div>
      )}

      {footer.length > 0 && <p className="mt-2 text-[12px] leading-snug text-mp-ink-3">{footer.join(" · ")}</p>}
    </section>
  );
}

/** When it's due, calm in every state: early quiet, due in the accent, past the window a warm mark, never an alarm. */
function DueLine({ due, now, tz, her }: { due: PlanDue; now: Date; tz: string; her: string }) {
  const status = dueStatus(due, now);
  const late = status === "late";
  return (
    <p
      className={cx(
        "mt-1 flex items-start gap-1.5 text-[14px] leading-snug",
        status === "early" && "text-mp-ink-2",
        status === "due" && "font-semibold text-mp-accent-fg",
        late && "font-medium text-mp-ink"
      )}
    >
      <Icon name={DUE_ICON} size={15} strokeWidth={2} className={cx("mt-[2px] shrink-0", late && "mp-kind-ink")} style={late ? { color: KIND_COLOR.feed } : undefined} />
      <span className="min-w-0">{cardDueWords(due, now, tz, her)}</span>
    </p>
  );
}

/** A side's letter on its color, as on the dock's tiles (an amber ring at night). */
function SideDot({ side }: { side: Side }) {
  return (
    <span
      aria-hidden
      className="mp-kind-fill mp-side-mark inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
      style={{ backgroundColor: SIDE_COLOR[side], color: SIDE_INK[side] }}
    >
      {side}
    </span>
  );
}

/** One step: its number (a check once logged, a dot while going), the plan's words or what was logged, and its action. */
function Step({ row, action }: { row: StepRow; action: React.ReactNode }) {
  if (row.state === "note") return <li className="pl-[34px] text-[14px] leading-snug text-mp-ink-2 [overflow-wrap:anywhere]">{row.text}</li>;
  const done = row.state === "done";
  const going = row.state === "running";
  return (
    <li>
      <div className="flex gap-2.5">
        <span
          aria-hidden
          className={cx(
            "mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums",
            going ? "bg-mp-accent text-mp-on-accent" : done ? "bg-mp-sunken text-mp-accent-fg" : "bg-mp-sunken text-mp-ink-2"
          )}
        >
          {done ? <Icon name="check" size={14} strokeWidth={2.5} /> : going ? <Icon name="timer" size={13} strokeWidth={2.25} /> : row.n}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cx("text-[15px] leading-snug [overflow-wrap:anywhere]", done ? "text-mp-ink-2" : "text-mp-ink")}>
            <span className="sr-only">{done ? "Done: " : going ? "Going: " : `Step ${row.n}: `}</span>
            {row.text}
          </p>
          {row.status && <p className={cx("mt-0.5 text-[13px] leading-snug", going ? "font-semibold text-mp-accent-fg" : "text-mp-ink-2")}>{row.status}</p>}
        </div>
      </div>
      {/* The card's whole width: the biggest thing on it, and room for both sides at 320px. */}
      {action && <div className="mt-2.5">{action}</div>}
    </li>
  );
}
