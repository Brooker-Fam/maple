"use client";

import { useCallback, useState } from "react";
import type { OnboardingView, StepId } from "@/lib/maple/onboarding/steps";
import { useMaple } from "../useMaple";

export type InviteLink = { name: string; role: "member" | "viewer"; url: string };

/** Every write answers with the new view, so the next question is always the server's, never guessed here. */
export function useOnboarding(initial: OnboardingView) {
  const { api, refresh } = useMaple();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [versions, setVersions] = useState<Partial<Record<StepId, number>>>({});
  const [links, setLinks] = useState<InviteLink[]>([]);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      try {
        const res = await api<{ view: OnboardingView; invites?: InviteLink[] }>("/api/maple/onboarding", { method: "POST", body: JSON.stringify(body) });
        setView(res.view);
        const step = (body.step ?? body.skip) as StepId | undefined;
        if (step) setVersions((v) => ({ ...v, [step]: (v[step] ?? 0) + 1 }));
        if (res.invites?.length) setLinks((l) => [...l, ...res.invites!]);
        void refresh();
        return true;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : "Couldn't save that. Try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, refresh]
  );

  const reload = useCallback(async () => {
    try {
      const res = await api<{ needed: boolean; view?: OnboardingView }>("/api/maple/onboarding");
      if (res.view) setView(res.view);
      return res.needed;
    } catch {
      return true;
    }
  }, [api]);

  return {
    view,
    versions,
    busy,
    problem,
    clearProblem: () => setProblem(null),
    links,
    answer: (step: StepId, value: unknown) => post({ step, value }),
    skip: (step: StepId) => post({ skip: step }),
    finish: () => post({ finish: true }),
    reload,
  };
}

export type Onboarding = ReturnType<typeof useOnboarding>;
