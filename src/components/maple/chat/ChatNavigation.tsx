"use client";

import { DESTINATION_LABELS, destinationAllowed, navigationCardSchema, type ChatNavigationCard } from "@/lib/maple/chat/navigation";
import { useAppNav } from "../AppNav";
import { useCareNav } from "../care/CareNav";
import { useCare } from "../care/useCare";
import { Icon } from "../icons";
import { useNotifications } from "../notify";
import { requestSection } from "../sectionFocus";
import { useSheets } from "../sheets";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

export default function ChatNavigation({ navigation: raw }: { navigation: ChatNavigationCard | unknown }) {
  const app = useAppNav();
  const careNav = useCareNav();
  const care = useCare();
  const notifications = useNotifications();
  const sheets = useSheets();
  const { readOnly } = useMaple();
  const parsed = navigationCardSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { destination } = parsed.data;
  const available = destinationAllowed(destination, readOnly) && (destination !== "mom_medicines" || !!care);
  const open = () => {
    if (!available) return;
    switch (destination) {
      case "notifications": notifications.open(); break;
      case "doctor_questions": careNav.openDoctor(); break;
      case "help": careNav.openHelp(); break;
      case "add_photo": sheets.open({ kind: "moment" }); break;
      case "baby_profile": if (app.go("family/baby")) requestSection("baby-details"); break;
      case "pediatrician": if (app.go(readOnly ? "family/baby" : "family/doctor")) requestSection(readOnly ? "baby-details" : "doctor-contacts"); break;
      case "phone_preferences": if (app.go("family/appearance")) requestSection("phone-preferences"); break;
      case "mom_medicines": if (app.go("care")) requestSection("mom-medicines"); break;
      case "family_settings": app.go("family"); break;
      case "history": app.go("log"); break;
      default: app.go(destination);
    }
  };
  return (
    <section className={cx(tone.card, "space-y-2 p-3.5")} aria-label={DESTINATION_LABELS[destination]}>
      <Button variant="soft" className="w-full justify-between" onClick={open} disabled={!available}>
        <span>{destination === "add_photo" ? "Add a photo" : `Open ${DESTINATION_LABELS[destination]}`}</span>
        <Icon name="chevron-right" size={17} />
      </Button>
      {!available && <p className={cx(tone.muted, "text-[13px] leading-snug")}>This screen isn&apos;t available to this account.</p>}
      {available && destination === "notifications" && <p className={cx(tone.muted, "text-[13px] leading-snug")}>Review reminders and permissions on this phone.</p>}
    </section>
  );
}
