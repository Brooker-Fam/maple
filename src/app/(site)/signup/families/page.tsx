import type { Metadata } from "next";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import FamilyPicker from "./FamilyPicker";

export const metadata: Metadata = {
  title: "Your families",
  robots: { index: false, follow: false },
};

/** The family switcher, for someone in more than one family's log. */
export default function Families() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">Your families</h1>
        <FamilyPicker />
      </main>
      <SiteFooter />
    </>
  );
}
