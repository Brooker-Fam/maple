"use client";

import { partLevelOf, type Part, type PartLevel } from "@/lib/maple/access";
import { useMaple } from "./useMaple";

/**
 * This person's level of a part an owner can turn down for them (access.ts:
 * the questions for the doctor, moments, the chat): what the app shows and
 * offers them. The server decides every read and write on its own; this only
 * keeps the app from showing what's hidden or offering what it would refuse.
 * Before the first state arrives nothing is narrowed, as `readOnly` isn't
 * either (no screen that reads this shows before it).
 */
export function usePart(part: Part): PartLevel {
  const { state } = useMaple();
  return state?.me ? partLevelOf(state.me, part) : "log";
}

/** The in-app chat is on for this person: not a photos-only guest, and not turned off by an owner. */
export function useChatOn(): boolean {
  return usePart("chat") !== "none";
}
