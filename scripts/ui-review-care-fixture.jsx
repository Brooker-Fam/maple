import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { planView } from "../src/lib/maple/care";
import { FixtureContext } from "./ui-review-care-mocks";
import PlanDetail from "../src/components/maple/care/PlanDetail";
import MedPlanSheet from "../src/components/maple/care/MedPlanSheet";
import DoseSheet from "../src/components/maple/care/DoseSheet";
import CareSettingsSheet from "../src/components/maple/care/CareSettingsSheet";
import DoseTimeSheet from "../src/components/maple/care/DoseTimeSheet";
import { MomTempSheet } from "../src/components/maple/care/MomTempSheet";

const now = new Date("2026-10-28T13:30:00Z");
const email = "example-parent@example.test";
const plan = {
  id: 901, name: "Example medicine", also_called: null, dose_text: "Example label",
  schedule: { type: "as_needed" }, max_24h: null, limit_unit: null, units_per_dose: null,
  label_text: null, reason: null, contains_apap: false, instructions: null,
  course_start: null, course_end: null, show_on_today: true, private: false,
  stopped_at: null, reviewed_at: null, reviewed_by: null, sort: 0,
  created_by: email, updated_by: null, source: "web", created_at: now.toISOString(), updated_at: now.toISOString(),
};
const entry = (id, kind, at, data) => ({ id, kind, at, data, med_id: kind === "dose" ? plan.id : null, note: null, private: false, created_by: email, updated_by: null, source: "web", created_at: at, updated_at: at });
const recentDose = entry(1, "dose", "2026-10-28T10:00:00Z", { name: plan.name, dose: "Recent example label" });
const recentTemps = Array.from({ length: 7 }, (_, i) => entry(10 + i, "temp", `2026-10-${28 - i}T12:00:00Z`, { temp_c: 37 + i / 10 }));
const oldDose = entry(99, "dose", "2026-09-12T10:00:00Z", { name: plan.name, dose: "Older example dose" });
const oldTemp = entry(100, "temp", "2026-09-12T12:00:00Z", { temp_c: 36.5 });

function App() {
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "detail";
  const [open, setOpen] = useState(true);
  const requests = [];
  const failures = { history: false, save: true, cap: false };
  window.__careFixture = { failures, requests };
  const api = useCallback(async (pathname) => {
    const url = new URL(pathname.startsWith("/") ? pathname : `/api/maple/${pathname}`, "https://maple-care.example.test");
    requests.push(url.search);
    if (url.pathname !== "/api/maple/care/entries") throw Error("Unexpected synthetic request");
    if (failures.history) throw Error("Synthetic history failure");
    if (failures.cap) return { entries: Array.from({ length: 2000 }, (_, i) => ({ ...oldDose, id: 2000 + i })), tz: "America/New_York" };
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const kind = url.searchParams.get("kind");
    return { entries: [recentDose, ...recentTemps, oldDose, oldTemp].filter((e) => (!kind || e.kind === kind) && e.at.slice(0, 10) >= from && e.at.slice(0, 10) <= to), tz: "America/New_York" };
  }, []);
  const rejectSave = async () => { if (failures.save) throw Error("Synthetic save failure"); return { created: true, id: 999 }; };
  const state = {
    baby: { name: "Example Baby", nickname: null, timezone: "America/New_York", born_at: "2026-09-01T12:00:00Z", settings: {} },
    family: { id: 99, care_name: "Example Parent", created_at: "2026-09-01T12:00:00Z" },
    me: { email }, members: [{ email, display_name: "Example Parent", role: "owner" }], entries: [],
  };
  const ctx = { now, tz: state.baby.timezone, self: true, members: state.members, me: email, name: "Example Parent", settings: {} };
  const view = planView(plan, [recentDose], ctx);
  const care = {
    name: "Example Parent", self: true,
    access: { read: true, write: true, private: true, therapist: true, mood: false, manage: true },
    state: { settings: {}, plans: [plan], entries: [recentDose, ...recentTemps], person: { member: email, name: "Example Parent", created_by: email } },
    plans: [view], finished: [], rows: [view], doses: () => [recentDose],
    act: { savePlan: rejectSave, logTemp: rejectSave, logDose: rejectSave, patchPerson: rejectSave, editEntry: rejectSave, editDoseTime: rejectSave },
  };
  const maple = { state, now: () => now, api, units: "us", memberName: () => "Example Parent", memberLabel: () => "Example Parent", refresh: async () => {}, toast() {} };
  const close = () => setOpen(false);
  return <FixtureContext.Provider value={{ maple, care }}><main className="p-5"><h1>Example care</h1><button onClick={() => setOpen(true)}>Open example</button></main>
    {scenario === "detail" && <PlanDetail planId={open ? plan.id : null} care={care} onClose={close} />}
    {scenario === "plan" && <MedPlanSheet open={open} care={care} onClose={close} />}
    {scenario === "temp" && <MomTempSheet open={open} care={care} onClose={close} />}
    {scenario === "settings" && <CareSettingsSheet open={open} care={care} onClose={close} />}
    {scenario === "dose" && <DoseSheet open={open} onClose={close} />}
    {scenario === "plan-dose" && <DoseSheet open={open} planId={plan.id} onClose={close} />}
    {scenario === "dose-time" && <DoseTimeSheet open={open} dose={recentDose} onClose={close} />}
  </FixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
