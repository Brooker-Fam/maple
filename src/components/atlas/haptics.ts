/* A tiny haptic tick for explicit reader actions (a Holds/Fails call, a swiped card).
   Android browsers vibrate; iOS Safari has no Vibration API, so this is a no-op there. */

export function tick(ms = 8) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
  } catch {
    /* some browsers throw when vibration is blocked; nothing to do */
  }
}
