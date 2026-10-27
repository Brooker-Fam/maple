"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NEAR_BOTTOM, useVisibleArea } from "../chat/page";
import { ToastHost } from "../ui";

/**
 * A new family's setup as the Chat page: the Chat tab's frame (it fills what
 * the phone can see, messages scroll and stay pinned to the newest, the
 * composer sits at the bottom or on the keyboard), with the question's card
 * as the newest thing on the page. The chat portals its composer into the
 * bottom slot, so the card stays mounted when the chat comes or goes.
 */

type Frame = { composer: HTMLElement | null; keyboard: boolean };

const FrameContext = createContext<Frame>({ composer: null, keyboard: false });

export const useSetupFrame = () => useContext(FrameContext);

export function SetupPage({ header, children }: { header: ReactNode; children: ReactNode }) {
  const area = useVisibleArea(true);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [composer, setComposer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const stick = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    stick();
    const watch = new ResizeObserver(stick);
    watch.observe(inner);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <FrameContext.Provider value={{ composer, keyboard: !!area?.keyboard }}>
      <section
        aria-label="Chat"
        className="fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-lg flex-col bg-mp-bg"
        style={area ? { height: area.height, transform: `translateY(${area.top}px)` } : { height: "100dvh" }}
      >
        <header className="shrink-0 space-y-3 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-2">{header}</header>
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
        >
          <div ref={content} className="flex min-h-full flex-col justify-end gap-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+16px)]">
            {children}
          </div>
        </div>
        <div ref={setComposer} className="shrink-0" />
      </section>
      <ToastHost />
    </FrameContext.Provider>
  );
}
