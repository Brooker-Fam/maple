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

type Hour = { time: string; half: "am" | "pm"; title: string; body: React.ReactNode; visual: React.ReactNode };

const HOURS: Hour[] = [
  {
    time: "6:40",
    half: "am",
    title: "See what the other parent logged",
    body: (
      <>
        After you&rsquo;ve been away three hours or more, Today shows one line with what the others logged and who logged it.
        Grandparents can join as view-only guests and follow along without changing anything.
      </>
    ),
    visual: <HandoffFragment />,
  },
  {
    time: "9:15",
    half: "am",
    title: "Log a diaper or a nap with one tap",
    body: (
      <>
        Pee, Poop and Both log a diaper at the current time, and Sleep starts a nap timer. Hold a button to open the full form
        and log one from earlier. In the diaper form, each poop color shows a line about what it usually means.
      </>
    ),
    visual: <StoolFragment />,
  },
  {
    time: "11:30",
    half: "am",
    title: "Growth charts and questions for the pediatrician",
    body: (
      <>
        Weight, length and head size go on the WHO growth curves as you enter them. Questions for the pediatrician go on one list,
        and the For the doctor sheet has a visit summary you can copy.
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
    title: "Photos and firsts stay in your log",
    body: <>Add a photo to a moment, such as a first bath. Only the people in your family&rsquo;s log can see it.</>,
    visual: <MomentFragment />,
  },
  {
    time: "5:45",
    half: "pm",
    title: "Mom has her own page",
    body: (
      <>
        It shows when each of her medicines is OK again, on the schedule her clinician gave. It also keeps her temperature, her
        questions for her OB, and the warning signs to watch for, with the numbers to call. The app never suggests a dose, and
        its chat is told not to.
      </>
    ),
    visual: <MomFragment />,
  },
  {
    time: "8:20",
    half: "pm",
    title: "Log by voice with Siri, or type in the chat",
    body: (
      <>
        On an iPhone, a Siri shortcut logs a diaper or starts a timer by voice. In the app&rsquo;s chat, type what happened and it
        saves each entry with an Undo. You can also connect your own Claude or ChatGPT account and ask how the week went.
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

const NIGHT_FACTS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Next side",
    body: (
      <>
        Today shows which side to offer next. The rule is explained in{" "}
        <Link className="site-link" href="/blog/how-maple-counts-a-feed">
          How Maple counts a feed
        </Link>
        .
      </>
    ),
  },
  { title: "Back and forth", body: "Mark a feed as back and forth once, and you don’t need to tap Switch for the rest of it." },
  { title: "Forgotten timer", body: "Once a side has run 45 minutes, Done lets you pick when she finished." },
];

const SOURCES = [
  { text: "AAP", href: "https://www.healthychildren.org/" },
  { text: "CDC", href: "https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/newborn-basics.html" },
  { text: "WHO", href: "https://www.who.int/tools/child-growth-standards/standards" },
];

const PROMISES = [
  {
    title: "Who can see it",
    body: (
      <>
        Only the people you invite can see your log in Maple. Maple shows no ads and never sells your data. The{" "}
        <Link className="site-link" href="/privacy">
          privacy page
        </Link>{" "}
        lists the services that store or carry it.
      </>
    ),
  },
  { title: "Analytics", body: "The app and this site have no analytics or session replay." },
  {
    title: "Source code",
    body: (
      <>
        Maple&rsquo;s code is public under the MIT license, on{" "}
        <a className="site-link" href="https://github.com/Brooker-Fam/maple">
          GitHub
        </a>
        .
      </>
    ),
  },
  { title: "Who makes it", body: "Matt Brooker makes Maple; he and his wife use it every day." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="mx-auto grid w-full max-w-[76rem] items-center gap-12 px-4 pt-12 pb-20 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-20 lg:pt-20 lg:pb-28">
          <div>
            <h1 className="site-display max-w-[13ch] text-[clamp(2.85rem,1.4rem+6vw,5.75rem)] leading-[0.98] text-mp-ink">
              A newborn log you and your partner share.
            </h1>
            <p className="site-prose mt-6 text-[19px] leading-[1.55]">
              Each of you logs from your own phone, into the same log. The buttons sit at the bottom of the screen, and one tap
              starts a feed or logs a diaper.
            </p>
            <div className="mt-9">
              <WaitlistForm />
            </div>
          </div>
          <Phone
            className="mx-auto lg:mr-4"
            label="Sample screen: Today mid-feed. The left side ran 12 minutes, she has been on the right for 4 minutes, and the dock holds Switch, Pause, Done and More above Pee, Poop, Both and Sleep."
          >
            <TodayMock />
          </Phone>
        </section>

        <section aria-labelledby="day" className="mx-auto w-full max-w-[76rem] px-4 pb-24 sm:px-8">
          <div className="max-w-[40rem] border-t border-mp-line pt-12">
            <h2 id="day" className="site-display text-[clamp(2.1rem,1.5rem+2.4vw,3.2rem)] leading-[1.05] text-mp-ink">
              One day with June
            </h2>
            <p className="site-prose mt-4">Sample data.</p>
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

        <section aria-labelledby="lantern" className="site-night site-night-band">
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
                From 8pm to 7am the app turns dim amber on near-black, and photos dim with it. During a feed, the Lantern button on
                the timer card opens a full-screen timer with a large clock and the dock&rsquo;s buttons, and asks the phone to keep
                the screen on. Each button needs a half-second hold, so a stray tap doesn&rsquo;t end the feed.
              </p>
              <dl className="mt-10 grid max-w-[40rem] gap-x-8 gap-y-6 sm:grid-cols-3">
                {NIGHT_FACTS.map((f) => (
                  <div key={f.title} className="border-t border-mp-line pt-4">
                    <dt className="text-[16px] font-semibold text-mp-ink">{f.title}</dt>
                    <dd className="mt-1 text-[15px] leading-relaxed text-mp-ink-2">{f.body}</dd>
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
                Medical advice comes from your pediatrician
              </h2>
              <p className="site-prose mt-4">
                Maple is a log. It doesn&rsquo;t diagnose anything or give medical advice. Its notes follow public guidance from
                the{" "}
                {SOURCES.map((src, i) => (
                  <span key={src.text}>
                    {i === SOURCES.length - 1 ? " and " : i > 0 ? ", " : ""}
                    <a className="site-link" href={src.href}>
                      {src.text}
                    </a>
                  </span>
                ))}{" "}
                for healthy full-term babies. In an emergency, call{" "}
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
            <p className="site-prose mt-4">Leave your email to hear when other families can sign up.</p>
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
