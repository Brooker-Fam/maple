"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/maple/icons";

type Feature = "feeding" | "sleep" | "diapers" | "growth" | "moments";
const FEATURES: { id: Feature; label: string; icon: IconName; title: string; description: string; hint: string }[] = [
  { id: "feeding", label: "Feeding", icon: "bottle", title: "Find your feeding rhythm.", description: "Nursing, bottles, and pumping. See when feeds happen and how your day takes shape.", hint: "Try adding a feed to this sample day." },
  { id: "sleep", label: "Sleep", icon: "moon", title: "See how sleep unfolds.", description: "Keep track of naps and nights, so the next person on duty knows how the day has gone.", hint: "Start a sample nap. End it when you’re ready." },
  { id: "diapers", label: "Diapers", icon: "droplet", title: "Less to keep in your head.", description: "Wet, dirty, or both. Keep a shared count ready for your next handoff or checkup.", hint: "Tap a button and watch the count change." },
  { id: "growth", label: "Growth", icon: "sprout", title: "Watch their story grow.", description: "Keep measurements together and return to them as your baby grows, from one checkup to the next.", hint: "Choose a moment on the sample growth chart." },
  { id: "moments", label: "Moments", icon: "camera", title: "The firsts you’ll want to keep.", description: "A first bath. A first smile. Save photos and notes for the people sharing these days with you.", hint: "Flip through a few illustrated firsts." },
];

function DemoHeader({ title, icon }: { title: string; icon: IconName }) {
  return <div className="mx-demo-heading"><span className="mx-demo-icon"><Icon name={icon} size={19} /></span><span>{title}</span><span className="mx-demo-baby">June’s log</span></div>;
}

function DemoButton({ children, onClick, secondary = false }: { children: ReactNode; onClick: () => void; secondary?: boolean }) {
  return <button type="button" className={`mx-action${secondary ? " mx-action-secondary" : ""}`} onClick={onClick}>{children}</button>;
}

function FeedingDemo() {
  const [logged, setLogged] = useState(false);
  const total = logged ? 7 : 6;
  return (
    <div className="mx-demo-content">
      <DemoHeader title="A day of feeds" icon="bottle" />
      <div className="mx-feed-dial">
        <svg viewBox="0 0 230 230" aria-hidden="true">
          <circle cx="115" cy="115" r="92" fill="none" stroke="var(--mx-track)" strokeWidth="16" />
          {[8, 57, 112, 163, 224, 282, ...(logged ? [325] : [])].map((angle, index) => <circle key={angle} cx="115" cy="115" r="92" fill="none" stroke={index % 2 ? "var(--mx-gold)" : "var(--mx-peach)"} strokeWidth="16" strokeDasharray="24 555" strokeLinecap="round" transform={`rotate(${angle - 90} 115 115)`} />)}
          {[0, 3, 6, 9].map((hour, i) => <text key={hour} x={[115, 226, 115, 4][i]} y={[8, 119, 229, 119][i]} textAnchor="middle" fill="var(--mx-muted)" fontSize="9">{["12a", "6a", "12p", "6p"][i]}</text>)}
        </svg>
        <div className="mx-dial-center"><strong>{total}</strong><span>feeds logged</span><small>Today</small></div>
      </div>
      <div className="mx-sample-line"><Icon name={logged ? "check" : "clock-3"} size={16} /><span>{logged ? "Sample feed added · 12 minutes" : "Most recent · nursing"}</span></div>
      <DemoButton onClick={() => setLogged(!logged)}><Icon name={logged ? "arrow-left-right" : "plus"} size={17} />{logged ? "Undo sample feed" : "Log a sample feed"}</DemoButton>
      <p className="mx-demo-status" role="status">{logged ? "Added to this demo only." : "Nursing and bottles, together."}</p>
    </div>
  );
}

function SleepDemo() {
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const toggle = () => {
    if (running) { setRunning(false); setFinished(true); }
    else { setSeconds(0); setFinished(false); setRunning(true); }
  };
  return (
    <div className="mx-demo-content">
      <DemoHeader title="Time to rest" icon="moon" />
      <div className={`mx-sleep-scene${running ? " mx-sleep-running" : ""}`} aria-hidden="true">
        <span className="mx-sleep-star mx-star-one">✦</span><span className="mx-sleep-star mx-star-two">✧</span><span className="mx-sleep-star mx-star-three">✦</span>
        <div className="mx-moon"><Icon name="moon" size={90} strokeWidth={1} /></div>
        <div className="mx-sleep-cloud" />
      </div>
      <div className="mx-sleep-time"><strong aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`}>{Math.floor(seconds / 60).toString().padStart(2, "0")}<span>:</span>{(seconds % 60).toString().padStart(2, "0")}</strong><span>{running ? "Sample nap in progress" : finished ? "Sample nap saved" : "Ready for a sample nap"}</span></div>
      <DemoButton onClick={toggle}><Icon name={running ? "sun" : "moon"} size={17} />{running ? "End sample nap" : finished ? "Try another nap" : "Start sample nap"}</DemoButton>
      <p className="mx-demo-status" role="status">{finished ? "Saved in this demo only." : running ? "Timer running. You can end it whenever you like." : "Last sample nap · 1 hour 12 minutes"}</p>
    </div>
  );
}

function DiapersDemo() {
  const [wet, setWet] = useState(4);
  const [dirty, setDirty] = useState(2);
  const [status, setStatus] = useState("Tap to log a sample diaper.");
  const reset = () => { setWet(4); setDirty(2); setStatus("Sample counts reset."); };
  return (
    <div className="mx-demo-content">
      <DemoHeader title="The diaper details" icon="droplet" />
      <div className="mx-diaper-totals">
        <div className="mx-diaper-total mx-wet"><Icon name="droplet" size={35} strokeWidth={1.4} /><strong>{wet}</strong><span>wet diapers</span></div>
        <div className="mx-diaper-total mx-dirty"><Icon name="poop" size={35} strokeWidth={1.4} /><strong>{dirty}</strong><span>dirty diapers</span></div>
      </div>
      <div className="mx-mini-timeline" aria-hidden="true"><span>Today</span><i /><i /><i /><i /><i /><i /><span>Now</span></div>
      <div className="mx-action-pair">
        <DemoButton onClick={() => { setWet(wet + 1); setStatus(`Wet diaper added. ${wet + 1} wet diapers in this demo.`); }}><Icon name="plus" size={16} />Wet</DemoButton>
        <DemoButton onClick={() => { setDirty(dirty + 1); setStatus(`Dirty diaper added. ${dirty + 1} dirty diapers in this demo.`); }} secondary><Icon name="plus" size={16} />Dirty</DemoButton>
      </div>
      <p className="mx-demo-status" role="status">{status}</p>
      <button type="button" className="mx-reset" onClick={reset}>Reset sample counts</button>
    </div>
  );
}

const MEASUREMENTS = [{ label: "Day 3", weight: "3.2", x: 35, y: 147 }, { label: "Week 2", weight: "3.7", x: 150, y: 95 }, { label: "Week 4", weight: "4.2", x: 265, y: 45 }];
function GrowthDemo() {
  const [selected, setSelected] = useState(2);
  const point = MEASUREMENTS[selected];
  return (
    <div className="mx-demo-content">
      <DemoHeader title="Growing over time" icon="sprout" />
      <div className="mx-growth-value" aria-live="polite"><span>{point.label} · sample weight</span><strong>{point.weight}<small>kg</small></strong></div>
      <svg className="mx-growth-chart" viewBox="0 0 300 185" role="img" aria-label="Illustrative weight chart: 3.2 kilograms on day 3, 3.7 kilograms at week 2, and 4.2 kilograms at week 4.">
        {[45, 95, 147].map(y => <line key={y} x1="20" y1={y} x2="280" y2={y} stroke="var(--mx-track)" strokeDasharray="3 6" />)}
        <path d="M35 147C78 147 101 110 150 95S224 49 265 45L265 178H35Z" fill="var(--mx-sage)" opacity=".12" />
        <path d="M35 147C78 147 101 110 150 95S224 49 265 45" fill="none" stroke="var(--mx-sage)" strokeWidth="3" strokeLinecap="round" />
        {MEASUREMENTS.map((p, index) => <g key={p.label}><circle cx={p.x} cy={p.y} r={index === selected ? 13 : 5} fill="var(--mx-sage)" opacity={index === selected ? .18 : 1} /><circle cx={p.x} cy={p.y} r={index === selected ? 5 : 3} fill="var(--mx-sage)" /></g>)}
      </svg>
      <div className="mx-date-choices" aria-label="Sample measurements">{MEASUREMENTS.map((p, i) => <button key={p.label} type="button" aria-pressed={selected === i} onClick={() => setSelected(i)}>{p.label}</button>)}</div>
      <p className="mx-demo-status">Follow measurements from one checkup to the next.</p>
    </div>
  );
}

const MOMENTS = [{ title: "First bath", note: "A splash. A squeak. A warm towel.", date: "Day 12", icon: "bath" as const }, { title: "First smile", note: "The whole room smiled back.", date: "Week 6", icon: "heart" as const }, { title: "Hello, world", note: "The day we met you.", date: "Day 1", icon: "sun" as const }];
function MomentArt({ index }: { index: number }) {
  return (
    <svg viewBox="0 0 280 150" aria-hidden="true" className="mx-moment-art">
      <circle cx="210" cy="35" r="23" fill="currentColor" opacity=".12" />
      <path d="M24 122Q80 99 138 123T265 115" stroke="currentColor" strokeWidth="1" opacity=".2" fill="none" />
      {index === 0 ? <>
        <path d="M78 83h124l-12 36a13 13 0 0 1-12 9h-76a13 13 0 0 1-12-9Z" fill="currentColor" opacity=".22" />
        <path d="M75 83h130M98 128l-4 9m88-9 4 9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M94 82V55c0-16 20-16 20-2" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="136" cy="62" r="16" fill="none" stroke="currentColor" strokeWidth="2" opacity=".6" /><circle cx="166" cy="49" r="9" fill="none" stroke="currentColor" strokeWidth="2" opacity=".4" /><circle cx="178" cy="70" r="5" fill="currentColor" opacity=".4" />
      </> : index === 1 ? <>
        <circle cx="140" cy="76" r="44" fill="currentColor" opacity=".15" />
        <path d="M116 65q6-8 12 0m24 0q6-8 12 0M122 88q18 22 36 0" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="m82 35 3 7 7 3-7 3-3 7-3-7-7-3 7-3Zm111 47 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" fill="currentColor" opacity=".6" />
      </> : <>
        <path d="M87 110a53 53 0 0 1 106 0" fill="currentColor" opacity=".18" />
        <path d="M104 110a36 36 0 0 1 72 0m-59 0a23 23 0 0 1 46 0" stroke="currentColor" strokeWidth="5" fill="none" opacity=".45" />
        <path d="M140 26v13M82 54l10 10m96-10-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="79" cy="95" r="15" fill="var(--mx-card)" /><circle cx="199" cy="103" r="21" fill="var(--mx-card)" />
      </>}
    </svg>
  );
}
function MomentsDemo() {
  const [selected, setSelected] = useState(0);
  const moment = MOMENTS[selected];
  return (
    <div className="mx-demo-content">
      <DemoHeader title="Their firsts" icon="camera" />
      <div className={`mx-memory-card mx-memory-${selected}`} aria-live="polite">
        <MomentArt index={selected} /><div className="mx-memory-caption"><small>{moment.date}</small><h4>{moment.title}</h4><p>{moment.note}</p></div>
      </div>
      <div className="mx-moment-choices" aria-label="Illustrated sample moments">{MOMENTS.map((m, i) => <button key={m.title} type="button" aria-label={`Show ${m.title.toLowerCase()}`} aria-pressed={selected === i} onClick={() => setSelected(i)}><Icon name={m.icon} size={20} /><span>{m.title}</span></button>)}</div>
      <p className="mx-demo-status">In Maple, add your own photos and memories.</p>
    </div>
  );
}

const DEMOS = { feeding: FeedingDemo, sleep: SleepDemo, diapers: DiapersDemo, growth: GrowthDemo, moments: MomentsDemo };

export default function FeatureExplorer() {
  const [active, setActive] = useState<Feature>("feeding");
  const [night, setNight] = useState(false);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const feature = FEATURES.find((item) => item.id === active)!;
  const Demo = DEMOS[active];
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % FEATURES.length;
    else if (event.key === "ArrowLeft") next = (index + FEATURES.length - 1) % FEATURES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FEATURES.length - 1;
    else return;
    event.preventDefault();
    setActive(FEATURES[next].id);
    tabs.current[next]?.focus();
  }
  return (
    <div className="mx-explorer">
      <div className="mx-tabs" role="tablist" aria-label="Explore Maple features">{FEATURES.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-selected={active === item.id} aria-controls={`${id}-panel`} tabIndex={active === item.id ? 0 : -1} ref={el => { tabs.current[index] = el; }} onClick={() => setActive(item.id)} onKeyDown={event => onTabKey(event, index)}><Icon name={item.icon} size={20} /><span>{item.label}</span></button>)}</div>
      <div className="mx-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${active}`} tabIndex={0}>
        <div className="mx-feature-copy">
          <span className="mx-feature-number">0{FEATURES.findIndex(f => f.id === active) + 1} / 05</span>
          <h3>{feature.title}</h3>
          <p>{feature.description}</p>
          <div className="mx-try-hint"><Icon name="arrow-right" size={20} /><span>{feature.hint}</span></div>
        </div>
        <div className={`mx-stage mx-stage-${active}${night ? " mx-night" : ""}`}>
          <div className="mx-stage-bar"><span>Interactive demo</span><button type="button" className="mx-night-toggle" aria-label="Night preview" aria-pressed={night} onClick={() => setNight(!night)}><Icon name={night ? "moon" : "sun"} size={16} /><span>{night ? "Night" : "Day"}</span></button></div>
          <div className="mx-demo-window"><Demo key={active} /></div>
        </div>
      </div>
    </div>
  );
}
