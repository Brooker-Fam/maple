"use client";

import { useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * One cooldown for a tap that swaps what's under the thumb, shared by the
 * dock (Sleep ↔ Woke up, Left → Switch to Right), the sleep strip (Put down →
 * How did it go?) and the sleep plan's cards, sheets and one-tap answers (Woke
 * up opening How did it go? with Picked up under the thumb, a Last night
 * answer bringing in the next question, Put her down turning the turn's card
 * into the try's). A double tap's second tap comes 100–400 ms after the first,
 * in the same place: within TAP_COOLDOWN_MS of the last tap that did something,
 * and NEAR_PX of where it landed, a tap does nothing. 600 ms, as long as a
 * toast's chips wait (ui.tsx CHIP_ARM_MS): nobody reads a new question and taps
 * its answer that fast, and a tap anywhere else isn't slowed at all.
 *
 * Something that changes with no tap here to bring it in (another phone's
 * answer on a poll, the clock) waits the same while after it appears, for a
 * tap of any place: the thumb was already on its way to what was there.
 */
export const TAP_COOLDOWN_MS = 600;
/** How far apart a double tap's two taps land: less than the 44px between two buttons' centers. */
const NEAR_PX = 40;

/** Where and when (the performance clock: monotonic, unlike the server-synced now(), which jumps on a poll). */
type Spot = { x: number; y: number; at: number; dock?: boolean };

/** The last pointer down anywhere, the last key down, and the last tap that did something. */
let down: Spot | null = null;
let keyAt = Number.NEGATIVE_INFINITY;
let last: Spot | null = null;
let watching = false;

function watch(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, at: performance.now() }), { capture: true, passive: true });
  window.addEventListener("keydown", () => (keyAt = performance.now()), { capture: true, passive: true });
}

/** Where a tap at `at` began: its pointer down (none for a key since, or for an assistive activation with no pointer). */
const spotOf = (at: number): Spot | null => (down && at - down.at < 1500 && down.at > keyAt ? down : null);

/** A tap that did something (`dock`: one of the dock's tiles): what it brings in under the thumb waits out the cooldown. */
export function noteTap(at = performance.now(), opts: { dock?: boolean } = {}): void {
  watch();
  const p = spotOf(at);
  last = { x: p?.x ?? Number.NaN, y: p?.y ?? Number.NaN, at, dock: !!opts.dock };
}

/** A double tap's second half: soon after the last tap that did something, where it landed. A stutter stays one tap. */
export function doubleTap(at = performance.now()): boolean {
  const p = spotOf(at);
  const near = !!last && !!p && at - last.at < TAP_COOLDOWN_MS && Math.hypot(p.x - last.x, p.y - last.y) < NEAR_PX;
  if (near) last = { ...last!, at };
  return near;
}

/** The dock's own wait: any tile soon after the last tile tapped, since its tiles sit edge to edge. */
export function dockTapped(at = performance.now()): boolean {
  return !!last?.dock && at - last.at < TAP_COOLDOWN_MS;
}

export type TapGuard = {
  /** True while what it guards only just changed with no tap here to bring it in. */
  fresh: (at?: number) => boolean;
  /** One button's one-tap action: nothing for a double tap's second half or while fresh; otherwise noted, then run. */
  tap: <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => void;
  /**
   * Spread on a card or a sheet's host: every button and link in it does nothing for those taps, and every button tap
   * that went through is noted (a chip's too: its place is where a second tap would land, and a toggle tapped twice at
   * once was meant once).
   */
  props: { onClickCapture: (e: ReactMouseEvent) => void; onClick: (e: ReactMouseEvent) => void };
};

/**
 * The guard for buttons a tap (or another phone, or the clock) can put under
 * the thumb. `key` names what they show (a question, a card's state, a sheet's
 * open, a button's label): a new one arms them again.
 */
export function useTapGuard(key: string | number | null = null): TapGuard {
  const shown = useRef({ at: Number.NEGATIVE_INFINITY, elsewhere: false });
  // Before the browser paints it, so no tap can land on it unarmed. A change no touch or key here just brought in came
  // from elsewhere (with a touch, doubleTap covers its second half); never the page's first showing, before anyone
  // touched it, and never for someone using only keys.
  useLayoutEffect(() => {
    watch();
    const at = performance.now();
    shown.current = { at, elsewhere: !!down && at - Math.max(down.at, keyAt) >= TAP_COOLDOWN_MS };
  }, [key]);
  return useMemo(() => {
    const fresh = (at = performance.now()) => shown.current.elsewhere && at - shown.current.at < TAP_COOLDOWN_MS;
    const blocked = (at: number) => doubleTap(at) || fresh(at);
    return {
      fresh,
      tap:
        <A extends unknown[]>(fn: (...args: A) => unknown) =>
        (...args: A) => {
          const at = performance.now();
          if (blocked(at)) return;
          noteTap(at);
          fn(...args);
        },
      props: {
        onClickCapture: (e: ReactMouseEvent) => {
          if (!(e.target as Element | null)?.closest?.("button, a[href]") || !blocked(performance.now())) return;
          e.preventDefault();
          e.stopPropagation();
        },
        onClick: (e: ReactMouseEvent) => {
          if ((e.target as Element | null)?.closest?.("button")) noteTap();
        },
      },
    };
  }, []);
}

/**
 * After a one-tap answer takes its own button away: focus the first of
 * `targets` (CSS selectors) that's there once React has drawn the change (the
 * next question, else the card's heading), so a screen reader's place isn't
 * dropped back at the top of the page. Headings take focus without a tab stop.
 */
export function focusNext(...targets: string[]): void {
  if (typeof window === "undefined") return;
  const go = () => {
    for (const sel of targets) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el || el.closest("[hidden], [inert]")) continue;
      if (!el.matches("button, a[href], input, select, textarea, [tabindex]")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      return;
    }
  };
  // Two frames: the answer's state lands in a render of its own, after this.
  requestAnimationFrame(() => requestAnimationFrame(go));
}
