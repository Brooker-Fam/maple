"use client";

import { createContext, useContext, useEffect } from "react";

export const SettingsDraftContext = createContext<(id: string, dirty: boolean) => void>(() => {});

export function useSettingsDraft(id: string, dirty: boolean) {
  const register = useContext(SettingsDraftContext);
  useEffect(() => {
    register(id, dirty);
    return () => register(id, false);
  }, [dirty, id, register]);
}
