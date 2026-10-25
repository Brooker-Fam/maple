/**
 * Notifications on this phone (the client side of src/lib/maple/push.ts).
 *
 *   <NotificationsProvider> once in MapleApp, inside MapleProvider (anywhere:
 *   it portals its sheet to <body>). It renders the sheet itself.
 *   useNotifications(): { status, prefs, health, value, open(), turnOn(), turnOff(),
 *     setPrefs(), testInOneMinute(), sendNow(), refresh(), forgetThisPhone(), … }
 *   <NotificationsRow />: the "Notifications · On" row for Family and her tab.
 *   useRemindChip(): the dose toast's "Remind me at 12:56 PM" (useCare uses it).
 *   MAPLE_OPEN_EVENT: a tapped notice while the app is open (see context.ts).
 */
export { NotificationsProvider } from "./NotificationsProvider";
export { useNotifications, useRemindChip, MAPLE_OPEN_EVENT, type Notifications, type MapleOpenEvent } from "./context";
export { NotificationsRow } from "./NotificationsRow";
export { default as NotificationsSheet } from "./NotificationsSheet";
export { notificationsValue, type NotifyStatus, type ReminderFact } from "./words";
