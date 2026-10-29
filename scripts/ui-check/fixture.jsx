import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DoseTimeSheet from "../../src/components/maple/care/DoseTimeSheet";
import RecentDoses from "../../src/components/maple/care/RecentDoses";
import EntryRow, { entryEditPreset } from "../../src/components/maple/EntryRow";
import { MomentEditor } from "../../src/components/maple/FeedParts";
import FixTimesSheet from "../../src/components/maple/sheets/FixTimesSheet";
import { Button, Sheet, ToastHost, tone } from "../../src/components/maple/ui";
import { feedCtx, moveEdge, switchTo } from "../../src/lib/maple/feed";
import { formatTime } from "../../src/lib/maple/time";
import { ApiError, FixtureContext } from "./mocks";

const TZ = "America/New_York";
const INITIAL_NOW = "2026-10-28T13:30:00.000Z";
const iso = (clock) => `2026-10-28T${clock}:00.000Z`;
const initialDoses = () => [
  { id: 101, kind: "dose", med_id: 1, at: iso("12:00"), data: { name: "Example medicine", units: 2, unit: "tablets", dose: "Example label", skipped: false }, note: "Synthetic note to preserve", private: false, source: "web", created_by: "sam@example.test", updated_by: null, created_at: iso("12:00"), updated_at: iso("12:00") },
  { id: 102, kind: "dose", med_id: null, at: iso("03:50"), data: { name: "One-time example with a longer medicine name", units: null, dose: null }, note: null, private: false, source: "web", created_by: "sam@example.test", updated_by: null, created_at: iso("03:50"), updated_at: iso("03:50") },
];
const initialFeed = () => ({
  id: 201, kind: "feed", started_at: iso("12:45"), ended_at: iso("13:15"), active: false,
  data: { method: "breast", first_side: "L", last_side: "R", segments: [
    { side: "L", start: iso("12:45"), end: iso("12:55") },
    { side: "R", start: iso("13:00"), end: iso("13:15") },
  ] },
  note: null, source: "web", created_by: "sam@example.test", updated_by: null, created_at: iso("12:45"), updated_at: iso("13:15"),
});
const initialActiveFeed = () => {
  const entry = initialFeed();
  return { ...entry, id: 202, active: true, ended_at: null, updated_at: iso("13:00"), data: { ...entry.data, segments: [entry.data.segments[0], { ...entry.data.segments[1], end: null }] } };
};
const initialHistoricalFeed = () => {
  const entry = initialFeed();
  const previous = (at) => new Date(Date.parse(at) - 5 * 86400_000).toISOString();
  return { ...entry, id: 203, started_at: previous(entry.started_at), ended_at: previous(entry.ended_at), created_at: previous(entry.created_at), updated_at: previous(entry.updated_at), note: "Historical example note", data: { ...entry.data, segments: entry.data.segments.map((part) => ({ ...part, start: previous(part.start), end: previous(part.end) })) } };
};

function App() {
  const [doses, setDoses] = useState(initialDoses);
  const [feed, setFeed] = useState(initialFeed);
  const [now, setNow] = useState(() => new Date(INITIAL_NOW));
  const [target, setTarget] = useState(null);
  const [nursing, setNursing] = useState(false);
  const [activeNursing, setActiveNursing] = useState(false);
  const [activeFeed, setActiveFeed] = useState(initialActiveFeed);
  const [savedNursing, setSavedNursing] = useState(false);
  const [history, setHistory] = useState([]);
  const [historicalFeed, setHistoricalFeed] = useState(initialHistoricalFeed);
  const [historicalLoaded, setHistoricalLoaded] = useState(false);
  const [routedSheet, setRoutedSheet] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const [sequence, setSequence] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [page, setPage] = useState("care");
  const latest = useRef({ doses, feed, activeFeed, historicalFeed, now });
  const sheetTargets = useRef([]);
  const calls = useRef([]);
  const failNext = useRef(false);
  const timerFailure = useRef(null);
  const version = useRef(0);
  latest.current = { doses, feed, activeFeed, historicalFeed, now };

  const message = (text, undo) => setToasts([{ id: ++version.current, text, tone: "ok", undo }]);
  const editDoseTime = async (base, at) => {
    calls.current.push({ id: base.id, at, expect_updated_at: base.updated_at });
    if (failNext.current) { failNext.current = false; throw new TypeError("offline fixture"); }
    const current = latest.current.doses.find((d) => d.id === base.id);
    if (!current || current.updated_at !== base.updated_at) throw new ApiError(409, "This dose changed. Use the latest time.");
    const saved = { ...current, at, updated_at: new Date(Date.parse(INITIAL_NOW) + ++version.current * 1000).toISOString() };
    setDoses((all) => all.map((d) => d.id === saved.id ? saved : d));
    message(`Time saved as ${formatTime(at, TZ)}.`, () => {
      const live = latest.current.doses.find((d) => d.id === saved.id);
      if (live?.updated_at === saved.updated_at) setDoses((all) => all.map((d) => d.id === saved.id ? { ...d, at: current.at, updated_at: new Date(Date.parse(INITIAL_NOW) + ++version.current * 1000).toISOString() } : d));
    });
    return saved;
  };
  const openDoseTime = (dose) => { setTarget(dose); setSequence((n) => n + 1); };
  const care = { access: { write: true }, state: { entries: doses }, act: { editDoseTime } };
  const maple = {
    state: { baby: { name: "River", nickname: null, sex: "female", timezone: TZ }, family: { id: 99, care_name: "Sam", ask: "an owner" }, entries: [feed, activeFeed, ...history, ...(historicalLoaded ? [historicalFeed] : [])], me: { email: "sam@example.test" } },
    now: () => latest.current.now,
    refresh: async () => {},
    readOnly,
    units: "us",
    member: () => ({ name: "Sam", email: "sam@example.test" }),
    timerBusy: () => false,
    memberLabel: () => "Sam",
    whoDiscarded: async () => null,
    toasts,
    dismissToast: (id) => setToasts((all) => all.filter((t) => t.id !== id)),
  };
  useEffect(() => {
    window.__mapleUiFixture = {
      snapshot: () => ({ ...latest.current, calls: calls.current, sheetTargets: sheetTargets.current }),
      failNextSave: () => { failNext.current = true; },
      changeElsewhere: () => setDoses((all) => all.map((d) => d.id === 101 ? { ...d, at: iso("12:10"), updated_at: iso("13:29") } : d)),
      setNow: (at) => setNow(new Date(at)),
      setReadOnly,
      historicalFailure: (kind) => { timerFailure.current = kind; },
      evictHistorical: () => setHistoricalLoaded(false),
      nursingScenario: (kind = "switch") => {
        const saved = initialFeed();
        if (kind === "switch") {
          saved.data.segments[0].end = iso("13:05");
          saved.data.segments[1].start = iso("13:05");
        }
        const active = { ...saved, id: 202, active: true, ended_at: null, data: { ...saved.data, segments: saved.data.segments.map((s, i) => i === 1 ? { ...s, end: null } : { ...s }) } };
        if (kind === "paused") active.data.segments = [{ ...saved.data.segments[0] }];
        setFeed(saved);
        setActiveFeed(active);
        setNow(new Date(INITIAL_NOW));
        // Four previous ten-minute sides give the real preset selector a usual duration.
        setHistory([0, 1, 2, 3].map((i) => {
          const start = kind === "last-feed" && i === 0 ? iso("12:28") : new Date(Date.parse(iso("10:00")) - i * 3600_000).toISOString();
          const end = new Date(Date.parse(start) + 10 * 60_000).toISOString();
          return { ...saved, id: 300 + i, started_at: start, ended_at: end, data: { ...saved.data, segments: [{ side: "L", start, end }] } };
        }));
        calls.current = [];
        setToasts([]);
      },
    };
  }, []);
  const saveNursing = (to) => {
    const before = feed;
    const moved = moveEdge(feed.data, { edge: "side_end", ref: { side: "L", start: iso("12:45") }, to }, feedCtx(feed, now));
    setFeed({ ...feed, data: moved.data, started_at: moved.startedAt, ended_at: moved.endedAt });
    setNursing(false);
    message(`Left ended at ${formatTime(to, TZ)}.`, () => setFeed(before));
  };
  const retime = async (entry, edit, options = {}) => {
    const before = entry.id === 203 ? latest.current.historicalFeed : entry.id === 202 ? latest.current.activeFeed : latest.current.feed;
    if (timerFailure.current) {
      const failure = timerFailure.current;
      timerFailure.current = null;
      if (failure === "gone") {
        options.onError?.({ kind: "gone", who: "Alex", message: "Alex discarded this feed" });
        return null;
      }
      const end = new Date(Date.parse(before.ended_at) + 2 * 60_000).toISOString();
      const newer = { ...before, ended_at: end, updated_at: new Date(Date.parse(INITIAL_NOW) + ++version.current * 1000).toISOString(), data: { ...before.data, segments: before.data.segments.map((s, i, all) => i === all.length - 1 ? { ...s, end } : s) } };
      setHistoricalFeed(newer);
      setHistoricalLoaded(true);
      options.onError?.({ kind: "changed", who: "Alex", message: "Alex just changed this feed", entry: newer });
      return null;
    }
    const moved = moveEdge(before.data, { ...edit, to: new Date(edit.to) }, feedCtx(before, latest.current.now));
    const saved = { ...before, data: moved.data, started_at: moved.startedAt, ended_at: moved.endedAt, updated_at: new Date(Date.parse(INITIAL_NOW) + ++version.current * 1000).toISOString() };
    calls.current.push({ timer: true, id: entry.id, edit });
    if (entry.id === 203) setHistoricalFeed(saved);
    else if (entry.id === 202) setActiveFeed(saved);
    else setFeed(saved);
    return { entry: saved };
  };
  const resume = async (entry, side, at) => {
    const before = latest.current.activeFeed;
    const changed = switchTo(before.data, side, at, { explicit: true, now: latest.current.now });
    const saved = { ...before, data: changed.data, updated_at: new Date(Date.parse(INITIAL_NOW) + ++version.current * 1000).toISOString() };
    calls.current.push({ timer: true, action: "resume", id: entry.id, side, at: at.toISOString() });
    setActiveFeed(saved);
    return { entry: saved };
  };
  // The application router is the fixture boundary: actual EntryRow presets
  // and actual FixTimesSheet actions select which real editor to show. The
  // full-details marker only records that navigation and its exact entry.
  const sheets = {
    open: (next) => { sheetTargets.current.push(next); setRoutedSheet(next); },
    close: () => setRoutedSheet(null),
    current: routedSheet,
  };

  return (
    <FixtureContext.Provider value={{ maple, care, nav: { openDoseTime }, now, sheets, timerActions: { retime, resume } }}>
      <main className="mx-auto min-h-screen max-w-md space-y-6 px-4 py-6 pb-32">
        <header><p className="text-[13px] text-mp-ink-2">Example family · synthetic records</p><h1 className="mt-1 text-[32px] font-semibold text-mp-ink">{page === "care" ? "Sam" : "Nursing"}</h1></header>
        <nav className="flex flex-wrap gap-2" aria-label="Fixture views">
          <Button variant={page === "care" ? "primary" : "soft"} onClick={() => setPage("care")}>Medicines</Button>
          <Button variant={page === "nursing" ? "primary" : "soft"} onClick={() => setPage("nursing")}>Nursing</Button>
          <Button variant={page === "history" ? "primary" : "soft"} onClick={() => setPage("history")}>History</Button>
        </nav>
        {page === "care" ? <RecentDoses care={care} /> : page === "history" ? (
          <section aria-label="Example log" className={`${tone.card} p-2`}>
            <EntryRow entry={feed} now={now} onClick={() => sheets.open({ kind: feed.kind, entry: feed, preset: entryEditPreset(feed) })} />
            <EntryRow entry={historicalFeed} now={now} onClick={() => sheets.open({ kind: historicalFeed.kind, entry: historicalFeed, preset: entryEditPreset(historicalFeed) })} />
          </section>
        ) : (
          <section className={`${tone.card} space-y-3 p-4`}>
            <h2 className="text-[17px] font-semibold text-mp-ink">Recently logged</h2>
            <p className="text-mp-ink">Left: {formatTime(feed.data.segments[0].start, TZ)}–{formatTime(feed.data.segments[0].end, TZ)}</p>
            <p className="text-mp-ink-2">Right: {formatTime(feed.data.segments[1].start, TZ)}–{formatTime(feed.data.segments[1].end, TZ)}</p>
            <Button variant="ghost" onClick={() => setNursing(true)}>Edit left end time</Button>
            <Button variant="ghost" onClick={() => setActiveNursing(true)}>Edit active nursing times</Button>
            <Button variant="ghost" onClick={() => setSavedNursing(true)}>Edit saved nursing times</Button>
            <Button variant="ghost" onClick={() => sheets.open({ kind: "feed", entry: feed, preset: { fix: { target: { breakAfter: { side: "L", start: feed.data.segments[0].start } } } } })}>Edit completed break</Button>
          </section>
        )}
        {target && <DoseTimeSheet key={sequence} open onClose={() => setTarget(null)} dose={target} />}
        {nursing && <Sheet open calm onClose={() => setNursing(false)} title="Edit nursing time" subtitle="Left ended">
          <MomentEditor entry={feed} tz={TZ} edge={{ edge: "side_end", ref: { side: "L", start: iso("12:45") } }} mode="commit" onSave={saveNursing} onCancel={() => setNursing(false)} />
        </Sheet>}
        {activeNursing && <FixTimesSheet open kind="feed" entry={activeFeed} preset={{ fix: { target: "current" } }} onClose={() => setActiveNursing(false)} />}
        {savedNursing && <FixTimesSheet open kind="feed" entry={feed} preset={{ fix: { target: "finish" } }} onClose={() => setSavedNursing(false)} />}
        {routedSheet?.preset?.fix && <FixTimesSheet key={`history-${routedSheet.entry.id}`} open {...routedSheet} onClose={sheets.close} />}
        {routedSheet && !routedSheet.preset?.fix && <Sheet open title="Feed details" onClose={sheets.close}>
          <p>Opened details for example entry {routedSheet.entry.id}</p>
          <p>{routedSheet.entry.note}</p>
        </Sheet>}
      </main>
      <ToastHost />
    </FixtureContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
