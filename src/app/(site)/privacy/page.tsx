import type { Metadata } from "next";
import { CONTACT_EMAIL, LegalPage } from "@/components/site/legal";
import { siteOpenGraph } from "@/components/site/meta";

const DESCRIPTION = "What Maple keeps, where it’s kept, who can see it, how the AI features use it, and how to have it deleted.";

export const metadata: Metadata = {
  title: "Privacy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: siteOpenGraph("Privacy | Maple", DESCRIPTION, "/privacy"),
};

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy"
      lead="Maple is a newborn tracker. This page says what it keeps, where, who can see it, and how to have it deleted. It covers maplebaby.app, and Maple’s iPhone and Android apps once they’re released."
      other={{ href: "/terms", label: "terms" }}
    >
      <h2>Summary</h2>
      <ul>
        <li>
          What you log stays in your family&rsquo;s log, and in Maple only the people in it can see it. The services that run
          Maple, and the AI model behind its chat, are listed below.
        </li>
        <li>No ads. Your data is never sold or shared for advertising.</li>
        <li>No analytics or session replay, in the app or on this site.</li>
        <li>
          If you use Maple&rsquo;s chat, your messages go to an AI model through Vercel AI Gateway, and every request asks for zero
          data retention and no training.
        </li>
        <li>
          Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and your family&rsquo;s log is deleted within 30 days.
        </li>
      </ul>

      <h2>What Maple keeps</h2>
      <h3>About you</h3>
      <p>
        When you sign in with Google, Google shares your name, email address and profile photo with Maple. Maple keeps your
        email address and your first name (or your full name, if Google has no first name for you). It doesn&rsquo;t keep your
        photo or anything else from your Google account. Someone invited with a one-time link instead of Google is known by the
        name on their invite.
      </p>
      <p>
        When someone is removed from a family&rsquo;s log, Maple keeps their email address so they can&rsquo;t sign back
        in. Inviting them again clears it.
      </p>
      <h3>What your family logs</h3>
      <p>
        Your baby&rsquo;s name, due date and birth details, and everything you add: feeds, pumping, diapers and stool colors,
        sleep, temperatures and other readings, growth, medicines, notes, questions for the doctor, milestones and photos. Each
        entry records who added it and, when it came from the app, a random id for that phone, used only so a notification can
        skip the phone that did it.
      </p>
      <p>
        Mom&rsquo;s page keeps her own medicines and their schedule, the doses she took, her temperature, questions for her OB and
        her daily check-ins, including the optional PHQ-9 and GAD-7 questionnaires.
      </p>
      <p>
        Deleting an entry from the baby&rsquo;s log, or one of mom&rsquo;s medicines, doses, temperatures or questions, hides it so
        you can restore it; it stays in the database until your family&rsquo;s log is deleted. Deleting one of her check-ins
        removes it for good at once, and so does deleting everything on her page.
      </p>
      <h3>The chat</h3>
      <p>
        Your chat with Maple is saved in your family&rsquo;s log so you can scroll back. It belongs to you alone: nobody else in
        your family can read it, and &ldquo;Delete chat history&rdquo; removes it for good. Maple also counts each answer&rsquo;s
        length and cost, without its words, to keep within its limits.
      </p>
      <h3>The waitlist</h3>
      <p>
        If you join the waitlist, Maple keeps your email address and the date you joined. It is used only to tell you when Maple
        opens to more families.
      </p>
      <h3>To keep things working</h3>
      <ul>
        <li>A sign-in cookie, so you stay signed in. Your theme and a few app settings are saved on your own phone.</li>
        <li>
          A keyed hash of your IP address, which can&rsquo;t be turned back into the address without Maple&rsquo;s secret key,
          counted per hour to limit how often one connection can try to sign in, upload or join the waitlist. Maple
          doesn&rsquo;t keep the address itself, and clears out counts more than a day old.
        </li>
        <li>For each phone that turns on notifications, the address its browser gave Maple for sending them.</li>
        <li>
          A hashed copy of each personal key behind a Siri shortcut, so each entry from a shortcut records who logged it. Claude and ChatGPT
          connections use signed keys that Maple doesn&rsquo;t store.
        </li>
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
          <strong>Upstash</strong>, when Maple uses it to send notifications on time, gets only the times to wake up. What you
          logged isn&rsquo;t sent to it.
        </li>
      </ul>
      <p>
        If error reporting is turned on, a server error is sent to PostHog as the kind of error and where in Maple&rsquo;s code it
        happened. The contents of your log and your messages aren&rsquo;t sent.
      </p>

      <h2>Who can see it</h2>
      <p>
        In Maple, the members of your family&rsquo;s log, and no one else. An owner invites people as members or as view-only
        guests. View-only guests can read the baby&rsquo;s log but not mom&rsquo;s page. Removing someone ends their sign-ins,
        connections and Siri shortcuts at once.
      </p>
      <p>
        The person who runs Maple can reach the database to keep it working. They don&rsquo;t read families&rsquo; logs, except to
        fix a problem you ask them to look at or when the law requires it. The services above store or carry your data only to
        run Maple, and the chat sends parts of it to an AI model, as the next section says.
      </p>

      <h2>The AI features</h2>
      <h3>Maple&rsquo;s chat</h3>
      <p>
        When you use the chat, your message, the recent conversation, and whatever it looks up in your log to answer are sent to
        an AI model chosen by Maple, through Vercel AI Gateway. For members who can see mom&rsquo;s page, that can include her
        medicines and doses, her temperatures and her questions for her OB, but never her check-ins. Every request asks the
        Gateway for zero data retention and no training on your data, and names the only providers it may be sent to, each one
        the Gateway lists as keeping no data. Nothing about your messages goes into Maple&rsquo;s logs or error reports.
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
        &ldquo;status&rdquo;. Apple handles what you say to Siri, under Apple&rsquo;s terms. Revoke the key in Maple (Family &rarr;
        Shortcuts &amp; assistants) to stop it.
      </p>

      <h2>Notifications</h2>
      <p>
        Notifications are off until you turn them on, phone by phone. They go through your browser&rsquo;s push service (Apple,
        Google or Mozilla), encrypted so that service can&rsquo;t read them. Maple can send notices about mom&rsquo;s medicines
        (when one is OK again, her set times, and &ldquo;Logged&rdquo; when a dose is saved on another phone) and, if you turn it
        on, the nursing timer on the lock screen. By default a medicine notice names the medicine and says when it was last
        taken, on the lock screen; turn on Hide medicine names to keep it generic. No notice ever gives a dose amount. Signing
        out turns them off on that phone.
      </p>

      <h2>Ads and selling data</h2>
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
        photos, chats and members are deleted within 30 days. Copies in the database host&rsquo;s short-term backups expire on
        their own after that. First, you can download every entry in the baby&rsquo;s log as a CSV from Family &rarr; Data &amp;
        account; mom&rsquo;s page and photos aren&rsquo;t in that file. To leave the waitlist, email the same address.
      </p>

      <h2>Open source</h2>
      <p>
        Maple&rsquo;s code is public under the MIT license at{" "}
        <a href="https://github.com/Brooker-Fam/maple">github.com/Brooker-Fam/maple</a>, so you can read what it does with your data.
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
