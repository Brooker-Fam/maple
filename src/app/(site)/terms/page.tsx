import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, HelpLines, LegalPage } from "@/components/site/legal";
import { siteOpenGraph } from "@/components/site/meta";

const DESCRIPTION = "The terms for using Maple, a newborn tracker that gives no medical advice and comes with no warranty.";

export const metadata: Metadata = {
  title: "Terms",
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: siteOpenGraph("Terms | Maple", DESCRIPTION, "/terms"),
};

export default function Terms() {
  return (
    <LegalPage
      title="Terms"
      lead="These are the terms for using Maple at maplebaby.app, and in its iPhone and Android apps once they’re released. Using Maple means you agree to them."
      other={{ href: "/privacy", label: "privacy page" }}
    >
      <h2>Maple doesn&rsquo;t give medical advice</h2>
      <p>
        Maple is for writing down a newborn&rsquo;s days and a parent&rsquo;s recovery. It doesn&rsquo;t diagnose or treat
        anything, and it isn&rsquo;t a medical device or a medical record.
      </p>
      <p>
        Its notes and reminders come from public guidance (such as the AAP, CDC and WHO) for healthy, full-term babies. They are
        general and don&rsquo;t account for your baby&rsquo;s health. Your pediatrician&rsquo;s and your own clinician&rsquo;s
        advice always comes first, and nothing in Maple is a reason to wait before calling them.
      </p>
      <div className="site-callout">
        <p className="mt-0">
          <strong>If you think your baby or you need help now, call one of these numbers instead of using Maple.</strong>
        </p>
        <HelpLines />
        <p>Maple can&rsquo;t call anyone for you, and no one is told automatically.</p>
      </div>

      <h2>AI answers can be wrong</h2>
      <p>
        Maple&rsquo;s chat, and Claude, ChatGPT, Muse or Grok when you connect them, can misread what you say or log the wrong thing. Each
        entry they save shows up in your log with who added it, and can be undone; check them. Don&rsquo;t use their answers to
        make medical decisions. When you connect your own Claude, ChatGPT, Muse or Grok account, that provider&rsquo;s terms apply to it too.
      </p>

      <h2>Who can use Maple</h2>
      <p>
        Maple is for adults 18 and older. The <Link href="/signup">sign-up page</Link> says whether new families can join or
        leave an email address on the waitlist. A family log&rsquo;s owners decide who is in it, can remove anyone who isn&rsquo;t an
        owner, and can make someone already in it an owner, which another owner can&rsquo;t undo in Maple.
        Invite only people who expect an invitation from you, and check their email address and access before sending it,
        including on the card Maple&rsquo;s chat shows or what a connected assistant reads back to you. You&rsquo;re
        responsible for who you invite and for keeping your sign-in and email codes to yourself. Google, Apple and email
        sign-in are available when shown on the sign-in page. Connecting a sign-in method to your existing account does not
        combine separate family logs.
      </p>

      <h2>Email and feedback</h2>
      <p>
        Maple sends requested sign-in codes, invite links and a new owner&rsquo;s welcome email through Resend. Feedback you
        send from Settings, the chat or the question on Today is saved with your family&rsquo;s account and emailed to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, where replies to Maple&rsquo;s emails go too. The{" "}
        <Link href="/privacy">privacy page</Link> explains what these emails contain, how invite addresses and feedback are
        kept, and the limited usage events sent to PostHog.
      </p>

      <h2>Optional MyChart imports</h2>
      <p>
        Where offered, a family owner can import selected growth measurements from a supported healthcare organization.
        Use only records you are authorized to access and share on your baby&rsquo;s behalf. Confirm the selected child and
        review the dates, units and values before saving. Imported measurements become part of your shared baby log and can
        be used by the AI features you or other permitted family members use, as explained on the{" "}
        <Link href="/privacy">privacy page</Link>.
      </p>
      <p>
        Availability depends on the healthcare organization and your access there, including permission to access a child&rsquo;s
        record. Imports can be incomplete or out of date and do not update automatically. Maple does not replace the medical
        record, correct it or send your entries to a clinician. Check the source record and contact your care team about
        errors or medical questions. Removing imported measurements from Maple does not remove copies already exported or
        included in a chat.
      </p>

      <h2>Who owns what you log</h2>
      <p>
        You own what you add to Maple. You let Maple store it, show it to people your family has granted access, and process
        it to run the features you use, such as sending a chat message to an AI model. The{" "}
        <Link href="/privacy">privacy page</Link> says exactly how.
      </p>

      <h2>Using it fairly</h2>
      <p>
        Don&rsquo;t try to get into someone else&rsquo;s log, get around Maple&rsquo;s limits, overload it, or use it to harm
        anyone. Maple can end access that does.
      </p>

      <h2>Price</h2>
      <p>
        Maple doesn&rsquo;t charge anything today. Any price will be posted on the <Link href="/pricing">pricing page</Link> before it
        applies to anyone, and nothing is charged without your agreement.
      </p>

      <h2>No warranty</h2>
      <p>
        Maple is a small project, offered as it is. It can go down or show something wrong, and data can be lost, so keep
        anything you can&rsquo;t lose somewhere else too. You can download every entry in the baby&rsquo;s log as a CSV at any time;
        mom&rsquo;s page and photos aren&rsquo;t in that file. Maple&rsquo;s code is open source under the MIT license, which
        also comes with no warranty.
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
