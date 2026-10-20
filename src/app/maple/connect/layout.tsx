import type { Metadata } from "next";

// Unlinked family page: keep it out of search results.
export const metadata: Metadata = {
  title: "Connect Maple's Log to Claude or ChatGPT",
  description: "Log feeds, diapers and naps for Maple by just saying them to Claude or ChatGPT.",
  robots: { index: false, follow: false },
};

export default function MapleConnectLayout({ children }: { children: React.ReactNode }) {
  return children;
}
