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

const TITLE = "Maple | Who fed her last?";
const DESCRIPTION =
  "Who fed her last? Maple is one newborn log on both parents' phones, with the last feed and the next side ready at 3am. Free while in early access, with a waitlist for now.";

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
  return <div className={`site ${cormorantItalic.variable}`}>{children}</div>;
}
