"use client";

import { useState } from "react";
import type { Entry } from "@/lib/maple/types";
import { Button } from "../ui";
import { useMaple } from "../useMaple";
import { useSheets } from "./index";

export function useSavedEntryConflict(entry: Entry | undefined) {
  const { state } = useMaple();
  const { open } = useSheets();
  const [received, onConflict] = useState<Entry | null>(null);
  const live = entry && state?.entries.find((item) => item.id === entry.id);
  const latest = received && (!live || Date.parse(received.updated_at) >= Date.parse(live.updated_at)) ? received : live;
  const changed = !!entry && !!latest && Date.parse(latest.updated_at) > Date.parse(entry.updated_at);

  return {
    changed,
    onConflict,
    notice: changed && (
      <div role="alert" className="space-y-2 rounded-xl bg-mp-sunken p-3 text-sm text-mp-ink-2">
        <p>This entry changed while you were editing. Your draft is still here. Review the latest entry before saving.</p>
        <Button variant="soft" onClick={() => open({ kind: latest.kind, entry: latest })}>
          Discard draft and use latest
        </Button>
      </div>
    ),
  };
}
