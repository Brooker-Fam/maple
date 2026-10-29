import { createContext, useContext } from "react";

// Only app state and write boundaries are synthetic; Lantern and Sheet stay real.
export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useCare = () => useFixture().care;
export const useNow = () => useFixture().now;
export const useTimerActions = () => useFixture().actions;
export const useSheets = () => useFixture().sheets;
export const useHoldTimerToasts = () => {};
export class ApiError extends Error {}
