"use client";

import type { ReactNode } from "react";
import { NavRow } from "../care/parts";
import { useNotifications } from "./context";

/**
 * "Notifications" with this phone's state (On, Off, Stopped, "Home Screen app
 * first", "On · may be late"); a tap opens the sheet. For Family → On this
 * phone and her tab, inside a GROUP like any other row.
 */
export function NotificationsRow({ note }: { note?: ReactNode } = {}) {
  const n = useNotifications();
  return <NavRow icon="bell" label="Notifications" note={note} value={n.value} onClick={n.open} />;
}

export default NotificationsRow;
