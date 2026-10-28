import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { scoreScreen } from "../src/lib/maple/care";
import FullCheckInSheet from "../src/components/maple/care/FullCheckIn";
import CheckInSection from "../src/components/maple/care/CheckIn";
import NutritionEntrySheet from "../src/components/maple/care/NutritionEntrySheet";
import { FixtureContext } from "./ui-review-care-mocks";

const now = new Date("2026-10-28T13:30:00Z");
const email = "example-parent@example.test";
const initial = { id: 701, kind: "checkin", at: now.toISOString(), data: { level: 4, tags: [] }, note: null, created_at: now.toISOString(), updated_at: now.toISOString() };
function Fixture() {
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "full";
  const [open, setOpen] = useState(true);
  const [checkin, setCheckin] = useState(initial);
  const controls = useRef({ fail: false, calls: [], pending: null, hold: false });
  window.__checkinFixture = controls.current;
  controls.current.externalTags = (tags) => setCheckin((entry) => ({ ...entry, data: { ...entry.data, tags } }));
  const saveScreen = async (data, options) => {
    const control = controls.current;
    control.calls.push({ kind: "screen", data, options });
    if (control.hold) await new Promise((resolve) => { control.pending = resolve; });
    if (control.fail || (control.failFirst && control.calls.length === 1)) throw Error("Synthetic check-in save failure");
    return { id: options?.id ?? 900 + control.calls.length, kind: "screen", at: now.toISOString(), data: scoreScreen(data), note: null, created_at: now.toISOString(), updated_at: now.toISOString() };
  };
  const updateCheckin = async (id, patch) => {
    const control = controls.current;
    control.calls.push({ kind: "checkin", id, patch });
    setCheckin((entry) => ({ ...entry, data: { ...entry.data, ...(patch.tags ? { tags: patch.tags } : {}), ...(patch.level ? { level: patch.level } : {}) }, ...(patch.note !== undefined ? { note: patch.note } : {}) }));
    if (control.hold) await new Promise((resolve) => { control.pending = resolve; });
    if (control.fail) throw Error("Synthetic check-in save failure");
  };
  const care = {
    name: "Example Parent", self: true, access: { read: true, write: true, mood: true, private: true },
    state: { person: { name: "Example Parent", member: email, self: true }, settings: {}, plans: [], entries: [] },
    mood: { todayCheckin: checkin, checkins: [checkin], latestScreen: null, suggestion: null, crisis: false },
    plans: [], finished: [], rows: [], act: { saveScreen, updateCheckin },
  };
  const state = { baby: { name: "Example Baby", timezone: "America/New_York", born_at: "2026-09-01T12:00:00Z", settings: {} }, family: { id: 99 }, care: care.state, me: { email }, members: [] };
  return <FixtureContext.Provider value={{ maple: { state, now: () => now, toast() {}, memberName: () => "Example Parent", units: "us", refresh: async () => {} }, care }}>
    <main className="mx-auto max-w-lg p-4"><h1>Example check-in</h1>{scenario === "daily" ? <CheckInSection /> : scenario === "food" || scenario === "drink" ? open && <NutritionEntrySheet kind={scenario} care={care} saving={false} onClose={() => setOpen(false)} onSave={async () => { throw Error("Synthetic nutrition save failure"); }} /> : <><button onClick={() => setOpen(true)}>Open fuller check-in</button><FullCheckInSheet open={open} onClose={() => setOpen(false)} /></>}</main>
  </FixtureContext.Provider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
