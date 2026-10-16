"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";

type Theme = "light" | "system" | "dark";

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  isDark: boolean;
}>({
  theme: "system",
  setTheme: () => {},
  isDark: false,
});

export function useTheme() {
  return useContext(ThemeContext);
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [isDark, setIsDark] = useState(false);

  const applyTheme = useCallback((t: Theme) => {
    const root = document.documentElement;
    if (t === "dark") {
      root.classList.add("dark");
      setIsDark(true);
    } else if (t === "light") {
      root.classList.remove("dark");
      setIsDark(false);
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", prefersDark);
      setIsDark(prefersDark);
    }
  }, []);

  useEffect(() => {
    // Browser storage can be blocked (Safari "Block all cookies", Firefox with storage off),
    // and then merely touching localStorage throws: fall back to the system theme.
    let stored: Theme | null = null;
    try {
      stored = localStorage.getItem("theme") as Theme | null;
    } catch {
      /* storage unavailable */
    }
    const initial = stored || "system";
    setThemeState(initial);
    applyTheme(initial);
  }, [applyTheme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme, applyTheme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem("theme", t);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    applyTheme(t);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
}
