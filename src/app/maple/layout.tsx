import type { Metadata, Viewport } from "next";
import "./maple.css";

export const metadata: Metadata = {
  title: "Maple's Log",
  description: "Feeds, diapers, sleep and little moments for Maple Jane.",
  manifest: "/maple.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Maple",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/maple-icon.svg", type: "image/svg+xml" },
      { url: "/maple-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    // Sized, so iOS prefers it over the site-wide apple-touch-icon the root layout hard-codes.
    apple: { url: "/maple-apple-touch-icon.png", sizes: "180x180" },
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FDF8F0" },
    { media: "(prefers-color-scheme: dark)", color: "#0D1F0F" },
  ],
  viewportFit: "cover",
};

export default function MapleLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
