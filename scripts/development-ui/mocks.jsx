import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useNow = () => useFixture().maple.now();
export const useSheets = () => useFixture().sheets;
export const useCare = () => null;
export const useCareNav = () => ({});
export const useHoldTimerToasts = () => {};

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
