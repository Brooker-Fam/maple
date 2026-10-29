import { createRoot } from "react-dom/client";
import { NotificationsProvider } from "../../src/components/maple/notify/NotificationsProvider";
import SignOutButton from "../../src/components/maple/SignOutButton";
import { useNotifications } from "../../src/components/maple/notify/context";

function Fixture() {
  const notifications = useNotifications();
  window.notificationFixture.current = notifications;
  return <main><button onClick={notifications.open}>Open notifications</button><SignOutButton /></main>;
}

createRoot(document.getElementById("root")).render(<NotificationsProvider><Fixture /></NotificationsProvider>);
