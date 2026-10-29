import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppNavProvider, useAppNav } from "../../src/components/maple/AppNav";
import DailyDiscovery from "../../src/components/maple/development/DailyDiscovery";
import DiscoveryPreferences from "../../src/components/maple/development/DiscoveryPreferences";
import MilestonesToNotice from "../../src/components/maple/development/MilestonesToNotice";
import { setNightActive } from "../../src/components/maple/nightLook";
import ActivitySheet from "../../src/components/maple/sheets/ActivitySheet";
import { FixtureContext } from "./mocks";
import { dailyDiscovery } from "../../src/lib/maple/development";
import { DISCOVERIES } from "../../src/lib/maple/guidelines/development";

const MEMBER = { email: "alex@example.test", display_name: "Alex Example", role: "owner" };
const NOW = "2026-10-29T16:00:00.000Z";
const MOMENT = {
  id: 901, kind: "moment", started_at: "2026-10-21T14:00:00.000Z", ended_at: null, active: false,
  data: { milestone: "first-smile", title: "A synthetic smile" }, note: null, source: "app",
  created_by: MEMBER.email, updated_by: null, created_at: NOW, updated_at: NOW,
};

function Contents({ baby, viewer, calls, open }) {
  const nav = useAppNav();
  return <>
    <main className="min-h-screen bg-mp-bg px-4 pt-6 pb-24 text-mp-ink">
      <h1 className="mb-6 text-[30px] font-semibold">{nav.tab === "moments" ? "Moments" : nav.tab === "family" ? "Settings" : "Today"}</h1>
      {nav.tab === "today" && <DailyDiscovery />}
      {nav.tab === "family" && <DiscoveryPreferences />}
      {nav.tab === "moments" && <MilestonesToNotice baby={baby} moments={[MOMENT]} viewer={viewer} onOpen={(entry) => calls.current.push({ kind: "open-moment", id: entry.id })} onAdd={(preset) => open({ kind: "moment", preset })} />}
    </main>
    <nav aria-label="Fixture tabs" className="fixed inset-x-0 bottom-0 flex min-h-[56px] justify-around bg-mp-surface text-mp-ink">
      <button type="button" onClick={() => nav.go("today")}>Today tab</button>
      <button type="button" onClick={() => nav.go("moments")}>Moments tab</button>
      <button type="button" onClick={() => nav.go("family")}>Settings tab</button>
    </nav>
  </>;
}

function App() {
  const options = new URLSearchParams(window.location.search);
  const [clock, setClock] = useState(options.get("now") ?? NOW);
  const [identity, setIdentity] = useState({ family: 99, baby: 99, email: MEMBER.email });
  const [baby, setBaby] = useState({ name: "River Example", nickname: "River", sex: "female", born_at: options.get("born") ?? "2026-10-20T12:00:00.000Z", timezone: options.get("timezone") ?? "America/New_York", settings: options.has("gestation") ? { gestational_age_weeks: Number(options.get("gestation")) } : {} });
  const [theme, setTheme] = useState(options.get("theme") ?? "day");
  const [sheet, setSheet] = useState(null);
  const calls = useRef([]);
  const currentBaby = useRef(baby);
  currentBaby.current = baby;
  const viewer = options.get("role") === "viewer";
  const active = options.has("timer") ? [{ id: 902, kind: options.get("timer"), active: true, data: {}, started_at: clock, ended_at: null }] : [];
  const open = (value) => { calls.current.push({ kind: "sheet", value }); setSheet(value); };
  const refuseWrite = () => { calls.current.push({ kind: "write" }); throw new Error("Unexpected synthetic write"); };
  const maple = {
    state: { baby: { ...baby, id: identity.baby }, family: { id: identity.family }, me: { ...MEMBER, email: identity.email, role: viewer ? "viewer" : "owner" }, members: [MEMBER], entries: [], care: null },
    summary: { active, today: { tummySec: 0 }, targets: { tummyMin: 0 } },
    now: () => new Date(clock), readOnly: viewer, online: true, units: "us", timerBusy: () => false,
    member: () => MEMBER, memberName: () => MEMBER.display_name, memberLabel: () => MEMBER.display_name,
    toast: () => {}, toasts: [], dismissToast: () => {}, log: refuseWrite, update: refuseWrite, remove: refuseWrite,
  };
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme !== "day");
    document.documentElement.classList.toggle("maple-night", theme === "night");
    setNightActive(theme === "night");
  }, [theme]);
  useEffect(() => {
    window.__development = {
      calls: () => calls.current,
      setClock, setTheme,
      setBaby: (value) => setBaby((current) => ({ ...current, ...value })),
      switchIdentity: (value) => setIdentity((current) => ({ ...current, ...value })),
      topicTitles: (topic) => DISCOVERIES.filter((discovery) => discovery.topic === topic).map((discovery) => discovery.title),
      showDiscovery: (id, topic) => {
        const first = Date.parse(currentBaby.current.born_at);
        for (let day = 0; day < 120; day++) {
          const instant = new Date(first + day * 86_400_000);
          if (dailyDiscovery(currentBaby.current, instant, [topic])?.id === id) {
            setClock(instant.toISOString());
            return;
          }
        }
        throw new Error(`No synthetic date for ${id}`);
      },
    };
  }, []);
  return <FixtureContext.Provider value={{ maple, sheets: { open, close: () => setSheet(null), current: sheet } }}>
    <AppNavProvider>
      <Contents baby={maple.state.baby} viewer={viewer} calls={calls} open={open} />
      {sheet?.kind === "tummy" && <ActivitySheet kind="tummy" open entry={sheet.entry} onClose={() => setSheet(null)} />}
    </AppNavProvider>
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
