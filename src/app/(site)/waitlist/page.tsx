import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import WaitlistForm from "@/components/site/WaitlistForm";
import { WAITLIST_ERRORS, type WaitlistError } from "@/lib/waitlist";

export const metadata: Metadata = {
  title: "Waitlist",
  robots: { index: false, follow: true },
};

const isError = (r: unknown): r is WaitlistError => typeof r === "string" && Object.hasOwn(WAITLIST_ERRORS, r);

/** Where the waitlist form lands when it was sent before the page's script loaded. */
export default async function Waitlist({ searchParams }: { searchParams: Promise<{ r?: string | string[] }> }) {
  const { r } = await searchParams;
  const joined = r === "joined";
  const error = isError(r) ? WAITLIST_ERRORS[r] : null;
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
          {joined ? "You’re on the list." : error ? "That didn’t go through." : "Join the waitlist"}
        </h1>
        <p className={`site-prose mt-4 ${error ? "text-mp-danger" : ""}`} role={error ? "alert" : undefined}>
          {joined
            ? "We’ll email you when Maple opens to more families. Nothing else."
            : (error ?? "Maple is open to one family for now. Leave your email and you’ll hear when it opens.")}
        </p>
        {!joined && (
          <div className="mt-8">
            <WaitlistForm />
          </div>
        )}
        <p className="mt-12 text-[15px]">
          <Link className="site-link" href="/">
            Back to Maple
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
