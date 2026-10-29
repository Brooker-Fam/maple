import type { Metadata } from "next";
import Link from "next/link";
import GetStarted from "@/components/site/GetStarted";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import FeatureExplorer from "@/components/site/FeatureExplorer";
import HomeDayScene from "@/components/site/HomeDayScene";
import Leaf from "@/components/site/Leaf";
import { Icon } from "@/components/maple/icons";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Home() {
  return (
    <div className="maple-home">
      <div className="home-sky home-header"><SiteHeader home /></div>
      <main id="main">
        <section className="home-sky home-hero" aria-labelledby="home-title">
          <div className="home-hero-inner">
            <div className="home-hero-copy">
              <p className="home-eyebrow"><span className="home-tiny-star" aria-hidden>✦</span> Your family’s newborn companion</p>
              <h1 id="home-title">Tiny days.<br />A little more<br /><em>understanding.</em></h1>
              <p className="home-hero-lead">Feeds, naps, little firsts.<br />A shared place to make sense of it all.</p>
              <div className="home-actions">
                <GetStarted placement="hero" />
                <a href="#explore" className="home-explore-link">Take a little tour <Icon name="chevron-down" size={17} /></a>
              </div>
              <p className="home-access">Free in early access · Made by parents</p>
            </div>
            <HomeDayScene />
          </div>
          <div className="home-hero-bottom" aria-hidden><span>A little less to remember.</span><span>A little more room to be here.</span></div>
        </section>

        <section id="explore" aria-labelledby="explore-title" className="home-explore home-section">
          <div className="home-section-heading">
            <p className="home-eyebrow">Meet Maple</p>
            <h2 id="explore-title">Their little world.<br /><em>All in one place.</em></h2>
            <p>Pick a little part of the day. Try it for yourself.</p>
          </div>
          <FeatureExplorer />
        </section>

        <section aria-labelledby="care-title" className="home-care home-section">
          <div className="home-section-heading home-heading-inline">
            <div><p className="home-eyebrow">For the people doing the caring</p><h2 id="care-title">You’re in this<br /><em>together.</em></h2></div>
            <p>One shared log. More ways to feel connected.</p>
          </div>
          <div className="home-care-grid">
            <article className="home-care-card home-card-sage">
              <div className="home-care-art home-handoff-art" aria-hidden>
                <div className="home-avatar home-avatar-one">M</div><span className="home-avatar-line" /><div className="home-avatar home-avatar-two">D</div>
                <div className="home-handoff-note"><Icon name="check" size={17} /><span>Bottle logged by Dad</span><small>Just now</small></div>
              </div>
              <h3>Pass the baby.<br />Keep the picture.</h3>
              <p>Pick up where your partner left off, from your own phone.</p>
            </article>
            <article className="home-care-card home-card-lilac">
              <div className="home-care-art home-chat-art" aria-hidden>
                <span className="home-chat-bubble">What happened while I slept?</span>
                <span className="home-chat-answer"><Leaf size={22} /><span>2 feeds. 3 diapers.<br />One busy little morning.</span></span>
              </div>
              <h3>Ask it like<br />you’d say it.</h3>
              <p>Log a moment or explore your history with Maple’s chat.</p>
            </article>
            <article className="home-care-card home-card-peach">
              <div className="home-care-art home-mom-art" aria-hidden>
                <div className="home-mom-sun"><Icon name="heart" size={45} strokeWidth={1.2} /></div>
                <span className="home-mom-note">A little space for you.</span>
                <span className="home-mom-star">✧</span>
              </div>
              <h3>Because mom<br />matters, too.</h3>
              <p>A place for your recovery, medicines, and daily check-ins.</p>
            </article>
          </div>
          <p className="home-sample-note">Illustrations use fictional sample data.</p>
        </section>

        <section id="maples-story" aria-labelledby="story-title" className="home-story">
          <div className="home-story-inner">
            <div className="home-story-art" aria-hidden><span className="home-story-ring" /><Leaf size={100} /><span className="home-story-star">✧</span><span className="home-story-handwritten">for Maple,<br />with love.</span></div>
            <div className="home-story-copy">
              <p className="home-eyebrow">A real baby. A real beginning.</p>
              <h2 id="story-title">Made for our little Maple.<br /><em>Here for your little world.</em></h2>
              <p>At her six-day checkup, Maple’s weight was down. Her log helped us see feeding gaps, talk with her doctor, and follow the changes that helped breastfeeding work for us. Today, she’s doing great.</p>
              <Link href="/about" className="home-text-link">Read our family’s story <Icon name="arrow-right" size={18} /></Link>
            </div>
          </div>
        </section>

        <section className="home-finale home-section" aria-labelledby="join">
          <div className="home-privacy"><Icon name="lock" size={17} /><span>Your family’s space. No ads. Never sold for advertising.</span><Link href="/privacy">Our privacy promise <span aria-hidden>↗</span></Link></div>
          <span className="home-finale-star" aria-hidden>✦</span>
          <h2 id="join">Find your<br /><em>family’s rhythm.</em></h2>
          <p>For the messy, sleepy, wonderful beginning.</p>
          <GetStarted className="mt-7" placement="footer" />
          <p className="home-access">Free while we grow. No paid plan in early access.</p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
