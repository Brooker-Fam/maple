"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import FeedingPlanSheet from "./FeedingPlanSheet";

/**
 * One place to open the feeding plan's sheet from anywhere (Today's Next feed
 * card, Settings, More): useFeedingPlanNav().openPlan(). Mounted once in
 * MapleApp, beside CareNavProvider, holding the sheet itself. `edit`: open
 * straight on the form (adding a plan, or Edit from the card).
 */
export type FeedingPlanNav = { openPlan(opts?: { edit?: boolean }): void };

// Outside a provider (a stray render in a test, say) it does nothing.
const NONE: FeedingPlanNav = { openPlan: () => {} };
const Ctx = createContext<FeedingPlanNav | null>(null);

export function useFeedingPlanNav(): FeedingPlanNav {
  return useContext(Ctx) ?? NONE;
}

export function FeedingPlanNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Each open is a fresh sheet (its own draft), kept mounted while it slides away.
  const [shown, setShown] = useState<{ edit: boolean; seq: number } | null>(null);
  const openPlan = useCallback((opts?: { edit?: boolean }) => {
    setShown((s) => ({ edit: !!opts?.edit, seq: (s?.seq ?? 0) + 1 }));
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ openPlan }), [openPlan]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {shown && <FeedingPlanSheet key={shown.seq} open={open} edit={shown.edit} onClose={() => setOpen(false)} />}
    </Ctx.Provider>
  );
}
