import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import { siteOpenGraph } from "@/components/site/meta";
import SiteAnalytics from "@/components/analytics/SiteAnalytics";
import "../maple/maple.css";
import "./site.css";
import "./home.css";
import "@/components/site/feature-explorer.css";

const cormorantItalic = Cormorant_Garamond({
  variable: "--font-site-italic",
  subsets: ["latin"],
  weight: ["500"],
  style: "italic",
  display: "swap",
});

const TITLE = "Maple Baby | Feeds, sleep, diapers & shared care";
const DESCRIPTION = "Track feeds, sleep, diapers, growth, and little firsts with Maple Baby. One shared family log for everyday care, patterns, and appointments.";

export const metadata: Metadata = {
  title: { default: TITLE, template: "%s | Maple Baby" },
  description: DESCRIPTION,
  applicationName: "Maple Baby",
  robots: { index: true, follow: true },
  openGraph: siteOpenGraph(TITLE, DESCRIPTION, "/"),
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F3EC" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1310" },
  ],
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`site ${cormorantItalic.variable}`}>
      <SiteAnalytics />
      {children}
    </div>
  );
}
