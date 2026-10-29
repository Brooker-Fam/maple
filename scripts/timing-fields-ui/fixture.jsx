import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RecordedTimeField } from "../../src/components/maple/TimeField";
import { MapleProvider } from "../../src/components/maple/useMaple";

function Fixture() {
  const [value, setValue] = useState(() => new Date("2026-10-28T13:30:50.000Z"));
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState("");
  return <>
    <RecordedTimeField label="Recorded at" value={value} onChange={setValue} onInvalidChange={setInvalid} tz="America/New_York" />
    <button type="button" disabled={invalid} onClick={() => setSaved(value.toISOString())}>Save</button>
    <output aria-label="Saved time">{saved}</output>
  </>;
}

createRoot(document.getElementById("root")).render(<MapleProvider><Fixture /></MapleProvider>);
