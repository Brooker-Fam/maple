import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TimeRange } from "../../src/components/maple/uiFields";
import { MapleProvider } from "../../src/components/maple/useMaple";

function Fixture() {
  const [range, setRange] = useState(() => [new Date("2026-10-28T03:00:00.000Z"), new Date("2026-10-29T03:59:50.000Z")]);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState("");
  return <>
    <TimeRange start={range[0]} end={range[1]} onChange={(start, end) => setRange([start, end])} onInvalidChange={setInvalid} tz="America/New_York" />
    <button type="button" disabled={invalid} onClick={() => setSaved(range[1].toISOString())}>Save</button>
    <output aria-label="Saved end">{saved}</output>
  </>;
}

createRoot(document.getElementById("root")).render(<MapleProvider><Fixture /></MapleProvider>);
