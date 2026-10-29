import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { siteOpenGraph } from "@/components/site/meta";
import { draftsVisible } from "@/lib/blog";
import { ABOUT_DRAFT } from "./draft";

const DESCRIPTION =
  "How Maple Baby helped our family see feeding gaps, bring clear data to the doctor, and follow the changes that supported breastfeeding.";

export const metadata: Metadata = {
  title: "Our story",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  robots: { index: !ABOUT_DRAFT, follow: !ABOUT_DRAFT },
  openGraph: siteOpenGraph("Our story | Maple", DESCRIPTION, "/about"),
};

export default function About() {
  if (ABOUT_DRAFT && !draftsVisible()) notFound();
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
          A clearer picture of Maple&rsquo;s feeds.
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
          <h2>The six-day appointment</h2>
          <p>
            At Maple&rsquo;s six-day appointment, her weight was down. Looking back through Maple Baby helped us understand
            her feeding patterns: we were going too long between certain feeds, and we could see when those gaps were
            happening.
          </p>
          <p>
            At the doctor&rsquo;s office, we could share direct data about her feeds. We had a record of what had happened
            to help us talk it through.
          </p>
          <h2>Changing our routine, and following what happened</h2>
          <p>
            We changed our feeding routine and kept tracking. Feeds, wet diapers, dirty diapers, and weight gave us a way
            to follow those changes over time. Maple&rsquo;s weight went up, and she&rsquo;s doing great.
          </p>
          <p>
            We had wondered whether we might need to supplement with formula. For our family, seeing the patterns and
            making those changes helped breastfeeding work.
          </p>
          <h2>What we want Maple to help you see</h2>
          <p>
            That experience shaped what matters most to us about Maple: understanding feeding patterns, having clear
            information for the doctor, and following changes as a family. The timers and quick logging make that record
            easier to keep, even during a busy day or a broken night.
          </p>
          <p>
            My wife and I still use it every day, each from our own phone. Maple records nursing, bottles, diapers, and
            growth, so the log can follow your family&rsquo;s feeding routine.
          </p>
          <h2>Made by our family</h2>
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
            Ready to try Maple? <Link href="/signup">Get started</Link> shows the current sign-up options. When sign-up is
            closed, you can join the waitlist there. To reach me, write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
