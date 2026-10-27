import { signupMode } from "@/lib/maple/family";
import JoinPage from "./JoinPage";

export const dynamic = "force-dynamic";

/** While the Brookers' log is the only one, every link is theirs; after that a link nobody has opened can't say whose. */
export default function Page() {
  return <JoinPage askWho={signupMode() === "off" ? "Matt or Brittany" : "whoever sent it"} />;
}
