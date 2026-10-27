import type { Metadata } from "next";
import Link from "next/link";
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

type Hour = { time: string; half: "am" | "pm"; title: string; body: string; visual: React.ReactNode };

const HOURS: Hour[] = [
  {
    time: "6:40",
    half: "am",
    title: "Your partner did the 2am feed and is asleep with the monitor on their face.",
    body: "The whole night is waiting for you in one line.",
    visual: <HandoffFragment />,
  },
  {
    time: "9:15",
    half: "am",
    title: "The poop is a color you’ve never seen before.",
    body: "Maple knows what it usually means, and which colors mean call the doctor.",
    visual: <StoolFragment />,
  },
  {
    time: "11:30",
    half: "am",
    title: "The pediatrician asks how many wet diapers. You say “a lot.”",
    body: "Next time you’ll have the actual number.",
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
    title: "The cord stump fell off in the car seat.",
    body: "Keep the firsts somewhere only your family can see.",
    visual: <MomentFragment />,
  },
  {
    time: "5:45",
    half: "pm",
    title: "Nobody remembers when mom last took ibuprofen. Including mom.",
    body: "Her meds get their own page, so “is it OK yet?” has an answer.",
    visual: <MomFragment />,
  },
  {
    time: "8:20",
    half: "pm",
    title: "Your hands are full, and one of them is wet.",
    body: "Tell Siri, or type “wet one at 8” into the chat.",
    visual: (
      <div className="grid gap-3">
        <SiriFragment />
        <AskFragment />
      </div>
    ),
  },
];

const NIGHT_FACTS = [
  "Next side, ready before you ask.",
  "Switching every five minutes? It keeps up.",
  "Fell asleep mid-feed? It asks when she finished.",
];

const PROMISES: { key: string; line: React.ReactNode }[] = [
  {
    key: "who",
    line: (
      <Link className="site-link" href="/privacy">
        Only people you invite can see it.
      </Link>
    ),
  },
  { key: "ads", line: "No ads. Never sold." },
  {
    key: "source",
    line: (
      <a className="site-link" href="https://github.com/Brooker-Fam/maple">
        Open source.
      </a>
    ),
  },
  { key: "maker", line: "Made by a dad who uses it every night." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid w-full max-w-[76rem] items-center gap-12 px-4 pt-12 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-20 lg:pt-20 lg:pb-28">
          <div>
            <h1 className="site-display max-w-[13ch] text-[clamp(2.85rem,1.4rem+6vw,5.75rem)] leading-[0.98] text-mp-ink">
              Left boob or right boob?
            </h1>
            <p className="site-prose mt-6 text-[19px] leading-[1.55]">You knew an hour ago. Maple remembers, on both your phones.</p>
            <div className="mt-9">
              <WaitlistForm />
            </div>
          </div>
          <div className="mx-auto lg:mr-4">
            <Phone label="Sample screen: Today mid-feed. The left side ran 12 minutes, she has been on the right for 4 minutes, and the dock holds Switch, Pause, Done and More above Pee, Poop, Both and Sleep.">
              <TodayMock />
            </Phone>
            <p className="mt-3 text-center text-[13px] text-mp-ink-3">Sample data.</p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[76rem] px-4 pb-24 sm:px-8">
          <hr className="max-w-[40rem] border-t border-mp-line" />

          <div className="site-rail mt-14 space-y-20 lg:space-y-28">
            {HOURS.map((h) => (
              <article key={h.time + h.half} className="site-hour" aria-labelledby={`hour-${h.time}-${h.half}`}>
                <p className="site-time">
                  <time>{h.time}</time>
                  <small>{h.half}</small>
                </p>
                <div className="mt-4 lg:mt-1">
                  <h2 id={`hour-${h.time}-${h.half}`} className="site-display text-[clamp(1.75rem,1.4rem+1.2vw,2.3rem)] leading-[1.1] text-mp-ink">
                    {h.title}
                  </h2>
                  <p className="site-prose mt-3">{h.body}</p>
                </div>
                <div className="mt-7 max-w-[34rem] lg:mt-1">{h.visual}</div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="lantern" className="site-night site-night-band">
          <div className="mx-auto grid w-full max-w-[76rem] items-center gap-14 px-4 py-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-24 lg:py-28">
            <div>
              <p className="site-italic text-[clamp(4.5rem,2.5rem+9vw,9.5rem)] leading-[0.9] tracking-[-0.02em] text-[#e8a23f]">
                <time>3:12</time>
                <span className="ml-3 text-[0.4em] opacity-70">am</span>
              </p>
              <h2 id="lantern" className="site-display mt-8 text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05]">
                Neither of you can do boob math at 3am
              </h2>
              <p className="site-prose mt-4 text-mp-ink-2">Maple does it, on a screen dim enough not to wake anyone else.</p>
              <ul className="mt-10 grid max-w-[34rem] gap-y-6">
                {NIGHT_FACTS.map((f) => (
                  <li key={f} className="border-t border-mp-line pt-4 text-[16px] font-semibold text-mp-ink">
                    {f}
                  </li>
                ))}
              </ul>
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
                Your pediatrician is still the doctor.
              </h2>
              <p className="site-prose mt-4">Maple is a log. It doesn&rsquo;t give medical advice.</p>
            </div>
            <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {PROMISES.map((p) => (
                <li key={p.key} className="font-display text-[1.55rem] leading-tight font-semibold text-mp-ink">
                  {p.line}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="join" className="border-t border-mp-line">
          <div className="mx-auto w-full max-w-[76rem] px-4 py-20 sm:px-8 lg:py-24">
            <h2 id="join" className="site-display max-w-[22ch] text-[clamp(2.4rem,1.6rem+3.2vw,4rem)] leading-[1.02] text-mp-ink">
              Want in?
            </h2>
            <p className="site-prose mt-4">Maple is one family right now. Leave your email and you&rsquo;ll hear when that changes.</p>
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
