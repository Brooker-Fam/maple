import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DoseTimeSheet from "../../src/components/maple/care/DoseTimeSheet";
import RecentDoses from "../../src/components/maple/care/RecentDoses";
import { MomentEditor } from "../../src/components/maple/FeedParts";
import FixTimesSheet from "../../src/components/maple/sheets/FixTimesSheet";
import { Button, Sheet, ToastHost, tone } from "../../src/components/maple/ui";
import { feedCtx, moveEdge } from "../../src/lib/maple/feed";
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

function App() {
  const [doses, setDoses] = useState(initialDoses);
  const [feed, setFeed] = useState(initialFeed);
  const [now, setNow] = useState(() => new Date(INITIAL_NOW));
  const [target, setTarget] = useState(null);
  const [nursing, setNursing] = useState(false);
  const [activeNursing, setActiveNursing] = useState(false);
  const activeFeed = useRef(initialActiveFeed()).current;
  const [sequence, setSequence] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [page, setPage] = useState("care");
  const latest = useRef({ doses, feed, activeFeed, now });
  const calls = useRef([]);
  const failNext = useRef(false);
  const version = useRef(0);
  latest.current = { doses, feed, activeFeed, now };

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
    state: { baby: { name: "River", nickname: null, sex: "female", timezone: TZ }, family: { id: 99, care_name: "Sam", ask: "an owner" }, entries: [feed, activeFeed], me: { email: "sam@example.test" } },
    now: () => latest.current.now,
    refresh: async () => {},
    readOnly: false,
    timerBusy: () => false,
    memberLabel: () => "Sam",
    whoDiscarded: async () => null,
    toasts,
    dismissToast: (id) => setToasts((all) => all.filter((t) => t.id !== id)),
  };
  useEffect(() => {
    window.__mapleUiFixture = {
      snapshot: () => ({ ...latest.current, calls: calls.current }),
      failNextSave: () => { failNext.current = true; },
      changeElsewhere: () => setDoses((all) => all.map((d) => d.id === 101 ? { ...d, at: iso("12:10"), updated_at: iso("13:29") } : d)),
      setNow: (at) => setNow(new Date(at)),
    };
  }, []);
  const saveNursing = (to) => {
    const before = feed;
    const moved = moveEdge(feed.data, { edge: "end", ref: { side: "L", start: iso("12:45") }, to }, feedCtx(feed, now));
    setFeed({ ...feed, data: moved.data, started_at: moved.startedAt, ended_at: moved.endedAt });
    setNursing(false);
    message(`Left ended at ${formatTime(to, TZ)}.`, () => setFeed(before));
  };

  return (
    <FixtureContext.Provider value={{ maple, care, nav: { openDoseTime }, now, timerActions: { retime: async () => { calls.current.push({ timer: true }); return { entry: activeFeed }; } } }}>
      <main className="mx-auto min-h-screen max-w-md space-y-6 px-4 py-6 pb-32">
        <header><p className="text-[13px] text-mp-ink-2">Example family · synthetic records</p><h1 className="mt-1 text-[32px] font-semibold text-mp-ink">{page === "care" ? "Sam" : "Nursing"}</h1></header>
        <nav className="flex gap-2" aria-label="Fixture views">
          <Button variant={page === "care" ? "primary" : "soft"} onClick={() => setPage("care")}>Medicines</Button>
          <Button variant={page === "nursing" ? "primary" : "soft"} onClick={() => setPage("nursing")}>Nursing</Button>
        </nav>
        {page === "care" ? <RecentDoses care={care} /> : (
          <section className={`${tone.card} space-y-3 p-4`}>
            <h2 className="text-[17px] font-semibold text-mp-ink">Recently logged</h2>
            <p className="text-mp-ink">Left: {formatTime(feed.data.segments[0].start, TZ)}–{formatTime(feed.data.segments[0].end, TZ)}</p>
            <p className="text-mp-ink-2">Right: {formatTime(feed.data.segments[1].start, TZ)}–{formatTime(feed.data.segments[1].end, TZ)}</p>
            <Button variant="ghost" onClick={() => setNursing(true)}>Edit left end time</Button>
            <Button variant="ghost" onClick={() => setActiveNursing(true)}>Edit active nursing times</Button>
          </section>
        )}
        {target && <DoseTimeSheet key={sequence} open onClose={() => setTarget(null)} dose={target} />}
        {nursing && <Sheet open calm onClose={() => setNursing(false)} title="Edit nursing time" subtitle="Left ended">
          <MomentEditor entry={feed} tz={TZ} edge={{ edge: "end", ref: { side: "L", start: iso("12:45") } }} mode="commit" onSave={saveNursing} onCancel={() => setNursing(false)} />
        </Sheet>}
        {activeNursing && <FixTimesSheet open kind="feed" entry={activeFeed} preset={{ fix: { target: "current" } }} onClose={() => setActiveNursing(false)} />}
      </main>
      <ToastHost />
    </FixtureContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
