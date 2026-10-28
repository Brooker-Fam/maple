"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminActsAs } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { CareEntryInput, CareNutritionEntry, CareNutritionInput, DoseResult } from "@/lib/maple/types";
import { ApiError, useMaple } from "../useMaple";
import type { UseCare } from "./useCare";

function clientId(): string {
  try { return crypto.randomUUID(); }
  catch { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
}

export function useNutrition(care: UseCare) {
  const maple = useMaple();
  const latest = useRef({ maple, care });
  latest.current = { maple, care };
  const active = useRef(true);
  const inflight = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const save = useCallback(async (input: CareNutritionInput, existing?: CareNutritionEntry): Promise<void> => {
    const { maple: current, care: currentCare } = latest.current;
    const state = current.state;
    if (!active.current || !state?.care || !currentCare.access.write) throw new Error("This page isn't available for changes.");
    if (inflight.current) return;
    const sameSession = () => {
      const next = latest.current.maple.state;
      return active.current && next?.family?.id === state.family?.id && next?.me.email === state.me.email
        && next?.care?.person.member === state.care?.person.member && next?.care?.access.write === true;
    };
    inflight.current = true;
    setSaving(true);
    try {
      if (existing) {
        await currentCare.act.editEntry(existing.id, { data: input.data, at: input.at, note: input.note ?? null }, existing.updated_at);
        return;
      }
      const body: CareEntryInput = { ...input, client_id: clientId() };
      let result: DoseResult;
      try {
        result = await current.care.track(() => current.api<DoseResult>("/api/maple/care/entries", { method: "POST", body: JSON.stringify(body) }));
      } catch (error) {
        if (!sameSession()) return;
        if (error instanceof ApiError && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
        const timestamp = current.now().toISOString();
        const member = state.me.email === "admin" ? adminActsAs(state.baby, state.members)?.email ?? "admin" : state.me.email;
        const entry: CareNutritionEntry = {
          ...input, id: current.care.tempId(), med_id: null, note: input.note ?? null, private: false,
          created_by: member, updated_by: null, source: "web", created_at: timestamp, updated_at: timestamp,
        };
        current.care.queue(body, entry);
        current.toast("Saved on this phone · will sync when you're back online", {
          tone: "info", undo: () => void currentCare.act.deleteEntry(entry.id).catch(() => {}),
        });
        return;
      }
      if (!sameSession()) return;
      const entry = result.entry;
      if (!entry || (!result.created && !result.deduped)) throw new Error("That entry wasn't saved. Try again.");
      current.care.patch((value) => ({ ...value, entries: [entry, ...value.entries.filter((item) => item.id !== entry.id)] }));
      const label = input.kind === "food" ? "Food" : input.data.name;
      current.toast(`${label} logged at ${formatTime(entry.at, state.baby.timezone ?? DEFAULT_TZ)}`, {
        undo: () => void currentCare.act.deleteEntry(entry.id).catch(() => {}),
      });
    } finally {
      inflight.current = false;
      if (sameSession()) {
        setSaving(false);
        void current.refresh();
      }
    }
  }, []);

  return { save, saving };
}
