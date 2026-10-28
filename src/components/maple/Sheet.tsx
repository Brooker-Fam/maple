"use client";

import { AnimatePresence, motion, useDragControls, useReducedMotion } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { useNightActive } from "./nightLook";
import { Button, cx, tone } from "./ui";
import { setSlot } from "./sheetSlots";
import { registerSheet } from "./sheetHistory";

// ── Sheet (bottom drawer) ────────────────────────────────────────────────

/**
 * Make everything outside `el` inert (the app, the dock, the tab bar), so
 * Tab and Switch Control stay in an open sheet and can't reach Done in the
 * dock behind it. The toast host stays live (a toast leaving as the sheet
 * opens must not let a tap fall through it); while a sheet is open, toasts
 * draw inside it (sheetSlots). Returns the undo, which clears only what this
 * call set.
 */
function inertOutside(el: HTMLElement): () => void {
  const set: HTMLElement[] = [];
  const shut = (n: Element) => {
    if (!(n instanceof HTMLElement) || n.inert || n.matches("script, style, link, template, [data-maple-toasts]")) return;
    if (n.querySelector("[data-maple-toasts]")) {
      for (const c of Array.from(n.children)) shut(c);
      return;
    }
    n.inert = true;
    set.push(n);
  };
  let node: HTMLElement = el;
  while (node.parentElement && node !== document.body) {
    for (const sib of Array.from(node.parentElement.children)) if (sib !== node) shut(sib);
    node = node.parentElement;
  }
  return () => {
    for (const n of set) n.inert = false;
  };
}

/** The open sheets, newest last: Escape closes only the top one (and nothing while that one is locked). */
const openSheets: object[] = [];

/** How long a locked sheet ignores taps after it opens: a double tap on whatever opened it must not start a call. */
const LOCK_HOLD_MS = 700;
const SheetArmed = createContext(true);

/** False for a locked sheet's first moments, while its buttons ignore taps (they show it as aria-disabled). */
export function useSheetArmed(): boolean {
  return useContext(SheetArmed);
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  calm,
  locked,
  actions,
  display,
  tall,
  dirty = false,
}: {
  open: boolean;
  dirty?: boolean;
  onClose: () => void;
  title: string;
  /** One quiet line under the title ("Nursing · feed started 4:00 PM"). */
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Fix times: it stops at 90% of the screen, and focus goes to the title,
   * then back to whatever opened it. (Every sheet fades in without a slide
   * at night and under Reduce Motion.)
   */
  calm?: boolean;
  /**
   * The crisis sheet: no backdrop close, no drag-to-dismiss, no Escape and no
   * X, so the only ways out are its own `actions`. For its first 700 ms every
   * tap inside is ignored (useSheetArmed tells its buttons to say so).
   */
  locked?: boolean;
  /** Small text buttons in the header row, at the top; a locked sheet's only way out ("Close"). */
  actions?: ReactNode;
  /** The title in the display serif, larger: her screen's name, the one place it's used (§11.5). */
  display?: boolean;
  /** The chat: always 92% of the screen, so it doesn't grow under the thumb with every reply. */
  tall?: boolean;
}) {
  const [discarding, setDiscarding] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setDiscarding(true);
    else onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    if (!open || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm("Leave and discard your unsaved changes?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("maple-before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("maple-before-navigate", beforeNavigate);
    };
  }, [open, dirty]);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const night = useNightActive();
  const reduce = useReducedMotion();
  // A locked sheet holds its taps for a moment each time it opens (React's "adjust state while rendering" pattern).
  const [armed, setArmed] = useState(!locked);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && discarding) setDiscarding(false);
    if (open && locked && armed) setArmed(false);
  }
  useEffect(() => {
    if (!open || armed) return;
    const t = window.setTimeout(() => setArmed(true), LOCK_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [open, armed]);
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  });
  // No slide at 3am or with Reduce Motion: it fades in where it will sit.
  const still = night || !!reduce;
  // aria-modal alone doesn't keep focus in: the background goes inert while it's open.
  // The opener is noted first (going inert takes its focus) and refocused once it's live again.
  useEffect(() => {
    if (!open || !rootRef.current) return;
    const opener = document.activeElement as HTMLElement | null;
    const undo = inertOutside(rootRef.current);
    return () => {
      undo();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open, calm]);
  // Toasts come in here while it's open (and go back above the dock as it starts to close).
  useEffect(() => {
    const el = slotRef.current;
    if (!open || !el) return;
    setSlot(el, true);
    return () => setSlot(el, false);
  }, [open]);
  // A toast in the slot takes the body's room. What you were on stays in view: the field you're typing in, or the
  // bottom of the form if you'd scrolled down to it (never a jump from the top, where the sheet's main choice is).
  useEffect(() => {
    const slot = slotRef.current;
    const body = bodyRef.current;
    if (!open || !slot || !body) return;
    let h = slot.offsetHeight;
    const nearBottom = () => body.scrollTop > 0 && body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    let atBottom = nearBottom();
    const onScroll = () => (atBottom = nearBottom());
    const ro = new ResizeObserver(() => {
      const grew = slot.offsetHeight - h;
      h = slot.offsetHeight;
      if (grew <= 0) return;
      if (atBottom) body.scrollTop += grew;
      const a = document.activeElement;
      if (a instanceof HTMLElement && a !== body && body.contains(a)) a.scrollIntoView({ block: "nearest" });
    });
    body.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(slot);
    return () => {
      body.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [open]);
  // The latest onClose without re-running the effect: a parent ticking every second (the dock) would otherwise pull focus back to the top each time.
  const closeRef = useRef(requestClose);
  useEffect(() => {
    closeRef.current = requestClose;
  });
  useEffect(() => {
    if (!open) return;
    // Only the top sheet answers Escape, so a sheet opened from another closes alone and a locked one stays put.
    const me = {};
    openSheets.push(me);
    const leaveHistory = registerSheet(() => closeRef.current(), () => !!lockedRef.current);
    const onKey = (e: KeyboardEvent) => {
      if (openSheets.at(-1) !== me) return;
      if (e.key === "Escape" && !lockedRef.current) closeRef.current();
      if (e.key !== "Tab") return;
      const controls = [...(rootRef.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]') ?? [])]
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        e.preventDefault();
        panelRef.current?.focus();
      } else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (calm ? titleRef.current : panelRef.current)?.focus();
    return () => {
      openSheets.splice(openSheets.indexOf(me), 1);
      leaveHistory();
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, calm]);

  return (
    <>
    <AnimatePresence>
      {open && (
        // m-0!: a sheet rendered inside a space-y list mustn't pick up its margin and float off the bottom.
        <div ref={rootRef} className="fixed inset-0 z-[80] m-0! flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div
            className={cx("absolute inset-0", night ? "bg-black/55" : "bg-black/40")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={locked ? undefined : requestClose}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            initial={still ? { opacity: 0 } : { y: "100%" }}
            animate={still ? { opacity: 1 } : { y: 0 }}
            exit={still ? { opacity: 0 } : { y: "100%" }}
            transition={still ? { duration: 0.18 } : { type: "spring", damping: 30, stiffness: 320 }}
            drag={locked ? false : "y"}
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) requestClose();
            }}
            // A locked sheet's first moments: a tap (or Enter) does nothing, a tel: link included.
            onClickCapture={
              armed
                ? undefined
                : (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }
            }
            className={cx(
              "relative flex w-full max-w-lg flex-col rounded-t-[24px] bg-mp-bg outline-none sm:rounded-[24px]",
              calm ? "max-h-[90dvh]" : tall ? "h-[92dvh]" : "max-h-[92dvh]"
            )}
          >
            <SheetArmed.Provider value={armed}>
            {/* Drag from the header to dismiss; the body scrolls normally. A locked sheet has no grabber and doesn't drag. */}
            <div className={cx("shrink-0", !locked && "touch-none")} onPointerDown={locked ? undefined : (e) => drag.start(e)}>
            {locked ? (
              // No grabber: its way out is a row of small text buttons at the very top, never down by the thumb.
              <div className="flex min-h-[44px] flex-wrap items-center justify-end gap-x-1 px-3 pt-2">{actions}</div>
            ) : (
              <div className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-mp-ink/15" />
            )}
            <div className={cx("flex items-center justify-between gap-3 px-5 pb-3", locked ? "pt-0.5" : "pt-2")}>
              <div className="min-w-0">
                <h2 ref={titleRef} tabIndex={calm ? -1 : undefined} className={cx(display ? tone.display : tone.heading, display ? "text-[28px] leading-tight" : "text-[20px]", "outline-none")}>
                  {title}
                </h2>
                {subtitle && <p className="mt-0.5 text-[13px] leading-snug text-mp-ink-2">{subtitle}</p>}
              </div>
              {!locked && (
                <div className="-mr-1.5 flex shrink-0 items-center gap-1">
                  {actions}
                  <button type="button" onClick={requestClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
                      <Icon name="x" size={18} strokeWidth={2.25} />
                    </span>
                  </button>
                </div>
              )}
            </div>
            </div>
            <div ref={bodyRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-4">
              {children}
            </div>
            {/*
              Toasts while it's open (ToastHost portals them here): above the footer, never over it. A hairline
              sets one off from the form, so it can't read as the field above it; with no footer, it keeps clear
              of the home indicator.
            */}
            <div
              ref={slotRef}
              data-locked={locked ? "" : undefined}
              className={cx("shrink-0 px-5 not-empty:border-t not-empty:border-mp-line not-empty:pt-3", !footer && "pb-[env(safe-area-inset-bottom)]")}
              aria-live="polite"
            />
            {footer && (
              <div className="shrink-0 border-t border-mp-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {footer}
              </div>
            )}
            </SheetArmed.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
    {open && discarding && <Sheet open onClose={() => setDiscarding(false)} title="Discard unsaved changes?" calm footer={
      <div className="flex gap-3">
        <Button variant="soft" className="flex-1" onClick={() => setDiscarding(false)}>Keep editing</Button>
        <Button variant="danger" className="flex-1" onClick={() => { setDiscarding(false); onClose(); }}>Discard changes</Button>
      </div>
    }><p className="text-mp-ink-2">Your changes have not been saved.</p></Sheet>}
    </>
  );
}
