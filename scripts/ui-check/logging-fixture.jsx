import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import LogTab from "../../src/components/maple/LogTab";
import PatternsTab, { buildVisitSummary } from "../../src/components/maple/PatternsTab";
import { dayKey } from "../../src/lib/maple/time";
import MoreSheet from "../../src/components/maple/MoreSheet";
import TodayTab from "../../src/components/maple/TodayTab";
import DiaperSheet from "../../src/components/maple/sheets/DiaperSheet";
import SleepSheet from "../../src/components/maple/sheets/SleepSheet";
import FeedSheet from "../../src/components/maple/sheets/FeedSheet";
import NoteSheet from "../../src/components/maple/sheets/NoteSheet";
import PumpSheet from "../../src/components/maple/sheets/PumpSheet";
import GrowthSheet from "../../src/components/maple/sheets/GrowthSheet";
import TempSheet from "../../src/components/maple/sheets/TempSheet";
import VitalsSheet from "../../src/components/maple/sheets/VitalsSheet";
import MedSheet from "../../src/components/maple/sheets/MedSheet";
import ActivitySheet from "../../src/components/maple/sheets/ActivitySheet";
import MomentSheet from "../../src/components/maple/sheets/MomentSheet";
import { summarize } from "../../src/lib/maple/insights";
import { makeVoice } from "../../src/lib/maple/voice";
import { LoggingContext } from "./logging-mocks";

const NOW = new Date("2026-10-28T13:30:00.000Z");
const EMAIL = "sam@example.test";
const mode = new URLSearchParams(location.search).get("mode") ?? "history";
const entry = (id, kind, started_at, data, extra = {}) => ({
  id, kind, started_at, data, active: false, ended_at: null, note: null,
  created_by: EMAIL, updated_by: null, source: "web", created_at: started_at, updated_at: started_at, ...extra,
});
const entries = [
  entry(1, "diaper", "2026-10-28T13:10:00.000Z", { pee: true, poop: false }),
  entry(2, "diaper", "2026-10-28T12:10:00.000Z", { pee: false, poop: true }),
  entry(3, "feed", "2026-10-28T11:10:00.000Z", { method: "bottle", amount_ml: 60 }),
  entry(4, "note", "2026-10-28T10:10:00.000Z", {}, { note: "Synthetic example note" }),
  entry(5, "feed", "2026-10-27T11:10:00.000Z", { method: "bottle", amount_ml: 60 }),
];
const savedNursing = entry(7, "feed", "2026-10-28T12:00:00.000Z", {
  method: "breast", first_side: "L", last_side: "R", segments: [
    { side: "L", start: "2026-10-28T12:00:00.000Z", end: "2026-10-28T12:20:00.000Z" },
    { side: "R", start: "2026-10-28T12:25:00.000Z", end: "2026-10-28T12:35:00.000Z" },
  ],
}, { ended_at: "2026-10-28T12:35:00.000Z", updated_at: "2026-10-28T12:35:00.000Z" });
const savedPumpSides = entry(8, "pump", "2026-10-28T12:00:00.000Z", { left_ml: 100, right_ml: 40 }, { ended_at: "2026-10-28T12:15:00.000Z" });
const savedPumpTotal = entry(9, "pump", "2026-10-28T12:00:00.000Z", { total_ml: 100 }, { ended_at: "2026-10-28T12:15:00.000Z" });
const savedTemperature = entry(10, "temp", "2026-10-28T12:00:00.000Z", { temp_c: 37.123, method: "rectal" });
const growthMeasurements = { weight_g: 3373, length_cm: 51.43, head_cm: 34.27, at: "doctor" };
const savedGrowth = entry(11, "growth", "2026-10-28T12:00:00.000Z", growthMeasurements);

function App() {
  const [target, setTarget] = useState(() => {
    if (mode === "form-nursing-details") return { kind: "feed", entry: savedNursing };
    if (mode === "form-pump-sides") return { kind: "pump", entry: savedPumpSides };
    if (mode === "form-pump-total") return { kind: "pump", entry: savedPumpTotal };
    if (mode === "form-pump-preset") return { kind: "pump", preset: { total_ml: 90 } };
    if (mode === "form-pump-sides-preset") return { kind: "pump", preset: { left_ml: 100, right_ml: 40 } };
    if (mode === "form-pump-midnight") return { kind: "pump", preset: { started_at: "2026-10-25T04:00:00.000Z", ended_at: "2026-10-25T04:00:00.000Z" } };
    if (mode === "form-temp-edit") return { kind: "temp", entry: savedTemperature };
    if (mode === "form-temp-edit-unknown") return { kind: "temp", entry: { ...savedTemperature, id: 12, data: { temp_c: savedTemperature.data.temp_c } } };
    if (mode === "form-temp-preset") return { kind: "temp", preset: { temp_c: 37 } };
    if (mode === "form-temp-precise-preset") return { kind: "temp", preset: { temp_c: 37.123 } };
    if (mode === "form-growth-edit") return { kind: "growth", entry: savedGrowth };
    if (mode === "form-growth-edit-unknown") return { kind: "growth", entry: { ...savedGrowth, id: 13, data: { weight_g: 3373, length_cm: 51.43, head_cm: 34.27 } } };
    if (mode === "form-growth-preset") return { kind: "growth", preset: growthMeasurements };
    if (mode === "form-vitals-skin") return { kind: "vitals", preset: { jaundice: "none" } };
    if (mode === "form-moment-earlier") return { kind: "moment", preset: { started_at: "2026-10-25T13:30:00.000Z" } };
    return mode.startsWith("form-") ? { kind: mode.slice(5) } : null;
  });
  const [more, setMore] = useState(mode.startsWith("more"));
  const failing = useRef(mode === "patterns-error");
  const calls = useRef([]);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const state = useMemo(() => ({
    now: NOW.toISOString(), rev: "synthetic", growth: [], lifetime: null, care: null,
    baby: { name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", settings: {} },
    family: { id: 99, care_name: "Sam", ask: "an owner" },
    me: { email: EMAIL }, members: [{ email: EMAIL, display_name: "Sam", role: "owner", color: "#674b7b" }],
    entries: mode === "today-empty" ? [] : mode.startsWith("more") ? [entry(6, "feed", "2026-10-28T13:20:00.000Z", { method: "breast", first_side: "L", segments: [{ side: "L", start: "2026-10-28T13:20:00.000Z", end: mode === "more-paused" ? "2026-10-28T13:25:00.000Z" : null }] }, { active: true })] : mode === "form-temp-edit-unknown" ? [...entries, savedTemperature] : entries,
  }), []);
  const summary = useMemo(() => summarize({ ...state, now: NOW, vo: makeVoice({ name: "River", pronoun: "she", mom: "Sam" }) }), [state]);
  const api = useCallback(async (pathname, options) => {
    calls.current.push(pathname);
    if (failing.current) throw new Error("Synthetic connection failure");
    if (pathname === `entries?id=${savedNursing.id}` && options?.method === "PATCH") {
      const patch = JSON.parse(options.body);
      calls.current.push({ id: savedNursing.id, patch });
      return { entry: { ...savedNursing, ...patch, data: { ...savedNursing.data, ...patch.data }, updated_at: NOW.toISOString() } };
    }
    return { entries: pathname.includes("deleted=1") ? [] : state.entries };
  }, [state]);
  const now = useCallback(() => NOW, []);
  const maple = { state, summary, api, now, readOnly: false, units: new URLSearchParams(location.search).get("units") === "metric" ? "metric" : "us", seenAt: null,
    memberName: () => "Sam", memberLabel: () => "Sam", member: () => state.members[0],
    isNight: () => false, timerBusy: () => false, toasts: [], toast() {}, dismissToast() {},
    log: async (value) => { calls.current.push({ log: value }); return value; }, remove() {},
    update: async (id, patch) => {
      calls.current.push({ id, patch });
      const previous = currentTarget.current?.entry;
      return { ...previous, ...patch, data: { ...previous?.data, ...patch.data } };
    },
    refresh: async () => {},
  };
  const close = useCallback(() => setTarget(null), []);
  useEffect(() => {
    window.__loggingFixture = { snapshot: () => ({ target: currentTarget.current, calls: calls.current }), recover: () => { failing.current = false; },
      visitSummary: ({ born, approximate, at = NOW.toISOString() }) => {
        const now = new Date(at);
        return buildVisitSummary({
          state: { ...state, baby: { ...state.baby, born_at: born, settings: { birth_time_approx: approximate } } },
          history: [], notes: [], todayKey: dayKey(now, state.baby.timezone), tz: state.baby.timezone, now,
        });
      } };
  }, []);
  const Form = target && { diaper: DiaperSheet, sleep: SleepSheet, feed: FeedSheet, note: NoteSheet, pump: PumpSheet, growth: GrowthSheet, temp: TempSheet, vitals: VitalsSheet, med: MedSheet, bath: ActivitySheet, tummy: ActivitySheet, moment: MomentSheet }[target.kind];
  return <LoggingContext.Provider value={{ maple, sheets: { open: setTarget, close, current: target } }}>
    <main className="mx-auto min-h-screen max-w-lg pb-20">
      {mode.startsWith("history") && <LogTab />}
      {mode.startsWith("patterns") && <PatternsTab />}
      {mode.startsWith("today") && <TodayTab onNavigate={() => {}} />}
      {mode.startsWith("more") && <MoreSheet open={more} onClose={() => setMore(false)} />}
      {Form && <Form open onClose={close} {...target} />}
    </main>
  </LoggingContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
