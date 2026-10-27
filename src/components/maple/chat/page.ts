"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * The Chat page's frame, shared by the Chat tab and a new family's setup
 * chat: the page fills what the phone can see, so the iPhone keyboard never
 * covers the composer. No AI SDK here, so the setup form doesn't carry it.
 */

/** The tab bar's height above the home indicator (56px buttons and a hairline). */
export const TAB_BAR = 57;
/** Within this of the bottom, new messages keep the page pinned there. */
export const NEAR_BOTTOM = 96;

/** What the phone can see, while the tab shows: null without visualViewport (the page then uses 100dvh). */
export function useVisibleArea(active: boolean) {
  const [area, setArea] = useState<{ height: number; top: number; keyboard: boolean } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const read = () => setArea({ height: vv.height, top: vv.offsetTop, keyboard: window.innerHeight - vv.height > 120 });
    read();
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    return () => {
      vv.removeEventListener("resize", read);
      vv.removeEventListener("scroll", read);
    };
  }, [active]);
  return area;
}

/** While the tab shows: the page under it doesn't scroll, and toasts clear the composer (as they clear Today's dock). */
export function usePageHold(active: boolean, composer: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = composer.current;
    if (!active || !el) return;
    const root = document.documentElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const set = () => root.style.setProperty("--maple-dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty("--maple-dock-h");
      document.body.style.overflow = prev;
    };
  }, [active, composer]);
}
