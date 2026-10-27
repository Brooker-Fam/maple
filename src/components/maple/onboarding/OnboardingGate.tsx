"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import type { OnboardingView } from "@/lib/maple/onboarding/steps";
import { useNotifications } from "../notify";
import { openSetupWhenReady } from "./actions";
import { useMaple } from "../useMaple";

const Onboarding = dynamic(() => import("./Onboarding"), { ssr: false });

type Check = { needed: boolean; view?: OnboardingView; failed?: true };

/**
 * A family whose setup isn't finished gets its setup as the Chat page
 * (Onboarding) in place of the app; everyone else gets `children` unchanged,
 * at once. The server decides (GET /api/maple/onboarding answers
 * `needed: false` for a finished family, family 1 among them).
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const { status, api, refresh, state } = useMaple();
  const notifications = useNotifications();
  const [notificationSetup, setNotificationSetup] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [asked, setAsked] = useState(false);
  const signedIn = status === "ready" || status === "error";
  // The log loaded, so this family is set up (the server refuses the log to one that isn't): nothing to ask.
  const loaded = status === "ready" && !!state;

  useEffect(() => {
    if (!signedIn || check || loaded) return;
    let live = true;
    api<Check>("/api/maple/onboarding")
      .then((res) => live && setCheck(res))
      .catch(() => live && setCheck({ needed: false, failed: true }))
      .finally(() => live && setAsked(true));
    return () => {
      live = false;
    };
  }, [signedIn, check, api, loaded]);

  // Offline on the first open: ask again, so a family still setting up isn't left on the error screen.
  useEffect(() => {
    if (!check?.failed) return;
    const t = window.setTimeout(() => setCheck(null), 15_000);
    return () => window.clearTimeout(t);
  }, [check]);

  useEffect(() => {
    if (status === "signedOut") {
      setCheck(null);
      setNotificationSetup(false);
    }
  }, [status]);

  useEffect(() => {
    if (openSetupWhenReady(notificationSetup, loaded, notifications.open)) setNotificationSetup(false);
  }, [notificationSetup, loaded, notifications.open]);

  if (check?.needed && check.view) {
    return (
      <Onboarding
        initial={check.view}
        onDone={(requested) => {
          setNotificationSetup(requested);
          setCheck({ needed: false });
          void refresh();
        }}
      />
    );
  }
  // A family with no baby yet can't load the log: wait for the answer rather than flash its error screen.
  if (status === "error" && !asked) return null;
  return children;
}
