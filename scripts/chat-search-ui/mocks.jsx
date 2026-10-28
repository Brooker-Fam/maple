import { createContext, useContext } from "react";
export const FixtureContext = createContext(null);
const fixture = () => useContext(FixtureContext);
export const useMaple = () => fixture().maple;
export const useNow = () => new Date("2026-10-28T16:00:00.000Z");
export const useSheets = () => fixture().sheets;
export const useAppNav = () => fixture().nav;
