import { createContext, useContext } from "react";
export const FixtureContext = createContext(null);
const fixture = () => useContext(FixtureContext);
export const useMaple = () => fixture().maple;
export const useNow = () => new Date("2026-10-28T16:00:00.000Z");
export const useNotifications = () => fixture().notifications;
export const useAppNav = () => fixture().app;
export const useCareNav = () => fixture().careNav;
export const useCare = () => fixture().care;
export const useSheets = () => fixture().sheets;
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
