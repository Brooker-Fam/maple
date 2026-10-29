import { Icon } from "@/components/maple/icons";
import Leaf from "./Leaf";

const ticks = Array.from({ length: 48 }, (_, i) => i * 7.5);

/** An original illustration of a fictional day, not a live family record. */
export default function HomeDayScene() {
  return (
    <figure className="home-day-scene" aria-label="Illustration of a baby's day: feeds, sleep, diapers and little firsts, held together in one log.">
      <div className="home-orbit home-orbit-one" aria-hidden />
      <div className="home-orbit home-orbit-two" aria-hidden />
      <span className="home-spark home-spark-one" aria-hidden>✧</span>
      <span className="home-spark home-spark-two" aria-hidden>✦</span>
      <span className="home-spark home-spark-three" aria-hidden>✧</span>
      <div className="home-day-dial" aria-hidden>
        <svg viewBox="0 0 400 400" className="home-dial-rings">
          <circle cx="200" cy="200" r="172" fill="none" stroke="currentColor" opacity=".12" />
          {ticks.map((angle, i) => <line key={angle} x1="200" y1={i % 4 ? 20 : 15} x2="200" y2="26" stroke="currentColor" strokeWidth={i % 4 ? 1 : 2} opacity={i % 4 ? .22 : .5} transform={`rotate(${angle} 200 200)`} />)}
          <g transform="rotate(-90 200 200)" fill="none" strokeWidth="19" strokeLinecap="round">
            <circle cx="200" cy="200" r="145" stroke="#b9a6d4" strokeDasharray="114 797" strokeDashoffset="-11" />
            <circle cx="200" cy="200" r="145" stroke="#b9a6d4" strokeDasharray="86 825" strokeDashoffset="-230" />
            <circle cx="200" cy="200" r="145" stroke="#b9a6d4" strokeDasharray="140 771" strokeDashoffset="-520" />
            <circle cx="200" cy="200" r="117" stroke="#eeb285" strokeDasharray="28 707" strokeDashoffset="-115" />
            <circle cx="200" cy="200" r="117" stroke="#eeb285" strokeDasharray="20 715" strokeDashoffset="-275" />
            <circle cx="200" cy="200" r="117" stroke="#eeb285" strokeDasharray="30 705" strokeDashoffset="-402" />
            <circle cx="200" cy="200" r="117" stroke="#eeb285" strokeDasharray="22 713" strokeDashoffset="-632" />
          </g>
          <g fill="#add1cf">
            <circle cx="293" cy="103" r="6" /><circle cx="315" cy="249" r="6" /><circle cx="144" cy="322" r="6" /><circle cx="95" cy="183" r="6" />
          </g>
        </svg>
        <div className="home-dial-center">
          <Leaf size={34} />
          <span className="home-dial-label">a little day</span>
          <strong>It all<br />belongs.</strong>
          <span className="home-dial-date">Feeds · naps · firsts</span>
        </div>
      </div>
      <div className="home-orbit-note home-note-sleep" aria-hidden><span className="home-note-icon"><Icon name="moon" size={23} /></span><span><small>A little rest</small><strong>Nap · 1h 12m</strong></span></div>
      <div className="home-orbit-note home-note-feed" aria-hidden><span className="home-note-icon"><Icon name="bottle" size={24} /></span><span><small>All fed</small><strong>Logged by Dad</strong></span></div>
      <div className="home-orbit-note home-note-moment" aria-hidden><span className="home-note-icon"><Icon name="heart" size={22} /></span><span><small>A little first</small><strong>That tiny smile.</strong></span></div>
      <figcaption className="home-scene-caption">A little day with Maple</figcaption>
    </figure>
  );
}
