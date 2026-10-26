import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, HelpLines, LegalPage } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Maple: a newborn tracker, not medical advice, offered as is.",
  alternates: { canonical: "/terms" },
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms"
      lead="These are the terms for using Maple, at maplebaby.app and in its iPhone and Android apps. Using Maple means you agree to them. They're short on purpose."
      other={{ href: "/privacy", label: "privacy page" }}
    >
      <h2>Maple is a tracker, not medical advice</h2>
      <p>
        Maple helps a family write down a newborn&rsquo;s days and a parent&rsquo;s recovery. It is not medical advice, it
        doesn&rsquo;t diagnose or treat anything, and it isn&rsquo;t a medical device or a medical record.
      </p>
      <p>
        Its notes and reminders are general information drawn from public guidance (such as the AAP, CDC and WHO) for healthy,
        full-term babies. They can&rsquo;t know your baby. Your pediatrician&rsquo;s and your own clinician&rsquo;s advice always
        comes first, and nothing in Maple is a reason to wait before calling them.
      </p>
      <div className="site-callout">
        <p className="mt-0">
          <strong>If you think your baby or you need help now, don&rsquo;t use Maple. Call.</strong>
        </p>
        <HelpLines />
        <p>Maple can&rsquo;t call anyone for you, and no one is told automatically.</p>
      </div>

      <h2>AI answers can be wrong</h2>
      <p>
        Maple&rsquo;s chat, and Claude or ChatGPT when you connect them, can misread what you say or log the wrong thing. Each
        entry they save shows up in your log with who added it, and can be undone; check them. Don&rsquo;t use their answers to
        make medical decisions. When you connect your own Claude or ChatGPT account, that provider&rsquo;s terms apply to it too.
      </p>

      <h2>Who can use Maple</h2>
      <p>
        Maple is for adults. Today it&rsquo;s open to one family, by invitation; others can{" "}
        <Link href="/#join">join the waitlist</Link>. The owner of a family&rsquo;s log decides who is in it and can remove anyone.
        You&rsquo;re responsible for who you invite and for keeping your sign-in to yourself.
      </p>

      <h2>Your log is yours</h2>
      <p>
        What you add to Maple stays yours. You let Maple store it, show it to the members of your family&rsquo;s log, and process
        it to run the features you use, such as sending a chat message to an AI model. The{" "}
        <Link href="/privacy">privacy page</Link> says exactly how.
      </p>

      <h2>Using it fairly</h2>
      <p>
        Don&rsquo;t try to get into someone else&rsquo;s log, get around Maple&rsquo;s limits, overload it, or use it to harm
        anyone. Maple can end access that does.
      </p>

      <h2>Price</h2>
      <p>Maple doesn&rsquo;t charge anything today. If that changes, you&rsquo;ll be told first, and nothing is charged without your agreement.</p>

      <h2>No warranty</h2>
      <p>
        Maple is a small project, offered as it is. It can be down, slow, or wrong, and data can be lost, so keep anything
        you can&rsquo;t lose somewhere else too: you can download every entry as a CSV at any time. Maple&rsquo;s code is open
        source under the MIT license, which also comes with no warranty.
      </p>
      <p>
        As far as the law allows, Maple and the people who make it aren&rsquo;t responsible for losses that come from using it or
        from relying on what it shows. Nothing here limits rights you have that the law says can&rsquo;t be limited.
      </p>

      <h2>Stopping</h2>
      <p>
        You can stop using Maple at any time and ask for your family&rsquo;s log to be deleted by writing to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. If Maple ever shuts down, you&rsquo;ll be told ahead of time, with
        a chance to download your log.
      </p>

      <h2>Changes</h2>
      <p>
        When these terms change, the version and date at the top change too. A change that matters is announced in the app before
        it applies; using Maple after that means you accept it.
      </p>
    </LegalPage>
  );
}
