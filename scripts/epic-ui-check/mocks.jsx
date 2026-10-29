import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext);
export const useNow = () => new Date("2026-01-15T17:00:00Z");
export const useSheets = () => ({ close: () => {} });
export const AskChatButton = () => null;
