import type { Metadata } from "next";
import Link from "next/link";
import GetStarted from "@/components/site/GetStarted";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { GrowthFragment, HandoffFragment, PatternQuestionFragment, QuestionsFragment } from "@/components/site/fragments";
import { LanternMock, PatternsMock, Phone } from "@/components/site/phone";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const BENEFITS = [
  {
    title: "See when the longer gaps happen.",
    body: "A day can feel like one long feed. Look across your logged feeds to see their timing, the spaces between them, and how the pattern changes from day to day. Ask Maple’s chat to help you explore the record.",
    visual: <PatternQuestionFragment />,
  },
  {
    title: "Bring the details to the doctor.",
    body: "When your pediatrician asks about feeds or wet diapers, have the record ready. Keep your questions together and copy a visit summary to share at an appointment or in the patient portal.",
    visual: <QuestionsFragment />,
  },
  {
    title: "Follow the changes you make.",
    body: "As you adjust your routine, keep tracking feeds, wet and dirty diapers, and weight. Look back together with your care team to understand what changed over time.",
    visual: <GrowthFragment />,
  },
];

const NIGHT_FACTS = [
  "Nursing timers, bottles, and wet and dirty diapers in one log.",
  "Feeding side and duration, remembered for you.",
  "Hands full? Log with Siri or Maple’s chat.",
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid w-full max-w-[76rem] items-center gap-12 px-4 pt-12 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-20 lg:pt-20 lg:pb-28">
          <div>
            <p className="mb-5 text-[14px] font-semibold tracking-wide text-mp-accent-fg">Made by Maple’s parents, for the early days</p>
            <h1 className="site-display max-w-[15ch] text-[clamp(2.85rem,1.4rem+6vw,5.75rem)] leading-[0.98] text-mp-ink">
              See the patterns in your baby’s feeding.
            </h1>
            <p className="site-prose mt-6 text-[19px] leading-[1.55]">
              Track feeds, diapers, and weight. Understand your baby’s rhythm, bring clear records to the doctor, and follow the changes you make.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
              <GetStarted placement="hero" />
              <a className="site-link py-3 text-[16px]" href="#maples-story">Read Maple’s story</a>
            </div>
            <p className="mt-4 text-[14px] text-mp-ink-3">Free in early access. One shared log for your family.</p>
          </div>
          <Phone className="mx-auto lg:mr-4" label="Illustrative sample using fictional data: June’s logged feeds across several days in Patterns, with wet and dirty diaper counts and a visit summary.">
            <PatternsMock />
          </Phone>
        </section>

        <section id="maples-story" aria-labelledby="story-title" className="scroll-mt-8 border-y border-mp-line bg-mp-surface">
          <div className="mx-auto grid w-full max-w-[76rem] gap-8 px-4 py-16 sm:px-8 lg:grid-cols-2 lg:gap-20 lg:py-20">
            <div>
              <p className="text-[14px] font-semibold text-mp-accent-fg">Our family’s story</p>
              <h2 id="story-title" className="site-display mt-4 max-w-[20ch] text-[clamp(2.3rem,1.6rem+2.8vw,3.6rem)] leading-[1.05] text-mp-ink">It started at Maple’s six-day appointment.</h2>
              <p className="site-prose mt-5">Her weight was down. We wanted to understand what was happening.</p>
            </div>
            <div className="space-y-4 text-[17px] leading-relaxed text-mp-ink-2">
              <p>Looking through Maple Baby, we could see her feeding patterns and the times when we were going too long between feeds. At the doctor’s office, we had the actual data to talk through.</p>
              <p>We changed our routine and kept tracking the feeds, wet diapers, dirty diapers, and weight. Maple’s weight went up, and she’s doing great.</p>
              <p>We had wondered whether we might need to supplement with formula. For our family, seeing those patterns helped us make changes that made breastfeeding work.</p>
              <p className="pt-2 font-medium text-mp-ink">That’s what we want Maple to help with: a clearer picture of your baby’s days.</p>
              <Link href="/about" className="site-link inline-block py-2">More about Maple and our family</Link>
            </div>
          </div>
        </section>

        <section aria-labelledby="patterns" className="mx-auto w-full max-w-[76rem] px-4 py-20 sm:px-8 lg:py-24">
          <h2 id="patterns" className="site-display max-w-[22ch] text-[clamp(2.2rem,1.6rem+2.4vw,3.4rem)] leading-[1.05] text-mp-ink">Little details. A clearer picture.</h2>
          <p className="site-prose mt-4">From the first few feeds to your next appointment, put the record to use.</p>
          <div className="mt-14 space-y-16 lg:space-y-20">
            {BENEFITS.map((benefit, i) => (
              <article key={benefit.title} className="grid items-center gap-7 border-t border-mp-line pt-8 lg:grid-cols-2 lg:gap-20">
                <div>
                  <p className="text-[14px] font-semibold text-mp-accent-fg">0{i + 1}</p>
                  <h3 className="site-display mt-3 max-w-[24ch] text-[clamp(1.8rem,1.4rem+1.2vw,2.5rem)] leading-[1.1] text-mp-ink">{benefit.title}</h3>
                  <p className="site-prose mt-4">{benefit.body}</p>
                </div>
                <div className="w-full max-w-[34rem]">{benefit.visual}</div>
              </article>
            ))}
          </div>
          <p className="mt-8 text-[13px] text-mp-ink-3">Illustrations use fictional sample data. Patterns reflect what you log; an unlogged feed is not necessarily a missed feed.</p>
        </section>

        <section aria-labelledby="together" className="border-t border-mp-line">
          <div className="mx-auto grid w-full max-w-[76rem] items-center gap-8 px-4 py-16 sm:px-8 lg:grid-cols-2 lg:gap-20">
            <div>
              <h2 id="together" className="site-display max-w-[22ch] text-[clamp(2rem,1.5rem+2vw,3rem)] leading-[1.08] text-mp-ink">One picture, even when you take turns.</h2>
              <p className="site-prose mt-4">Both parents can add to the same log from their own phones. See the feeds and diapers from your partner’s shift before yours begins.</p>
            </div>
            <HandoffFragment />
          </div>
        </section>

        <section aria-labelledby="lantern" className="site-night site-night-band">
          <div className="mx-auto grid w-full max-w-[76rem] items-center gap-14 px-4 py-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-24 lg:py-24">
            <div>
              <p className="site-italic text-[clamp(4.5rem,2.5rem+9vw,9.5rem)] leading-[0.9] tracking-[-0.02em] text-[#e8a23f]">
                <time>3:12</time><span className="ml-3 text-[0.4em] opacity-70">am</span>
              </p>
              <h2 id="lantern" className="site-display mt-8 max-w-[22ch] text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05]">Easy to keep up with, even at 3am.</h2>
              <p className="site-prose mt-4 text-mp-ink-2">The useful record starts with the everyday details. Keep them close on a screen dim enough for night feeds.</p>
              <ul className="mt-10 grid max-w-[34rem] gap-y-6">
                {NIGHT_FACTS.map((fact) => <li key={fact} className="border-t border-mp-line pt-4 text-[16px] font-semibold text-mp-ink">{fact}</li>)}
              </ul>
            </div>
            <Phone night className="mx-auto lg:mr-4" label="Sample screen: the Lantern at night, with a nursing timer and large Switch, Pause and Done controls.">
              <LanternMock />
            </Phone>
          </div>
        </section>

        <section aria-labelledby="join">
          <div className="mx-auto w-full max-w-[76rem] px-4 py-20 sm:px-8 lg:py-24">
            <h2 id="join" className="site-display max-w-[22ch] text-[clamp(2.4rem,1.6rem+3.2vw,4rem)] leading-[1.02] text-mp-ink">Start seeing your baby’s patterns.</h2>
            <p className="site-prose mt-4">Build a record you can return to, share with your doctor, and learn from together. Maple is free while it’s in early access.</p>
            <GetStarted className="mt-8" placement="footer" />
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
