import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { siteOpenGraph } from "@/components/site/meta";
import { draftsVisible } from "@/lib/blog";
import { ABOUT_DRAFT } from "./draft";

const DESCRIPTION = "Maple is made by Matt Brooker, a software engineer, for his own family. It’s open source.";

export const metadata: Metadata = {
  title: "About",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  robots: { index: !ABOUT_DRAFT, follow: !ABOUT_DRAFT },
  openGraph: siteOpenGraph("About | Maple", DESCRIPTION, "/about"),
};

export default function About() {
  if (ABOUT_DRAFT && !draftsVisible()) notFound();
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
          I made Maple for my own family.
        </h1>
        {ABOUT_DRAFT && (
          <p className="mt-6 rounded-xl border border-mp-line bg-mp-surface px-4 py-3 text-[15px] text-mp-ink-2">
            Draft. It isn&rsquo;t listed anywhere and doesn&rsquo;t show in production.
          </p>
        )}
        <div className="site-legal mt-6 text-[18px] leading-[1.65]">
          <p>
            I&rsquo;m Matt Brooker, a software engineer. My daughter, Maple, was born in October 2026, and that month I made the
            first version of this app for my wife and me to keep track of her days. It&rsquo;s named after her.
          </p>
          <p>My wife and I use it every day, each from our own phone.</p>
          <p>
            Maple is open source. Its code is on GitHub under the MIT license, at{" "}
            <a href="https://github.com/Brooker-Fam/maple">github.com/Brooker-Fam/maple</a>, so you can read what it does with a
            family&rsquo;s data. None of the entries or photos my family logs are in it.
          </p>
          <p>
            I write Maple with Claude, Anthropic&rsquo;s AI model, and most of the commits in its history list Claude as an author
            or co-author.
          </p>
          <p>
            Families can&rsquo;t sign up yet. The <Link href="/waitlist">waitlist</Link> is the way to hear when they can. To reach
            me, write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
