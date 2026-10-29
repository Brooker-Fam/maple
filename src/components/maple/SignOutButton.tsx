"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNotifications } from "./notify";
import { Button, Sheet } from "./ui";
import { useMaple } from "./useMaple";

export default function SignOutButton({ children, className, onRequest, role, tabIndex, disabled }: {
  children?: ReactNode;
  className?: string;
  onRequest?: () => void;
  role?: "menuitem";
  tabIndex?: number;
  disabled?: boolean;
}) {
  const { api, refresh, state, toast } = useMaple();
  const notify = useNotifications();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const pending = useRef(false);

  const signOut = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await notify.forgetThisPhone({ everywhere: true });
      try {
        await api("/api/maple/auth/signout", { method: "POST" });
      } catch {
        toast("Couldn't confirm sign-out. Try again.", { tone: "error" });
      }
      await refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const request = () => {
    if (pending.current || !window.dispatchEvent(new Event("maple-before-navigate", { cancelable: true }))) return;
    onRequest?.();
    if (state?.me.email.startsWith("invite:")) setConfirm(true);
    else void signOut();
  };

  return (
    <>
      <button type="button" role={role} tabIndex={tabIndex} disabled={busy || disabled} onClick={request} className={className}>
        {children}
        <span>{busy ? "Signing out…" : "Sign out"}</span>
      </button>
      {confirm && createPortal(
        <Sheet open onClose={() => { if (!busy) setConfirm(false); }} title="Sign out?" calm footer={
          <div className="flex gap-3">
            <Button variant="soft" className="flex-1" disabled={busy} onClick={() => setConfirm(false)}>Stay signed in</Button>
            <Button variant="danger" className="flex-1" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Sign out anyway"}</Button>
          </div>
        }>
          <p className="text-[15px] leading-relaxed text-mp-ink-2">You joined with a one-time link. After signing out, you will need a new invite from a family owner. The link you used cannot sign you in again.</p>
        </Sheet>, document.body
      )}
    </>
  );
}
