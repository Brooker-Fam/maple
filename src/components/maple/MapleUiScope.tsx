"use client";

import { useEffect } from "react";

/**
 * Puts .maple-ui on <html> while any /maple page is open, which scopes the
 * app's font and page background (src/app/maple/maple.css). On <html> rather
 * than a wrapper so sheets, the dock and toasts portaled to <body> get it too.
 */
export default function MapleUiScope({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("maple-ui");
    return () => root.classList.remove("maple-ui");
  }, []);
  return <>{children}</>;
}
