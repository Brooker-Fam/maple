import { createContext, useContext } from "react";
export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext);
export const useNow = () => new Date("2026-10-28T13:30:00.000Z");
export const useHoldTimerToasts = () => {};
export const useSheets = () => ({ open() {} });
export const AskChatButton = () => null;
export const photoUrl = (id, index, size = "thumb") => `/api/maple/photo?entry=${id}&i=${index}&size=${size}`;
export class ApiError extends Error { constructor(message, status, body) { super(message); this.status = status; this.body = body; } }
export default function SignOutButton() { return null; }
