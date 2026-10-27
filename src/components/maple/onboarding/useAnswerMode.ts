"use client";

import { useState } from "react";

type AnswerMode = "chat" | "form";

const keyFor = (familyId: number) => `maple-onboarding-mode:${familyId}`;

function savedMode(familyId: number): AnswerMode {
  try {
    return localStorage.getItem(keyFor(familyId)) === "form" ? "form" : "chat";
  } catch {
    return "chat";
  }
}

export function useAnswerMode(familyId: number) {
  const [choice, setChoice] = useState(() => ({ familyId, mode: savedMode(familyId) }));
  if (choice.familyId !== familyId) setChoice({ familyId, mode: savedMode(familyId) });

  const chooseMode = (mode: AnswerMode) => {
    setChoice({ familyId, mode });
    try {
      localStorage.setItem(keyFor(familyId), mode);
    } catch {}
  };

  return {
    mode: choice.mode,
    chooseMode,
    fallbackToForm: () => setChoice({ familyId, mode: "form" }),
  };
}
