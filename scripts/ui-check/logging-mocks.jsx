import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const LoggingContext = createContext(null);
export const useMaple = () => useContext(LoggingContext).maple;
export const useNow = () => useMaple().now();
export const useSheets = () => useContext(LoggingContext).sheets;
export const useCare = () => null;
export const useCareNav = () => ({ openDoctor() {}, openHelp() {} });
export const useTimerActions = () => ({ dismissToast() {} });
export const useHoldTimerToasts = () => {};
export const useAppNav = () => ({ go() {} });
export const OnTop = ({ children }) => createPortal(children, document.body);
export const doneText = () => "Done";
export const nextSideWords = () => "Left next time";
export class ApiError extends Error {}
