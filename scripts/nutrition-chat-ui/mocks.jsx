import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useNow = () => useFixture().maple.now();
export const useCare = () => useFixture().care;
export const useChatThread = () => useFixture().thread;
export const useCareNav = () => ({ openHelp() {}, openCare() {}, openSupport() {}, openDoctor() {} });
export const useSheets = () => ({});
export const useHoldTimerToasts = () => {};

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
