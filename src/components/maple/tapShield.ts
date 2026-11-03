import { TAP_COOLDOWN_MS } from "./tapCooldown";

/**
 * Today's page moving under the thumb: Up next's Put down brings a bassinet
 * try's card in at the top of Right now, pushing the page down, so the second
 * half of a double tap would land on whatever slid under it (an outcome, Edit
 * time, the Last fed block). For the tap cooldown after a tap like that, a tap
 * anywhere on the page (`[data-today-page]`) does nothing. The dock, toasts
 * and sheets sit outside the page and are never held, so a tap there still
 * lands; the dock keeps its own cooldowns, and a try started from the dock's
 * strip moves nothing under its thumb.
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
}
