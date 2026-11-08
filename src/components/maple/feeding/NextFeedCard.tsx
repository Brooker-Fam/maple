"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { minutesShort, other } from "@/lib/maple/feed";
import { checkInText, dueStatus, type FeedingPlan, type PlanDue, type PlanFeed, type Range } from "@/lib/maple/feeding-plan";
import { dayKey, formatDuration, formatTime } from "@/lib/maple/time";
import type { Entry, Side } from "@/lib/maple/types";
import { useBabyWords } from "../familyWords";
import { SIDE_NAME } from "../FeedParts";
import { Icon, type IconName } from "../icons";
import { useNightActive } from "../nightLook";
import { KIND_COLOR, SIDE_COLOR, SIDE_INK } from "../palette";
import { useSheets } from "../sheets";
import { focusNext, useTapGuard } from "../tapCooldown";
import { holdTodayTaps } from "../tapShield";
import { Button, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { useTimerActions } from "../useTimerActions";
import { useFeedingPlanNav } from "./FeedingPlanNav";
import { cardDueWords, listWords, type StepAction } from "./nextFeed";
import { usePlanLog, usePlanNow, type PlanRow } from "./usePlanNow";

/**
 * Today's Next feed card: the family's feeding plan (settings.feeding_plan,
 * from their care team) read against the log (usePlanNow, the reading the dock
 * and the running timer cards share), so nobody has to ask what to do next.
 *
 * Before a feed, compact so its one big action and the top of Last fed clear
 * the dock on a small phone: which feed is next ("Next feed", or "Night feed"
 * in the plan's night), when it's due and what that counts from ("10:30 AM–
 * 11:30 AM, in 1h 00m · 2.5–3.5 h after the 8:00 AM feed"; calm in every
 * state, "Due since 4:10 PM" is a fact, never an alarm), its first step in the
 * plan's words with the action (Start Left, the side the dock suggests, with
 * the other side beside it, or only the plan's side when it nurses on one;
 * Start pumping; Log bottle, the bottle form prefilled from the plan), its
 * later steps on one line, and one quiet
 * "Other feed" for the plan's other feeds, kept on this phone until a feed
 * starts or the plan's turn changes. While a feed is going ("Now"), each step
 * says whether it's logged, going or still to do; the next physical step
 * carries the action (milk at the breast in one tap, a top-up in the bottle
 * form naming its feed, Start pumping), a step can carry a small second one
 * beside it, and a short bottle step has a quiet "She's done" (a step only if
 * needed, "Not needed") that sets it aside on this phone. "Not …?" says which plan feed it really was, for every
 * phone (data.plan on its entries). A finished feed's steps nobody logged get
 * one line with Fix, which opens each fix and Got it (set aside on this phone).
 *
 * Every amount, minute and time is the plan's or the log's, in the plan's
 * unit. Viewers see the same card with no buttons but Plan; photos-only
 * guests see none of it. A tap that changes the page under the thumb holds
 * Today's taps for the cooldown (tapShield), and a change from elsewhere (the
 * other phone starting the feed) arms the card's buttons again (useTapGuard),
 * so a double tap never logs twice.
 */

const DUE_ICON: IconName = "clock-3";
const MIN = 60_000;
/** Keeps a part opened low on the card clear of the dock and tab bar when it's brought into view (the dock publishes its height). */
const CLEAR_DOCK = "scroll-mt-4 scroll-mb-[calc(var(--maple-dock-h,0px)+72px+env(safe-area-inset-bottom))]";

/** "2.5–3.5 h", "3 h", "2h 15m–3h 00m": a plan's interval, said short. */
function hoursText(r: Range): string {
  const h = (m: number) => (m % 30 === 0 ? String(m / 60) : null);
  const [a, b] = [h(r.min), h(r.max)];
  if (a !== null && b !== null) return a === b ? `${a} h` : `${a}–${b} h`;
  const d = (m: number) => formatDuration(m * 60);
  return r.min === r.max ? d(r.min) : `${d(r.min)}–${d(r.max)}`;
}

/**
 * What a due window counts from: "2.5–3.5 h after the 8:00 AM feed" (the plan's interval from the last feed's start;
 * on demand, "at most 3 h after the 8:00 AM feed"), or "after the 3:40 AM feed" when the window moved (a day feed
 * waiting for the night to end).
 */
export function dueFromWords(d: PlanDue, plan: FeedingPlan, tz: string): string {
  const every = d.night ? (plan.night?.every ?? plan.day.every) : plan.day.every;
  const at = formatTime(d.base, tz);
  const plain = !!every && d.from === d.base + every.min * MIN && d.to === d.base + every.max * MIN;
  return plain && every ? `${d.onDemand ? "at most " : ""}${hoursText(every)} after the ${at} feed` : `after the ${at} feed`;
}

/** A very short screen (an older small phone, under 600px tall): the card puts its big action before its later steps. */
function useShortScreen(): boolean {
  const [short, setShort] = useState(false);
  useEffect(() => {
    const check = () => setShort(window.innerHeight < 600);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return short;
}

/** The plan's other feeds that feed her (one that only pumps never comes up). */
const feeding = (plan: FeedingPlan) => plan.feeds.filter((f) => f.steps.some((s) => s.do === "nurse" || s.do === "bottle"));

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export default function NextFeedCard() {
  const { state, summary, readOnly, update, toast } = useMaple();
  const w = useBabyWords();
  const night = useNightActive();
  const nav = useFeedingPlanNav();
  const sheets = useSheets();
  const actions = useTimerActions();
  const p = usePlanNow();
  const logOne = usePlanLog();
  const short = useShortScreen();
  // One action at a time: its buttons wait while it's out (a start, a one-tap log, a correction).
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  // What's open on the card: the missed line's fixes, the plan's other feeds (before a feed), or which feed it was (during
  // one). Only for the card it was opened on: once the card moves on (a feed starts, the line is fixed), it's closed.
  const [opened, setOpened] = useState<{ what: "fix" | "other" | "was"; on: string } | null>(null);

  const fp = p?.fp ?? null;
  const rows = p?.rows ?? [];
  const primary = p?.primary ?? null;
  const missed = p?.missed ?? [];
  const on = fp ? [fp.focus.state, fp.focus.feed.id, fp.focus.start ?? "", p?.missedStart ?? ""].join("|") : "";
  const open = opened && opened.on === on ? opened.what : null;
  const setOpen = (to: typeof open | ((o: typeof open) => typeof open)) => {
    const next = typeof to === "function" ? to(open) : to;
    setOpened(next ? { what: next, on } : null);
  };
  /** Open or close a part of the card: what's under the thumb changes, so Today's taps wait out the cooldown. */
  const toggle = (what: NonNullable<typeof open>) => {
    holdTodayTaps();
    setOpen((o) => (o === what ? null : what));
  };
  // An opened part low on the card comes up above the dock (instantly at night or with reduced motion).
  const reveal = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("maple-night");
    el.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, []);
  // What's under the thumb: the feed, its state, the step with the action, the missed line. A change from elsewhere arms it again.
  const guard = useTapGuard(fp ? [fp.focus.state, fp.focus.feed.id, primary?.row.key ?? "", primary?.action.kind ?? "", missed.length ? p?.missedStart : ""].join("|") : null);

  if (!state || !summary || !p || !fp || !state.baby.born_at || state.me.role === "photos") return null;

  const { plan, base, tz, now } = p;
  const focus = fp.focus;
  const underway = focus.state === "underway";
  const chosen = !!p.chosen;
  const eyebrow = underway ? "Now" : focus.night ? "Night feed" : "Next feed";
  const due = fp.due;
  const dueHere = due && due.for === "focus" ? due : null;
  const dueAfter = due && due.for === "after" ? due : null;
  // The side the dock and Last fed suggest (nextSideFor), else Left for a first feed.
  const first: Side = summary.next?.side ?? "L";
  const run = focus.group?.run ?? null;
  const missedStart = p.missedStart;
  const fixes = missed.filter((m) => m.fix);

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
  const openForm = (a: Extract<StepAction, { kind: "form" }>) => {
    if (inFlight.current) return;
    sheets.open({ kind: a.sheet, preset: a.preset });
  };
  const pickFeed = (id: string | null) =>
    act(() => {
      setOpen(null);
      p.pick(id);
    });
  const setAside = () =>
    act(() => {
      setOpen(null);
      p.setMissedAside();
    });

  /**
   * Which plan feed this one really was, for every phone: data.plan on its nursing entries (or its bottles), each
   * made against the version shown; changed meanwhile (a Switch, the other phone), once more on what's there now.
   */
  const correct = (to: PlanFeed) =>
    act(async () => {
      setOpen(null);
      const list: Entry[] = (run ? run.entries : (focus.group?.bottles ?? [])).filter((e) => e.id > 0 && e.data.plan !== to.id);
      const save = (b: Entry) => update(b.id, { data: { plan: to.id }, expect_updated_at: b.updated_at }, { toast: "", throwOnError: true });
      try {
        for (const e of list) {
          try {
            await save(e);
          } catch (err) {
            const latest = err instanceof ApiError && err.status === 409 ? (err.body as { entry?: Entry } | null)?.entry : undefined;
            if (!latest || latest.id !== e.id || latest.kind !== "feed") throw err;
            if (latest.data.plan === to.id) continue;
            await save(latest);
          }
        }
        toast(`This feed is ${to.name} now`, { tone: "ok" });
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) toast("The feed just changed on another phone, so that wasn't saved. Try again.", { tone: "info" });
        else if (err instanceof ApiError) toast(err.status < 500 ? err.message : "That wasn't saved. Try again in a moment.", { tone: "error" });
        else toast("You're offline, so that wasn't saved. Try again when you're back online.", { tone: "error" });
      }
    });

  /** One action's buttons: the card's big one (`big`), or a small one beside a row or in the missed line's fixes. */
  const actionView = (a: StepAction, big: boolean): ReactNode => {
    if (a.kind === "nurse") {
      const shield = a.shield ? ", with the nipple shield" : "";
      if (a.side) {
        // The plan nurses on one side only ("left only, pump the right"): that side's Start alone, never the other.
        const only = a.side;
        return (
          <div data-plan-primary>
            <Button size="lg" className="w-full whitespace-nowrap" disabled={busy} onClick={() => startNursing(only, a.shield)} aria-label={`Start ${SIDE_NAME[only]}${shield}: ${focus.feed.name}`}>
              <SideDot side={only} />
              Start {SIDE_NAME[only]}
            </Button>
          </div>
        );
      }
      const second = other(first);
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
      return big ? (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={startPump}>
            <Icon name="milk" size={19} />
            Start pumping
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" disabled={busy} onClick={startPump} className="-ml-3">
          Start pumping
        </Button>
      );
    }
    if (a.kind === "form") {
      return big ? (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => openForm(a)} aria-label={a.aria}>
            <Icon name={a.sheet === "pump" ? "milk" : "bottle"} size={19} />
            {a.label}
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => openForm(a)} aria-label={a.aria} className="-ml-3">
          {a.label}
        </Button>
      );
    }
    if (a.kind === "log") {
      return big ? (
        <div data-plan-primary>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => act(() => logOne(a.log))} aria-label={a.log.aria}>
            <Icon name="bottle" size={19} />
            {a.log.label}
          </Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => logOne(a.log))} aria-label={a.log.aria} className="-ml-3">
          {a.log.label}
        </Button>
      );
    }
    // Formula or breast milk, as the plan says or as the family says: one tap each, neither the default.
    if (!big) {
      // Beside a row or in the missed line's fixes: the words, then the two as quiet links on one row.
      return (
        <div role="group" aria-label={a.prompt.replace(/:$/, "")} className="w-full">
          <p className="pt-1 text-[13px] leading-snug text-mp-ink-2">{a.prompt}</p>
          <div className="-ml-3 flex flex-wrap">
            {a.options.map((o) => (
              <Button key={o.label} variant="ghost" size="sm" disabled={busy} onClick={() => act(() => logOne(o))} aria-label={o.aria}>
                {o.label}
              </Button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div data-plan-primary role="group" aria-label={a.prompt.replace(/:$/, "")}>
        <p className="mb-1.5 text-[13px] font-medium text-mp-ink-2">{a.prompt}</p>
        <div className="grid grid-cols-2 gap-2">
          {a.options.map((o) => (
            <Button key={o.label} size="lg" variant="soft" disabled={busy} onClick={() => act(() => logOne(o))} aria-label={o.aria}>
              {o.label}
            </Button>
          ))}
        </div>
      </div>
    );
  };

  // The faint line: who the plan is from (the care team, when it doesn't say) and the check-in (was, once it's passed).
  const today = dayKey(now, tz);
  const checkIn = plan.check_in
    ? plan.check_in < today
      ? `Check-in was ${checkInText(plan.check_in)}`
      : plan.check_in === today
        ? "Check-in today"
        : `Check-in ${checkInText(plan.check_in)}`
    : null;
  const footer = chosen ? "Picked on this phone, not the plan's turn" : [plan.from ? `Plan from ${plan.from}` : "From your care team's plan", checkIn].filter(Boolean).join(" · ");
  // Before a feed: the plan's other feeds (the plan's own turn is "Back to …" while another one is picked here).
  const others = fp.others.filter((f) => !chosen || f.id !== base.focus.feed.id);
  // During one: the plan's other feeds it might have been instead, when there's something of it to say it on.
  const wasList = underway && (run || focus.group?.bottles.length) ? feeding(plan).filter((f) => f.id !== focus.feed.id) : [];
  const canWas = !readOnly && wasList.length > 0 && !(run ?? { entries: focus.group?.bottles ?? [] }).entries.some((e) => e.id < 0);
  const canOther = !readOnly && !underway && (chosen || others.length > 0);

  // Before a feed: its first step and the action, the rest on one line. The first step is the one with the action.
  const lead = underway ? -1 : Math.max(0, rows.findIndex((r) => (primary ? r === primary.row : r.state !== "note")));
  const later = underway ? [] : rows.slice(lead + 1);
  const laterSteps = later.filter((r) => r.state !== "note").map((r) => lowerFirst(r.text));
  // "Then pump 15 min; then top up 25–35 ml, …", then the plan's notes ("Burp halfway").
  const laterWords = [laterSteps.length ? `Then ${laterSteps.join("; then ")}` : null, ...later.filter((r) => r.state === "note").map((r) => r.text)].filter(Boolean).join(" · ");

  return (
    <section data-next-feed aria-label={`${eyebrow}: ${focus.feed.name}`} {...guard.props} className={cx(tone.card, "px-4 pt-2.5", canOther || canWas ? "pb-1" : "pb-3.5")}>
      <div className={cx("flex items-center justify-between gap-2", short ? "min-h-[26px]" : "min-h-[32px]")}>
        <p className="text-[13px] font-semibold tracking-[0.01em] text-mp-ink-2">{eyebrow}</p>
        <button
          type="button"
          onClick={() => nav.openPlan()}
          aria-label="Plan: open the feeding plan"
          className={cx(
            "-mr-2 inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-xl px-2 text-[14px] font-medium text-mp-accent-fg transition active:bg-mp-ink/5",
            short ? "-my-[9px]" : "[@media(max-height:719px)]:-my-1.5"
          )}
        >
          Plan
          <Icon name="chevron-right" size={15} />
        </button>
      </div>
      <h3 id="next-feed-title" className="text-[21px] leading-[1.2] font-semibold tracking-[-0.01em] text-mp-ink [overflow-wrap:anywhere]">
        {focus.feed.name}
      </h3>
      {dueHere && <DueLine due={dueHere} now={now} tz={tz} her={w.him} from={dueFromWords(dueHere, plan, tz)} />}
      {focus.extraNursing && run && (
        <p className="mt-1 text-[13px] leading-snug text-mp-ink-2">
          {w.He} nursed too · {minutesShort(run.min.total)}
        </p>
      )}

      {/* On a very short screen the next step's action comes first, above the steps, so it clears the dock. */}
      {underway && short && primary && !readOnly && <div className="mt-2">{actionView(primary.action, true)}</div>}
      {underway ? (
        <ol className="mt-3 space-y-3" aria-label={`${focus.feed.name}: steps`}>
          {rows.map((r) => (
            <Step
              key={r.key}
              row={r}
              action={r.action && !readOnly && !short ? actionView(r.action, true) : null}
              secondary={r.secondary && !readOnly ? actionView(r.secondary, false) : null}
              close={
                r.close && !readOnly ? (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => p.closeRow(r.key))} className="-ml-3 font-medium text-mp-ink-2!">
                    {r.close}
                  </Button>
                ) : null
              }
            />
          ))}
        </ol>
      ) : (
        <div className={short ? "mt-2" : "mt-2.5"}>
          {/*
            The feed's steps in one short paragraph: the first (the one the action starts) in full, the rest quieter after
            it. On a very short screen the rest goes under the action, so the action clears the dock.
          */}
          <p className="text-[15px] leading-snug text-mp-ink [overflow-wrap:anywhere]">
            {rows.slice(0, lead + 1).map((r, i) => (
              <span key={r.key} className={r.state === "note" ? "text-mp-ink-2" : undefined}>
                {i > 0 ? " · " : ""}
                {r.text}
              </span>
            ))}
            {laterWords && !(short && primary && !readOnly) && <span className="text-[14px] text-mp-ink-2">{`. ${laterWords}`}</span>}
          </p>
          {primary && !readOnly && <div className={short ? "mt-2" : "mt-2.5"}>{actionView(primary.action, true)}</div>}
          {laterWords && short && primary && !readOnly && <p className="mt-1.5 text-[14px] leading-snug text-mp-ink-2 [overflow-wrap:anywhere]">{laterWords}</p>}
        </div>
      )}

      {/*
        A finished feed's steps nobody logged: one row under the next feed's action (so that stays above the dock), its
        Fix opening each fix and Got it (set aside on this phone).
      */}
      {missed.length > 0 && missedStart !== null && (
        <div role="group" aria-label="Not logged" className={cx(tone.inset, "mt-3 pl-3.5", readOnly ? "py-2.5 pr-3.5" : "pr-1")}>
          <div className="flex items-center gap-1">
            <p className="min-w-0 flex-1 py-1 text-[13px] leading-snug text-mp-ink">
              <span className="font-semibold">{formatTime(missedStart, tz)} feed:</span> {listWords(missed.map((m) => m.what))} not logged
            </p>
            {!readOnly && (
              <button
                type="button"
                aria-expanded={open === "fix"}
                onClick={() => toggle("fix")}
                className="inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-xl px-2.5 text-[14px] font-medium text-mp-accent-fg transition active:bg-mp-ink/5"
              >
                Fix
                <Icon name="chevron-right" size={15} className={cx("transition", open === "fix" && "rotate-90")} />
              </button>
            )}
          </div>
          {!readOnly && open === "fix" && (
            <div ref={reveal} className={cx("-ml-0.5 flex flex-wrap items-center gap-x-1 pb-1", CLEAR_DOCK)}>
              {fixes.map((m) => (
                <span key={m.key}>{actionView(m.fix!, false)}</span>
              ))}
              <Button variant="ghost" size="sm" onClick={setAside} aria-label="Got it: set this aside on this phone" className="-ml-1 text-mp-ink-2!">
                Got it
              </Button>
            </div>
          )}
        </div>
      )}

      {underway && fp.after && (
        <div className="mt-3 border-t border-mp-line pt-2.5 text-[13px] leading-snug text-mp-ink-2">
          <p className="font-semibold text-mp-ink [overflow-wrap:anywhere]">
            Then{fp.after.night ? " the night feed" : ""}: {fp.after.feed.name}
          </p>
          {dueAfter && <p>{cardDueWords(dueAfter, now, tz, w.him)}</p>}
        </div>
      )}

      {/* The card's last line: the plan's other feeds (before one) or which one it was (during one), and the faint line. */}
      {canOther || canWas ? (
        <div className={cx("flex items-center gap-3", underway ? "mt-1" : "mt-0.5")}>
          <button
            type="button"
            aria-expanded={open === "other" || open === "was"}
            onClick={() => toggle(canWas ? "was" : "other")}
            className="-ml-2 inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-xl px-2 text-[14px] text-mp-ink-2 transition active:bg-mp-ink/5"
          >
            {canWas ? `Not ${focus.feed.name}?` : "Other feed"}
            {!canWas && <Icon name="chevron-right" size={15} className={cx("transition", open === "other" && "rotate-90")} />}
          </button>
          <p className="min-w-0 flex-1 text-right text-[12px] leading-snug text-mp-ink-3">{footer}</p>
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-snug text-mp-ink-3">{footer}</p>
      )}
      {(open === "other" && canOther) || (open === "was" && canWas) ? (
        <div ref={reveal} role="group" aria-label={open === "was" ? "Which feed it was" : "The plan's other feeds"} className={cx("-mx-2 mb-2 border-t border-mp-line pt-1", CLEAR_DOCK)}>
          <p className="px-2 pt-1 text-[12px] leading-snug text-mp-ink-2">{open === "was" ? "Which feed was it? Every phone follows." : "Do another feed instead, on this phone:"}</p>
          {open === "was"
            ? wasList.map((f) => (
                <ChooserRow key={f.id} disabled={busy} onClick={() => correct(f)} label={`It was ${f.name}`}>
                  {f.name}
                </ChooserRow>
              ))
            : [
                ...(chosen
                  ? [
                      <ChooserRow key="back" disabled={busy} onClick={() => pickFeed(null)} label={`Back to ${base.focus.feed.name}`}>
                        Back to {base.focus.feed.name}
                      </ChooserRow>,
                    ]
                  : []),
                ...others.map((f) => (
                  <ChooserRow key={f.id} disabled={busy} onClick={() => pickFeed(f.id)} label={`Do ${f.name} instead`}>
                    {f.name}
                  </ChooserRow>
                )),
              ]}
        </div>
      ) : null}
    </section>
  );
}

/** One feed in a chooser: its name, a 44px row. */
function ChooserRow({ children, onClick, disabled, label }: { children: ReactNode; onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-2 text-left text-[15px] text-mp-ink transition active:bg-mp-ink/5 disabled:opacity-40 [overflow-wrap:anywhere]"
    >
      <span className="min-w-0 flex-1">{children}</span>
      <Icon name="chevron-right" size={15} className="shrink-0 text-mp-ink-3" />
    </button>
  );
}

/** When it's due and what that counts from, calm in every state: early quiet, due in the accent, past the window a warm mark, never an alarm. */
function DueLine({ due, now, tz, her, from }: { due: PlanDue; now: Date; tz: string; her: string; from: string }) {
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
      <span className="min-w-0">
        {cardDueWords(due, now, tz, her)}
        {/* Past the window it already says how long since the last feed. */}
        {!late && <span className="font-normal text-mp-ink-2"> · {from}</span>}
      </span>
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

/** One step: its number (a check once logged, a dot while going), the plan's words or what was logged, and its actions. */
function Step({ row, action, secondary, close }: { row: PlanRow; action: ReactNode; secondary: ReactNode; close: ReactNode }) {
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
          {/* Beside the row, small: milk at the breast still to log once the nursing is over; She's done for a short bottle. */}
          {(secondary || close) && (
            <div className="-mb-1 flex flex-wrap items-center gap-x-3">
              {secondary}
              {close}
            </div>
          )}
        </div>
      </div>
      {/* The card's whole width: the biggest thing on it, and room for both sides at 320px. */}
      {action && <div className="mt-2.5">{action}</div>}
    </li>
  );
}
