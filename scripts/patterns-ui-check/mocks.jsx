import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
const fixture = () => useContext(FixtureContext);
export const useMaple = () => fixture().maple;
export const useNow = () => fixture().maple.now();
export const useCareNav = () => fixture().careNav;
export const useCare = () => null;
export const useSheets = () => fixture().sheets;
export const useChatNav = () => ({ ask: () => false });
export const useTimerActions = () => ({});
export const useHoldTimerToasts = () => {};
export const doneText = () => { throw new Error("Unexpected timer write"); };
export const nextSideWords = () => { throw new Error("Unexpected timer write"); };
export class ApiError extends Error {}
