import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { siteOpenGraph } from "@/components/site/meta";
import GetStarted from "@/components/site/GetStarted";

const DESCRIPTION =
  "Maple is free while it’s in early access. There is no paid plan, and any price will be posted on this page before it applies to anyone.";

export const metadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: { canonical: "/pricing" },
  openGraph: siteOpenGraph("Pricing | Maple", DESCRIPTION, "/pricing"),
};

export default function Pricing() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
          Maple is free while it&rsquo;s in early access.
        </h1>
        <p className="site-prose mt-5 text-[19px] leading-[1.55]">
          There is no paid plan during the beta. <Link href="/signup" className="site-link">Get started</Link> shows the current sign-up options.
        </p>

        <div className="site-legal mt-6">
          <h2>The tracker is cheap to run</h2>
          <p>
            Entries and photos sit on web hosting and a database the family already pays for, so one more feed or diaper adds
            almost nothing to the bill.
          </p>

          <h2>The chat costs real money</h2>
          <p>
            Chat, the tab inside the app, sends each message to an AI model through Vercel AI Gateway. The Gateway charges for each
            one by how much text the model reads and writes. In Maple&rsquo;s tests a message cost under a cent, so a day of
            ordinary use should come to a few cents. No family&rsquo;s real use has been measured yet, so that is an estimate.
          </p>
          <p>
            The app caps what the chat can spend for a family, at $0.50 a day and $5 a month by default. Past the cap, the chat
            stops until the next day or month, and logging works as usual.
          </p>

          <h2>Any price goes on this page first</h2>
          <p>
            If Maple ever charges for anything, the price will be posted here before it applies to anyone, and nothing is charged
            without your agreement. The <Link href="/terms">terms</Link> say the same.
          </p>
        </div>

        <div className="mt-14 border-t border-mp-line pt-8">
          <GetStarted className="mt-5" placement="pricing" />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
