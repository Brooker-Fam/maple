import { createContext, useContext } from "react";

// Bundle-time aliases only. These hooks never enter a production route.
export const FixtureContext = createContext(null);
const fixture = () => useContext(FixtureContext);
export const useMaple = () => fixture().maple;
export const useNow = () => fixture().maple.now();
export const useChatThread = () => fixture().thread;
export const useChatNav = () => fixture().chatNav;
export const useCareNav = () => fixture().nav;
export const useCare = () => fixture().care ?? null;
export const useSheets = () => fixture().sheets;
export const useAppNav = () => fixture().appNav;
export const useTimerActions = () => ({});
export const useHoldTimerToasts = () => {};

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
