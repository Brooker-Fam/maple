import { createContext, useContext } from "react";

export const DoseFixtureContext = createContext(null);
export const useMaple = () => useContext(DoseFixtureContext).maple;
export const useCare = () => useContext(DoseFixtureContext).care;
export const useNow = () => useContext(DoseFixtureContext).sampledNow;
export const useHoldTimerToasts = () => {};
export const useSheets = () => ({ open: () => {}, close: () => {}, current: null });
export class ApiError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}
