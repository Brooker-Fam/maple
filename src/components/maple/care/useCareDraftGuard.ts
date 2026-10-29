"use client";

import { useEffect } from "react";

export function useCareDraftGuard(active: boolean, isSaving: () => boolean) {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!active && !isSaving()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (isSaving()) {
        event.preventDefault();
        window.alert("Your question or answer is still saving. Please wait before leaving.");
        return;
      }
      if (active && !window.confirm("Leave and discard your unsaved questions and answers?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("maple-before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("maple-before-navigate", beforeNavigate);
    };
  }, [active, isSaving]);
}
