/**
 * The family this tab's screen shows (from its last state). Every write the
 * tab sends names it (X-Maple-Family, checked by withMember and withCare),
 * so a tab left open after a switch elsewhere is turned away with 409
 * `family_mismatch` instead of filing into the family the cookie now opens.
 */
let shown: number | null = null;

/** Fired on a mismatch, so the tab reloads the family it's really in. */
export const FAMILY_MOVED_EVENT = "maple:family-moved";

export function setShownFamily(id: number | null): void {
  shown = id;
}

export function shownFamilyHeaders(): Record<string, string> {
  return shown == null ? {} : { "X-Maple-Family": String(shown) };
}
