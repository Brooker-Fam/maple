import type { Metadata } from "next";
import { Cormorant_Garamond } from "next/font/google";
import ThemeProvider from "@/components/ThemeProvider";
import ClientErrors from "@/components/analytics/ClientErrors";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant-garamond",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(MAPLE_ORIGIN),
  title: "Maple",
  description: "Understand your baby’s feeding patterns. Track feeds, diapers, and weight in one shared family log.",
  icons: {
    icon: [
      { url: "/maple-icon.svg", type: "image/svg+xml" },
      { url: "/maple-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/maple-apple-touch-icon.png", sizes: "180x180" },
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cormorantGaramond.variable} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <ClientErrors />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
