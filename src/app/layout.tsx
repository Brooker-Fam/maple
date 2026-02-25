import type { Metadata } from "next";
import { Cormorant_Garamond, Quicksand } from "next/font/google";
import Navigation from "@/components/Navigation";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant-garant",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const quicksand = Quicksand({
  variable: "--font-quicksand",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Matt & Brittany's Wedding",
  description:
    "Matt & Brittany got married! Join the Brookers for a wedding celebration on the farm, June 27, 2026. RSVP, play fun games, and get all the details for our big party.",
  keywords: [
    "wedding",
    "farm wedding",
    "Matt Brooker",
    "Brittany Brooker",
    "June 2026",
    "enchanted wedding",
    "wedding celebration",
  ],
  authors: [{ name: "Matt & Brittany Brooker" }],
  openGraph: {
    title: "Matt & Brittany's Wedding",
    description:
      "We got married! Now come celebrate with us on the farm, June 27, 2026. Food, games, and good company.",
    type: "website",
    locale: "en_US",
    siteName: "Brooker Wedding",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matt & Brittany's Wedding",
    description:
      "We got married! Join us June 27, 2026 for a wedding celebration on the farm.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cormorantGaramond.variable} ${quicksand.variable}`}
    >
      <body className="enchanted-bg min-h-screen font-[family-name:var(--font-quicksand)] antialiased">
        <Navigation />
        <main>{children}</main>
      </body>
    </html>
  );
}
