/**
 * One cooldown for the whole dock: a tap can swap the button under the
 * thumb (Sleep ↔ Woke up, Left → Switch to Right, the sleep strip's Put down
 * → How did it go?), so a double tap must not land on the replacement and do
 * the opposite thing. The dock's tiles and the sleep plan's strip on top of
 * it both wait this long after a tap.
 */
export const TAP_COOLDOWN_MS = 800;
