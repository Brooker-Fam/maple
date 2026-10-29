import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import Lantern from "../../src/components/maple/Lantern";
import { Sheet } from "../../src/components/maple/Sheet";
import { FixtureContext } from "./mocks";

const now = new Date("2026-10-28T13:30:00.000Z");
const params = new URLSearchParams(location.search);
const since = params.has("long") ? "2026-10-28T12:00:00.000Z" : "2026-10-28T13:25:00.000Z";
const kind = params.has("sleep") ? "sleep" : "feed";
const segments = params.has("both-row") ? [
  { side: "L", start: "2026-10-28T13:15:00.000Z", end: "2026-10-28T13:20:00.000Z" },
  { side: "R", start: "2026-10-28T13:20:00.000Z", end: since },
  { side: "L", start: since, end: null },
] : [{ side: "L", start: since, end: null }];
const entry = {
  id: 99, kind, started_at: segments[0].start, ended_at: null, active: true,
  data: kind === "feed" ? { method: "breast", first_side: "L", last_side: "L", segments } : {}, note: null,
  created_by: "sam@example.test", updated_at: since, source: "web",
};

function Fixture() {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(null);
  const calls = useRef([]);
  const act = (action) => async () => { calls.current.push(action); return entry; };
  const maple = {
    state: { baby: { name: "River", sex: null, timezone: "UTC", settings: {} }, family: { id: 99 }, entries: [entry] },
    now: () => now, readOnly: false, toasts: [],
  };
  const care = params.has("care") ? {
    name: "Sam", self: true, access: { write: true },
    todayLine: { held: false, view: { plan: { id: 7, name: "Example medicine", also_called: null }, oneTap: "save", glance: { ready: true, text: "OK now" } } },
    held: () => null,
    act: { tookIt: async () => { calls.current.push("dose"); return "saved"; } },
  } : null;
  useEffect(() => {
    window.__lantern = { calls: () => [...calls.current], close: () => setOpen(false) };
  }, []);
  return <FixtureContext.Provider value={{
    maple, now, care,
    actions: { pause: act("pause"), resume: act("resume"), switchSide: act("switch"), stop: act("stop"), backAndForth: act("both") },
    sheets: { open: setSheet },
  }}>
    <main>
      <button type="button" onClick={() => setOpen(true)}>Open lantern</button>
      <button type="button" onClick={() => calls.current.push("background")}>Background timer action</button>
    </main>
    {open && <Lantern entry={entry} onClose={() => setOpen(false)} dim />}
    <Sheet open={!!sheet} title="When did the feed end?" onClose={() => setSheet(null)}>
      <button type="button">Choose the finish time</button>
    </Sheet>
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<MotionConfig reducedMotion="user"><Fixture /></MotionConfig>);

