/** Open a saved dose from a toast without coupling the care store to its navigation provider. */
export const DOSE_TIME_EVENT = "maple-edit-dose-time";

export function requestDoseTime(entryId: number): void {
  if (typeof window === "undefined" || !Number.isInteger(entryId) || entryId <= 0) return;
  window.dispatchEvent(new CustomEvent(DOSE_TIME_EVENT, { detail: { entryId } }));
}
