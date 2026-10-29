import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import { siteOpenGraph } from "@/components/site/meta";
import SiteAnalytics from "@/components/analytics/SiteAnalytics";
import "../maple/maple.css";
import "./site.css";

const cormorantItalic = Cormorant_Garamond({
  variable: "--font-site-italic",
  subsets: ["latin"],
  weight: ["500"],
  style: "italic",
  display: "swap",
});

const TITLE = "Maple Baby | Understand your baby’s feeding patterns";
const DESCRIPTION = "Track feeds, diapers, and weight. See feeding patterns, bring clear records to the doctor, and follow changes with Maple Baby. Free in early access.";

export const metadata: Metadata = {
  title: { default: TITLE, template: "%s | Maple" },
  description: DESCRIPTION,
  applicationName: "Maple",
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
