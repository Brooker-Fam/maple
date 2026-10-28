import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useNow = () => useFixture().maple.now();
export const useChatThread = () => useFixture().thread;
export const useCareNav = () => useFixture().careNav;
export const useCare = () => null;
export const useSheets = () => useFixture().sheets;
export const useTimerActions = () => ({});
export const useHoldTimerToasts = () => {};
export const doneText = () => { throw new Error("Unexpected timer write"); };
export const nextSideWords = () => { throw new Error("Unexpected timer write"); };

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
