import type { Metadata, Viewport } from "next";
import { siteOpenGraph } from "@/components/site/meta";
import SiteAnalytics from "@/components/analytics/SiteAnalytics";
import { cormorantItalicVariables } from "../fonts/cormorant-italic";
import "../maple/maple.css";
import "./site.css";
import "./home.css";
import "@/components/site/feature-explorer.css";

const TITLE = "Maple Baby | Feeds, sleep, diapers & shared care";
const DESCRIPTION = "Make sense of the early days. See patterns in feeds, sleep, and growth, share care with your family, and keep the moments you want to remember.";

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
    <div className={`site ${cormorantItalicVariables}`}>
      <SiteAnalytics />
      {children}
    </div>
  );
}
