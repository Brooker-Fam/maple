import { TAP_COOLDOWN_MS } from "./tapCooldown";

/**
 * Today's page moving under the thumb. Her Took it and the plan's Put down
 * are on the page (Up next), not the fixed dock, so a tap that takes
 * something away above them or brings something in pushes them, and the
 * second half of a double tap would land on whatever slid under it: a dose,
 * a try, an outcome. For the tap cooldown after a tap like that, a tap
 * anywhere on the page (`[data-today-page]`) does nothing. The taps that hold:
 * Up next's Put down and Last night Answer, the Last night card's Not now,
 * While you slept's Got it, the goal return card's Done, the holding card's
 * bassinet buttons, and the dock's sleep strip going away (the dock gets
 * shorter). A Put down's try card comes with the server's answer, so it also
 * holds again when that card arrives (holdTodayTapsWhenItMoves, then
 * todayPageMoved). The dock, toasts and sheets sit outside the page and are
 * never held, so a tap there still lands; the dock keeps its own cooldowns.
 *
 * One capturing listener on the window, added the first time it's needed: it
 * runs before React's own, so a held tap never reaches a handler.
 */
let holdUntil = 0;
let listening = false;

function onClick(e: MouseEvent) {
  if (performance.now() >= holdUntil) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target?.closest("[data-today-page]")) return;
  e.preventDefault();
  e.stopPropagation();
}

/** Hold taps on Today's page for `ms` (the tap cooldown by default); a longer hold already running is kept. */
export function holdTodayTaps(ms = TAP_COOLDOWN_MS): void {
  if (typeof window === "undefined") return;
  if (!listening) {
    window.addEventListener("click", onClick, true);
    listening = true;
  }
  holdUntil = Math.max(holdUntil, performance.now() + ms);
  markHeld();
}

/**
 * While taps are held, the page carries `data-taps-held`, so a check (or anyone debugging) can see it and wait it out;
 * nothing styles it.
 */
let markTimer: number | undefined;
function markHeld() {
  const page = document.querySelector("[data-today-page]");
  if (!page) return;
  page.setAttribute("data-taps-held", "");
  window.clearTimeout(markTimer);
  markTimer = window.setTimeout(() => document.querySelector("[data-today-page]")?.removeAttribute("data-taps-held"), Math.max(0, holdUntil - performance.now()) + 20);
}

/** Until when a tap on the page waits for the move it will bring (its write answered later). */
let moveExpectedUntil = 0;

/**
 * A page tap whose move comes later (a Put down: the try card arrives with the server's answer, which can take longer
 * than the cooldown): when that move comes within `withinMs`, it holds taps again (todayPageMoved).
 */
export function holdTodayTapsWhenItMoves(withinMs = 10_000): void {
  if (typeof window === "undefined") return;
  moveExpectedUntil = performance.now() + withinMs;
}

/**
 * The page just moved for a tap made on it (a try card came in): hold taps from now. True when a page tap was waiting
 * for it, so the card can take focus (the button tapped is gone); false for a move nobody on this page asked for (a try
 * started from the dock, Siri or another phone).
 */
export function todayPageMoved(): boolean {
  if (typeof window === "undefined" || performance.now() >= moveExpectedUntil) return false;
  moveExpectedUntil = 0;
  holdTodayTaps();
  return true;
}
