import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DoseTimeSheet from "../../src/components/maple/care/DoseTimeSheet";
import DoseSheet from "../../src/components/maple/care/DoseSheet";
import PlanDetail from "../../src/components/maple/care/PlanDetail";
import ChatCareEditor from "../../src/components/maple/chat/ChatCareEditor";
import { planView } from "../../src/lib/maple/care";
import { DoseFixtureContext } from "./mocks";

const initialDose = () => ({ id: 101, med_id: 901, kind: "dose", at: "2026-10-28T12:00:00.000Z", data: { name: "Example medicine" }, note: "Synthetic note", created_by: "sam@example.test", updated_at: "2026-10-28T12:00:00.000Z" });
const plan = { id: 901, name: "Example medicine", schedule: { type: "as_needed" }, max_24h: null, units_per_dose: null, limit_unit: null, created_at: "2026-10-01T12:00:00.000Z" };

function Fixture() {
  const [record, setRecord] = useState(initialDose);
  const [open, setOpen] = useState(true);
  const [sampledNow] = useState(() => new Date());
  const calls = useRef([]);
  const latest = useRef(null);
  latest.current = { record, open, calls: calls.current };
  const mode = new URLSearchParams(window.location.search).get("form");
  const maple = { state: { baby: { timezone: "America/New_York" }, me: { email: "sam@example.test" } }, now: () => new Date(), refresh: async () => {}, memberLabel: () => "Sam", online: true, units: "metric" };
  const care = {
    access: { write: true }, state: { entries: record ? [record] : [], settings: {} },
    self: true, name: "Sam", doses: () => mode === "plan" ? [] : [record], finished: [],
    plans: [planView(plan, [record], { now: sampledNow, tz: "America/New_York", self: true, name: "Sam", members: [], me: "sam@example.test", settings: {} })],
    act: {
      editDoseTime: async (dose, at) => {
        calls.current.push({ dose, at });
        const saved = { ...record, at, updated_at: new Date(Date.parse(dose.updated_at) + 1000).toISOString() };
        setRecord(saved);
        return saved;
      },
      logDose: async (input) => { calls.current.push({ input }); return { created: true }; },
      editEntry: async (id, patch, version) => { calls.current.push({ id, patch, version }); },
    },
  };
  useEffect(() => {
    window.doseFixture = {
      snapshot: () => latest.current,
      change: (patch) => setRecord((current) => ({ ...current, ...patch, updated_at: new Date(Date.parse(current.updated_at) + 1000).toISOString() })),
    };
  }, []);
  return <DoseFixtureContext.Provider value={{ maple, care, sampledNow }}>
    {mode === "chat" ? open && <ChatCareEditor entry={initialDose()} onClose={() => setOpen(false)} />
      : mode === "details" ? <PlanDetail planId={open ? plan.id : null} onClose={() => setOpen(false)} care={care} />
        : mode === "plan" || mode === "one-off" ? <DoseSheet open={open} onClose={() => setOpen(false)} planId={mode === "plan" ? plan.id : undefined} name="One-time example" start={{ at: initialDose().at }} />
          : <DoseTimeSheet open={open} onClose={() => setOpen(false)} dose={initialDose()} />}
  </DoseFixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
