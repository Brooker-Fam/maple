import { useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import PatternsTab, { requestGrowthChart } from "../../src/components/maple/PatternsTab";
import { setNightActive } from "../../src/components/maple/nightLook";
import { dayBounds } from "../../src/lib/maple/time";
import { FixtureContext } from "./mocks";

const NOW = "2026-10-29T16:00:00.000Z";
const MEMBER = { email: "alex@example.test", display_name: "Alex Example", role: "owner" };
const now = () => new Date(NOW);
const entries = [];
let nextId = 900;
function add(kind, date, start, end, data) {
  entries.push({ id: ++nextId, kind, started_at: `${date}T${start}:00-04:00`, ended_at: end ? `${date}T${end}:00-04:00` : null,
    active: false, data, note: null, source: "app", created_by: MEMBER.email,
    updated_by: null, created_at: NOW, updated_at: NOW });
}
// Oct 26 is deliberately blank; a gap must not be described as care that did not happen.
for (const day of [23, 24, 25, 27, 28, 29]) {
  const date = `2026-10-${day}`;
  add("feed", date, "06:00", "06:20", { method: "breast", left_sec: 1200, right_sec: 0, first_side: "L" });
  add("feed", date, "10:00", null, { method: "bottle", amount_ml: 60 });
  add("sleep", date, "00:00", "03:00", {});
  add("diaper", date, "09:00", null, { pee: true, poop: true, color: "mustard" });
}
// A real midnight boundary: yesterday's sleep contributes an hour to each date.
entries.push({ ...entries[0], id: ++nextId, kind: "sleep", started_at: "2026-10-28T23:00:00-04:00", ended_at: "2026-10-29T01:00:00-04:00", data: {} });

function App() {
  const calls = useRef([]);
  const failHistory = useRef(new URLSearchParams(window.location.search).has("historyError"));
  const failRange = useRef(new URLSearchParams(window.location.search).has("rangeError"));
  const api = useCallback(async (path, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Fixture refuses writes");
    calls.current.push({ kind: "api", path });
    const url = new URL(path, "https://maple-patterns.example.test/");
    if (!url.pathname.endsWith("/entries")) throw new Error(`Unexpected API: ${path}`);
    if (path.startsWith("entries?") && failHistory.current) throw new Error("Synthetic history failure");
    if (path.startsWith("/api/maple/entries?") && failRange.current) throw new Error("Synthetic range failure");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const lo = from ? dayBounds(from, "America/New_York")[0].getTime() : -Infinity;
    const hi = to ? dayBounds(to, "America/New_York")[1].getTime() : Infinity;
    return { entries: entries.filter((entry) => Date.parse(entry.started_at) < hi && Date.parse(entry.ended_at ?? entry.started_at) >= lo) };
  }, []);
  const maple = {
    state: {
      family: { id: 99, ask: "an owner" },
      baby: { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: { show_alerts: false } },
      me: MEMBER, members: [MEMBER], entries: entries.filter((entry) => Date.parse(entry.ended_at ?? entry.started_at) >= Date.parse(NOW) - 72 * 3600_000),
      growth: [], care: null, now: NOW, rev: "synthetic-1",
    },
    summary: { targets: null, age: { days: 28, dayOfLife: 29 }, teamDiapers: 0 },
    api, now, readOnly: false, online: true, units: "us", isNight: () => false,
    member: () => MEMBER, memberName: () => MEMBER.display_name, memberLabel: () => MEMBER.display_name,
    toast: () => {}, toasts: [], dismissToast: () => {},
    log: () => { throw new Error("Unexpected log write"); }, update: () => { throw new Error("Unexpected log write"); }, remove: () => { throw new Error("Unexpected log write"); },
  };
  useEffect(() => {
    window.__patterns = {
      calls: () => calls.current,
      allowHistory: () => { failHistory.current = false; },
      growth: requestGrowthChart,
      night: (value) => { document.documentElement.classList.toggle("maple-night", value); document.documentElement.classList.toggle("dark", value); setNightActive(value); },
    };
  }, []);
  return <FixtureContext.Provider value={{ maple,
    careNav: { openDoctor: () => calls.current.push({ kind: "doctor" }), openHelp: () => {}, openCare: () => {}, openSupport: () => {} },
    sheets: { open: (value) => calls.current.push({ kind: "sheet", value }), close: () => {}, current: null },
  }}>
    <main className="mx-auto max-w-xl bg-mp-bg pb-8"><PatternsTab onNavigate={(target) => calls.current.push({ kind: "navigate", target })} /></main>
  </FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
