import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext);
export const useNow = () => useMaple().now();
export const useHoldTimerToasts = () => {};
export const useCareNav = () => ({});
export const useNotifications = () => ({ open() {}, value: "Off" });
export const useSheets = () => ({});
export const OnTop = ({ children }) => createPortal(children, document.body);
export const CrisisStrip = () => null;
export const CheckInSection = () => null;
export const TemperatureTile = () => null;
export const QuestionsSection = () => null;
export const VisitSummaryRow = () => null;
export const ChatCareRow = () => null;
export const NotificationsRow = () => null;
export default function UnrelatedScreen() { return null; }
export class ApiError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}
