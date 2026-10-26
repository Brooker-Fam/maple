import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import { siteOpenGraph } from "@/components/site/meta";
import "../maple/maple.css";
import "./site.css";

const cormorantItalic = Cormorant_Garamond({
  variable: "--font-site-italic",
  subsets: ["latin"],
  weight: ["500"],
  style: "italic",
  display: "swap",
});

const DESCRIPTION =
  "Maple is a calm newborn tracker for both parents: a one-thumb nursing timer, diapers, sleep, growth and a page for mom's recovery, with a dim Lantern for 3am feeds.";

export const metadata: Metadata = {
  title: { default: "Maple: the newborn log for both of you", template: "%s | Maple" },
  description: DESCRIPTION,
  applicationName: "Maple",
  robots: { index: true, follow: true },
  openGraph: siteOpenGraph("Maple: the newborn log for both of you, built for 3am", DESCRIPTION, "/"),
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F3EC" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1310" },
  ],
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <div className={`site ${cormorantItalic.variable}`}>{children}</div>;
}
