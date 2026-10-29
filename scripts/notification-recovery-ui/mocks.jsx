const state = { baby: { name: "River", sex: "female", timezone: "UTC", settings: {} }, family: { id: 99 }, me: { email: "sam@example.test", role: "owner" }, entries: [] };
const fixture = window.notificationFixture = {
  deleted: false, unsubscribed: false, prefs: { nursing: true },
  mark: { member: "sam@example.test", endpoint: "https://push.example.test/synthetic" },
  failDelete: true, unsubscribeResult: "reject", reads: [], saves: [], toasts: [], signouts: 0,
};
const health = { clock: "ok", checked_at: "2026-10-28T12:00:00Z", clock_at: "2026-10-28T12:00:00Z", undelivered: 0, missed: [], gaps: [], test: null, needs_resubscribe: false };
const api = async (url, options = {}) => {
  if (url === "/api/maple/auth/signout") { fixture.signouts++; return {}; }
  if (options.method === "DELETE") {
    if (fixture.failDelete) throw new Error("Synthetic delete failure");
    fixture.deleted = true;
    return {};
  }
  if (options.method === "PATCH") {
    const prefs = JSON.parse(options.body).prefs;
    const save = () => { fixture.prefs = prefs; return { sub: { prefs } }; };
    return fixture.holdSave ? new Promise(resolve => fixture.saves.push(() => resolve(save()))) : save();
  }
  const result = { publicKey: "synthetic", sub: fixture.deleted ? null : { prefs: { ...fixture.prefs } }, health, reminders: null };
  return fixture.holdRead ? new Promise(resolve => fixture.reads.push(() => resolve(result))) : result;
};
const now = () => new Date("2026-10-28T12:00:00Z");
const toast = message => { fixture.toasts.push(message); };
const refresh = async () => {};
export const useMaple = () => ({ state, status: "ready", api, toast, refresh, now, units: "us", readOnly: false });
export const useNow = now;
export const useHoldTimerToasts = () => {};
export const useCare = () => null;
export class ApiError extends Error {}
export const supported = () => true;
export const permission = () => "granted";
export const readMark = () => fixture.mark;
export const writeMark = mark => { fixture.mark = mark; };
export const registration = async () => undefined;
export const existing = async () => fixture.unsubscribed ? null : {
  endpoint: "https://push.example.test/synthetic",
  unsubscribe: async () => {
    if (fixture.unsubscribeResult === "reject") throw new Error("Synthetic unsubscribe failure");
    fixture.unsubscribed = fixture.unsubscribeResult;
    return fixture.unsubscribeResult;
  },
};
export const keyMatches = () => true;
export const stoppedSnoozed = () => true;
export const snoozeStopped = () => {};
export const offersShown = () => 3;
export const countOffer = () => {};
export const OFFER_MAX = 3;
export const isIos = () => false;
export const standalone = () => false;
export const worker = async () => undefined;
export const deviceLabel = () => "Synthetic browser";
export const keyBytes = () => new Uint8Array();
