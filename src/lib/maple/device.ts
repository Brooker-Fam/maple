/**
 * A per-install id for this copy of the app (localStorage 'maple-device'),
 * sent with every app request as X-Maple-Device. It exists only so a
 * notification can go to "the other phone" and skip the phone that did the
 * action. It is never shown to anyone, never names a person and never
 * decides access. Siri and assistant writes carry none.
 *
 * Safe to import from the client and the server (no Node or Next imports).
 */

export const DEVICE_HEADER = "X-Maple-Device";
export const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;

const KEY = "maple-device";
let memo: string | null = null;

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // not a secure context
  }
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** This install's id (made on first use); null on the server. Storage that throws keeps an in-memory id for the session. */
export function deviceId(): string | null {
  if (typeof window === "undefined") return null;
  if (memo) return memo;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored && DEVICE_RE.test(stored)) return (memo = stored);
  } catch {
    // private window or blocked storage
  }
  const id = makeId();
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // kept in memory only
  }
  return (memo = id);
}

/** The header to add to an app request, or none. */
export function deviceHeaders(): Record<string, string> {
  const id = deviceId();
  return id ? { [DEVICE_HEADER]: id } : {};
}

/** The id a request came with, if it's well formed (server side). */
export function deviceOf(request: { headers: { get(name: string): string | null } }): string | null {
  const v = request.headers.get(DEVICE_HEADER);
  return v && DEVICE_RE.test(v) ? v : null;
}

/** A stored or sent id, checked (anything else reads as none). */
export const cleanDevice = (v: unknown): string | null => (typeof v === "string" && DEVICE_RE.test(v) ? v : null);
