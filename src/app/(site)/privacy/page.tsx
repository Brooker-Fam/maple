import type { Metadata } from "next";
import { CONTACT_EMAIL, LegalPage } from "@/components/site/legal";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Maple keeps, where it's kept, who can see it, how the AI features use it, and how to have it deleted.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy"
      lead="Maple is a newborn tracker. This page says what it keeps, where, who can see it, and how to have it deleted. It covers maplebaby.app and Maple's iPhone and Android apps, which show the same app."
      other={{ href: "/terms", label: "terms" }}
    >
      <h2>The short version</h2>
      <ul>
        <li>What you log stays in your family&rsquo;s log. Only the people in it can see it.</li>
        <li>No ads. Your data is never sold or shared for advertising.</li>
        <li>No analytics or session replay, in the app or on this site.</li>
        <li>
          If you use Maple&rsquo;s chat, your messages go to an AI model through Vercel AI Gateway, which Maple asks to keep
          nothing and train on nothing.
        </li>
        <li>Ask, and your family&rsquo;s log is deleted.</li>
      </ul>

      <h2>What Maple keeps</h2>
      <h3>About you</h3>
      <p>
        When you sign in with Google, Maple gets your email address and first name, and nothing else from your Google account:
        not your contacts, calendar or files. Someone invited with a one-time link instead of Google is known by the name they
        pick.
      </p>
      <h3>What your family logs</h3>
      <p>
        Your baby&rsquo;s name, due date and birth details, and everything you add: feeds, pumping, diapers and stool colors,
        sleep, temperatures and other readings, growth, medicines, notes, questions for the doctor, milestones and photos. Each
        entry records who added it.
      </p>
      <p>
        Mom&rsquo;s page keeps her own medicines and their schedule, the doses she took, her temperature, questions for her OB and
        her daily check-ins, including the optional PHQ-9 and GAD-7 questionnaires.
      </p>
      <p>
        Deleting an entry hides it and lets you restore it; it stays in the database until your family&rsquo;s log is deleted.
      </p>
      <h3>The chat</h3>
      <p>
        Your chats with Maple are saved in your family&rsquo;s log so you can scroll back. Each chat belongs to the person who
        started it, and &ldquo;Delete this chat&rdquo; removes it for good. Maple also counts each chat&rsquo;s length and cost,
        without its words, to keep within its limits.
      </p>
      <h3>The waitlist</h3>
      <p>
        If you join the waitlist: your email, the month your baby is due or was born if you pick one, and when you joined. It is
        used only to tell you when Maple opens to more families.
      </p>
      <h3>To keep things working</h3>
      <ul>
        <li>A sign-in cookie, so you stay signed in. Your theme and a few app settings are saved on your own phone.</li>
        <li>
          A one-way hash of your IP address, counted per hour to limit how often one connection can try to sign in, upload or
          join the waitlist. Maple doesn&rsquo;t keep the address itself.
        </li>
        <li>For each phone that turns on notifications, the address its browser gave Maple for sending them.</li>
        <li>The personal keys behind Siri shortcuts and Claude or ChatGPT connections, so Maple knows who is logging.</li>
      </ul>

      <h2>Where it&rsquo;s kept</h2>
      <ul>
        <li>
          <strong>Neon</strong> runs Maple&rsquo;s Postgres database, which holds everything above except photos.
        </li>
        <li>
          <strong>Vercel Blob</strong> stores photos. They are only ever shown through Maple to someone signed in to your log.
        </li>
        <li>
          <strong>Vercel</strong> hosts Maple. Like any web host, it keeps request logs (such as IP addresses and the pages asked
          for) under its own policy.
        </li>
        <li>
          <strong>Upstash</strong>, when Maple uses it to send notifications on time, gets only the times to wake up, never what
          you logged.
        </li>
      </ul>
      <p>
        If error reporting is turned on, a server error is sent to PostHog with technical details only, never the contents of your
        log or your messages.
      </p>

      <h2>Who can see it</h2>
      <p>
        The members of your family&rsquo;s log, and no one else. An owner invites people as members or as view-only guests.
        View-only guests can read the baby&rsquo;s log but not mom&rsquo;s page. Removing someone ends their sign-ins, connections
        and Siri shortcuts at once.
      </p>
      <p>
        The person who runs Maple can reach the database to keep it working. They don&rsquo;t read families&rsquo; logs, except to
        fix a problem you ask them to look at or when the law requires it.
      </p>

      <h2>The AI features</h2>
      <h3>Maple&rsquo;s chat</h3>
      <p>
        When you use the chat, your message, the recent conversation, and whatever it looks up in your log to answer (for members
        who can see mom&rsquo;s page, that can include her medicines) are sent to an AI model chosen by Maple, through Vercel AI
        Gateway. Every request asks the Gateway for zero data retention and no training on your data. Vercel says it then sends
        requests only to providers that keep nothing and don&rsquo;t train on it. Nothing about your messages goes into
        Maple&rsquo;s logs or error reports.
      </p>
      <h3>Claude and ChatGPT</h3>
      <p>
        You can connect Maple to your own Claude or ChatGPT account. What those assistants read from your log or add to it goes
        through your account with Anthropic or OpenAI, under their terms and your privacy settings there; Maple doesn&rsquo;t
        control what they keep. You can disconnect at any time.
      </p>
      <h3>Siri</h3>
      <p>
        A Siri shortcut uses a personal key you make in Maple and sends short actions such as &ldquo;pee&rdquo; or
        &ldquo;status&rdquo;. Apple handles what you say to Siri, under Apple&rsquo;s terms. Delete the key in Maple to stop it.
      </p>

      <h2>Notifications</h2>
      <p>
        Notifications are off until you turn them on, phone by phone. They go through your browser&rsquo;s push service (Apple,
        Google or Mozilla), encrypted so that service can&rsquo;t read them. Notices about mom&rsquo;s medicines say when one is OK
        again, never a dose. Signing out turns them off on that phone.
      </p>

      <h2>No ads, no selling</h2>
      <p>
        Maple shows no ads and has no advertising or tracking cookies. Your data is never sold, rented or shared for advertising.
      </p>

      <h2>Children</h2>
      <p>
        Maple is for adults. A baby&rsquo;s details are entered by their parents or the family members they invite.
      </p>

      <h2>Keeping and deleting</h2>
      <p>
        Your log stays until you ask for it to be deleted. Email{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> from an address in your family&rsquo;s log, and the log, its
        photos, chats and members are deleted within 30 days. You can download every entry as a CSV first, from Family &rarr;
        Data &amp; account. To leave the waitlist, email the same address.
      </p>

      <h2>Open source</h2>
      <p>
        Maple&rsquo;s code is public under the MIT license at{" "}
        <a href="https://github.com/Brooker-Fam/maple">github.com/Brooker-Fam/maple</a>, so you can read exactly what it does.
        Your family&rsquo;s data is never part of it.
      </p>

      <h2>Changes</h2>
      <p>
        When this page changes, its version and date at the top change too, and anything that changes how your data is used is
        announced in the app before it applies.
      </p>
    </LegalPage>
  );
}
