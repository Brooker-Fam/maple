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
    "Join Matt & Brittany Brooker for their enchanted farm wedding celebration on June 27, 2026! RSVP, play fun games, and get all the details for our magical day on the farm.",
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
      "You're invited to the most magical wedding ever! Join us June 27, 2026 for an enchanted farm wedding celebration.",
    type: "website",
    locale: "en_US",
    siteName: "Brooker Wedding",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matt & Brittany's Wedding",
    description:
      "You're invited! June 27, 2026 - An enchanted farm wedding celebration.",
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
