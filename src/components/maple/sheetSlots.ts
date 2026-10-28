/**
 * The open sheets' toast slots, newest last. While a sheet is open ToastHost
 * draws toasts in the top one, between its body and its footer, so a toast
 * takes room instead of sitting over the sheet's times or its Save (timer
 * toasts wait meanwhile, see SheetProvider; an error still shows).
 */
const sheetSlots: HTMLElement[] = [];
const slotSubs = new Set<() => void>();
export const subscribeSlots = (cb: () => void) => {
  slotSubs.add(cb);
  return () => {
    slotSubs.delete(cb);
  };
};
export const topSlot = () => sheetSlots[sheetSlots.length - 1] ?? null;
export const noSlot = () => null;
export function setSlot(el: HTMLElement, on: boolean) {
  const i = sheetSlots.indexOf(el);
  if (on === i >= 0) return;
  if (on) sheetSlots.push(el);
  else sheetSlots.splice(i, 1);
  for (const cb of slotSubs) cb();
}
