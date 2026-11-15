import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
          This page wandered off, like the other sock.
        </h1>
        <p className="site-prose mt-4">There&rsquo;s nothing at this address. The link may be wrong, or the page may have moved.</p>
        <p className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-[16px]">
          <Link className="site-link" href="/">
            Maple&rsquo;s home page
          </Link>
          <Link className="site-link" href="/blog">
            All blog posts
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
