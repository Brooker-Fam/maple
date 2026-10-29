import { createContext, useContext } from "react";

// Test-only aliases replace app hooks at bundle time. Production routes never load these.
export const FixtureContext = createContext(null);
export const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useCare = () => useFixture().care;
export const useCareNav = () => useFixture().nav;
export const useNow = () => useFixture().now;
export const useTimerActions = () => useFixture().timerActions;
export const useHoldTimerToasts = () => {};
export const useSheets = () => useFixture().sheets ?? { open: () => {}, close: () => {}, current: null };

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
