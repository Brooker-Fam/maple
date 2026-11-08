import type { Metadata } from "next";
import ThemeProvider from "@/components/ThemeProvider";
import ClientErrors from "@/components/analytics/ClientErrors";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";
import { cormorantVariables } from "./fonts/cormorant";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(MAPLE_ORIGIN),
  title: "Maple Baby",
  description: "Make sense of the early days. See patterns in feeds, sleep, and growth, share care with your family, and keep the moments you want to remember.",
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
    <html lang="en" className={cormorantVariables} suppressHydrationWarning>
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
