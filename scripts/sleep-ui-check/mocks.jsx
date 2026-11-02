import { createContext, useContext } from "react";
export { ApiError } from "../../src/lib/maple/client-request";

// Only the app state, the clock, the timer actions, the navigation and sheet openers and the care and chat openers are
// synthetic; Today, the dock, More, the toasts, the sleep provider, its strip, cards and sheets, and Sheet stay real.
export const FixtureContext = createContext(null);
const useFixture = () => useContext(FixtureContext);
export const useMaple = () => useFixture().maple;
export const useNow = () => useFixture().now;
export const useHoldTimerToasts = () => {};
export const useCareNav = () => useFixture().careNav;
export const CareNavProvider = ({ children }) => children;
export const useChatNav = () => useFixture().chatNav;
export const ChatNavProvider = ({ children }) => children;
export const useSheets = () => useFixture().sheets;
export const SheetProvider = ({ children }) => children;
export const useCare = () => null;
export const useTimerActions = () => useFixture().actions;
export const useAppNav = () => useFixture().appNav;
export const AppNavProvider = ({ children }) => children;
export const doneText = () => ({ text: "Done" });
export const nextSideWords = () => "Left next time";
