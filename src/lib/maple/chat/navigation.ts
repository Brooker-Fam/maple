import { z } from "zod";

/** Fixed in-app destinations only. The model never supplies a URL or a selector. */
export const CHAT_DESTINATIONS = ["today", "history", "moments", "family_settings", "phone_preferences", "baby_profile", "pediatrician", "notifications", "doctor_questions", "mom_medicines", "add_photo", "help", "people", "feeding_plan"] as const;
export type ChatDestination = (typeof CHAT_DESTINATIONS)[number];

export const navigationInputSchema = z.object({ destination: z.enum(CHAT_DESTINATIONS) }).strict();
export const navigationCardSchema = z.object({ v: z.literal(1), destination: z.enum(CHAT_DESTINATIONS) }).strict();
export type ChatNavigationCard = z.infer<typeof navigationCardSchema>;

export const DESTINATION_LABELS: Record<ChatDestination, string> = {
  today: "Today", history: "History", moments: "Moments", family_settings: "Family settings",
  phone_preferences: "This phone's settings", baby_profile: "Baby details", pediatrician: "Doctor contacts",
  notifications: "Notifications", doctor_questions: "For the doctor", mom_medicines: "Medicines",
  add_photo: "Add a photo", help: "Help", people: "People & permissions", feeding_plan: "Feeding plan",
};

/**
 * `parts`: this person's levels of the parts an owner can turn down
 * (access.ts): no For the doctor where its questions are hidden, no Moments
 * where moments are, and no Add a photo below adding them.
 */
export function destinationAllowed(destination: ChatDestination, viewer: boolean, parts: { doctor?: "none" | "view" | "log"; moments?: "none" | "view" | "log" } = {}): boolean {
  if (destination === "doctor_questions" && parts.doctor === "none") return false;
  if (destination === "moments" && parts.moments === "none") return false;
  if (destination === "add_photo" && parts.moments !== undefined && parts.moments !== "log") return false;
  return !viewer || (destination !== "mom_medicines" && destination !== "add_photo");
}
