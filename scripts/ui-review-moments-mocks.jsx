import { createContext, useContext } from "react";

export const FixtureContext = createContext(null);
export const useMaple = () => useContext(FixtureContext);
export const useNow = () => new Date("2026-10-28T13:30:00.000Z");
export const useSheets = () => ({ open: (value) => { window.__momentsOpened = value; } });
export const photoUrl = (id, index, size = "thumb") => `/api/maple/photo?entry=${id}&i=${index}&size=${size}`;
