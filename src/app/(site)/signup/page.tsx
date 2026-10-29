import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import WaitlistForm from "@/components/site/WaitlistForm";
import { siteOpenGraph } from "@/components/site/meta";
import { effectiveSignupMode } from "@/lib/maple/family";
import { isSignupError, SIGNUP_ERRORS } from "@/lib/maple/family/signup";
import { isGoogleConfigured } from "@/lib/maple/auth";
import { isAppleConfigured } from "@/lib/maple/apple";
import { isEmailConfigured } from "@/lib/maple/email-auth";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

const DESCRIPTION = "Start a shared log of feeds, diapers, and weight. See patterns and bring clear records to appointments with Maple Baby.";

export const metadata: Metadata = {
  title: "Get started",
  description: DESCRIPTION,
  robots: { index: false, follow: true },
  openGraph: siteOpenGraph("Get started | Maple", DESCRIPTION, "/signup"),
};

/** MAPLE_SIGNUP off: the waitlist. On: configured sign-in methods, with an invite code when needed. */
export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string | string[]; join?: string | string[] }> }) {
  const { error: raw, join } = await searchParams;
  const mode = await effectiveSignupMode();
  const error = isSignupError(raw) ? SIGNUP_ERRORS[raw] : null;

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        {mode === "off" ? (
          <>
            <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">Sign-up isn’t open yet</h1>
            <p className="site-prose mt-4">Maple is open to one family for now. Leave your email to hear when other families can sign up.</p>
            <div className="mt-8">
              <WaitlistForm />
            </div>
          </>
        ) : (
          <SignupForm mode={mode} error={error} joining={join === "1"} providers={{ google: isGoogleConfigured(), apple: isAppleConfigured(), email: isEmailConfigured() }} />
        )}
        <p className="mt-12 text-[15px]">
          Already in a family’s log?{" "}
          <a className="site-link" href="/maple" rel="nofollow">
            Sign in
          </a>
          <span className="mx-2 text-mp-ink-3" aria-hidden>
            ·
          </span>
          <Link className="site-link" href="/">
            Back to Maple
          </Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
