import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext).maple;
export const useNow = () => useMaple().now();
export const useCare = () => useContext(FixtureContext).care;
export const useCareNav = () => ({ openDoseTime() {}, openDose() {}, openTemp() {} });
export const useSheets = () => ({ open() {}, close() {} });
export class ApiError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}
