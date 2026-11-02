import { createContext, useContext } from "react";

// Only the app state, the clock and the care sheets' opener are synthetic; the sleep provider, its sheets and Sheet stay real.
export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useNow = () => useFixture().now;
export const useHoldTimerToasts = () => {};
export const useCareNav = () => useFixture().careNav;
export const useSheets = () => ({ open: () => {}, close: () => {}, current: null });
