import type { Metadata } from "next";
import JoinPage from "./JoinPage";

export const dynamic = "force-dynamic";

// For the preview in a message (with ./opengraph-image); the tab keeps the app's title.
export const metadata: Metadata = {
  openGraph: { title: "You’re invited to Maple’s Log", description: "Open the link on your phone to join the family’s newborn log." },
};

/** A link nobody has opened cannot identify its sender. */
export default function Page() {
  return <JoinPage askWho="whoever sent it" />;
}
