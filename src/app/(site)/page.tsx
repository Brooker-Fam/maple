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
    title: "Theo did the 2am feed and is asleep with the monitor on his face",
    body: (
      <>
        Wake him and the best you&rsquo;ll get is that there was probably a bottle. Once you&rsquo;ve been away three hours, Today
        shows one line of what got logged while you were gone, like 1 feed, 2 wet and a nap by Theo. A tap opens it into a few
        short sentences, signed by him.
      </>
    ),
    visual: <HandoffFragment />,
  },
  {
    time: "9:15",
    half: "am",
    title: "The poop is a color neither of you can name",
    body: (
      <>
        It&rsquo;s a mustard yellow you didn&rsquo;t know a person could make. Tap Poop, then Edit, and the color chart calls it
        textbook breastfed poop. On pale, gray, chalky white or red, it says to call your pediatrician today. Sizes go up to
        Blowout, for the ones that reach her shoulder blades.
      </>
    ),
    visual: <StoolFragment />,
  },
  {
    time: "11:30",
    half: "am",
    title: "The pediatrician asks how many wet diapers, and you say a lot",
    body: (
      <>
        Every diaper you tapped is already counted. Open For the doctor and copy a visit summary of the last seven days, poop
        colors and weights included. Type a question in at 4am and it&rsquo;s on the same sheet at the checkup.
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
    title: "Grandma wants a photo, and your camera roll is all poop",
    body: (
      <>
        Save the good ones in Maple as moments, like her first bath or the day the cord stump fell off. Invite the grandparents as
        view-only guests and they can look whenever they like, without texting you and without logging a diaper by accident.
      </>
    ),
    visual: <MomentFragment />,
  },
  {
    time: "5:45",
    half: "pm",
    title: "Nobody remembers when Ana last took ibuprofen, Ana included",
    body: (
      <>
        Her discharge papers have the schedule, and nobody can find the discharge papers. Copy it onto her own page once, and it
        shows when each medicine is OK again. If Theo already logged it in the last half hour, Took it asks before saving another.
        It never suggests a dose.
      </>
    ),
    visual: <MomFragment />,
  },
  {
    time: "8:20",
    half: "pm",
    title: "Your hands are full, and one of them just got peed on",
    body: (
      <>
        Set up the Siri shortcut on an iPhone, and &ldquo;Hey Siri, Maple pee&rdquo; logs it under your name. &ldquo;Maple
        status&rdquo; says out loud when she last ate and which side is next. Once a hand is dry, tell the chat what happened in
        your own words and it logs each entry with an Undo.
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
    title: "You each remember a different side",
    body: "Today shows the side to start on next, following the AAP’s advice to alternate. Tap Done and the toast says “Left if she wants more” or “Right next time.”",
  },
  {
    title: "Cluster feeding nights",
    body: "Some nights she wants the other side every few minutes. Mark the feed back and forth once and stop tapping Switch. Done lists those minutes as both, apart from Left and Right, and says “Left next time, or the fuller side.”",
  },
  {
    title: "Fell asleep mid-feed",
    body: "After 45 minutes on one side the card asks “Still nursing?” and Done lets you pick when she finished, so the log doesn’t say she nursed until sunrise.",
  },
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
        Only the people you invite can see your log in Maple, and view-only guests can&rsquo;t see mom&rsquo;s page. The{" "}
        <Link className="site-link" href="/privacy">
          privacy page
        </Link>{" "}
        lists the services that store it.
      </>
    ),
  },
  {
    title: "No ads or analytics",
    body: "The app and this site run no analytics or session replay, and nothing you log is ever sold.",
  },
  {
    title: "Open source",
    body: (
      <>
        The code is public under the MIT license on{" "}
        <a className="site-link" href="https://github.com/Brooker-Fam/maple">
          GitHub
        </a>
        , so you can read what it does with your data.
      </>
    ),
  },
  {
    title: "Who makes it",
    body: "Matt Brooker, a software engineer, built Maple for his family the month his daughter was born. He and his wife use it every day.",
  },
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
            <p className="site-prose mt-6 text-[19px] leading-[1.55]">
              You knew an hour ago. Now it&rsquo;s 3am and the answer is gone, along with when she last ate and whether that diaper
              had poop in it. Maple keeps one log on both your phones, so the next side is on the screen before you&rsquo;re fully
              awake.
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
            <p className="site-prose mt-4">June is two weeks old and has never once waited for the clean diaper.</p>
            <p className="mt-2 text-[14px] text-mp-ink-3">Sample data.</p>
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
                At 3am your phone is the brightest thing in the house
              </h2>
              <p className="site-prose mt-4 text-mp-ink-2">
                From 8pm to 7am the app turns dim amber on near-black, and checking it barely lights up whoever&rsquo;s asleep next
                to you. During a feed, tap Lantern and the whole screen turns into one big clock that asks the phone to stay awake, so
                you aren&rsquo;t poking it with your nose. A stray kick can&rsquo;t end the feed there, since Switch, Pause and Done
                each take a half-second hold.
              </p>
              <h3 className="site-display mt-12 text-[clamp(1.5rem,1.3rem+0.8vw,1.9rem)] leading-[1.1]">
                Neither of you can do boob math at 3am
              </h3>
              <dl className="mt-6 grid max-w-[34rem] gap-y-6">
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
                Maple&rsquo;s notes follow public guidance from the{" "}
                {SOURCES.map((src, i) => (
                  <span key={src.text}>
                    {i === SOURCES.length - 1 ? " and " : i > 0 ? ", " : ""}
                    <a className="site-link" href={src.href}>
                      {src.text}
                    </a>
                  </span>
                ))}{" "}
                for healthy full-term babies. A worrying temperature or poop color says who to call as you enter it, whether
                that&rsquo;s your pediatrician, your OB or{" "}
                <a className="site-link" href="tel:911">
                  911
                </a>
                . Warnings about feed gaps and diaper counts start switched off, since they only mean something when every feed and
                diaper gets logged.
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
            <h2 id="join" className="site-display max-w-[22ch] text-[clamp(2.4rem,1.6rem+3.2vw,4rem)] leading-[1.02] text-mp-ink">
              So far Maple has one family, and it&rsquo;s the one that built it.
            </h2>
            <p className="site-prose mt-4">
              Leave your email to hear when other families can sign up. It&rsquo;s free while in early
              access, and any price goes on the{" "}
              <Link className="site-link" href="/pricing">
                pricing page
              </Link>{" "}
              before it applies to anyone.
            </p>
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
