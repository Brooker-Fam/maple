"use client";

import { createContext, useContext } from "react";
import type { CarePlan } from "@/lib/maple/types";
import type { ToastAction } from "../useMaple";
import type { NotifyStatus, PushHealth, PushPrefs, ReminderFact } from "./words";

/** What NotificationsProvider shares (its own file, so the sheet and useCare read it without importing the provider). */

export type Notifications = {
  status: NotifyStatus;
  prefs: PushPrefs;
  /** The server's clock and this phone's deliveries and latest test (null until read). */
  health: PushHealth | null;
  /** What each of her current medicines can notify about; null for anyone who can't see them. */
  reminders: ReminderFact[] | null;
  /** The row's value: "On", "Off", "Stopped", "Home Screen app first", "On · may be late". */
  value: string | undefined;
  busy: boolean;
  problem: string | null;
  /** When this phone's last "Send a test in 1 minute" was due (the server forgets once it's sent). */
  testDueAt: string | null;
  isOpen: boolean;
  /** Show the Notifications sheet. */
  open(): void;
  close(): void;
  /** Call it straight from a tap: the permission prompt is asked before anything awaits (iOS insists). Resolves true once on. */
  turnOn(): Promise<boolean>;
  turnOff(): Promise<void>;
  /** The whole prefs object (the server replaces it). */
  setPrefs(p: PushPrefs): Promise<void>;
  /** "Send a test in 1 minute" through the real scheduled path; `all` (owners): every phone on this login. */
  testInOneMinute(opts?: { all?: boolean }): Promise<{ due_at: string; phones: number } | null>;
  /** "Send one now": straight from the server, no clock involved. */
  sendNow(): Promise<boolean>;
  /** Re-read the browser and the server. */
  refresh(): Promise<void>;
  /**
   * Sign-out: this phone's notifications off (DELETE, then unsubscribe), before
   * the session goes. Resolves true when something was turned off. Never throws.
   */
  forgetThisPhone(): Promise<boolean>;
};

/** A tapped notice's URL, for the app to go to: `window.addEventListener(MAPLE_OPEN_EVENT, (e) => { route(e.detail.url); e.preventDefault(); })`. */
export const MAPLE_OPEN_EVENT = "maple-open";
export type MapleOpenEvent = CustomEvent<{ url: string }>;

const noop = async () => {};
const NONE: Notifications = {
  status: "loading",
  prefs: {},
  health: null,
  reminders: null,
  value: undefined,
  busy: false,
  problem: null,
  testDueAt: null,
  isOpen: false,
  open: () => {},
  close: () => {},
  turnOn: async () => false,
  turnOff: noop,
  setPrefs: noop,
  testInOneMinute: async () => null,
  sendNow: async () => false,
  refresh: noop,
  forgetThisPhone: async () => false,
};

export const NotificationsContext = createContext<Notifications | null>(null);

/** The chip a dose toast can carry ("Remind me at 12:56 PM"), on a context that never changes, so useCare doesn't re-render on every health read. */
export type Offer = (plan: CarePlan, nextAt: string | null) => ToastAction | null;
export const OfferContext = createContext<Offer | null>(null);
const noOffer: Offer = () => null;

/** This phone's notifications. Outside the provider: a quiet stand-in where every action does nothing. */
export function useNotifications(): Notifications {
  return useContext(NotificationsContext) ?? NONE;
}

/**
 * For a saved dose's toast: "Remind me at 12:56 PM" on a phone whose
 * notifications are off (supported, not denied) when the plan has a next
 * time, at most 3 times per phone and never once on. In an iPhone Safari tab
 * it's "Get reminders on this phone" and opens the sheet's steps. Null: no chip.
 */
export function useRemindChip(): Offer {
  return useContext(OfferContext) ?? noOffer;
}
