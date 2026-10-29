import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DoseTimeSheet from "../../src/components/maple/care/DoseTimeSheet";
import { DoseFixtureContext } from "./mocks";

const initialDose = () => ({ id: 101, kind: "dose", at: "2026-10-28T12:00:00.000Z", data: { name: "Example medicine" }, note: "Synthetic note", updated_at: "2026-10-28T12:00:00.000Z" });

function Fixture() {
  const [record, setRecord] = useState(initialDose);
  const [open, setOpen] = useState(true);
  const [sampledNow] = useState(() => new Date());
  const calls = useRef([]);
  const latest = useRef(null);
  latest.current = { record, open, calls: calls.current };
  const maple = { state: { baby: { timezone: "America/New_York" } }, now: () => new Date(), refresh: async () => {} };
  const care = {
    access: { write: true }, state: { entries: record ? [record] : [] },
    act: { editDoseTime: async (dose, at) => {
      calls.current.push({ dose, at });
      const saved = { ...record, at, updated_at: new Date(Date.parse(dose.updated_at) + 1000).toISOString() };
      setRecord(saved);
      return saved;
    } },
  };
  useEffect(() => {
    window.doseFixture = {
      snapshot: () => latest.current,
      change: (patch) => setRecord((current) => ({ ...current, ...patch, updated_at: new Date(Date.parse(current.updated_at) + 1000).toISOString() })),
    };
  }, []);
  return <DoseFixtureContext.Provider value={{ maple, care, sampledNow }}>
    <DoseTimeSheet open={open} onClose={() => setOpen(false)} dose={initialDose()} />
  </DoseFixtureContext.Provider>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
