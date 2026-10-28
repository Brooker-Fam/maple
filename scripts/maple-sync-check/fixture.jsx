import { createRoot } from "react-dom/client";
import { MapleProvider, useMaple } from "../../src/components/maple/useMaple";
import { SyncChip } from "fixture-sync-chip";

function Fixture() {
  const maple = useMaple();
  window.__mapleSync = maple;
  return <div data-testid="sync-warning"><SyncChip /></div>;
}

createRoot(document.getElementById("root")).render(<MapleProvider><Fixture /></MapleProvider>);
