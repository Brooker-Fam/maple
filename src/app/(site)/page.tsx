import type { Metadata } from "next";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import WaitlistForm from "@/components/site/WaitlistForm";
import {
  AskFragment,
  GrowthFragment,
  HandoffFragment,
  MomentFragment,
  MomFragment,
  QuestionsFragment,
  SiriFragment,
  StoolFragment,
} from "@/components/site/fragments";
import { LanternMock, Phone, TodayMock } from "@/components/site/phone";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

type Hour = { time: string; half: "am" | "pm"; title: string; body: React.ReactNode; visual: React.ReactNode };

const HOURS: Hour[] = [
  {
    time: "6:40",
    half: "am",
    title: "Both of you, one log",
    body: (
      <>
        Whoever was up at 2am, the other one wakes to a single line: what happened, and who did it. Two phones, or three with a
        grandparent, all on the same log. View-only guests can follow along without changing anything.
      </>
    ),
    visual: <HandoffFragment />,
  },
  {
    time: "9:15",
    half: "am",
    title: "Diapers and naps in a tap",
    body: (
      <>
        Pee, poop or both from the dock. Pick the color from real swatches and Maple says what it usually means, including the few
        that mean calling your pediatrician today. Naps, bottles and pumping work the same way.
      </>
    ),
    visual: <StoolFragment />,
  },
  {
    time: "11:30",
    half: "am",
    title: "Ready for the checkup",
    body: (
      <>
        Weight, length and head size land on the WHO growth curves as you enter them. The questions you thought of at 4am wait on
        one list, and a visit summary is ready to copy for the pediatrician.
      </>
    ),
    visual: (
      <div className="grid gap-3">
        <GrowthFragment />
        <QuestionsFragment />
      </div>
    ),
  },
  {
    time: "4:30",
    half: "pm",
    title: "The firsts, kept",
    body: (
      <>
        Add a photo to a moment and it stays in your family&rsquo;s log, not on a feed. First bath, first smile, the first night
        she slept four hours in a row.
      </>
    ),
    visual: <MomentFragment />,
  },
  {
    time: "5:45",
    half: "pm",
    title: "A page for mom, too",
    body: (
      <>
        Her own medicines on the schedule her clinician gave, when each one is OK again, her temperature, questions for her OB, and
        the warning signs worth a call, with the numbers to call. Maple never suggests a dose.
      </>
    ),
    visual: <MomFragment />,
  },
  {
    time: "8:20",
    half: "pm",
    title: "Hands full? Say it instead",
    body: (
      <>
        Ask Siri while you rock her. Or tell Maple&rsquo;s chat in plain words and it saves the entries, each with an Undo, for you
        to check. You can also connect your own Claude or ChatGPT account and ask how the week went.
      </>
    ),
    visual: (
      <div className="grid gap-3">
        <SiriFragment />
        <AskFragment />
      </div>
    ),
  },
];

const NIGHT_FACTS = [
  { title: "The next side, remembered", body: "It says which side to start on, from the side she started on last time." },
  { title: "Back and forth", body: "Going both sides? Say so once, and there's no need to tap Switch." },
  { title: "Forgot to stop?", body: "When a side runs long, Done asks when she finished instead of guessing." },
];

const PROMISES = [
  { title: "Private to your family", body: "Only the people you invite can see your log. No ads, and your data is never sold." },
  { title: "Nothing watching you", body: "No analytics or session replay in the app." },
  {
    title: "Open source",
    body: (
      <>
        Every line of Maple is public under the MIT license, on{" "}
        <a className="site-link" href="https://github.com/Brooker-Fam/maple">
          GitHub
        </a>
        .
      </>
    ),
  },
  { title: "Made by a family", body: "Maple began as the log one family kept for their own newborn. They still use it every day." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid w-full max-w-[76rem] items-center gap-12 px-4 pt-12 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-20 lg:pt-20 lg:pb-28">
          <div>
            <h1 className="site-display max-w-[13ch] text-[clamp(2.85rem,1.4rem+6vw,5.75rem)] leading-[0.98] text-mp-ink">
              The newborn log for both of you, built for 3am.
            </h1>
            <p className="site-prose mt-6 text-[19px] leading-[1.55]">
              Maple keeps feeds, diapers, sleep and the small firsts in one log you share. The timer works with one thumb, the
              buttons are big, and after dark the whole thing dims to a low amber glow.
            </p>
            <div className="mt-9">
              <WaitlistForm />
            </div>
          </div>
          <Phone
            className="mx-auto lg:mr-4"
            label="Sample screen: June's Today page mid-feed. The left side ran 12 minutes, she has been on the right for 4 minutes, and the dock holds Switch, Pause, Done and More."
          >
            <TodayMock />
          </Phone>
        </section>

        <section aria-labelledby="day" className="mx-auto w-full max-w-[76rem] px-4 pb-24 sm:px-8">
          <div className="max-w-[40rem] border-t border-mp-line pt-12">
            <h2 id="day" className="site-display text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05] text-mp-ink">
              One day with June
            </h2>
            <p className="site-prose mt-4">
              June is made up, and so is everything on these screens. What they do is real: this is the app as it works today.
            </p>
          </div>

          <div className="site-rail mt-14 space-y-20 lg:space-y-28">
            {HOURS.map((h) => (
              <article key={h.time + h.half} className="site-hour" aria-labelledby={`hour-${h.time}-${h.half}`}>
                <p className="site-time">
                  <time>{h.time}</time>
                  <small>{h.half}</small>
                </p>
                <div className="mt-4 lg:mt-1">
                  <h3 id={`hour-${h.time}-${h.half}`} className="site-display text-[clamp(1.75rem,1.4rem+1.2vw,2.3rem)] leading-[1.1] text-mp-ink">
                    {h.title}
                  </h3>
                  <p className="site-prose mt-3">{h.body}</p>
                </div>
                <div className="mt-7 max-w-[34rem] lg:mt-1">{h.visual}</div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="lantern" className="site-night">
          <div className="mx-auto grid w-full max-w-[76rem] items-center gap-14 px-4 py-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-24 lg:py-28">
            <div>
              <p className="site-italic text-[clamp(4.5rem,2.5rem+9vw,9.5rem)] leading-[0.9] tracking-[-0.02em] text-[#e8a23f]">
                <time>3:12</time>
                <span className="ml-3 text-[0.4em] opacity-70">am</span>
              </p>
              <h2 id="lantern" className="site-display mt-8 text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05]">
                The Lantern
              </h2>
              <p className="site-prose mt-4 text-mp-ink-2">
                From 8pm to 7am Maple dims to amber on near-black, and photos dim with it. Open a feed and the Lantern fills the
                screen: one big clock and three buttons, and the screen stays awake. Each button needs a half-second hold, so a
                flailing hand can&rsquo;t end the feed.
              </p>
              <dl className="mt-10 grid max-w-[40rem] gap-x-8 gap-y-6 sm:grid-cols-3">
                {NIGHT_FACTS.map((f) => (
                  <div key={f.title} className="border-t border-mp-line pt-4">
                    <dt className="text-[16px] font-semibold text-mp-ink">{f.title}</dt>
                    <dd className="mt-1 text-[15px] leading-relaxed text-mp-ink-3">{f.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <Phone
              night
              className="mx-auto lg:mr-4"
              label="Sample screen: the Lantern at night, dim amber on black. She has been on the right side for 6 minutes 48 seconds, 18 minutes in all, with three big hold buttons: Switch, Pause and Done."
            >
              <LanternMock />
            </Phone>
          </div>
        </section>

        <section aria-labelledby="honest" className="mx-auto w-full max-w-[76rem] px-4 py-20 sm:px-8 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-20">
            <div>
              <h2 id="honest" className="site-display text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05] text-mp-ink">
                A tracker, not a doctor
              </h2>
              <p className="site-prose mt-4">
                Maple helps you remember. It doesn&rsquo;t diagnose anything, and it isn&rsquo;t medical advice. Its notes follow
                public guidance from the AAP, CDC and WHO for healthy full-term babies, and your pediatrician&rsquo;s word comes
                first. In an emergency, call{" "}
                <a className="site-link" href="tel:911">
                  911
                </a>
                .
              </p>
            </div>
            <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {PROMISES.map((p) => (
                <div key={p.title}>
                  <dt className="font-display text-[1.55rem] leading-tight font-semibold text-mp-ink">{p.title}</dt>
                  <dd className="mt-1.5 text-[16px] leading-relaxed text-mp-ink-2">{p.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section aria-labelledby="join" className="border-t border-mp-line">
          <div className="mx-auto w-full max-w-[76rem] px-4 py-20 sm:px-8 lg:py-24">
            <h2 id="join" className="site-display max-w-[16ch] text-[clamp(2.4rem,1.6rem+3.2vw,4rem)] leading-[1.02] text-mp-ink">
              Maple is open to one family for now.
            </h2>
            <p className="site-prose mt-4">It&rsquo;s getting ready for more. Leave your email and you&rsquo;ll hear when it opens.</p>
            <div className="mt-8">
              <WaitlistForm />
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
