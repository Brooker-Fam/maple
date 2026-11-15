import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TimeRange } from "../../src/components/maple/uiFields";
import { MapleProvider } from "../../src/components/maple/useMaple";

// ?keep=start&start=…&end=… renders a range whose duration chips keep the start; without it, the default (they keep the end).
const params = new URLSearchParams(location.search);
const keep = params.get("keep") === "start" ? "start" : undefined;

function Fixture() {
  const [range, setRange] = useState(() => [new Date(params.get("start") ?? "2026-10-28T03:00:00.000Z"), new Date(params.get("end") ?? "2026-10-29T03:59:50.000Z")]);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(["", ""]);
  return <>
    <TimeRange start={range[0]} end={range[1]} keep={keep} onChange={(start, end) => setRange([start, end])} onInvalidChange={setInvalid} tz="America/New_York" />
    <button type="button" disabled={invalid} onClick={() => setSaved([range[0].toISOString(), range[1].toISOString()])}>Save</button>
    <output aria-label="Saved start">{saved[0]}</output>
    <output aria-label="Saved end">{saved[1]}</output>
  </>;
}

createRoot(document.getElementById("root")).render(<MapleProvider><Fixture /></MapleProvider>);
