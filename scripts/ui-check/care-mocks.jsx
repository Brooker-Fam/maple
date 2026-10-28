import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const CareFixtureContext = createContext(null);
export const useMaple = () => useContext(CareFixtureContext);
export const useNow = () => useMaple().now();
export const useHoldTimerToasts = () => {};
export const useAppNav = () => ({ go: () => {} });
export const useSheets = () => ({ open: () => {}, close: () => {}, current: null });
export const useTimerActions = () => ({});
export const doneText = () => "Done";
export const OnTop = ({ children }) => createPortal(children, document.body);
export const MomTempSheet = () => null;
export const requestQuestion = () => {};
export default function UnrelatedScreen() { return null; }
export class ApiError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}
