"use client";

import { useSyncExternalStore } from "react";
import {
  EMPTY_MEMORY,
  MAX_SEEN,
  extraAgeDays,
  extraMilk,
  extraTopics,
  pickExtra,
  type ExtraMemory,
  type ExtraMilk,
  type ExtraTopic,
} from "@/lib/maple/whimsy";
import type { Entry } from "@/lib/maple/types";

/**
 * Little extras on this phone (lib/maple/whimsy): a fun fact, a joke or a
 * cheer under what was just logged. Its switch is Settings → Appearance →
 * "Fun facts and cheers" (localStorage "maple-extras", "on" or "off"; nothing
 * saved reads as on), and the phone remembers the lines it has shown
 * ("maple-extras-seen"), so each comes round once before any repeats. Neither
 * leaves the phone. A browser under automation (navigator.webdriver: the
 * app's UI checks) starts with them off, so its screens read as each check
 * expects; a check that wants them sets the switch.
 *
 * Callers inside the app use useMaple().extra(), which also keeps a line away
 * from an urgent alert and knows the night; takeExtra is the part underneath.
 */

export const EXTRAS_KEY = "maple-extras";
export const EXTRAS_SEEN_KEY = "maple-extras-seen";
const PREF_EVENT = "maple-extras-pref";

// Used when storage is blocked, so the switch and the round still work for this visit.
let memoryOn: boolean | null = null;
let memorySeen: ExtraMemory = EMPTY_MEMORY;

const automated = () => typeof navigator !== "undefined" && navigator.webdriver === true;

export function readExtrasOn(): boolean {
  try {
    const v = localStorage.getItem(EXTRAS_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // storage blocked: this visit's choice, if one was made
  }
  return memoryOn ?? !automated();
}

export function writeExtrasOn(on: boolean) {
  memoryOn = on;
  try {
    localStorage.setItem(EXTRAS_KEY, on ? "on" : "off");
  } catch {
    // storage blocked: memoryOn carries it for this visit
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => e.key === EXTRAS_KEY && cb();
  window.addEventListener(PREF_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREF_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** This phone's switch, for Settings → Appearance. */
export function useExtrasOn(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, readExtrasOn, () => false);
  return [on, writeExtrasOn];
}

function readMemory(): ExtraMemory {
  try {
    const raw = localStorage.getItem(EXTRAS_SEEN_KEY);
    if (!raw) return memorySeen;
    const v = JSON.parse(raw) as Partial<ExtraMemory> | null;
    return {
      seen: Array.isArray(v?.seen) ? v.seen.filter((x): x is string => typeof x === "string").slice(-MAX_SEEN) : [],
      at: typeof v?.at === "number" && Number.isFinite(v.at) ? v.at : null,
      kind: v?.kind === "fact" || v?.kind === "joke" || v?.kind === "cheer" ? v.kind : null,
    };
  } catch {
    return memorySeen;
  }
}

function writeMemory(m: ExtraMemory) {
  memorySeen = m;
  try {
    localStorage.setItem(EXTRAS_SEEN_KEY, JSON.stringify(m));
  } catch {
    // storage blocked: kept for this visit
  }
}

export type ExtraWhen = {
  /** The baby's birth time (state.baby.born_at): lines for an age wait for it. */
  bornAt: string | null | undefined;
  now: Date;
  /** 8 PM–7 AM in the family's timezone, or the night look on: quiet cheers only, spaced out. */
  night: boolean;
};

/**
 * The line for something just logged, as written (the toast fills in the
 * baby's name and pronouns as it shows: Toast.aside), or undefined for none:
 * the switch is off, nothing fits, or it's night and one showed a moment ago.
 * Taking one marks it shown.
 */
export function takeExtra(topics: ExtraTopic[] | null, when: ExtraWhen, milk?: ExtraMilk | null): string | undefined {
  if (!topics?.length || !readExtrasOn()) return undefined;
  const picked = pickExtra({ topics, ageDays: extraAgeDays(when.bornAt, when.now), night: when.night, milk, memory: readMemory(), now: when.now.getTime() });
  if (!picked) return undefined;
  writeMemory(picked.memory);
  return picked.extra.text;
}

/** takeExtra for an entry just saved: extraTopics says what its line may be about (none for a reading or a medicine). */
export function extraForEntry(e: Entry, when: ExtraWhen): string | undefined {
  return takeExtra(extraTopics(e, extraAgeDays(when.bornAt, when.now)), when, extraMilk(e));
}
