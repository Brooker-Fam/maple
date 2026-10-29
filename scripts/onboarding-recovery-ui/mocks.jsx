import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext).maple;
export const useCare = () => useContext(FixtureContext).care;
export const useNow = () => useContext(FixtureContext).now;
export const useCareNav = () => ({ openHelp() {}, openDoctor() {} });
export const useSheets = () => ({ open() {}, close() {}, current: null });
export const useTimerActions = () => ({});
export const useHoldTimerToasts = () => {};
export const useNotifications = () => ({ value: "Off", open() {}, forgetThisPhone: async () => true });
export const NotificationsRow = () => <button type="button" className="min-h-11 px-4">Notifications</button>;

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
