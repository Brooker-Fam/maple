import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { siteOpenGraph } from "@/components/site/meta";

const DESCRIPTION =
  "Short answers about what Maple costs, who can see your log, what the AI sees, and how to export or delete your data.";

export const metadata: Metadata = {
  title: "Questions and answers",
  description: DESCRIPTION,
  alternates: { canonical: "/faq" },
  openGraph: siteOpenGraph("Questions and answers | Maple", DESCRIPTION, "/faq"),
};

type Linked = { text: string; href: string };
type Paragraph = (string | Linked)[];
type Faq = { id: string; q: string; a: Paragraph[] };

const MAIL: Linked = { text: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}` };

const FAQS: Faq[] = [
  {
    id: "free",
    q: "Is Maple free?",
    a: [
      [
        "Yes. It’s free while it’s in early access, and there is no paid plan. Any price will be posted on the ",
        { text: "pricing page", href: "/pricing" },
        " before it applies to anyone.",
      ],
    ],
  },
  {
    id: "sign-up",
    q: "Can I sign up?",
    a: [
      [
        "Not yet. One family uses Maple today. ",
        { text: "Join the waitlist", href: "/waitlist" },
        " and you’ll hear when Maple opens to more families.",
      ],
    ],
  },
  {
    id: "both-parents",
    q: "Can my partner and I both log?",
    a: [
      [
        "Yes, each from your own phone, into the same log. The owner of a log invites people from Family → Invite someone, with their Google account or with a one-time link for someone without Google. Each entry records who added it, and when you both tap the same feed timer, the taps are merged so neither of you overwrites the other.",
      ],
    ],
  },
  {
    id: "grandparents",
    q: "Can grandparents see the log?",
    a: [
      [
        "Yes. Invite them as View only. They can follow the baby’s log and Moments but can’t add or change anything, and mom’s page is hidden from them.",
      ],
    ],
  },
  {
    id: "night",
    q: "Does it work at night, one-handed?",
    a: [
      [
        "The logging buttons sit in a dock at the bottom of Today. One tap starts a side or a nap, or logs a diaper at the current time, and holding a button opens the full form. By default the app turns dim amber on black from 8pm to 7am (Family → On this phone → Night look).",
      ],
      [
        "During a feed, the Lantern button on the timer card opens a nearly black full-screen timer. Its buttons each need a half-second hold, and it asks the phone to keep the screen on. On an iPhone, a Siri shortcut can log without touching the screen, as ",
        { text: "Logging hands-free with Siri", href: "/blog/logging-hands-free-with-siri" },
        " explains.",
      ],
    ],
  },
  {
    id: "forgot-timer",
    q: "What if I forget to stop a timer?",
    a: [
      [
        "Once a side has run 45 minutes, the timer card shows “Still nursing?”, and from then on Done lets you pick when the feed ended instead of ending it at the moment you tap. A nap gets the same check after 5 hours, tummy time after 30 minutes and pumping after an hour, each with a button for when it really ended. Times can also be corrected later by opening the entry.",
      ],
    ],
  },
  {
    id: "notifications",
    q: "Will it send me notifications?",
    a: [
      [
        "Only if you turn them on, phone by phone. Once they’re on, a phone gets notices about mom’s medicines when one is OK again by her schedule, at her set times, and when a dose is logged on another phone. The nursing timer on the lock screen is a separate switch, off until you turn it on. Nothing else notifies, and no notice ever gives a dose amount. On an iPhone they work from the Home Screen app, on iOS 16.4 or later.",
      ],
    ],
  },
  {
    id: "data-sold",
    q: "Is my data sold?",
    a: [
      [
        "No. Maple shows no ads, and your data is never sold, rented or shared for advertising. There are no analytics or session replay in the app or on this site. The ",
        { text: "privacy page", href: "/privacy" },
        " lists each service that stores or carries your data, and why.",
      ],
    ],
  },
  {
    id: "ai",
    q: "What does the AI see?",
    a: [
      [
        "Ask, the chat inside the app, sends your message, the recent conversation and whatever it looks up in your log to an AI model through Vercel AI Gateway. Every request asks for zero data retention and no training on your data. Each person accepts short terms before their first message. Chats are saved in your family’s log so you can scroll back, and nothing you type goes into Maple’s server logs or error reports. ",
        { text: "What Maple’s chat sends to an AI model", href: "/blog/what-maple-sends-to-an-ai-model" },
        " lists each part of a request.",
      ],
      [
        "Mom’s medicines, temperatures and questions for her OB reach the chat only after she turns that on herself, and her check-ins never do. If you connect your own Claude or ChatGPT account, what it reads goes through that account, under that company’s terms. ",
        { text: "Connect Maple to Claude or ChatGPT", href: "/blog/connect-maple-to-claude-or-chatgpt" },
        " covers the setup.",
      ],
    ],
  },
  {
    id: "export",
    q: "Can I export my data?",
    a: [
      [
        "Yes. Family → Data & account → Download everything (CSV) gives you every entry in the baby’s log as a spreadsheet file. Mom’s page and photos aren’t in that file.",
      ],
    ],
  },
  {
    id: "medical-advice",
    q: "Does Maple give medical advice?",
    a: [
      [
        "No. Maple is a tracker. It doesn’t diagnose anything, and it never suggests a medicine dose. Its alerts follow public guidance from the ",
        { text: "AAP", href: "https://www.healthychildren.org/" },
        ", ",
        { text: "CDC", href: "https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/newborn-basics.html" },
        " and ",
        { text: "WHO", href: "https://www.who.int/tools/child-growth-standards/standards" },
        " for healthy full-term babies, and each one says who to call and how soon: 911, call now, call today, or mention it at the next checkup. Mom’s page does the same with her OB. Warnings and reminders stay off unless you turn them on in Family → On Today, though a reading such as a temperature is still checked as you enter it. Your pediatrician’s and OB’s advice comes first.",
      ],
      [
        "In an emergency, call ",
        { text: "911", href: "tel:911" },
        ". The Suicide & Crisis Lifeline takes calls and texts at ",
        { text: "988", href: "tel:988" },
        ", and the National Maternal Mental Health Hotline at ",
        { text: "1-833-852-6262", href: "tel:18338526262" },
        ", any time.",
      ],
    ],
  },
  {
    id: "apps",
    q: "Is there an iPhone or Android app?",
    a: [
      [
        "Not in the App Store or Google Play. Maple runs in the phone’s browser at maplebaby.app/maple. On an iPhone, open it in Safari and choose Share → Add to Home Screen. On Android, open it in Chrome and choose ⋮ → Add to Home screen. Code for iPhone and Android apps is in Maple’s repository, but they aren’t released.",
      ],
    ],
  },
  {
    id: "delete",
    q: "How do I delete my data?",
    a: [
      [
        "Email ",
        MAIL,
        " from an address in your family’s log. The log, its photos, chats and members are deleted within 30 days, and copies in the database host’s short-term backups expire on their own after that. Download the CSV first if you want a copy. To leave the waitlist, email the same address.",
      ],
      [
        "Inside the app, a deleted entry is hidden so it can be restored, and Delete this chat removes a chat for good.",
      ],
    ],
  },
  {
    id: "who",
    q: "Who builds Maple?",
    a: [
      [
        "Matt Brooker, a software engineer, made Maple for his own family when his daughter, Maple, was born in October 2026. He and his wife use it every day. The code is open source under the MIT license, on ",
        { text: "GitHub", href: "https://github.com/Brooker-Fam/maple" },
        ".",
      ],
    ],
  },
];

const plain = (p: Paragraph) => p.map((part) => (typeof part === "string" ? part : part.text)).join("");

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a.map(plain).join("\n\n") },
  })),
};

function Answer({ paragraph }: { paragraph: Paragraph }) {
  return (
    <p className="mt-2.5 text-[17px] leading-[1.6] text-mp-ink-2 text-pretty">
      {paragraph.map((part, i) => {
        if (typeof part === "string") return part;
        const cls = part.href.startsWith("tel:") ? "site-link whitespace-nowrap" : "site-link";
        return part.href.startsWith("/") ? (
          <Link key={i} className={cls} href={part.href}>
            {part.text}
          </Link>
        ) : (
          <a key={i} className={cls} href={part.href}>
            {part.text}
          </a>
        );
      })}
    </p>
  );
}

export default function FaqPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-[42rem] px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD).replace(/</g, "\\u003c") }} />
        <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">Questions and answers</h1>
        <p className="site-prose mt-5 text-[19px] leading-[1.55]">
          These answers describe Maple as it works today. For anything else, write to{" "}
          <a className="site-link" href={MAIL.href}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
        <div className="mt-12 divide-y divide-[var(--mp-line)] border-t border-mp-line">
          {FAQS.map((f) => (
            <section key={f.id} id={f.id} aria-labelledby={`${f.id}-q`} className="scroll-mt-6 py-8">
              <h2 id={`${f.id}-q`} className="font-display text-[1.65rem] leading-[1.15] font-semibold text-mp-ink">
                {f.q}
              </h2>
              {f.a.map((p, i) => (
                <Answer key={i} paragraph={p} />
              ))}
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
