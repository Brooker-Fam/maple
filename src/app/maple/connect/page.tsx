import { signupMode } from "@/lib/maple/family";
import MapleConnectPage from "./ConnectPage";

export const dynamic = "force-dynamic";

export default function Page() {
  return <MapleConnectPage calendarNote={signupMode() === "off"} />;
}
