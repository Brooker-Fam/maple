/**
 * The browser's side of notifications on this phone: support, the service
 * worker (/maple/sw.js, notifications only), the push subscription, and a
 * few per-phone notes in localStorage. Every storage read and write is in
 * try/catch: a private window or blocked storage just remembers less.
 */

export const SW_URL = "/maple/sw.js";
export const SCOPE = "/maple";

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

export function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export const supported = (): boolean => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export const permission = (): NotificationPermission | null => (typeof window !== "undefined" && "Notification" in window ? Notification.permission : null);

/** A label the phone gives itself on the server ("iPhone"): never a person. */
export const deviceLabel = (): string => (isIos() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Browser");

export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** False only when the subscription was made with a different server key (it can't be reused; the server's sends to it fail). */
export function keyMatches(sub: PushSubscription, publicKey: string | null): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key || !publicKey) return true;
  try {
    return sameBytes(new Uint8Array(key), keyBytes(publicKey));
  } catch {
    return true;
  }
}

export async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.getRegistration(SCOPE);
  } catch {
    return undefined;
  }
}

export async function existing(): Promise<PushSubscription | null> {
  const reg = await registration();
  try {
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** An active worker for /maple: register (or reuse) it and wait until it's running. */
export async function worker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
  if (reg.active) return reg;
  const sw = reg.installing ?? reg.waiting;
  if (sw) {
    await new Promise<void>((resolve) => {
      const done = () => sw.state === "activated" && resolve();
      sw.addEventListener("statechange", done);
      done();
      // Never hang the switch on a worker that won't say so.
      window.setTimeout(resolve, 8000);
    });
  }
  return reg;
}

// ── per-phone notes ─────────────────────────────────────────────────────

/**
 * The subscription this phone last turned on, and for whom: how the app
 * tells "Stopped" (it was on here and the browser dropped it) from "Off"
 * (never on, or turned off), and notices an endpoint the browser swapped.
 */
export type Mark = { endpoint: string; member: string };
const MARK_KEY = "maple-push-endpoint";

export function readMark(): Mark | null {
  try {
    const raw = window.localStorage.getItem(MARK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Mark>;
    return typeof v.endpoint === "string" && typeof v.member === "string" ? { endpoint: v.endpoint, member: v.member } : null;
  } catch {
    return null;
  }
}

export function writeMark(m: Mark | null): void {
  try {
    if (m) window.localStorage.setItem(MARK_KEY, JSON.stringify(m));
    else window.localStorage.removeItem(MARK_KEY);
  } catch {
    // remembered for this visit only
  }
}

function readNumber(key: string): number {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, n: number): void {
  try {
    window.localStorage.setItem(key, String(n));
  } catch {
    // storage blocked
  }
}

/** "Remind me at …" in a dose toast: at most this many times per phone. */
export const OFFER_MAX = 3;
const OFFERS_KEY = "maple-remind-offers";
// Without storage the count lives for the visit, so a blocked-storage phone still isn't asked on every dose.
let offersMemo: number | null = null;
export const offersShown = (): number => Math.max(offersMemo ?? 0, readNumber(OFFERS_KEY));
export function countOffer(): void {
  offersMemo = offersShown() + 1;
  writeNumber(OFFERS_KEY, offersMemo);
}

/** "Notifications stopped on this phone": once a day at most, three days after "Not now". */
const STOPPED_KEY = "maple-push-stopped-until";
export const stoppedSnoozed = (now: number): boolean => readNumber(STOPPED_KEY) > now;
export const snoozeStopped = (until: number): void => writeNumber(STOPPED_KEY, until);
