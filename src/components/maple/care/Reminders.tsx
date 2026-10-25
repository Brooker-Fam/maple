"use client";

import { useEffect } from "react";
import { useNotifications, type Notifications } from "../notify/context";
import { notificationsValue, type NotifyStatus } from "../notify/words";

/**
 * The old "Reminders on this phone" names, kept while her screen moves to its
 * tab: they all point at the one Notifications sheet now (src/components/
 * maple/notify), which NotificationsProvider renders and owns. New code uses
 * useNotifications(), NotificationsRow and open() directly.
 */

export type PhoneReminders = Notifications;

/** This phone's notifications (the provider's; this no longer keeps state of its own). */
export function usePhoneReminders(): PhoneReminders {
  return useNotifications();
}

export function remindersValue(status: NotifyStatus): string | undefined {
  return notificationsValue(status);
}

/** Opening it opens the Notifications sheet (on top of whatever asked) and hands control straight back. */
export default function RemindersSheet({ open, onClose }: { open: boolean; onClose: () => void; care?: unknown; phone?: unknown }) {
  const { open: show } = useNotifications();
  useEffect(() => {
    if (!open) return;
    show();
    onClose();
  }, [open, show, onClose]);
  return null;
}
