import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Quicksand } from "next/font/google";
import Navigation from "@/components/Navigation";
import ThemeProvider from "@/components/ThemeProvider";
import PostHogProvider from "@/components/PostHogProvider";
import MainLandmark from "./MainLandmark";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant-garamond",
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
  title: "Matt & Brittany",
  description:
    "Thank you for celebrating with us on our farm on June 27, 2026. The photos, the playlist, and the party games are all here.",
  authors: [{ name: "Matt & Brittany Brooker" }],
  openGraph: {
    title: "Matt & Brittany",
    description:
      "Thank you for celebrating with us on our farm on June 27, 2026. The photos, the playlist, and the party games are all here.",
    type: "website",
    locale: "en_US",
    siteName: "Matt & Brittany",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matt & Brittany",
    description: "Thank you for celebrating with us on our farm on June 27, 2026.",
  },
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Brooker",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#1D4420",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${cormorantGaramond.variable} ${quicksand.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="enchanted-bg min-h-screen font-[family-name:var(--font-quicksand)] antialiased">
        <PostHogProvider>
          <ThemeProvider>
            <Navigation />
            <MainLandmark>{children}</MainLandmark>
          </ThemeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
