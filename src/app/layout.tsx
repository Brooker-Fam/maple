import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Source_Sans_3 } from "next/font/google";
import Navigation from "@/components/Navigation";
import ThemeProvider from "@/components/ThemeProvider";
import PostHogProvider from "@/components/PostHogProvider";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  variable: "--font-cormorant-garamond",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Creekside Fields",
  description:
    "Creekside Fields is a whimsical, mossy, grounded farm raising heritage pigs on pasture with love and care in Greenwich, New York.",
  keywords: [
    "pasture raised pork",
    "heritage pigs",
    "Creekside Fields",
    "Greenwich NY farm",
    "small farm pork",
    "pastured pork",
    "mossy farm",
    "heritage pork",
  ],
  authors: [{ name: "Creekside Fields" }],
  openGraph: {
    title: "Creekside Fields",
    description:
      "A whimsical, mossy, grounded farm raising heritage pigs on pasture with love and care.",
    type: "website",
    locale: "en_US",
    siteName: "Creekside Fields",
  },
  twitter: {
    card: "summary_large_image",
    title: "Creekside Fields",
    description:
      "A whimsical, mossy, grounded farm raising heritage pigs on pasture with love and care.",
  },
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Creekside Fields",
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
      className={`${cormorantGaramond.variable} ${sourceSans.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="enchanted-bg min-h-screen font-[family-name:var(--font-source-sans)] antialiased">
        <PostHogProvider>
          <ThemeProvider>
            <Navigation />
            <main>{children}</main>
          </ThemeProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
