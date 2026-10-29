"use client";

import { useCallback } from "react";
import { tick } from "@/components/atlas/haptics";
import type { Entry, Side, TimerResponse } from "@/lib/maple/types";
import { useMaple, type TimerCallOptions } from "./useMaple";

export function useEarlierSwitch(onSaved: (response: TimerResponse, side: Side, at: Date) => void) {
  const { timerCall } = useMaple();
  return useCallback(async (entry: Entry, side: Side, at: Date, options: TimerCallOptions = {}) => {
    tick();
    const response = await timerCall({
      action: "switch",
      id: entry.id,
      side,
      at: at.toISOString(),
      expect_updated_at: entry.updated_at,
    }, options);
    if (response && !response.noop) onSaved(response, side, at);
    return response;
  }, [onSaved, timerCall]);
}
