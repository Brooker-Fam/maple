import type { Metadata } from "next";

// Unlinked family page: keep it out of search results.
export const metadata: Metadata = {
  title: "Connect Maple's Log to Claude, ChatGPT, Muse or Grok",
  description: "Log feeds, diapers and naps by just saying them to Claude, ChatGPT, Muse or Grok.",
  robots: { index: false, follow: false },
};

export default function MapleConnectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
