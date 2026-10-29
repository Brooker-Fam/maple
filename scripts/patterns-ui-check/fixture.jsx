import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import PatternsTab, { requestGrowthChart } from "../../src/components/maple/PatternsTab";
import HistoryTab from "../../src/components/maple/HistoryTab";
import { AppNavProvider, useAppNav } from "../../src/components/maple/AppNav";
import { Sheet } from "../../src/components/maple/Sheet";
import { setNightActive } from "../../src/components/maple/nightLook";
import { addDays, dayBounds, dayKey, daysBetween, parseDayKey, zonedTimeToUtc } from "../../src/lib/maple/time";
import { FixtureContext } from "./mocks";

const query = new URLSearchParams(window.location.search);
const NOW = query.get("now") ?? "2026-10-29T16:00:00.000Z";
const TZ = "America/New_York";
const TODAY = dayKey(new Date(NOW), TZ);
const LATEST_WEEK_FROM = addDays(TODAY, -((new Date(`${TODAY}T12:00:00Z`).getUTCDay() + 6) % 7));
const MEMBER = { email: "alex@example.test", display_name: "Alex Example", role: query.has("viewer") ? "viewer" : "owner" };
const now = () => new Date(NOW);
const entries = [];
let nextId = 900;
function add(kind, date, start, end, data) {
  const { year, month, day } = parseDayKey(date);
  const instant = (clock) => { const [hour, minute] = clock.split(":").map(Number); return zonedTimeToUtc(year, month, day, hour, minute, TZ).toISOString(); };
  entries.push({ id: ++nextId, kind, started_at: instant(start), ended_at: end ? instant(end) : null,
    active: false, data, note: null, source: "app", created_by: MEMBER.email,
    updated_by: null, created_at: NOW, updated_at: NOW });
}
// Oct 26 is deliberately blank; a gap must not be described as care that did not happen.
for (const offset of query.has("longHistory") ? Array.from({ length: 28 }, (_, i) => -i).filter((i) => i !== -3) : [-6, -5, -4, -2, -1, 0]) {
  const date = addDays(TODAY, offset);
  add("feed", date, "06:00", "06:20", { method: "breast", left_sec: 1200, right_sec: 0, first_side: "L" });
  add("feed", date, "10:00", null, { method: "bottle", amount_ml: 60 });
  add("sleep", date, "00:00", "03:00", {});
  add("diaper", date, "09:00", null, { pee: true, poop: true, color: "mustard" });
}
// A real midnight boundary: yesterday's sleep contributes an hour to each date.
entries.push({ ...entries[0], id: ++nextId, kind: "sleep", started_at: new Date(dayBounds(TODAY, TZ)[0].getTime() - 3600_000).toISOString(), ended_at: new Date(dayBounds(TODAY, TZ)[0].getTime() + 3600_000).toISOString(), data: {} });
if (query.has("extraTotals") || query.has("pumpOnly") || query.has("tummyOnly")) {
  if (query.has("pumpOnly") || query.has("tummyOnly")) entries.splice(0);
  if (!query.has("tummyOnly")) add("pump", TODAY, "08:00", "08:15", { total_ml: 90 });
  if (!query.has("pumpOnly")) add("tummy", TODAY, "08:30", "08:40", {});
}
if (query.has("shortSleep")) {
  entries.splice(0);
  add("sleep", TODAY, "08:00", null, {});
  entries[0].ended_at = new Date(Date.parse(entries[0].started_at) + 30_000).toISOString();
}
if (query.has("sleepCarry") || query.has("nurseCarry")) {
  entries.splice(0);
  const midnight = dayBounds(TODAY, TZ)[0].getTime();
  const minutes = query.has("sleepCarry") ? 60 : 10;
  const start = new Date(midnight - minutes * 60_000).toISOString();
  const end = new Date(midnight + minutes * 60_000).toISOString();
  add(query.has("sleepCarry") ? "sleep" : "feed", addDays(TODAY, -1), "23:00", null,
    query.has("sleepCarry") ? {} : { method: "breast", first_side: "L", segments: [{ side: "L", start, end }] });
  entries[0].started_at = start;
  entries[0].ended_at = end;
}
if (query.has("empty")) entries.splice(0);

function HistoryShell() {
  const nav = useAppNav();
  return nav.tab === "history" ? <HistoryTab /> : null;
}

function App() {
  const calls = useRef([]);
  const records = useRef(entries);
  const [revision, setRevision] = useState(1);
  const [snapshotNow, setSnapshotNow] = useState(NOW);
  const [sheet, setSheet] = useState(null);
  const heldDays = useRef(new Set());
  const delayed = useRef(new Map());
  const failHistory = useRef(query.has("historyError"));
  const failRange = useRef(query.has("rangeError"));
  const failRecent = useRef(query.has("missingRecent"));
  const failOlder = useRef(query.has("missingOlder"));
  const truncateDay = useRef(query.get("truncatedDay"));
  const api = useCallback(async (path, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Fixture refuses writes");
    calls.current.push({ kind: "api", path });
    const url = new URL(path, "https://maple-patterns.example.test/");
    if (!url.pathname.endsWith("/entries")) throw new Error(`Unexpected API: ${path}`);
    if (path.startsWith("/api/maple/entries?") && failRange.current) throw new Error("Synthetic range failure");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const historical = from && to && to < addDays(TODAY, -1) && daysBetween(from, to) <= 1;
    if (historical && failHistory.current) throw new Error("Synthetic history failure");
    if (path.startsWith("/api/maple/entries?") && failRecent.current && from <= TODAY && to >= TODAY) throw new Error("Synthetic latest week failure");
    if (path.startsWith("/api/maple/entries?") && failOlder.current && from < LATEST_WEEK_FROM) throw new Error("Synthetic previous week failure");
    const lo = from ? dayBounds(from, "America/New_York")[0].getTime() : -Infinity;
    const hi = to ? dayBounds(to, "America/New_York")[1].getTime() : Infinity;
    const selected = records.current.filter((entry) => Date.parse(entry.started_at) < hi && Date.parse(entry.ended_at ?? entry.started_at) >= lo);
    const truncated = !!truncateDay.current && from <= truncateDay.current && to >= truncateDay.current;
    const response = { entries: truncated && from === to ? selected.slice(0, 1) : selected, truncated };
    if (historical && heldDays.current.has(to)) return await new Promise((resolve) => {
      const pending = delayed.current.get(to) ?? [];
      delayed.current.set(to, [...pending, () => resolve(response)]);
    });
    return response;
  }, []);
  const maple = {
    state: {
      family: { id: 99, ask: "an owner" },
      baby: { id: 99, name: "River Example", nickname: "River", sex: "female", timezone: TZ, born_at: query.has("noBirthDate") ? null : query.get("born") ?? new Date(dayBounds(addDays(TODAY, -28), TZ)[0].getTime() + 12 * 3600_000).toISOString(), settings: { show_alerts: false } },
      me: MEMBER, members: [MEMBER], entries: query.has("missingRecent") ? [] : records.current.filter((entry) => Date.parse(entry.ended_at ?? entry.started_at) >= Date.parse(NOW) - 72 * 3600_000),
      growth: [], care: null, now: snapshotNow, rev: `synthetic-${revision}`,
    },
    summary: { targets: null, age: { days: 28, dayOfLife: 29 }, teamDiapers: 0 },
    api, now, readOnly: MEMBER.role === "viewer", online: true, units: query.has("metric") ? "metric" : "us", isNight: () => false,
    member: () => MEMBER, memberName: () => MEMBER.display_name, memberLabel: () => MEMBER.display_name,
    toast: () => {}, toasts: [], dismissToast: () => {},
    log: () => { throw new Error("Unexpected log write"); }, update: () => { throw new Error("Unexpected log write"); }, remove: () => { throw new Error("Unexpected log write"); },
  };
  useEffect(() => {
    window.__patterns = {
      calls: () => calls.current,
      entries: () => records.current,
      replaceEntries: (value) => { records.current = value; setRevision((revision) => revision + 1); },
      snapshot: (at, value) => { records.current = value; setSnapshotNow(at); setRevision((revision) => revision + 1); },
      updateEntry: (id, patch) => { records.current = records.current.map((entry) => entry.id === id ? { ...entry, ...patch, updated_at: new Date(Date.parse(NOW) + 1000).toISOString() } : entry); setRevision((value) => value + 1); },
      removeEntry: (id) => { records.current = records.current.filter((entry) => entry.id !== id); setRevision((value) => value + 1); },
      allowRange: () => { failRange.current = false; failRecent.current = false; failOlder.current = false; truncateDay.current = null; },
      allowHistory: () => { failHistory.current = false; },
      failHistory: () => { failHistory.current = true; setRevision((value) => value + 1); },
      holdDay: (day) => { heldDays.current.add(day); },
      releaseDay: (day) => { heldDays.current.delete(day); for (const resolve of delayed.current.get(day) ?? []) resolve(); delayed.current.delete(day); },
      growth: requestGrowthChart,
      night: (value) => { document.documentElement.classList.toggle("maple-night", value); document.documentElement.classList.toggle("dark", value); setNightActive(value); },
    };
  }, []);
  return <FixtureContext.Provider value={{ maple,
    careNav: { openDoctor: () => calls.current.push({ kind: "doctor" }), openHelp: () => {}, openCare: () => {}, openSupport: () => {} },
    sheets: { open: (value) => { calls.current.push({ kind: "sheet", value }); if (query.has("realSheet")) setSheet(value); }, close: () => setSheet(null), current: sheet },
  }}>
    <main className="mx-auto max-w-lg bg-mp-bg pb-8">
      {query.has("historyShell") ? <AppNavProvider><HistoryShell /></AppNavProvider> : <PatternsTab onNavigate={(target) => calls.current.push({ kind: "navigate", target })} />}
    </main>
    {query.has("realSheet") && <Sheet open={!!sheet} onClose={() => setSheet(null)} title="Edit recorded entry"><button type="button" onClick={() => setSheet(null)}>Cancel</button></Sheet>}
  </FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<App />);
